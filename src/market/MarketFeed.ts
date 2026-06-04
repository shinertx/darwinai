// ============================================================================
// MarketFeed — Adapted from final-radiation Detector.ts
// Emits MarketSignal objects for the Darwin organism
// ============================================================================

import EventEmitter from 'events'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { OnlinePumpAmmSdk } from '@pump-fun/pump-swap-sdk'
import bs58 from 'bs58'
import { MarketSignal, PricePoint } from '../types'
import { createSolanaConnection } from '../rpc/solanaConnection'
import { clearExpiredPoolSwapStates, rememberPoolSwapState } from './poolStateCache'

const PUMP_CORE_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
const PRICE_HISTORY_MAX = 20
const TX_CACHE_TTL_MS = 30 * 1000
const RECENT_AMM_CACHE_TTL_MS = 30 * 1000
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')

export interface MigrationFeedReadinessConfig {
  enabled: boolean
  attempts: number
  intervalMs: number
  lookupTimeoutMs: number
  emitTxFallbackOnExpiry: boolean
}

type PendingMigrationSignal = {
  signal: MarketSignal
  detectedAt: number
  expiresAt: number
}

type RecentAmmPoolHint = {
  pool: string
  liquiditySol: number
  seenAt: number
}

type PendingMigrationLifecycleConfig = {
  ttlMs: number
  ammExtensionMs: number
  recheckMs: number
}

type ActionableMigrationOverrides = {
  pool?: string
  liquiditySol?: number
}

type ActionableMigrationReadiness = {
  readyAt: number
  pool: string
}

type WsolReadyPool = {
  baseMint?: PublicKey | null
  quoteMint?: PublicKey | null
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
}

function parsePrivateKeyToPublicKey(value: string | undefined): PublicKey | null {
  if (!value) return null
  try {
    if (value.startsWith('[')) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value))).publicKey
    }
    return Keypair.fromSecretKey(bs58.decode(value)).publicKey
  } catch (_) {
    return null
  }
}

function resolvePendingMigrationLifecycleConfig(
  env: NodeJS.ProcessEnv = process.env
): PendingMigrationLifecycleConfig {
  return {
    ttlMs: parsePositiveInt(env.DARWIN_MIGRATION_PENDING_TTL_MS, 45_000),
    ammExtensionMs: parsePositiveInt(env.DARWIN_MIGRATION_PENDING_AMM_EXTENSION_MS, 15_000),
    recheckMs: parsePositiveInt(env.DARWIN_MIGRATION_PENDING_RECHECK_MS, 1_500),
  }
}

export function resolveMigrationFeedReadinessConfig(
  env: NodeJS.ProcessEnv = process.env
): MigrationFeedReadinessConfig {
  return {
    enabled: (env.DARWIN_MODE || '').trim().toLowerCase() === 'live',
    attempts: parsePositiveInt(env.DARWIN_MIGRATION_FEED_READY_ATTEMPTS, 6),
    intervalMs: parsePositiveInt(env.DARWIN_MIGRATION_FEED_READY_INTERVAL_MS, 250),
    lookupTimeoutMs: parsePositiveInt(env.DARWIN_MIGRATION_FEED_LOOKUP_TIMEOUT_MS, 900),
    emitTxFallbackOnExpiry: parseBooleanFlag(env.DARWIN_MIGRATION_EMIT_TX_FALLBACK_ON_EXPIRY, false),
  }
}

export function getSignalCooldownKey(signal: Pick<MarketSignal, 'mint' | 'type'>): string {
  return `${signal.mint}:${signal.type}`
}

export function isActionableWsolPool(pool: WsolReadyPool | null | undefined): boolean {
  return Boolean(
    pool?.quoteMint?.equals(WSOL_MINT) ||
    pool?.baseMint?.equals(WSOL_MINT)
  )
}

function createRealtimeConnection(rpcUrl: string): Connection {
  const wsEndpoint = (process.env.WSS_URL || '').trim()
  if (wsEndpoint) {
    return createSolanaConnection(rpcUrl, 'processed', { wsEndpoint })
  }
  return createSolanaConnection(rpcUrl, 'processed')
}

export class MarketFeed extends EventEmitter {
  private ammSignalCount = 0
  private ammRateBucketStart = Date.now()
  private connection: Connection | null = null
  private fetchConnections: Connection[] = []
  private fetchIndex = 0
  private coreSubscriptionId: number | null = null
  private ammSubscriptionId: number | null = null
  private recentSignals: Map<string, number> = new Map()
  private activeAmmFetches = 0
  private activeBuyFetches = 0
  private activeCoreFetches = 0
  private lastBuyFetchAt = 0
  private lastSignalAt = Date.now()
  private watchdogHandle: NodeJS.Timeout | null = null
  private cleanupHandle: NodeJS.Timeout | null = null
  private rpcUrl = ''
  private rpcUrls: string[] = []
  private priceHistory: Map<string, PricePoint[]> = new Map()
  private signalCooldownMs = 5000
  private txCache: Map<string, { tx: any; ts: number }> = new Map()
  private txInFlight: Map<string, Promise<any>> = new Map()
  private migrationReadinessConfig = resolveMigrationFeedReadinessConfig(process.env)
  private pendingMigrationLifecycle = resolvePendingMigrationLifecycleConfig(process.env)
  private pendingMigrationSignals: Map<string, PendingMigrationSignal> = new Map()
  private pendingMigrationProcessing: Set<string> = new Set()
  private pendingMigrationExpiryTimers: Map<string, NodeJS.Timeout> = new Map()
  private pendingMigrationRetryTimers: Map<string, NodeJS.Timeout> = new Map()
  private recentAmmPoolHints: Map<string, RecentAmmPoolHint> = new Map()
  private migrationProbeUser: PublicKey =
    parsePrivateKeyToPublicKey(process.env.PRIVATE_KEY) || Keypair.generate().publicKey
  private migrationReadinessSdk: OnlinePumpAmmSdk | null = null
  private migrationReadinessConnection: Connection | null = null

  constructor() {
    super()
  }

  public getPriceHistory(mint: string): PricePoint[] {
    return this.priceHistory.get(mint) || []
  }

  public addPricePoint(mint: string, price: number, volume?: number) {
    if (!this.priceHistory.has(mint)) {
      this.priceHistory.set(mint, [])
    }
    const history = this.priceHistory.get(mint)!
    history.push({ price, timestamp: Date.now(), volume })
    if (history.length > PRICE_HISTORY_MAX) {
      history.shift()
    }
  }

  public start(): boolean {
    this.rpcUrls = (process.env.RPC_URLS || process.env.RPC_URL || '')
      .split(',')
      .map((u: string) => u.trim())
      .filter(Boolean)

    this.rpcUrl = this.rpcUrls[0]
    if (!this.rpcUrl) {
      console.error('[MarketFeed] No RPC_URL in env. Cannot start.')
      return false
    }

    console.log('[MarketFeed] Starting PumpSwap feed...')
    this.connection = createRealtimeConnection(this.rpcUrl)
    this.fetchConnections = this.rpcUrls.map((url: string) => createSolanaConnection(url, 'confirmed'))
    this.migrationReadinessConnection = this.migrationReadinessConfig.enabled
      ? createSolanaConnection(this.rpcUrl, 'processed')
      : null
    this.migrationReadinessSdk = this.migrationReadinessConnection
      ? new OnlinePumpAmmSdk(this.migrationReadinessConnection)
      : null

    if (this.fetchConnections.length > 1) {
      console.log('[MarketFeed] RPC pool: ' + this.fetchConnections.length + ' endpoints')
    }
    if ((process.env.WSS_URL || '').trim()) {
      console.log('[MarketFeed] Using explicit WSS endpoint for subscriptions')
    }

    this.subscribeToPumpCore()
    this.subscribeToPumpAMM()

    this.lastSignalAt = Date.now()
    this.watchdogHandle = setInterval(() => {
      const silentMs = Date.now() - this.lastSignalAt
      if (silentMs > 120000) {
        console.warn('[MarketFeed] WATCHDOG: No signals for ' + Math.round(silentMs / 1000) + 's — reconnecting...')
        this.reconnect()
      }
    }, 30000)

    this.cleanupHandle = setInterval(() => {
      const now = Date.now()
      for (const [key, ts] of this.recentSignals) {
        if (now - ts > this.signalCooldownMs * 2) this.recentSignals.delete(key)
      }
      for (const [signature, cached] of this.txCache) {
        if (now - cached.ts > TX_CACHE_TTL_MS) this.txCache.delete(signature)
      }
      for (const [mint, hint] of this.recentAmmPoolHints) {
        if (now - hint.seenAt > RECENT_AMM_CACHE_TTL_MS) this.recentAmmPoolHints.delete(mint)
      }
      clearExpiredPoolSwapStates()
    }, 60000)

    return true
  }

  private reconnect() {
    console.log('[MarketFeed] Reconnecting...')
    if (this.connection) {
      if (this.coreSubscriptionId !== null) {
        try { this.connection.removeOnLogsListener(this.coreSubscriptionId) } catch (_) {}
        this.coreSubscriptionId = null
      }
      if (this.ammSubscriptionId !== null) {
        try { this.connection.removeOnLogsListener(this.ammSubscriptionId) } catch (_) {}
        this.ammSubscriptionId = null
      }
    }
    this.connection = createRealtimeConnection(this.rpcUrl)
    this.fetchConnections = this.rpcUrls.map((url: string) => createSolanaConnection(url, 'confirmed'))
    this.migrationReadinessConnection = this.migrationReadinessConfig.enabled
      ? createSolanaConnection(this.rpcUrl, 'processed')
      : null
    this.migrationReadinessSdk = this.migrationReadinessConnection
      ? new OnlinePumpAmmSdk(this.migrationReadinessConnection)
      : null
    this.subscribeToPumpCore()
    this.subscribeToPumpAMM()
    this.lastSignalAt = Date.now()
    console.log('[MarketFeed] Reconnected')
  }

  public stop() {
    if (this.watchdogHandle) { clearInterval(this.watchdogHandle); this.watchdogHandle = null }
    if (this.cleanupHandle) { clearInterval(this.cleanupHandle); this.cleanupHandle = null }
    for (const timer of this.pendingMigrationExpiryTimers.values()) {
      clearTimeout(timer)
    }
    this.pendingMigrationExpiryTimers.clear()
    for (const timer of this.pendingMigrationRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.pendingMigrationRetryTimers.clear()
    if (this.connection) {
      if (this.coreSubscriptionId !== null) this.connection.removeOnLogsListener(this.coreSubscriptionId)
      if (this.ammSubscriptionId !== null) this.connection.removeOnLogsListener(this.ammSubscriptionId)
    }
    this.recentSignals.clear()
    this.pendingMigrationSignals.clear()
    console.log('[MarketFeed] Stopped')
  }

  private subscribeToPumpAMM() {
    if (!this.connection) return
    try {
      this.ammSubscriptionId = this.connection.onLogs(
        new PublicKey(PUMP_AMM_PROGRAM_ID),
        async (logs: any, _ctx: any) => {
          try {
            if (logs.err) return
            const isPoolCreation = logs.logs?.some((l: string) => l.includes('Instruction: CreatePool'))
            if (isPoolCreation) {
              console.log('[MarketFeed] MIGRATION: ' + logs.signature)
              await this.processAMMEvent(logs.signature, 'migration')
              return
            }
            const isSellOrBuy = logs.logs?.some((l: string) =>
              l.includes('Instruction: Sell') || l.includes('Instruction: Buy')
            )
            if (isSellOrBuy) {
              const now = Date.now()
              if (now - this.lastBuyFetchAt < 500) return
              if (this.activeBuyFetches >= 2) return
              this.lastBuyFetchAt = now
              this.activeBuyFetches++
              try {
                await this.processAMMActivityEvent(logs.signature)
              } finally {
                this.activeBuyFetches--
              }
            }
          } catch (e) {
            console.error('[MarketFeed] AMM handler error:', e)
          }
        },
        'processed'
      )
      console.log('[MarketFeed] Subscribed to PumpSwap AMM (ID: ' + this.ammSubscriptionId + ')')
    } catch (e) {
      console.error('[MarketFeed] Failed to subscribe to AMM:', e)
    }
  }

  private subscribeToPumpCore() {
    if (!this.connection) return
    try {
      this.coreSubscriptionId = this.connection.onLogs(
        new PublicKey(PUMP_CORE_PROGRAM_ID),
        async (logs: any, _ctx: any) => {
          try {
            if (logs.err) return
            const isBuy = logs.logs?.some((l: string) => l.includes('Instruction: Buy'))
            if (!isBuy) return
            if (this.activeCoreFetches >= 6) return
            this.activeCoreFetches++
            try {
              const result = await this.processCoreEvent(logs.signature)
              if (result && result.solAmount >= 5.0) {
                console.log('[MarketFeed] WHALE BUY: ' + result.solAmount.toFixed(2) + ' SOL on ' + result.mint.slice(0, 8) + '...')
                const estimatedLiq = result.solAmount * 10
                this.emitSignal({
                  type: 'whale_buy',
                  mint: result.mint,
                  pool: '',
                  liquiditySol: estimatedLiq,
                  poolAgeMs: 0,
                  priceSol: 0,
                  eventData: { tradeSizeSol: result.solAmount },
                  timestamp: Date.now(),
                })
              }
            } finally {
              this.activeCoreFetches--
            }
          } catch (e) {
            console.error('[MarketFeed] Core handler error:', e)
          }
        },
        'processed'
      )
      console.log('[MarketFeed] Subscribed to Pump.fun Core (ID: ' + this.coreSubscriptionId + ')')
    } catch (e) {
      console.error('[MarketFeed] Failed to subscribe to Core:', e)
    }
  }

  private async processAMMEvent(signature: string, eventType: 'migration' | 'new_pool'): Promise<void> {
    if (!this.connection) return
    const detectedAt = Date.now()
    try {
      const tx = await this.fetchTransaction(signature, 'amm', {
        attempts: 5,
        retryDelayMs: 400,
        bypassThrottle: true,
      })
      if (!tx || !tx.meta) {
        console.log('[MarketFeed] Migration TX not fetchable: ' + signature.slice(0, 8))
        this.emitSignalSkip(
          {
            type: eventType === 'migration' ? 'migration' : 'new_pool',
            mint: '',
            pool: '',
            liquiditySol: 0,
            poolAgeMs: 0,
            priceSol: 0,
            eventData: { signature, detectedAt },
            timestamp: detectedAt,
          },
          'migration_tx_unavailable',
          { signature }
        )
        return
      }
      const tokenBalances = tx.meta.postTokenBalances || []
      const relevantToken = this.findPumpToken(tokenBalances)
      if (relevantToken?.mint) {
        const poolCandidates = this.extractPoolCandidateAddresses(tx)
        const poolAddress = poolCandidates[0] || ''
        const recentAmmHint = this.getRecentAmmPoolHint(relevantToken.mint)
        const liquiditySol = Math.max(
          this.extractSolAmount(tx),
          recentAmmHint?.liquiditySol ?? 0
        )
        const readinessPool = recentAmmHint?.pool || poolAddress
        const signal: MarketSignal = {
          type: eventType === 'migration' ? 'migration' : 'new_pool',
          mint: relevantToken.mint,
          pool: readinessPool,
          liquiditySol,
          poolAgeMs: 0,
          priceSol: 0,
          eventData: {
            signature,
            detectedAt,
            detectedPool: poolAddress,
            detectedPoolCandidates: poolCandidates,
            recentAmmPool: recentAmmHint?.pool,
            recentAmmSeenAt: recentAmmHint?.seenAt,
          },
          timestamp: detectedAt,
        }

        if (eventType === 'migration' && this.migrationReadinessConfig.enabled) {
          if (!readinessPool) {
            console.log('[MarketFeed] Migration pool missing: ' + relevantToken.mint.slice(0, 8))
            this.emitSignalSkip(signal, 'migration_pool_missing', { signature })
            return
          }

          console.log(
            '[MarketFeed] RAW MIGRATION: ' +
            readinessPool.slice(0, 8) +
            '... Liq: ' +
            liquiditySol.toFixed(2) +
            ' SOL'
          )
          this.enqueuePendingMigration(signal, detectedAt)
          return
        }

        const entryLabel = poolAddress ? poolAddress.slice(0, 8) : relevantToken.mint.slice(0, 8)
        console.log('[MarketFeed] FAST ENTRY: ' + entryLabel + '... Liq: ' + liquiditySol.toFixed(2) + ' SOL')
        this.emitSignal(signal)
      } else {
        console.log('[MarketFeed] Migration TX: no pump token found in balances')
        this.emitSignalSkip(
          {
            type: eventType === 'migration' ? 'migration' : 'new_pool',
            mint: '',
            pool: '',
            liquiditySol: 0,
            poolAgeMs: 0,
            priceSol: 0,
            eventData: { signature, detectedAt },
            timestamp: detectedAt,
          },
          'migration_tx_unavailable',
          { signature, reason: 'no_pump_token_found' }
        )
      }
    } catch (e) {
      console.error('[MarketFeed] Error processing AMM event:', e)
    }
  }

  private enqueuePendingMigration(signal: MarketSignal, detectedAt: number): void {
    const key = signal.pool || signal.mint
    if (!key) {
      this.emitSignalSkip(signal, 'migration_pool_missing', { mint: signal.mint })
      return
    }
    if (this.pendingMigrationSignals.has(key)) {
      return
    }

    this.pendingMigrationSignals.set(key, {
      signal,
      detectedAt,
      expiresAt: detectedAt + this.pendingMigrationLifecycle.ttlMs,
    })
    this.schedulePendingMigrationExpiry(key)
    void this.processPendingMigration(key)
  }

  private async processPendingMigration(key: string): Promise<void> {
    if (this.pendingMigrationProcessing.has(key)) {
      return
    }

    const pending = this.pendingMigrationSignals.get(key)
    if (!pending) return

    this.pendingMigrationProcessing.add(key)
    try {
      const readiness = await this.waitForMigrationPoolReady(pending.signal)
      if (!this.pendingMigrationSignals.has(key)) {
        return
      }

      const currentPending = this.pendingMigrationSignals.get(key)
      if (!currentPending) {
        return
      }

      if (readiness !== null) {
        this.emitActionablePendingMigration(
          key,
          currentPending,
          readiness.readyAt,
          'swap_state',
          { pool: readiness.pool }
        )
      } else {
        if (Date.now() >= currentPending.expiresAt) {
          this.expirePendingMigration(key, currentPending)
        } else {
          this.schedulePendingMigrationRetry(key, currentPending)
        }
      }
    } finally {
      this.pendingMigrationProcessing.delete(key)
    }
  }

  private promotePendingMigrationFromAmm(pool: string, mint: string, liquiditySol: number): boolean {
    const currentKey = this.pendingMigrationSignals.has(pool)
      ? pool
      : Array.from(this.pendingMigrationSignals.entries()).find(([, pending]) => pending.signal.mint === mint)?.[0]
    if (!currentKey) return false
    const pending = this.pendingMigrationSignals.get(currentKey)
    if (!pending) return false

    const nextKey = pool || currentKey
    const nextPending: PendingMigrationSignal = {
      signal: {
        ...pending.signal,
        pool,
        liquiditySol: Math.max(pending.signal.liquiditySol, liquiditySol),
        eventData: {
          ...pending.signal.eventData,
          detectedPool: pending.signal.eventData?.detectedPool || pending.signal.pool,
        },
      },
      detectedAt: pending.detectedAt,
      expiresAt: Math.max(
        pending.expiresAt,
        Date.now() + this.pendingMigrationLifecycle.ammExtensionMs
      ),
    }

    if (currentKey !== nextKey) {
      this.clearPendingMigrationState(currentKey)
    }
    this.pendingMigrationSignals.set(nextKey, nextPending)
    this.schedulePendingMigrationExpiry(nextKey)
    void this.processPendingMigration(nextKey)
    return true
  }

  private async waitForMigrationPoolReady(signal: MarketSignal): Promise<ActionableMigrationReadiness | null> {
    if (!this.migrationReadinessConfig.enabled) {
      return signal.pool
        ? { readyAt: Date.now(), pool: signal.pool }
        : null
    }

    if (!this.migrationReadinessSdk) {
      return null
    }

    const candidatePools = Array.from(
      new Set(
        [
          signal.pool,
          ...(Array.isArray(signal.eventData?.detectedPoolCandidates)
            ? signal.eventData.detectedPoolCandidates
            : []),
        ].filter((pool): pool is string => typeof pool === 'string' && pool.length > 20)
      )
    )
    if (candidatePools.length === 0) {
      return null
    }

    for (let attempt = 0; attempt < this.migrationReadinessConfig.attempts; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.migrationReadinessConfig.intervalMs))
      }

      for (const pool of candidatePools) {
        try {
          const state = await Promise.race<any | null>([
            this.migrationReadinessSdk.swapSolanaState(new PublicKey(pool), this.migrationProbeUser),
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), this.migrationReadinessConfig.lookupTimeoutMs)
            ),
          ])
          if (state && isActionableWsolPool((state as any).pool)) {
            rememberPoolSwapState(pool, state)
            return { readyAt: Date.now(), pool }
          }
        } catch (_) {}
      }
    }

    return null
  }

  private emitActionablePendingMigration(
    key: string,
    pending: PendingMigrationSignal,
    readyAt: number,
    readySource: 'swap_state' | 'amm_activity' | 'tx_fallback',
    overrides: ActionableMigrationOverrides = {}
  ): void {
    const readyPool = overrides.pool || pending.signal.pool
    const detectedPool = pending.signal.eventData?.detectedPool || pending.signal.pool
    const actionableSignal: MarketSignal = {
      ...pending.signal,
      pool: readyPool,
      liquiditySol: Math.max(
        pending.signal.liquiditySol,
        overrides.liquiditySol ?? pending.signal.liquiditySol
      ),
      poolAgeMs: Math.max(0, readyAt - pending.detectedAt),
      timestamp: readyAt,
      eventData: {
        ...pending.signal.eventData,
        detectedAt: pending.detectedAt,
        readyAt,
        readyLatencyMs: Math.max(0, readyAt - pending.detectedAt),
        readySource,
        detectedPool,
        readyPool,
      },
    }
    console.log(
      '[MarketFeed] ACTIONABLE MIGRATION: ' +
      readyPool.slice(0, 8) +
      '... Ready in ' +
      (readyAt - pending.detectedAt) +
      'ms' +
      ' [' + readySource + ']'
    )
    this.clearPendingMigrationState(key)
    this.emitSignal(actionableSignal)
  }

  private async processAMMActivityEvent(signature: string): Promise<void> {
    if (!this.connection) return
    try {
      await new Promise((r) => setTimeout(r, 500))
      const tx = await this.fetchTransaction(signature, 'amm', { attempts: 1 })
      if (!tx || !tx.meta) return
      const tokenBalances = tx.meta.postTokenBalances || []
      const relevantToken = this.findPumpToken(tokenBalances)
      if (!relevantToken?.mint) return
      const poolAddress = this.extractPoolCandidateAddresses(tx)[0] || null
      if (!poolAddress) return
      const tradeAmountSol = this.extractSolAmount(tx)
      const estimatedLiq = tradeAmountSol * 10
      this.recentAmmPoolHints.set(relevantToken.mint, {
        pool: poolAddress,
        liquiditySol: estimatedLiq,
        seenAt: Date.now(),
      })
      if (this.migrationReadinessConfig.enabled) {
        this.promotePendingMigrationFromAmm(poolAddress, relevantToken.mint, estimatedLiq)
      }
      if (tradeAmountSol < 5) return
      // Hard liquidity floor: skip amm_activity if estimated liquidity < 50 SOL
      if (estimatedLiq < 50) return
      // Rate limiter: max 10 amm_activity signals per minute
      if (!this.ammRateLimiter()) return
      console.log('[MarketFeed] AMM ACTIVITY: ' + poolAddress.slice(0, 8) + '... Trade: ' + tradeAmountSol.toFixed(2) + ' SOL')
      this.emitSignal({
        type: 'amm_activity',
        mint: relevantToken.mint,
        pool: poolAddress,
        liquiditySol: estimatedLiq,
        poolAgeMs: 0,
        priceSol: 0,
        eventData: { tradeSizeSol: tradeAmountSol, signature },
        timestamp: Date.now(),
      })
    } catch (_) {}
  }

  private async processCoreEvent(signature: string): Promise<{ mint: string; solAmount: number } | null> {
    if (!this.connection) return null
    try {
      const tx = await this.fetchTransaction(signature, 'core', { bypassThrottle: true })
      if (!tx) return null
      const solAmount = this.extractSolAmount(tx)
      if (solAmount > 5.0) {
        const tokenBalances = tx.meta?.postTokenBalances || []
        const tokenInfo = this.findPumpToken(tokenBalances)
        if (tokenInfo) return { mint: tokenInfo.mint, solAmount }
      }
      return null
    } catch (_) { return null }
  }

  private findPumpToken(tokenBalances: any[]): { mint: string } | null {
    const SOL_MINT = 'So11111111111111111111111111111111111111112'
    const candidates = tokenBalances.filter((tb: any) => {
      if (tb.mint === SOL_MINT) return false
      if (tb.uiTokenAmount?.decimals !== 6) return false
      return true
    })
    if (candidates.length === 0) return null
    const pumpToken = candidates.find((tb: any) => tb.mint.toLowerCase().endsWith('pump'))
    if (pumpToken) return { mint: pumpToken.mint }
    return { mint: candidates[0].mint }
  }

  private extractPoolCandidateAddresses(tx: any): string[] {
    const PUMP_AMM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
    const GLOBAL_STATE = 'GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR'
    const candidates: string[] = []
    const seen = new Set<string>()
    const addCandidate = (value: any) => {
      const key = value?.toString?.()
      if (!key || key === GLOBAL_STATE || seen.has(key)) return
      seen.add(key)
      candidates.push(key)
    }
    try {
      const mainInstructions = tx.transaction?.message?.instructions || []
      for (const ix of mainInstructions) {
        if (ix.programId.toString() === PUMP_AMM_ID) {
          for (const candidate of ix.accounts || []) {
            addCandidate(candidate)
          }
        }
      }
      const innerInstructions = tx.meta?.innerInstructions || []
      for (const inner of innerInstructions) {
        for (const ix of inner.instructions) {
          if (ix.programId.toString() === PUMP_AMM_ID) {
            for (const candidate of ix.accounts || []) {
              addCandidate(candidate)
            }
          }
        }
      }
    } catch (e) {}
    return candidates
  }

  private extractSolAmount(tx: any): number {
    try {
      const preBalances = tx.meta?.preBalances || []
      const postBalances = tx.meta?.postBalances || []
      let maxInflow = 0
      for (let i = 0; i < postBalances.length; i++) {
        const pre = preBalances[i] || 0
        const post = postBalances[i] || 0
        const change = (post - pre) / 1e9
        if (change > maxInflow) maxInflow = change
      }
      return maxInflow
    } catch (_) { return 0 }
  }

  private async fetchTransaction(
    signature: string,
    source: 'amm' | 'core' = 'amm',
    options: {
      attempts?: number
      retryDelayMs?: number
      bypassThrottle?: boolean
    } = {}
  ): Promise<any> {
    if (!this.connection) return null

    const cached = this.getCachedTransaction(signature)
    if (cached) return cached

    const inflight = this.txInFlight.get(signature)
    if (inflight) return inflight

    const promise = this.fetchTransactionUncached(signature, source, options)
    this.txInFlight.set(signature, promise)

    try {
      const tx = await promise
      if (tx) {
        this.txCache.set(signature, { tx, ts: Date.now() })
      }
      return tx
    } finally {
      this.txInFlight.delete(signature)
    }
  }

  private async fetchTransactionUncached(
    signature: string,
    source: 'amm' | 'core',
    options: {
      attempts?: number
      retryDelayMs?: number
      bypassThrottle?: boolean
    }
  ): Promise<any> {
    const bypassThrottle = options.bypassThrottle === true

    if (!bypassThrottle) {
      if (source === 'amm') {
        if (this.activeAmmFetches >= 4) return null
        this.activeAmmFetches++
      } else {
        if (this.activeCoreFetches >= 6) return null
        this.activeCoreFetches++
      }
    }

    try {
      const conn = this.getFetchConnection()
      const attempts = Math.max(1, options.attempts ?? 3)
      const retryDelayMs = Math.max(100, options.retryDelayMs ?? 1000)

      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt))
        }

        try {
          const tx = await conn.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          })
          if (tx) return tx
        } catch (_) {}
      }
    } finally {
      if (!bypassThrottle) {
        if (source === 'amm') this.activeAmmFetches--
        else this.activeCoreFetches--
      }
    }

    return null
  }

  private ammRateLimiter(): boolean {
    const now = Date.now()
    if (now - this.ammRateBucketStart > 60000) {
      this.ammSignalCount = 0
      this.ammRateBucketStart = now
    }
    if (this.ammSignalCount >= 10) return false
    this.ammSignalCount++
    return true
  }

  private emitSignal(signal: MarketSignal) {
    const now = Date.now()
    const key = getSignalCooldownKey(signal)
    const last = this.recentSignals.get(key) || 0
    if (now - last < this.signalCooldownMs) {
      this.emit('signal_skipped', {
        signal,
        reason: 'market_feed_cooldown',
        details: {
          cooldownKey: key,
          cooldownMs: this.signalCooldownMs,
          ageMs: now - last,
        },
        timestamp: now,
      })
      return
    }
    this.recentSignals.set(key, now)
    this.lastSignalAt = now

    // Add price point if we have price info
    if (signal.priceSol > 0) {
      this.addPricePoint(signal.mint, signal.priceSol)
    }

    console.log('[MarketFeed] SIGNAL: ' + signal.type + ' on ' + signal.mint.slice(0, 8) + '... (' + signal.liquiditySol.toFixed(2) + ' SOL liq)')
    this.emit('signal', signal)
  }

  private emitSignalSkip(
    signal: MarketSignal,
    reason: string,
    details: Record<string, any> = {}
  ): void {
    this.emit('signal_skipped', {
      signal,
      reason,
      details,
      timestamp: Date.now(),
    })
  }

  private getRecentAmmPoolHint(mint: string): RecentAmmPoolHint | null {
    const hint = this.recentAmmPoolHints.get(mint)
    if (!hint) return null
    if (Date.now() - hint.seenAt > RECENT_AMM_CACHE_TTL_MS) {
      this.recentAmmPoolHints.delete(mint)
      return null
    }
    return hint
  }

  private clearPendingMigrationState(key: string): void {
    this.pendingMigrationSignals.delete(key)
    this.pendingMigrationProcessing.delete(key)
    const timer = this.pendingMigrationExpiryTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.pendingMigrationExpiryTimers.delete(key)
    }
    const retryTimer = this.pendingMigrationRetryTimers.get(key)
    if (retryTimer) {
      clearTimeout(retryTimer)
      this.pendingMigrationRetryTimers.delete(key)
    }
  }

  private schedulePendingMigrationExpiry(key: string): void {
    const pending = this.pendingMigrationSignals.get(key)
    if (!pending) return

    const existingTimer = this.pendingMigrationExpiryTimers.get(key)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const delayMs = Math.max(0, pending.expiresAt - Date.now())
    const timer = setTimeout(() => {
      const currentPending = this.pendingMigrationSignals.get(key)
      if (!currentPending) return
      this.expirePendingMigration(key, currentPending)
    }, delayMs)
    this.pendingMigrationExpiryTimers.set(key, timer)
  }

  private schedulePendingMigrationRetry(key: string, pending: PendingMigrationSignal): void {
    const existingTimer = this.pendingMigrationRetryTimers.get(key)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const delayMs = Math.max(
      0,
      Math.min(this.pendingMigrationLifecycle.recheckMs, pending.expiresAt - Date.now())
    )
    const timer = setTimeout(() => {
      this.pendingMigrationRetryTimers.delete(key)
      void this.processPendingMigration(key)
    }, delayMs)
    this.pendingMigrationRetryTimers.set(key, timer)
  }

  private expirePendingMigration(key: string, pending: PendingMigrationSignal): void {
    if (
      this.migrationReadinessConfig.emitTxFallbackOnExpiry &&
      pending.signal.mint &&
      pending.signal.pool &&
      pending.signal.liquiditySol > 0
    ) {
      this.emitActionablePendingMigration(
        key,
        pending,
        Date.now(),
        'tx_fallback',
        { pool: pending.signal.pool }
      )
      return
    }

    this.emitSignalSkip(pending.signal, 'migration_pool_not_ready_in_feed', {
      pool: pending.signal.pool,
      detectedAt: pending.detectedAt,
      attempts: this.migrationReadinessConfig.attempts,
      intervalMs: this.migrationReadinessConfig.intervalMs,
      lookupTimeoutMs: this.migrationReadinessConfig.lookupTimeoutMs,
      ttlMs: this.pendingMigrationLifecycle.ttlMs,
    })
    this.clearPendingMigrationState(key)
  }

  private getFetchConnection(): Connection {
    if (this.fetchConnections.length === 0) return this.connection!
    const conn = this.fetchConnections[this.fetchIndex % this.fetchConnections.length]
    this.fetchIndex++
    return conn
  }

  private getCachedTransaction(signature: string): any | null {
    const cached = this.txCache.get(signature)
    if (!cached) return null
    if (Date.now() - cached.ts > TX_CACHE_TTL_MS) {
      this.txCache.delete(signature)
      return null
    }
    return cached.tx
  }
}
