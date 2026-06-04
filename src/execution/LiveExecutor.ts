// ============================================================================
// LiveExecutor — Real on-chain execution via PumpSwap SDK
// SDK handles ALL WSOL wrapping internally. WSOL ATA must be pre-funded once.
// Run scripts/ops/init_wsol_funded.mjs before first use.
// ============================================================================

import {
  Connection, Keypair, PublicKey,
  VersionedTransaction, TransactionInstruction, TransactionMessage, ComputeBudgetProgram,
} from '@solana/web3.js'
import {
  OnlinePumpAmmSdk, PUMP_AMM_SDK,
  buyQuoteInput as calculateBuyQuoteInput,
  pumpPoolAuthorityPda, poolPda, poolV2Pda, userVolumeAccumulatorPda, CANONICAL_POOL_INDEX,
} from '@pump-fun/pump-swap-sdk'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import BN from 'bn.js'
import bs58 from 'bs58'
import { v4 as uuidv4 } from 'uuid'
import { Genome, MarketSignal, Position, ClosedTrade } from '../types'
import { createSolanaConnection } from '../rpc/solanaConnection'
import {
  getLiveSignalWindow,
  resolveLiveBuySlippagePct,
  resolveLiveExecutionConfig,
  resolveLivePriorityMicro,
} from '../config/liveExecution'
import { getRecentPoolSwapState, rememberPoolSwapState } from '../market/poolStateCache'

const TX_FEE_SOL = 0.000025
const LAMPORTS = 1_000_000_000
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
const EXTEND_ACCOUNT_DISCRIMINATOR = Uint8Array.from([234, 102, 194, 203, 150, 72, 62, 229])
const PRICE_UPDATE_GUARD_MS = 5_000

type SettlementNetwork = 'devnet' | 'mainnet-beta'
type LandJobStatus = 'queued' | 'submitted' | 'confirmed' | 'finalized' | 'expired' | 'failed' | 'timed_out'

type SettlementRequestMetadata = {
  action: 'buy' | 'sell'
  mint: string
  strategyId?: string
  signalType?: MarketSignal['type']
  scenario?: string
  pool?: string
  reason?: string
}

type SettlementSendResult = {
  signature: string | null
  fallbackAllowed: boolean
  txForFallback: VersionedTransaction
}

export type WsolPoolSide = 'base' | 'quote'
export type StateRentBlockReason = 'ata_create' | 'pool_extend'
export type EntryTradabilityAssessment = {
  tradable: boolean
  reason: string | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTerminalLandStatus(
  status: string
): status is Extract<LandJobStatus, 'confirmed' | 'finalized' | 'expired' | 'failed' | 'timed_out'> {
  return ['confirmed', 'finalized', 'expired', 'failed', 'timed_out'].includes(status)
}

function inferSettlementNetwork(rpcUrl: string): SettlementNetwork {
  return rpcUrl.toLowerCase().includes('devnet') ? 'devnet' : 'mainnet-beta'
}

function normalizeApiUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value || '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseBooleanFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
}

export function getSignalPoolCandidates(signal: MarketSignal): string[] {
  const rawCandidates = [
    signal.pool,
    ...(Array.isArray(signal.eventData?.detectedPoolCandidates)
      ? signal.eventData.detectedPoolCandidates
      : []),
    typeof signal.eventData?.recentAmmPool === 'string' ? signal.eventData.recentAmmPool : undefined,
  ]

  return Array.from(
    new Set(rawCandidates.filter((pool): pool is string => typeof pool === 'string' && pool.length > 20))
  )
}

export function getExecutionPoolCandidates(signal: MarketSignal): string[] {
  const candidates = getSignalPoolCandidates(signal)

  // PumpSwap migration/create-pool instructions put the pool account first.
  // Retrying unrelated program, mint, and token accounts makes fresh pools age
  // out before the real pool has a fair chance to resolve.
  if (signal.type === 'migration') {
    return candidates.slice(0, 1)
  }

  return candidates
}

function accountExists(accountInfo: { owner?: PublicKey | null } | null | undefined, owner: PublicKey): boolean {
  return Boolean(accountInfo?.owner?.equals(owner))
}

function instructionMatchesDiscriminator(
  instruction: Pick<TransactionInstruction, 'data'>,
  discriminator: Uint8Array
): boolean {
  if (!instruction.data || instruction.data.length < discriminator.length) {
    return false
  }

  for (let i = 0; i < discriminator.length; i += 1) {
    if (instruction.data[i] !== discriminator[i]) {
      return false
    }
  }

  return true
}

export function detectStateRentBlockReason(
  instructions: Array<Pick<TransactionInstruction, 'programId' | 'data'>>
): StateRentBlockReason | null {
  return detectStateRentBlockReasons(instructions)[0] || null
}

export function detectStateRentBlockReasons(
  instructions: Array<Pick<TransactionInstruction, 'programId' | 'data'>>
): StateRentBlockReason[] {
  const reasons: StateRentBlockReason[] = []
  const addReason = (reason: StateRentBlockReason): void => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  for (const instruction of instructions) {
    if (instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      addReason('ata_create')
    }

    if (
      instruction.programId.equals(PUMP_AMM_PROGRAM_ID) &&
      instructionMatchesDiscriminator(instruction, EXTEND_ACCOUNT_DISCRIMINATOR)
    ) {
      addReason('pool_extend')
    }
  }

  return reasons
}

export function detectStateRentBlockReasonFromLogs(logs: string[] | null | undefined): StateRentBlockReason | null {
  return detectStateRentBlockReasonsFromLogs(logs)[0] || null
}

export function detectStateRentBlockReasonsFromLogs(logs: string[] | null | undefined): StateRentBlockReason[] {
  const reasons: StateRentBlockReason[] = []
  const addReason = (reason: StateRentBlockReason): void => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  if (!logs?.length) {
    return reasons
  }

  for (const line of logs) {
    if (line.includes('CreateIdempotent')) {
      addReason('ata_create')
    }

    if (line.includes('Instruction: ExtendAccount')) {
      addReason('pool_extend')
    }
  }

  return reasons
}

export function getWsolPoolSide(pool: {
  baseMint?: PublicKey | null
  quoteMint?: PublicKey | null
} | null | undefined): WsolPoolSide | null {
  if (pool?.quoteMint?.equals(WSOL_MINT)) {
    return 'quote'
  }

  if (pool?.baseMint?.equals(WSOL_MINT)) {
    return 'base'
  }

  return null
}

export class LiveExecutor {
  private connection: Connection
  private stateConnection: Connection
  private wallet: Keypair
  private pumpAmm: OnlinePumpAmmSdk
  private openPositions: Map<string, Position> = new Map()
  private positionTokens: Map<string, bigint> = new Map()
  private openMints: Set<string> = new Set()
  private lastRealPriceAt: Map<string, number> = new Map()
  private exiting: Set<string> = new Set()
  private mintTokenProgramCache: Map<string, PublicKey> = new Map()
  private settlementApiUrl: string
  private settlementTxreadyKey: string
  private settlementLandKey: string
  private settlementNetwork: SettlementNetwork
  private settlementConfirmationTarget: 'confirmed' | 'finalized'
  private settlementTimeoutSeconds: number
  private settlementPollIntervalMs: number
  private settlementHttpTimeoutMs: number
  private settlementShadowMode: boolean
  private settlementStrictMode: boolean
  private allowedStateRentReasons: Set<StateRentBlockReason>
  private liveConfig = resolveLiveExecutionConfig(process.env)
  private configuredTradeSizeSol: number
  private minBalanceSol: number
  private lastOpenFailureReason: string | null = null

  constructor() {
    const rpcUrl = (process.env.RPC_URLS || process.env.RPC_URL || '').split(',')[0].trim()
    if (!rpcUrl) throw new Error('[Live] RPC_URL not set')
    this.connection = createSolanaConnection(rpcUrl, 'confirmed')
    this.stateConnection = new Connection(rpcUrl, 'processed')
    this.pumpAmm = new OnlinePumpAmmSdk(this.stateConnection)

    const privateKey = process.env.PRIVATE_KEY || ''
    if (!privateKey) throw new Error('[Live] PRIVATE_KEY not set in env')
    this.wallet = privateKey.startsWith('[')
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(privateKey)))
      : Keypair.fromSecretKey(bs58.decode(privateKey))

    this.configuredTradeSizeSol = parsePositiveNumber(process.env.LIVE_TRADE_SIZE_SOL, 0.001)
    this.minBalanceSol = parsePositiveNumber(process.env.LIVE_MIN_BALANCE_SOL, 1.0)

    this.settlementApiUrl = normalizeApiUrl((process.env.SETTLEMENT_API_URL || '').trim())
    this.settlementTxreadyKey = (process.env.SETTLEMENT_TXREADY_API_KEY || '').trim()
    this.settlementLandKey = (process.env.SETTLEMENT_LAND_API_KEY || '').trim()
    this.settlementNetwork =
      process.env.SETTLEMENT_NETWORK === 'devnet' || process.env.SETTLEMENT_NETWORK === 'mainnet-beta'
        ? process.env.SETTLEMENT_NETWORK
        : inferSettlementNetwork(rpcUrl)
    this.settlementConfirmationTarget =
      (process.env.SETTLEMENT_CONFIRMATION_TARGET || 'confirmed') === 'finalized'
        ? 'finalized'
        : 'confirmed'
    this.settlementTimeoutSeconds = Number.parseInt(process.env.SETTLEMENT_TIMEOUT_SECONDS || '45', 10) || 45
    this.settlementPollIntervalMs = Number.parseInt(process.env.SETTLEMENT_POLL_INTERVAL_MS || '1200', 10) || 1200
    this.settlementHttpTimeoutMs = Number.parseInt(process.env.SETTLEMENT_HTTP_TIMEOUT_MS || '15000', 10) || 15000
    this.settlementShadowMode = parseBooleanFlag(process.env.DARWIN_SETTLEMENT_SHADOW_MODE)
    this.settlementStrictMode = parseBooleanFlag(process.env.DARWIN_SETTLEMENT_STRICT)
    this.allowedStateRentReasons = new Set<StateRentBlockReason>()
    if (parseBooleanFlag(process.env.DARWIN_LIVE_ALLOW_ATA_CREATE)) {
      this.allowedStateRentReasons.add('ata_create')
    }
    if (parseBooleanFlag(process.env.DARWIN_LIVE_ALLOW_POOL_EXTEND)) {
      this.allowedStateRentReasons.add('pool_extend')
    }

    console.log('[Live] Executor ready. Wallet:', this.wallet.publicKey.toBase58())
    console.log('[Live] Trade size:', this.configuredTradeSizeSol, 'SOL | Floor:', this.minBalanceSol, 'SOL')
    if (this.isSettlementEnabled()) {
      console.log('[Live] Settlement routing enabled:', this.settlementApiUrl, '| network:', this.settlementNetwork)
      console.log(
        '[Live] Settlement mode:',
        this.settlementStrictMode ? 'strict (no direct-RPC fallback)' : 'best-effort (fallback before submit only)'
      )
      if (this.settlementShadowMode) {
        console.log('[Live] Settlement shadow mode enabled: optimize/simulate only, no submit')
      }
    } else {
      console.log('[Live] Settlement routing disabled (using direct RPC sendRawTransaction).')
    }
    if (this.allowedStateRentReasons.size > 0) {
      console.log('[Live] Allowed state-rent setup:', Array.from(this.allowedStateRentReasons).join(','))
    }
  }

  async open(
    signal: MarketSignal,
    genome: Genome,
    strategyId: string,
    sizeSol: number,
    entryPrice: number
  ): Promise<Position | null> {
    try {
      this.lastOpenFailureReason = null
      if (sizeSol <= 0) {
        return null
      }

      if (this.openMints.has(signal.mint)) {
        return null
      }

      if (!(await this.waitForLiveEntryWindow(signal, 'before_buy'))) {
        return null
      }

      const mint = new PublicKey(signal.mint)
      const user = this.wallet.publicKey
      if (!signal.pool || signal.pool.length <= 20) {
        this.lastOpenFailureReason = 'live_pool_not_ready_post_feed'
        return null
      }

      const poolCandidates = getExecutionPoolCandidates(signal)
      if (poolCandidates.length === 0) {
        this.lastOpenFailureReason = 'live_pool_not_ready_post_feed'
        return null
      }
      const signalPool = new PublicKey(poolCandidates[0])
      const isMigration = signal.type === 'migration'
      const poolsToTry = poolCandidates.map((pool) => new PublicKey(pool))

      let swapState: any = null
      let selectedPool: PublicKey | null = null
      let wsolPoolSide: WsolPoolSide | null = null
      const cachedSwapState = getRecentPoolSwapState(signalPool.toBase58())
      const cachedWsolPoolSide = getWsolPoolSide((cachedSwapState as any)?.pool)
      if (cachedSwapState && cachedWsolPoolSide) {
        swapState = cachedSwapState
        selectedPool = signalPool
        wsolPoolSide = cachedWsolPoolSide
      }

      const maxAttempts = isMigration ? this.liveConfig.migrationPoolRetryAttempts : 1
      for (let attempt = 0; !swapState && attempt < maxAttempts; attempt++) {
        if (!(await this.waitForLiveEntryWindow(signal, 'before_pool_lookup'))) {
          return null
        }

        if (attempt > 0) {
          await sleep(this.liveConfig.migrationPoolRetryDelayMs)
        }

        let found = false
        for (const tryPool of poolsToTry) {
          try {
            const state = await Promise.race<any | null>([
              this.pumpAmm.swapSolanaState(tryPool, user),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), this.liveConfig.poolLookupTimeoutMs)),
            ])
            const resolvedWsolPoolSide = getWsolPoolSide((state as any)?.pool)
            if (state && resolvedWsolPoolSide) {
              swapState = state
              selectedPool = tryPool
              wsolPoolSide = resolvedWsolPoolSide
              rememberPoolSwapState(tryPool.toBase58(), state)
              found = true
              break
            }
          } catch (_) {}
        }

        if (found) break
        if (isMigration && attempt < maxAttempts - 1) {
          console.log(
            `[Live] Pool not ready yet for ${signal.mint.slice(0, 8)}, retry ${attempt + 1}/${maxAttempts - 1}...`
          )
        }
      }

      if (!swapState || !selectedPool || !wsolPoolSide) {
        this.lastOpenFailureReason = 'live_pool_not_ready_post_feed'
        return null
      }

      if (signal.type !== 'migration' && !selectedPool.equals(signalPool)) {
        console.log(
          '[Live] strategy invariant abort: non-migration signal resolved through unexpected pool | mint:',
          signal.mint.slice(0, 8),
          '| signalPool:',
          signalPool.toBase58().slice(0, 8),
          '| selectedPool:',
          selectedPool.toBase58().slice(0, 8)
        )
        return null
      }

      if (!(await this.waitForLiveEntryWindow(signal, 'before_build'))) {
        return null
      }

      const balanceSol = (await this.connection.getBalance(this.wallet.publicKey)) / LAMPORTS
      if (balanceSol < this.minBalanceSol + sizeSol) {
        console.log('[Live] Balance', balanceSol.toFixed(4), 'SOL below floor — skipping')
        return null
      }

      this.openMints.add(signal.mint)

      const lamportsIn = Math.floor(sizeSol * LAMPORTS)
      const buySlippagePct = resolveLiveBuySlippagePct(signal.type, this.liveConfig)
      const ixs = wsolPoolSide === 'quote'
        ? await (PUMP_AMM_SDK as any).buyQuoteInput(
            swapState,
            new BN(lamportsIn),
            buySlippagePct
          )
        : await (PUMP_AMM_SDK as any).sellBaseInput(
            swapState,
            new BN(lamportsIn),
            buySlippagePct
          )

      if (!ixs || ixs.length === 0) {
        this.openMints.delete(signal.mint)
        console.log('[Live] No buy ixs for', signal.mint.slice(0, 8))
        return null
      }

      const ixDetails = ixs
        .map((ix: any, index: number) => index + ':' + ix.programId.toBase58().slice(0, 12))
        .join(' ')
      console.log(
        '[Live] settlement trace:',
        'action=buy',
        '| mint:',
        signal.mint.slice(0, 8),
        '| signalType:',
        signal.type,
        '| strategyId:',
        strategyId.slice(-8),
        '| signalPool:',
        signalPool.toBase58().slice(0, 8),
        '| selectedPool:',
        selectedPool.toBase58().slice(0, 8),
        '| wsolSide:',
        wsolPoolSide,
        '| sizeSol:',
        sizeSol.toFixed(6)
      )
      console.log(
        '[Live] BUY',
        signal.mint.slice(0, 8),
        '| SDK ixs:',
        ixs.length,
        '| slippage:',
        buySlippagePct,
        '| ixs:',
        ixDetails
      )

      const signature = await this.buildAndSend(ixs, {
        action: 'buy',
        mint: signal.mint,
        strategyId,
        signalType: signal.type,
        scenario: `${signal.type}-buy`,
        pool: selectedPool.toBase58(),
      })
      if (!signature) {
        this.lastOpenFailureReason = this.lastOpenFailureReason || 'buy_not_sent'
        this.openMints.delete(signal.mint)
        return null
      }

      console.log('[Live] BUY TX:', signature.slice(0, 20), '...')
      const confirmation = await this.connection.confirmTransaction(signature, 'confirmed')
      if (confirmation.value.err) {
        this.openMints.delete(signal.mint)
        console.log('[Live] BUY FAILED on-chain:', confirmation.value.err)
        return null
      }
      console.log('[Live] BUY CONFIRMED:', signal.mint.slice(0, 8))

      const tokenAta = await this.getUserTokenAta(mint, user)
      const tokensReceived = await this.safeGetTokenBalance(tokenAta)
      const position: Position = {
        id: uuidv4(),
        strategyId,
        genomeId: genome.id,
        mint: signal.mint,
        pool: selectedPool.toBase58(),
        entryPriceSol: entryPrice,
        sizeSol: Math.max(sizeSol - TX_FEE_SOL, 0.000001),
        openedAt: Date.now(),
        peakPriceSol: entryPrice,
        lowestPriceSol: entryPrice,
        isPaper: false,
        poolLiqSol: signal.liquiditySol,
        signalType: signal.type,
        entrySignature: signature,
      }

      this.positionTokens.set(position.id, tokensReceived)
      this.openPositions.set(position.id, position)
      console.log(
        '[Live] Position opened:',
        position.id.slice(0, 8),
        '| token:',
        signal.mint.slice(0, 8),
        '| tokens received:',
        tokensReceived.toString()
      )
      return position
    } catch (error: any) {
      this.lastOpenFailureReason = this.lastOpenFailureReason || 'live_execution_error'
      this.openMints.delete(signal.mint)
      console.log('[Live] open() error:', error?.message?.slice(0, 200) || error)
      return null
    }
  }

  async assessEntryTradability(signal: MarketSignal, sizeSol: number): Promise<EntryTradabilityAssessment> {
    this.lastOpenFailureReason = null

    if (sizeSol <= 0) {
      this.lastOpenFailureReason = 'invalid_size'
      return { tradable: false, reason: this.lastOpenFailureReason }
    }

    if (this.openMints.has(signal.mint)) {
      this.lastOpenFailureReason = 'mint_already_open'
      return { tradable: false, reason: this.lastOpenFailureReason }
    }

    if (!(await this.waitForLiveEntryWindow(signal, 'before_buy'))) {
      this.lastOpenFailureReason = this.lastOpenFailureReason || 'signal_not_ready'
      return { tradable: false, reason: this.lastOpenFailureReason }
    }

    const user = this.wallet.publicKey
    if (!signal.pool || signal.pool.length <= 20) {
      this.lastOpenFailureReason = 'live_pool_not_ready_post_feed'
      return { tradable: false, reason: this.lastOpenFailureReason }
    }

    const poolCandidates = getExecutionPoolCandidates(signal)
    if (poolCandidates.length === 0) {
      this.lastOpenFailureReason = 'live_pool_not_ready_post_feed'
      return { tradable: false, reason: this.lastOpenFailureReason }
    }

    const signalPool = new PublicKey(poolCandidates[0])
    const isMigration = signal.type === 'migration'
    const poolsToTry = poolCandidates.map((pool) => new PublicKey(pool))

    let swapState: any = null
    let wsolPoolSide: WsolPoolSide | null = null
    const cachedSwapState = getRecentPoolSwapState(signalPool.toBase58())
    const cachedWsolPoolSide = getWsolPoolSide((cachedSwapState as any)?.pool)
    if (cachedSwapState && cachedWsolPoolSide) {
      swapState = cachedSwapState
      wsolPoolSide = cachedWsolPoolSide
    }

    const maxAttempts = isMigration ? this.liveConfig.migrationPoolRetryAttempts : 1
    for (let attempt = 0; !swapState && attempt < maxAttempts; attempt += 1) {
      if (!(await this.waitForLiveEntryWindow(signal, 'before_pool_lookup'))) {
        this.lastOpenFailureReason = this.lastOpenFailureReason || 'signal_not_ready'
        return { tradable: false, reason: this.lastOpenFailureReason }
      }

      if (attempt > 0) {
        await sleep(this.liveConfig.migrationPoolRetryDelayMs)
      }

      for (const tryPool of poolsToTry) {
        try {
          const state = await Promise.race<any | null>([
            this.pumpAmm.swapSolanaState(tryPool, user),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), this.liveConfig.poolLookupTimeoutMs)),
          ])
          const resolvedWsolPoolSide = getWsolPoolSide((state as any)?.pool)
          if (state && resolvedWsolPoolSide) {
            swapState = state
            wsolPoolSide = resolvedWsolPoolSide
            rememberPoolSwapState(tryPool.toBase58(), state)
            break
          }
        } catch {}
      }
    }

    if (!swapState || !wsolPoolSide) {
      this.lastOpenFailureReason = 'live_pool_not_ready_post_feed'
      return { tradable: false, reason: this.lastOpenFailureReason }
    }

    if (!(await this.waitForLiveEntryWindow(signal, 'before_build'))) {
      this.lastOpenFailureReason = this.lastOpenFailureReason || 'signal_not_ready'
      return { tradable: false, reason: this.lastOpenFailureReason }
    }

    const balanceSol = (await this.connection.getBalance(this.wallet.publicKey)) / LAMPORTS
    if (balanceSol < this.minBalanceSol + sizeSol) {
      this.lastOpenFailureReason = 'insufficient_balance'
      return { tradable: false, reason: this.lastOpenFailureReason }
    }

    const lamportsIn = Math.floor(sizeSol * LAMPORTS)
    const buySlippagePct = resolveLiveBuySlippagePct(signal.type, this.liveConfig)
    const ixs = wsolPoolSide === 'quote'
      ? await (PUMP_AMM_SDK as any).buyQuoteInput(
          swapState,
          new BN(lamportsIn),
          buySlippagePct
        )
      : await (PUMP_AMM_SDK as any).sellBaseInput(
          swapState,
          new BN(lamportsIn),
          buySlippagePct
        )

    if (!ixs || ixs.length === 0) {
      this.lastOpenFailureReason = 'no_buy_ixs'
      return { tradable: false, reason: this.lastOpenFailureReason }
    }

    const stateRentBlockReason = this.findDisallowedStateRentBlockReason(detectStateRentBlockReasons(ixs))
    if (stateRentBlockReason) {
      this.lastOpenFailureReason = `state_rent_blocked:${stateRentBlockReason}`
      return { tradable: false, reason: this.lastOpenFailureReason }
    }

    return { tradable: true, reason: null }
  }

  tick(currentPrices: Map<string, number>, genomes: Map<string, Genome>): ClosedTrade[] {
    const closed: ClosedTrade[] = []
    const now = Date.now()

    for (const [positionId, position] of this.openPositions) {
      if (this.exiting.has(positionId)) continue
      const genome = genomes.get(position.genomeId)
      if (!genome) continue

      const rawPrice = currentPrices.get(position.mint)
      if (rawPrice !== undefined && rawPrice > 0) {
        if (rawPrice > position.peakPriceSol) position.peakPriceSol = rawPrice
        if (rawPrice < position.lowestPriceSol) position.lowestPriceSol = rawPrice
        this.lastRealPriceAt.set(positionId, now)
      }

      const currentPrice = rawPrice && rawPrice > 0 ? rawPrice : position.entryPriceSol
      const lastUpdate = this.lastRealPriceAt.get(positionId) || 0
      const hadPrice = lastUpdate > 0 && lastUpdate > position.openedAt + PRICE_UPDATE_GUARD_MS

      const holdMs = now - position.openedAt
      const pricePct = (currentPrice - position.entryPriceSol) / position.entryPriceSol
      const peakPct = (position.peakPriceSol - position.entryPriceSol) / position.entryPriceSol
      const exit = genome.exit
      let exitReason = ''

      if (hadPrice && pricePct >= exit.takeProfitPct) exitReason = 'take_profit'
      else if (hadPrice && peakPct >= exit.trailingActivatePct) {
        if (currentPrice <= position.peakPriceSol * (1 - exit.trailingDistancePct)) {
          exitReason = 'trailing_stop'
        }
      } else if (holdMs >= exit.timeStopMs) exitReason = 'time_stop'
      else if (hadPrice && holdMs >= exit.noPumpBailMs && pricePct < 0.02) exitReason = 'no_pump_bail'
      else if (hadPrice && peakPct >= 0.05) {
        if ((position.peakPriceSol - currentPrice) / position.peakPriceSol >= exit.fadeGivebackPct) {
          exitReason = 'fade_exit'
        }
      }

      if (exitReason) {
        this.exiting.add(positionId)
        const pnlPct = Math.max(-1.0, Math.min(pricePct, 100.0))
        const trade: ClosedTrade = {
          id: uuidv4(),
          strategyId: position.strategyId,
          genomeId: position.genomeId,
          mint: position.mint,
          pool: position.pool,
          entryPriceSol: position.entryPriceSol,
          exitPriceSol: currentPrice,
          sizeSol: position.sizeSol,
          pnlSol: (position.sizeSol * pnlPct) - TX_FEE_SOL,
          pnlPct,
          mfePct: Math.min(peakPct, 100.0),
          maePct: Math.max(
            (position.lowestPriceSol - position.entryPriceSol) / position.entryPriceSol,
            -1.0
          ),
          exitReason,
          openedAt: position.openedAt,
          closedAt: now,
          holdMs,
          isPaper: false,
          signalType: position.signalType,
          poolLiqSol: position.poolLiqSol,
          desiredSizeSol: position.desiredSizeSol,
          cappedSizeSol: position.cappedSizeSol,
          poolCapSol: position.poolCapSol,
          fillRatio: position.fillRatio,
        }
        this.openPositions.delete(positionId)
        this.lastRealPriceAt.delete(positionId)
        this.sellToken(position, exitReason, positionId).catch((error) =>
          console.log('[Live] sell error:', error?.message || error)
        )
        closed.push(trade)
      }
    }

    return closed
  }

  private async sellToken(position: Position, reason: string, positionId: string): Promise<string | null> {
    try {
      const mintPk = new PublicKey(position.mint)
      const user = this.wallet.publicKey
      const tokenAta = await this.getUserTokenAta(mintPk, user)
      const positionTokens = this.positionTokens.get(positionId) ?? 0n
      const onChainTokens = await this.safeGetTokenBalance(tokenAta)
      const amount = onChainTokens > 0n ? onChainTokens : positionTokens
      if (amount === 0n) {
        console.log('[Live] No token balance to sell:', position.mint.slice(0, 8))
        return null
      }

      const poolPk = (position.pool && position.pool.length > 20)
        ? new PublicKey(position.pool)
        : poolPda(CANONICAL_POOL_INDEX, pumpPoolAuthorityPda(mintPk), mintPk, WSOL_MINT)
      const swapState = await this.pumpAmm.swapSolanaState(poolPk, user)
      const wsolPoolSide = getWsolPoolSide((swapState as any)?.pool)
      const ixs = wsolPoolSide === 'base'
        ? await this.buildQuoteExactInSellInstructions(swapState, amount)
        : await (PUMP_AMM_SDK as any).sellBaseInput(
            swapState,
            new BN(amount.toString()),
            this.liveConfig.sellSlippagePct
          )
      if (!ixs || ixs.length === 0) {
        console.log('[Live] No sell ixs:', position.mint.slice(0, 8))
        return null
      }

      const signature = await this.buildAndSend(ixs, {
        action: 'sell',
        mint: position.mint,
        strategyId: position.strategyId,
        signalType: position.signalType,
        scenario: `${position.signalType}-sell`,
        pool: position.pool,
        reason,
      })
      if (!signature) {
        console.log('[Live] Sell TX failed:', position.mint.slice(0, 8))
        return null
      }

      console.log(
        '[Live] SELL TX:',
        signature.slice(0, 20),
        '... |',
        position.mint.slice(0, 8),
        '| reason:',
        reason
      )
      const confirmation = await this.connection.confirmTransaction(signature, 'confirmed')
      if (confirmation.value.err) {
        console.log('[Live] SELL FAILED on-chain:', confirmation.value.err)
      } else {
        console.log('[Live] SELL CONFIRMED:', position.mint.slice(0, 8))
      }
      return signature
    } catch (error: any) {
      console.log('[Live] sellToken error:', error?.message?.slice(0, 200) || error)
      return null
    } finally {
      this.positionTokens.delete(positionId)
      this.openMints.delete(position.mint)
      this.exiting.delete(positionId)
    }
  }

  private async buildAndSend(
    ixs: any[],
    metadata: SettlementRequestMetadata
  ): Promise<string | null> {
    try {
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed')
      const settlementEnabled = this.isSettlementEnabled()
      const instructions = settlementEnabled
        ? ixs
        : [
            ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: resolveLivePriorityMicro(
                metadata.action,
                metadata.signalType,
                this.liveConfig
              ),
            }),
            ...ixs,
          ]
      const stateRentBlockReason = this.findDisallowedStateRentBlockReason(detectStateRentBlockReasons(instructions))
      if (stateRentBlockReason) {
        this.lastOpenFailureReason = `state_rent_blocked:${stateRentBlockReason}`
        console.log(
          '[Live] Abort trade due to state-rent preflight block:',
          stateRentBlockReason,
          '| action:',
          metadata.action,
          '| mint:',
          metadata.mint.slice(0, 8)
        )
        return null
      }
      const message = new TransactionMessage({
        payerKey: this.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message()
      const unsignedTx = new VersionedTransaction(message)

      if (settlementEnabled) {
        const settlementResult = await this.sendWithSettlement(unsignedTx, metadata)
        if (settlementResult.signature) {
          return settlementResult.signature
        }

        if (!settlementResult.fallbackAllowed) {
          console.log(
            '[Live] Settlement path failed after submit or strict mode blocked fallback for',
            metadata.action,
            metadata.mint.slice(0, 8)
          )
          return null
        }

        console.log(
          '[Live] Settlement unavailable before submit; falling back to direct RPC for',
          metadata.action,
          metadata.mint.slice(0, 8)
        )
        settlementResult.txForFallback.sign([this.wallet])
        return await this.connection.sendRawTransaction(settlementResult.txForFallback.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        })
      }

      const preflight = await this.shadowValidateTransaction(unsignedTx, metadata)
      if (preflight.blockedByStateRent) {
        this.lastOpenFailureReason = `state_rent_blocked:${preflight.blockedByStateRent}`
        console.log(
          '[Live] Abort trade due to simulated state-rent preflight block:',
          preflight.blockedByStateRent,
          '| action:',
          metadata.action,
          '| mint:',
          metadata.mint.slice(0, 8)
        )
        return null
      }

      if (!preflight.ok) {
        this.lastOpenFailureReason = 'direct_rpc_preflight_failed'
        console.log(
          '[Live] Direct-RPC preflight failed for',
          metadata.action,
          metadata.mint.slice(0, 8),
          '|',
          preflight.err || 'unknown'
        )
        return null
      }

      return await this.connection.sendRawTransaction(unsignedTx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      })
    } catch (error: any) {
      console.log('[Live] buildAndSend error:', error?.message?.slice(0, 300) || error)
      return null
    }
  }

  private isSettlementEnabled(): boolean {
    return Boolean(this.settlementApiUrl && this.settlementLandKey)
  }

  private findDisallowedStateRentBlockReason(reasons: StateRentBlockReason[]): StateRentBlockReason | null {
    return reasons.find((reason) => !this.allowedStateRentReasons.has(reason)) || null
  }

  private async sendWithSettlement(
    unsignedTx: VersionedTransaction,
    metadata: SettlementRequestMetadata
  ): Promise<SettlementSendResult> {
    let txToSign = unsignedTx
    let optimizedApplied = false

    try {
      if (this.settlementTxreadyKey) {
        const optimized = await this.optimizeViaSettlement(unsignedTx, metadata)
        if (optimized) {
          txToSign = optimized
          optimizedApplied = true
        }
      }

      let shadowResult = await this.shadowValidateTransaction(txToSign, metadata)
      if (!shadowResult.ok && optimizedApplied) {
        console.log(
          '[Live] optimized settlement tx invalid in shadow preflight; retrying original unsigned tx:',
          shadowResult.err || 'unknown'
        )
        txToSign = unsignedTx
        shadowResult = await this.shadowValidateTransaction(txToSign, metadata)
      }

      if (shadowResult.blockedByStateRent) {
        this.lastOpenFailureReason = `state_rent_blocked:${shadowResult.blockedByStateRent}`
        throw new Error(`state_rent_blocked:${shadowResult.blockedByStateRent}`)
      }

      if (!shadowResult.ok) {
        this.lastOpenFailureReason = 'settlement_shadow_preflight_failed'
        throw new Error(shadowResult.err || 'settlement shadow simulation failed')
      }

      if (this.settlementShadowMode) {
        return { signature: null, fallbackAllowed: false, txForFallback: txToSign }
      }

      txToSign.sign([this.wallet])
      const signedBase64 = Buffer.from(txToSign.serialize()).toString('base64')
      const submitResponse = await this.fetchWithTimeout(`${this.settlementApiUrl}/v1/land/submit`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.settlementLandKey,
        },
        body: JSON.stringify({
          transaction: signedBase64,
          network: this.settlementNetwork,
          confirmationTarget: this.settlementConfirmationTarget,
          executionMode: 'immediate',
          timeoutSeconds: this.settlementTimeoutSeconds,
          metadata: this.buildSettlementMetadata(metadata, 'live'),
        }),
      })

      if (!submitResponse.ok) {
        console.log(`[Live] land/submit ${submitResponse.status}: ${await submitResponse.text()}`)
        return {
          signature: null,
          fallbackAllowed: !this.settlementStrictMode,
          txForFallback: txToSign,
        }
      }

      const submitData = await submitResponse.json() as {
        job?: { id?: string; signature?: string | null; status?: LandJobStatus; error?: string | null }
      }
      const jobId = submitData.job?.id
      if (!jobId) {
        console.log('[Live] land/submit response missing job id')
        return {
          signature: null,
          fallbackAllowed: !this.settlementStrictMode,
          txForFallback: txToSign,
        }
      }

      console.log(
        '[Live] settlement submitted:',
        jobId,
        '| status:',
        submitData.job?.status || 'unknown',
        '| signature:',
        submitData.job?.signature || 'pending'
      )

      const immediateStatus = submitData.job?.status
      if (immediateStatus && isTerminalLandStatus(immediateStatus)) {
        if (immediateStatus === 'confirmed' || immediateStatus === 'finalized') {
          const signature = submitData.job?.signature || null
          console.log(
            '[Live] settlement confirmed:',
            jobId,
            '| status:',
            immediateStatus,
            '| signature:',
            signature || 'missing'
          )
          return {
            signature,
            fallbackAllowed: false,
            txForFallback: txToSign,
          }
        }

        console.log(
          '[Live] settlement failed terminally:',
          jobId,
          '| status:',
          immediateStatus,
          '| error:',
          submitData.job?.error || 'n/a'
        )
        return {
          signature: null,
          fallbackAllowed: false,
          txForFallback: txToSign,
        }
      }

      return await this.pollSettlementJob(jobId, txToSign)
    } catch (error: any) {
      console.log(
        '[Live] settlement failed before terminal confirmation:',
        error?.message?.slice(0, 400) || String(error)
      )
      return {
        signature: null,
        fallbackAllowed: !this.settlementStrictMode,
        txForFallback: txToSign,
      }
    }
  }

  private async optimizeViaSettlement(
    unsignedTx: VersionedTransaction,
    metadata: SettlementRequestMetadata
  ): Promise<VersionedTransaction | null> {
    try {
      const unsignedBase64 = Buffer.from(unsignedTx.serialize()).toString('base64')
      const optimizeResponse = await this.fetchWithTimeout(`${this.settlementApiUrl}/v1/txready/optimize`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.settlementTxreadyKey,
        },
        body: JSON.stringify({
          transaction: unsignedBase64,
          network: this.settlementNetwork,
          metadata: this.buildSettlementMetadata(
            metadata,
            this.settlementShadowMode ? 'shadow' : 'live'
          ),
        }),
      })

      if (!optimizeResponse.ok) {
        console.log(
          '[Live] txready optimize failed, continuing with original unsigned tx:',
          await optimizeResponse.text()
        )
        return null
      }

      const optimizeData = await optimizeResponse.json() as { optimizedTransaction?: string }
      if (!optimizeData.optimizedTransaction) {
        console.log('[Live] txready optimize response missing optimizedTransaction')
        return null
      }

      return VersionedTransaction.deserialize(
        Buffer.from(optimizeData.optimizedTransaction, 'base64')
      )
    } catch (error: any) {
      console.log('[Live] txready optimize error, continuing with original unsigned tx:', error?.message || error)
      return null
    }
  }

  private buildSettlementMetadata(metadata: SettlementRequestMetadata, mode: 'live' | 'shadow') {
    return {
      source: mode === 'shadow' ? 'darwin-shadow' : 'darwin-live',
      action: metadata.action,
      mint: metadata.mint,
      strategyId: metadata.strategyId || 'unknown',
      signalType: metadata.signalType || 'unknown',
      scenario: metadata.scenario || `${metadata.action}-${metadata.signalType || 'unknown'}`,
      client: 'darwin',
      mode,
      ...(metadata.pool ? { pool: metadata.pool } : {}),
      ...(metadata.reason ? { reason: metadata.reason } : {}),
    }
  }

  private async shadowValidateTransaction(
    txToSign: VersionedTransaction,
    metadata: SettlementRequestMetadata
  ): Promise<{ ok: boolean; err: string | null; blockedByStateRent: StateRentBlockReason | null }> {
    txToSign.sign([this.wallet])
    const simulation = await this.connection.simulateTransaction(txToSign, {
      commitment: 'processed',
      replaceRecentBlockhash: false,
      sigVerify: true,
    })
    const blockedByStateRent = this.findDisallowedStateRentBlockReason(
      detectStateRentBlockReasonsFromLogs(simulation.value.logs)
    )

    console.log(
      '[Live] settlement shadow result:',
      'action:',
      metadata.action,
      '| mint:',
      metadata.mint.slice(0, 8),
      '| scenario:',
      metadata.scenario || 'unknown',
      '| units:',
      simulation.value.unitsConsumed ?? 'n/a',
      '| err:',
      simulation.value.err ? JSON.stringify(simulation.value.err) : 'none'
    )
    if (simulation.value.err && simulation.value.logs?.length) {
      console.log('[Live] settlement shadow logs:')
      for (const line of simulation.value.logs.slice(0, 20)) {
        console.log('[Live]  ', line)
      }
    }

    return {
      ok: !simulation.value.err,
      err: simulation.value.err ? JSON.stringify(simulation.value.err) : null,
      blockedByStateRent,
    }
  }

  private async pollSettlementJob(
    jobId: string,
    txForFallback: VersionedTransaction
  ): Promise<SettlementSendResult> {
    const deadline = Date.now() + (this.settlementTimeoutSeconds * 1000) + 5_000
    while (Date.now() < deadline) {
      try {
        const jobResponse = await this.fetchWithTimeout(`${this.settlementApiUrl}/v1/land/jobs/${jobId}`, {
          headers: {
            'x-api-key': this.settlementLandKey,
          },
        })

        if (jobResponse.ok) {
          const data = await jobResponse.json() as {
            job?: { status?: LandJobStatus; signature?: string | null; error?: string | null }
          }
          const status = data.job?.status
          if (status && isTerminalLandStatus(status)) {
            if (status === 'confirmed' || status === 'finalized') {
              const signature = data.job?.signature || null
              console.log(
                '[Live] settlement confirmed:',
                jobId,
                '| status:',
                status,
                '| signature:',
                signature || 'missing'
              )
              return {
                signature,
                fallbackAllowed: false,
                txForFallback,
              }
            }

            console.log(
              '[Live] settlement failed terminally:',
              jobId,
              '| status:',
              status,
              '| error:',
              data.job?.error || 'n/a'
            )
            return {
              signature: null,
              fallbackAllowed: false,
              txForFallback,
            }
          }
        }
      } catch (error: any) {
        console.log('[Live] settlement job poll error:', error?.message || error)
      }

      await sleep(this.settlementPollIntervalMs)
    }

    console.log(
      '[Live] settlement failed terminally:',
      jobId,
      '| status: timed_out | error: polling deadline exceeded'
    )
    return {
      signature: null,
      fallbackAllowed: false,
      txForFallback,
    }
  }

  private async fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.settlementHttpTimeoutMs)
    try {
      return await fetch(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private async waitForLiveEntryWindow(
    signal: MarketSignal,
    phase: 'before_buy' | 'before_pool_lookup' | 'before_build'
  ): Promise<boolean> {
    const signalWindow = getLiveSignalWindow(signal, this.liveConfig)
    if (signalWindow.status === 'stale') {
      console.log(
        '[Live] Skip stale signal:',
        signal.mint.slice(0, 8),
        '| phase:',
        phase,
        '| ageMs:',
        signalWindow.ageMs,
        '| maxAgeMs:',
        signalWindow.maxAgeMs
      )
      return false
    }

    if (signalWindow.status === 'too_early') {
      console.log(
        '[Live] Waiting for signal readiness:',
        signal.mint.slice(0, 8),
        '| phase:',
        phase,
        '| waitMs:',
        signalWindow.waitMs
      )
      await sleep(signalWindow.waitMs)

      const postWaitWindow = getLiveSignalWindow(signal, this.liveConfig)
      if (postWaitWindow.status !== 'ready') {
        console.log(
          '[Live] Skip signal after readiness wait:',
          signal.mint.slice(0, 8),
          '| phase:',
          phase,
          '| status:',
          postWaitWindow.status,
          '| ageMs:',
          postWaitWindow.ageMs
        )
        return false
      }
    }

    return true
  }

  private async safeGetTokenBalance(ata: PublicKey): Promise<bigint> {
    try {
      return BigInt((await this.connection.getTokenAccountBalance(ata)).value.amount)
    } catch {
      return 0n
    }
  }

  private async resolveMintTokenProgramId(mint: PublicKey): Promise<PublicKey> {
    const cacheKey = mint.toBase58()
    const cached = this.mintTokenProgramCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const accountInfo = await this.connection.getAccountInfo(mint, 'confirmed')
    const programId = accountInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID
    this.mintTokenProgramCache.set(cacheKey, programId)
    return programId
  }

  private async getUserTokenAta(mint: PublicKey, user: PublicKey): Promise<PublicKey> {
    const tokenProgramId = await this.resolveMintTokenProgramId(mint)
    return getAssociatedTokenAddressSync(mint, user, false, tokenProgramId)
  }

  private async buildQuoteExactInSellInstructions(swapState: any, exactQuoteAmount: bigint): Promise<TransactionInstruction[]> {
    const sdk = PUMP_AMM_SDK as any
    const swapAccounts = sdk.swapAccounts(swapState)
    const {
      user,
      baseMint,
      quoteMint,
      userBaseTokenAccount,
      userQuoteTokenAccount,
      baseTokenProgram,
      quoteTokenProgram,
    } = swapAccounts
    const { pool, userBaseAccountInfo, userQuoteAccountInfo } = swapState
    const spendableQuoteIn = new BN(exactQuoteAmount.toString())
    const { base } = calculateBuyQuoteInput({
      quote: spendableQuoteIn,
      slippage: this.liveConfig.sellSlippagePct,
      baseReserve: swapState.poolBaseAmount,
      quoteReserve: swapState.poolQuoteAmount,
      globalConfig: swapState.globalConfig,
      baseMintAccount: swapState.baseMintAccount,
      baseMint: swapState.baseMint,
      coinCreator: pool.coinCreator,
      creator: pool.creator,
      feeConfig: swapState.feeConfig,
    })
    const precision = new BN(1_000_000_000)
    const slippageFactorFloat = Math.max(0, 1 - this.liveConfig.sellSlippagePct / 100) * 1_000_000_000
    const slippageFactor = new BN(Math.floor(slippageFactorFloat))
    const minBaseAmountOut = base.mul(slippageFactor).div(precision)
    const poolV2PdaKey = poolV2Pda(pool.baseMint)

    return await sdk.withWsolAccount(
      user,
      user,
      quoteMint,
      userQuoteTokenAccount,
      accountExists(userQuoteAccountInfo, quoteTokenProgram),
      spendableQuoteIn,
      async () => {
        const instructions: TransactionInstruction[] = []

        if (!accountExists(userBaseAccountInfo, baseTokenProgram)) {
          instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              user,
              userBaseTokenAccount,
              user,
              baseMint,
              baseTokenProgram,
            ),
          )
        }

        const builder = sdk.offlineProgram.methods
          .buyExactQuoteIn(spendableQuoteIn, minBaseAmountOut, { 0: true })
          .accounts(swapAccounts)

        if (pool.isCashbackCoin) {
          instructions.push(
            await builder.remainingAccounts([
              {
                pubkey: getAssociatedTokenAddressSync(
                  WSOL_MINT,
                  userVolumeAccumulatorPda(user),
                  true,
                  quoteTokenProgram,
                ),
                isWritable: true,
                isSigner: false,
              },
              {
                pubkey: poolV2PdaKey,
                isWritable: false,
                isSigner: false,
              },
            ]).instruction(),
          )
        } else {
          instructions.push(
            await builder.remainingAccounts([
              {
                pubkey: poolV2PdaKey,
                isWritable: false,
                isSigner: false,
              },
            ]).instruction(),
          )
        }

        if (baseMint.equals(WSOL_MINT)) {
          instructions.push(
            createCloseAccountInstruction(
              userBaseTokenAccount,
              user,
              user,
              undefined,
              TOKEN_PROGRAM_ID,
            ),
          )
        }

        return instructions
      },
    )
  }

  getOpenPositions(): Position[] {
    return Array.from(this.openPositions.values())
  }

  getOpenPositionCount(strategyId?: string): number {
    if (!strategyId) return this.openPositions.size
    return Array.from(this.openPositions.values()).filter((position) => position.strategyId === strategyId).length
  }

  async closePositionNow(positionId: string, reason = 'manual_close'): Promise<string | null> {
    const position = this.openPositions.get(positionId)
    if (!position) return null
    this.openPositions.delete(positionId)
    return await this.sellToken(position, reason, positionId)
  }

  async closeExternalPositionNow(
    position: Position,
    reason = 'manual_external_close',
    tokenAmountRaw?: bigint
  ): Promise<string | null> {
    if (tokenAmountRaw !== undefined && tokenAmountRaw > 0n) {
      this.positionTokens.set(position.id, tokenAmountRaw)
    }
    return await this.sellToken(position, reason, position.id)
  }

  removePosition(positionId: string): void {
    const position = this.openPositions.get(positionId)
    if (position) this.openMints.delete(position.mint)
    this.openPositions.delete(positionId)
    this.positionTokens.delete(positionId)
    this.lastRealPriceAt.delete(positionId)
    this.exiting.delete(positionId)
  }

  consumeLastOpenFailureReason(): string | null {
    const reason = this.lastOpenFailureReason
    this.lastOpenFailureReason = null
    return reason
  }
}
