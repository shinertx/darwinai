// ============================================================================
// MarketFeed — Adapted from final-radiation Detector.ts
// Emits MarketSignal objects for the Darwin organism
// ============================================================================

import EventEmitter from 'events'
import { Connection, PublicKey } from '@solana/web3.js'
import { MarketSignal, PricePoint } from '../types'

const PUMP_CORE_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
const PRICE_HISTORY_MAX = 20

export class MarketFeed extends EventEmitter {
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

  public start() {
    this.rpcUrls = (process.env.RPC_URLS || process.env.RPC_URL || '')
      .split(',')
      .map((u: string) => u.trim())
      .filter(Boolean)

    this.rpcUrl = this.rpcUrls[0]
    if (!this.rpcUrl) {
      console.error('[MarketFeed] No RPC_URL in env. Cannot start.')
      return
    }

    console.log('[MarketFeed] Starting PumpSwap feed...')
    this.connection = new Connection(this.rpcUrl, 'processed')
    this.fetchConnections = this.rpcUrls.map((url: string) => new Connection(url, 'confirmed'))

    if (this.fetchConnections.length > 1) {
      console.log('[MarketFeed] RPC pool: ' + this.fetchConnections.length + ' endpoints')
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
      for (const [mint, ts] of this.recentSignals) {
        if (now - ts > this.signalCooldownMs * 2) this.recentSignals.delete(mint)
      }
    }, 60000)
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
    this.connection = new Connection(this.rpcUrl, 'processed')
    this.fetchConnections = this.rpcUrls.map((url: string) => new Connection(url, 'confirmed'))
    this.subscribeToPumpCore()
    this.subscribeToPumpAMM()
    this.lastSignalAt = Date.now()
    console.log('[MarketFeed] Reconnected')
  }

  public stop() {
    if (this.watchdogHandle) { clearInterval(this.watchdogHandle); this.watchdogHandle = null }
    if (this.cleanupHandle) { clearInterval(this.cleanupHandle); this.cleanupHandle = null }
    if (this.connection) {
      if (this.coreSubscriptionId !== null) this.connection.removeOnLogsListener(this.coreSubscriptionId)
      if (this.ammSubscriptionId !== null) this.connection.removeOnLogsListener(this.ammSubscriptionId)
    }
    this.recentSignals.clear()
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
    try {
      const tx = await this.fetchTransaction(signature)
      if (!tx || !tx.meta) return
      const tokenBalances = tx.meta.postTokenBalances || []
      const relevantToken = this.findPumpToken(tokenBalances)
      if (relevantToken?.mint) {
        const poolAddress = this.extractPoolAddress(tx)
        if (poolAddress) {
          const liquiditySol = this.extractSolAmount(tx)
          console.log('[MarketFeed] FAST ENTRY: ' + poolAddress.slice(0, 8) + '... Liq: ' + liquiditySol.toFixed(2) + ' SOL')
          this.emitSignal({
            type: eventType === 'migration' ? 'migration' : 'new_pool',
            mint: relevantToken.mint,
            pool: poolAddress,
            liquiditySol,
            poolAgeMs: 0,
            priceSol: 0,
            eventData: { signature },
            timestamp: Date.now(),
          })
        }
      }
    } catch (e) {
      console.error('[MarketFeed] Error processing AMM event:', e)
    }
  }

  private async processAMMActivityEvent(signature: string): Promise<void> {
    if (!this.connection) return
    try {
      await new Promise((r) => setTimeout(r, 500))
      const conn = this.getFetchConnection()
      let tx: any = null
      try {
        tx = await conn.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        })
      } catch (_) { return }
      if (!tx || !tx.meta) return
      const tokenBalances = tx.meta.postTokenBalances || []
      const relevantToken = this.findPumpToken(tokenBalances)
      if (!relevantToken?.mint) return
      const poolAddress = this.extractPoolAddress(tx)
      if (!poolAddress) return
      const tradeAmountSol = this.extractSolAmount(tx)
      if (tradeAmountSol < 1) return
      const estimatedLiq = tradeAmountSol * 10
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
      const tx = await this.fetchTransaction(signature, 'core')
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

  private extractPoolAddress(tx: any): string | null {
    const PUMP_AMM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
    const GLOBAL_STATE = 'GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR'
    try {
      const mainInstructions = tx.transaction?.message?.instructions || []
      for (const ix of mainInstructions) {
        if (ix.programId.toString() === PUMP_AMM_ID) {
          if (!ix.accounts || ix.accounts.length < 4) continue
          const candidate = ix.accounts.find((a: any) => a.toString() !== GLOBAL_STATE)
          if (candidate) return candidate.toString()
        }
      }
      const innerInstructions = tx.meta?.innerInstructions || []
      for (const inner of innerInstructions) {
        for (const ix of inner.instructions) {
          if (ix.programId.toString() === PUMP_AMM_ID) {
            if (!ix.accounts || ix.accounts.length < 4) continue
            const candidate = ix.accounts.find((a: any) => a.toString() !== GLOBAL_STATE)
            if (candidate) return candidate.toString()
          }
        }
      }
    } catch (e) {}
    return null
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

  private async fetchTransaction(signature: string, source: 'amm' | 'core' = 'amm'): Promise<any> {
    if (!this.connection) return null
    if (source === 'amm') {
      if (this.activeAmmFetches >= 4) return null
      this.activeAmmFetches++
    } else {
      if (this.activeCoreFetches >= 6) return null
      this.activeCoreFetches++
    }
    try {
      const conn = this.getFetchConnection()
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const tx = await conn.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          })
          if (tx) return tx
        } catch (_) {
          if (attempt < 2) await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000))
        }
      }
    } finally {
      if (source === 'amm') this.activeAmmFetches--
      else this.activeCoreFetches--
    }
    return null
  }

  private emitSignal(signal: MarketSignal) {
    const now = Date.now()
    const last = this.recentSignals.get(signal.mint) || 0
    if (now - last < this.signalCooldownMs) return
    this.recentSignals.set(signal.mint, now)
    this.lastSignalAt = now

    // Add price point if we have price info
    if (signal.priceSol > 0) {
      this.addPricePoint(signal.mint, signal.priceSol)
    }

    console.log('[MarketFeed] SIGNAL: ' + signal.type + ' on ' + signal.mint.slice(0, 8) + '... (' + signal.liquiditySol.toFixed(2) + ' SOL liq)')
    this.emit('signal', signal)
  }

  private getFetchConnection(): Connection {
    if (this.fetchConnections.length === 0) return this.connection!
    const conn = this.fetchConnections[this.fetchIndex % this.fetchConnections.length]
    this.fetchIndex++
    return conn
  }
}
