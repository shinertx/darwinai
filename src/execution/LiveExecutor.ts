// ============================================================================
// LiveExecutor — Real on-chain execution via PumpSwap SDK
// SDK handles ALL WSOL wrapping internally. WSOL ATA must be pre-funded once.
// Run scripts/ops/init_wsol_funded.mjs before first use.
// ============================================================================

import {
  Connection, Keypair, PublicKey,
  VersionedTransaction, TransactionMessage, ComputeBudgetProgram,
} from '@solana/web3.js'
import {
  OnlinePumpAmmSdk, PUMP_AMM_SDK,
  pumpPoolAuthorityPda, poolPda, CANONICAL_POOL_INDEX,
} from '@pump-fun/pump-swap-sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import BN from 'bn.js'
import bs58 from 'bs58'
import { v4 as uuidv4 } from 'uuid'
import { Genome, MarketSignal, Position, ClosedTrade } from '../types'
import { createSolanaConnection } from '../rpc/solanaConnection'

const LIVE_SIZE_SOL         = parseFloat(process.env.LIVE_TRADE_SIZE_SOL  || '0.001')
const MIN_BALANCE_SOL       = parseFloat(process.env.LIVE_MIN_BALANCE_SOL || '1.0')
const BUY_SLIPPAGE_PCT      = 15
const SELL_SLIPPAGE_PCT     = 20
const TX_FEE_SOL            = 0.000025  // realistic Solana fee (base + 200k priority @ current rates)
const LAMPORTS              = 1_000_000_000
const WSOL_MINT             = new PublicKey('So11111111111111111111111111111111111111112')
const PRIORITY_MICRO        = 200_000
const PRICE_UPDATE_GUARD_MS = 5_000

export class LiveExecutor {
  private connection:      Connection
  private wallet:          Keypair
  private pumpAmm:         OnlinePumpAmmSdk
  private openPositions:   Map<string, Position> = new Map()
  private positionTokens:  Map<string, bigint>   = new Map()  // posId → token amount owned
  private openMints:       Set<string>            = new Set()  // dedup: 1 live position per mint
  private lastRealPriceAt: Map<string, number>   = new Map()
  private exiting:         Set<string>            = new Set()

  constructor() {
    const rpcUrl = (process.env.RPC_URLS || process.env.RPC_URL || '').split(',')[0].trim()
    if (!rpcUrl) throw new Error('[Live] RPC_URL not set')
    this.connection = createSolanaConnection(rpcUrl, 'confirmed')
    this.pumpAmm    = new OnlinePumpAmmSdk(this.connection)

    const pk = process.env.PRIVATE_KEY || ''
    if (!pk) throw new Error('[Live] PRIVATE_KEY not set in env')
    this.wallet = pk.startsWith('[')
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(pk)))
      : Keypair.fromSecretKey(bs58.decode(pk))

    console.log('[Live] Executor ready. Wallet:', this.wallet.publicKey.toBase58())
    console.log('[Live] Trade size:', LIVE_SIZE_SOL, 'SOL | Floor:', MIN_BALANCE_SOL, 'SOL')
  }

  // ── Buy ────────────────────────────────────────────────────────────────────
  async open(
    signal: MarketSignal,
    genome: Genome,
    strategyId: string,
    _sizeSol: number,
    entryPrice: number
  ): Promise<Position | null> {
    try {
      // Dedup: only one live position per mint at a time
      if (this.openMints.has(signal.mint)) {
        return null
      }

      const balSol = (await this.connection.getBalance(this.wallet.publicKey)) / LAMPORTS
      if (balSol < MIN_BALANCE_SOL + LIVE_SIZE_SOL) {
        console.log('[Live] Balance', balSol.toFixed(4), 'SOL below floor — skipping')
        return null
      }

      const mint = new PublicKey(signal.mint)
      const user = this.wallet.publicKey
      const canonicalPool = poolPda(CANONICAL_POOL_INDEX, pumpPoolAuthorityPda(mint), mint, WSOL_MINT)
      const signalPool    = (signal.pool && signal.pool.length > 20) ? new PublicKey(signal.pool) : canonicalPool

      // Fetch swap state.
      // For migrations: retry with canonical PDA + up to 3 retries (pool indexing delay).
      // For amm_activity: single attempt only — non-WSOL pools never become WSOL.
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
      let swapState: any = null
      const isMigration = signal.type === 'migration'
      const poolsToTry = [signalPool]
      if (isMigration && !signalPool.equals(canonicalPool)) {
        poolsToTry.push(canonicalPool)
      }

      const maxAttempts = isMigration ? 9 : 1
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) await sleep(600)  // wait 800ms between retries (migration only)
        let found = false
        for (const tryPool of poolsToTry) {
          try {
            const state = await this.pumpAmm.swapSolanaState(tryPool, user)
            if ((state as any).pool?.quoteMint?.equals(WSOL_MINT)) {
              swapState = state; found = true; break
            }
          } catch (_) { /* pool not found yet */ }
        }
        if (found) break
        if (isMigration && attempt < maxAttempts - 1) {
          console.log(`[Live] Pool not ready yet for ${signal.mint.slice(0,8)}, retry ${attempt+1}/${maxAttempts-1}...`)
        }
      }

      if (!swapState) {
        return null  // Non-WSOL pool or pool never appeared — skip silently
      }

      // Reserve mint slot before async buy to prevent concurrent buys of same token
      this.openMints.add(signal.mint)

      // SDK builds ALL instructions including WSOL wrap/unwrap internally
      const lamportsIn = Math.floor(LIVE_SIZE_SOL * LAMPORTS)
      const ixs = await (PUMP_AMM_SDK as any).buyQuoteInput(swapState, new BN(lamportsIn), BUY_SLIPPAGE_PCT)
      if (!ixs || ixs.length === 0) {
        this.openMints.delete(signal.mint)
        console.log('[Live] No buy ixs for', signal.mint.slice(0, 8)); return null
      }

      const ixDetails = ixs.map((ix: any, i: number) => i + ':' + ix.programId.toBase58().slice(0,12)).join(' ')
      console.log('[Live] BUY', signal.mint.slice(0, 8), '| SDK ixs:', ixs.length, '| WSOL ATA exists:', swapState.userQuoteAccountInfo ? 'yes' : 'no', '| ixs:', ixDetails)

      const sig = await this.buildAndSend(ixs)
      if (!sig) { this.openMints.delete(signal.mint); return null }
      console.log('[Live] BUY TX:', sig.slice(0, 20), '...')

      const conf = await this.connection.confirmTransaction(sig, 'confirmed')
      if (conf.value.err) {
        this.openMints.delete(signal.mint)
        console.log('[Live] BUY FAILED on-chain:', conf.value.err); return null
      }
      console.log('[Live] BUY CONFIRMED:', signal.mint.slice(0, 8))

      // Record token balance received by THIS buy (ATA deduped per mint, so total = ours)
      const tokenAta = getAssociatedTokenAddressSync(mint, user)
      const tokensReceived = await this.safeGetTokenBalance(tokenAta)

      const poolStr = (signal.pool && signal.pool.length > 20)
        ? signal.pool
        : canonicalPool.toBase58()

      const position: Position = {
        id:             uuidv4(),
        strategyId,
        genomeId:       genome.id,
        mint:           signal.mint,
        pool:           poolStr,
        entryPriceSol:  entryPrice,
        sizeSol:        Math.max(LIVE_SIZE_SOL - TX_FEE_SOL, 0.000001),
        openedAt:       Date.now(),
        peakPriceSol:   entryPrice,
        lowestPriceSol: entryPrice,
        isPaper:        false,
        poolLiqSol:     signal.liquiditySol,
        signalType:     signal.type,
      }
      this.positionTokens.set(position.id, tokensReceived)
      this.openPositions.set(position.id, position)
      console.log('[Live] Position opened:', position.id.slice(0, 8), '| token:', signal.mint.slice(0, 8), '| tokens received:', tokensReceived.toString())
      return position

    } catch (e: any) {
      this.openMints.delete(signal.mint)
      console.log('[Live] open() error:', e?.message?.slice(0, 200) || e)
      return null
    }
  }

  // ── Tick — identical exit logic to PaperExecutor ──────────────────────────
  tick(currentPrices: Map<string, number>, genomes: Map<string, Genome>): ClosedTrade[] {
    const closed: ClosedTrade[] = []
    const now = Date.now()

    for (const [posId, pos] of this.openPositions) {
      if (this.exiting.has(posId)) continue
      const genome = genomes.get(pos.genomeId)
      if (!genome) continue

      const rawPrice = currentPrices.get(pos.mint)
      if (rawPrice !== undefined && rawPrice > 0) {
        if (rawPrice > pos.peakPriceSol)   pos.peakPriceSol   = rawPrice
        if (rawPrice < pos.lowestPriceSol) pos.lowestPriceSol = rawPrice
        this.lastRealPriceAt.set(posId, now)
      }

      const currentPrice = rawPrice && rawPrice > 0 ? rawPrice : pos.entryPriceSol
      const lastUpdate   = this.lastRealPriceAt.get(posId) || 0
      const hadPrice     = lastUpdate > 0 && lastUpdate > pos.openedAt + PRICE_UPDATE_GUARD_MS

      const holdMs   = now - pos.openedAt
      const pricePct = (currentPrice - pos.entryPriceSol) / pos.entryPriceSol
      const peakPct  = (pos.peakPriceSol - pos.entryPriceSol) / pos.entryPriceSol
      const ex       = genome.exit
      let exitReason = ''

      if      (hadPrice && pricePct >= ex.takeProfitPct)                                    exitReason = 'take_profit'
      else if (hadPrice && peakPct >= ex.trailingActivatePct) {
        if (currentPrice <= pos.peakPriceSol * (1 - ex.trailingDistancePct))               exitReason = 'trailing_stop'
      }
      else if (holdMs >= ex.timeStopMs)                                                     exitReason = 'time_stop'
      else if (hadPrice && holdMs >= ex.noPumpBailMs && pricePct < 0.02)                   exitReason = 'no_pump_bail'
      else if (hadPrice && peakPct >= 0.05) {
        if ((pos.peakPriceSol - currentPrice) / pos.peakPriceSol >= ex.fadeGivebackPct)   exitReason = 'fade_exit'
      }

      if (exitReason) {
        this.exiting.add(posId)
        const pnlPct = Math.max(-1.0, Math.min(pricePct, 100.0))
        const trade: ClosedTrade = {
          id: uuidv4(), strategyId: pos.strategyId, genomeId: pos.genomeId,
          mint: pos.mint, pool: pos.pool,
          entryPriceSol: pos.entryPriceSol, exitPriceSol: currentPrice,
          sizeSol: pos.sizeSol,
          pnlSol: (pos.sizeSol * pnlPct) - TX_FEE_SOL,
          pnlPct,
          mfePct: Math.min(peakPct, 100.0),
          maePct: Math.max((pos.lowestPriceSol - pos.entryPriceSol) / pos.entryPriceSol, -1.0),
          exitReason, openedAt: pos.openedAt, closedAt: now, holdMs,
          isPaper: false, signalType: pos.signalType,
          poolLiqSol: pos.poolLiqSol,
          desiredSizeSol: pos.desiredSizeSol,
          cappedSizeSol: pos.cappedSizeSol,
          poolCapSol: pos.poolCapSol,
          fillRatio: pos.fillRatio,
        }
        this.openPositions.delete(posId)
        this.lastRealPriceAt.delete(posId)
        this.sellToken(pos.mint, pos.pool, exitReason, posId).catch(e =>
          console.log('[Live] sell error:', e?.message || e)
        )
        closed.push(trade)
      }
    }
    return closed
  }

  // ── Async sell ─────────────────────────────────────────────────────────────
  private async sellToken(mint: string, pool: string, reason: string, posId: string): Promise<void> {
    try {
      const mintPk   = new PublicKey(mint)
      const user     = this.wallet.publicKey

      // Use position-specific token amount (prevents collisions when multiple positions share mint ATA)
      const posTokens = this.positionTokens.get(posId) ?? 0n
      // Also check on-chain in case balance changed (partial fills etc)
      const tokenAta  = getAssociatedTokenAddressSync(mintPk, user)
      const onChain   = await this.safeGetTokenBalance(tokenAta)
      const amount    = onChain > 0n ? onChain : posTokens
      if (amount === 0n) {
        console.log('[Live] No token balance to sell:', mint.slice(0, 8)); return
      }

      const poolPk = (pool && pool.length > 20)
        ? new PublicKey(pool)
        : poolPda(CANONICAL_POOL_INDEX, pumpPoolAuthorityPda(mintPk), mintPk, WSOL_MINT)
      const swapState = await this.pumpAmm.swapSolanaState(poolPk, user)

      // SDK handles WSOL unwrap (receive SOL from sell) internally
      const ixs = await (PUMP_AMM_SDK as any).sellBaseInput(swapState, new BN(amount.toString()), SELL_SLIPPAGE_PCT)
      if (!ixs || ixs.length === 0) {
        console.log('[Live] No sell ixs:', mint.slice(0, 8)); return
      }

      const sig = await this.buildAndSend(ixs)
      if (!sig) { console.log('[Live] Sell TX failed:', mint.slice(0, 8)); return }

      console.log('[Live] SELL TX:', sig.slice(0, 20), '... |', mint.slice(0, 8), '| reason:', reason)
      const conf = await this.connection.confirmTransaction(sig, 'confirmed')
      if (conf.value.err) {
        console.log('[Live] SELL FAILED on-chain:', conf.value.err)
      } else {
        console.log('[Live] SELL CONFIRMED:', mint.slice(0, 8))
      }
    } catch (e: any) {
      console.log('[Live] sellToken error:', e?.message?.slice(0, 200) || e)
    } finally {
      this.positionTokens.delete(posId)
      this.openMints.delete(mint)   // release mint slot for future trades
      this.exiting.delete(posId)
    }
  }

  // ── Build + sign + send versioned transaction ─────────────────────────────
  private async buildAndSend(ixs: any[]): Promise<string | null> {
    try {
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed')
      const budgetIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO })
      const msg = new TransactionMessage({
        payerKey: this.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [budgetIx, ...ixs],
      }).compileToV0Message()
      const tx = new VersionedTransaction(msg)
      tx.sign([this.wallet])
      return await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
    } catch (e: any) {
      console.log('[Live] buildAndSend error:', e?.message?.slice(0, 300) || e)
      return null
    }
  }

  private async safeGetTokenBalance(ata: PublicKey): Promise<bigint> {
    try {
      return BigInt((await this.connection.getTokenAccountBalance(ata)).value.amount)
    } catch { return 0n }
  }

  getOpenPositions():                Position[]  { return Array.from(this.openPositions.values()) }
  getOpenPositionCount(id?: string): number      { return id ? [...this.openPositions.values()].filter(p => p.strategyId === id).length : this.openPositions.size }
  removePosition(posId: string):     void        {
    const pos = this.openPositions.get(posId)
    if (pos) this.openMints.delete(pos.mint)
    this.openPositions.delete(posId)
    this.positionTokens.delete(posId)
    this.lastRealPriceAt.delete(posId)
    this.exiting.delete(posId)
  }
}
