// ============================================================================
// Orchestrator — main event loop coordinating all Darwin systems
// ============================================================================

import { Connection } from '@solana/web3.js'
import { MarketFeed } from './market/MarketFeed'
import { PopulationManager } from './population/PopulationManager'
import { PaperExecutor } from './execution/PaperExecutor'
import { LiveExecutor } from './execution/LiveExecutor'
import { BankrollManager } from './execution/BankrollManager'
import { Logger } from './observatory/Logger'
import { PoolPriceService } from './market/PoolPriceService'
import { createRandom } from './genome/GenomeFactory'
import { MarketSignal, PricePoint, Genome, ClosedTrade } from './types'
import { getPrimaryRpcUrl, resolveRuntimeConfig, RuntimeConfig } from './config/runtime'

const GENERATION_INTERVAL_MS = 1 * 60 * 60 * 1000  // 1 hour (was 4)
const GENERATION_TRADE_THRESHOLD = 75              // (was 300)
const STATUS_INTERVAL_MS = 30 * 1000
const TICK_INTERVAL_MS = 1000
const PRICE_POLL_INTERVAL_MS = 3000

// Jupiter price cache
const priceCache: Map<string, { price: number; ts: number }> = new Map()
const PRICE_CACHE_TTL = 3000
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const AMM_ACTIVITY_MIN_LIQUIDITY_SOL = parseFloat(process.env.AMM_ACTIVITY_MIN_LIQUIDITY_SOL || '50')
const WHALE_BUY_MIN_LIQUIDITY_SOL = parseFloat(process.env.WHALE_BUY_MIN_LIQUIDITY_SOL || '50')
const NEW_POOL_MIN_LIQUIDITY_SOL = parseFloat(process.env.NEW_POOL_MIN_LIQUIDITY_SOL || '30')
const MIGRATION_MIN_LIQUIDITY_SOL = parseFloat(process.env.MIGRATION_MIN_LIQUIDITY_SOL || '25')
const TARGET_ENTRY_POOL_PCT = parseFloat(process.env.DARWIN_TARGET_ENTRY_POOL_PCT || '0.03')
const MIN_MEANINGFUL_FILL_RATIO = parseFloat(process.env.DARWIN_MIN_MEANINGFUL_FILL_RATIO || '0.5')

export class Orchestrator {
  private runtime: RuntimeConfig
  private feed: MarketFeed
  private population: PopulationManager
  private paperExecutor: PaperExecutor
  private liveExecutor: LiveExecutor | null = null
  private liveMode: boolean
  private bankroll: BankrollManager
  private logger: Logger
  private poolPriceService: PoolPriceService | null = null
  private lastGenerationAt = Date.now()
  private totalTradesSinceGeneration = 0
  private totalTrades = 0
  private tickHandle: NodeJS.Timeout | null = null
  private statusHandle: NodeJS.Timeout | null = null
  private pricePollHandle: NodeJS.Timeout | null = null
  private rpcConnection: Connection | null = null
  private startingBalance: number = parseFloat(process.env.STARTING_BALANCE_SOL || '1.0')
  private signalDistLog: { migration: number; amm: number; whale: number; other: number } = { migration: 0, amm: 0, whale: 0, other: 0 }
  private signalTradedLog: { migration: number; amm: number; whale: number; other: number } = { migration: 0, amm: 0, whale: 0, other: 0 }
  private lastSignalDistLog = Date.now()

  constructor() {
    this.runtime = resolveRuntimeConfig(process.env)
    this.liveMode = this.runtime.mode === 'live'
    for (const warning of this.runtime.warnings) {
      console.warn('[Darwin] Config warning: ' + warning)
    }
    if (this.liveMode && this.runtime.liveEnvErrors.length > 0) {
      throw new Error(
        'DARWIN_MODE=live requires ' + this.runtime.liveEnvErrors.join(', ')
      )
    }

    this.logger = new Logger()
    this.logger.initDb()
    this.feed = new MarketFeed()
    this.population = new PopulationManager(this.logger)
    this.paperExecutor = new PaperExecutor()
    this.bankroll = new BankrollManager()
    if (this.liveMode) {
      this.liveExecutor = new LiveExecutor()
      console.log('[Darwin] Live executor armed. Real funds will be used if signals fire.')
    }
  }

  public async start(): Promise<void> {
    console.log('[Darwin] ===== DARWIN ORGANISM STARTING =====')
    console.log('[Darwin] Mode: ' + this.runtime.mode.toUpperCase())
    console.log('[Darwin] Population size: ' + parseInt(process.env.DARWIN_POP_SIZE || '16', 10))
    console.log('[Darwin] Starting balance: ' + this.bankroll.getCurrentBalance().toFixed(4) + ' SOL')
    if (this.liveMode) {
      console.log('[Darwin] Live trade size: ' + parseFloat(process.env.LIVE_TRADE_SIZE_SOL || '0.001').toFixed(4) + ' SOL')
    }

    const rpcUrl = getPrimaryRpcUrl(process.env)
    if (rpcUrl) {
      this.rpcConnection = new Connection(rpcUrl, 'confirmed')
      this.poolPriceService = new PoolPriceService(rpcUrl)
      console.log('[Darwin] PoolPriceService ready (direct pool reserve reads)')
    } else {
      console.warn('[Darwin] WARNING: No RPC URL configured — pool price reads disabled, Jupiter only')
    }

    this.seedPopulation()

    this.feed.on('signal', (signal: MarketSignal) => {
      this.onSignal(signal).catch((e) => console.error('[Darwin] onSignal error:', e))
    })
    if (!this.feed.start()) {
      throw new Error('MarketFeed failed to start. Set RPC_URL or RPC_URLS before launching Darwin.')
    }

    this.tickHandle = setInterval(() => this.tickPositions(), TICK_INTERVAL_MS)
    this.statusHandle = setInterval(() => this.printStatus(), STATUS_INTERVAL_MS)
    this.pricePollHandle = setInterval(() => this.pollPricesForOpenPositions(), PRICE_POLL_INTERVAL_MS)
    setInterval(() => this.printSignalDistribution(), 5 * 60 * 1000)

    setTimeout(() => this.printStatus(), 5000)
    console.log('[Darwin] All systems running. Waiting for market signals...')
  }

  private seedPopulation(): void {
    const popSize = parseInt(process.env.DARWIN_POP_SIZE || '16', 10)
    console.log('[Darwin] Seeding initial population of ' + popSize + ' strategies...')

    // Load best previously evolved genomes from DB — carry knowledge across restarts
    const savedGenomes = this.logger.loadBestGenomes(Math.floor(popSize * 0.6))
    let seededFromDB = 0
    for (const genome of savedGenomes) {
      if (this.population.size() >= popSize) break
      // Bump generation count so we know this genome survived a restart
      genome.generation = (genome.generation || 0) + 1
      this.population.spawn(genome, true)
      seededFromDB++
    }

    // Fill remainder with fresh random genomes (exploration)
    const remaining = popSize - this.population.size()
    for (let i = 0; i < remaining; i++) {
      const genome = createRandom(0)
      this.population.spawn(genome, true)
    }

    console.log(
      '[Darwin] Population seeded: ' + this.population.size() + ' strategies ready' +
      ' (' + seededFromDB + ' from DB memory, ' + remaining + ' fresh random)'
    )
  }

  private async onSignal(signal: MarketSignal): Promise<void> {
    // Track signal distribution
    if (signal.type === 'migration') this.signalDistLog.migration++
    else if (signal.type === 'amm_activity') this.signalDistLog.amm++
    else if (signal.type === 'whale_buy') this.signalDistLog.whale++
    else this.signalDistLog.other++

    // Survival mode: if balance < 70% of starting balance, only trade migrations
    const balance = this.bankroll.getCurrentBalance()
    const inSurvivalMode = balance < this.startingBalance * 0.70
    if (inSurvivalMode && signal.type !== 'migration') {
      return  // Skip all non-migration signals when bleeding out
    }

    // Hard floor: skip obviously too-thin pools before strategy evaluation.
    if (signal.liquiditySol > 0 && signal.liquiditySol < this.getSignalLiquidityFloor(signal.type)) {
      return
    }

    // Fetch real price BEFORE evaluating strategies — skip if we can't get one
    // Priority: 1) pool reserves (direct on-chain) 2) migration estimate 3) Jupiter
    let entryPrice = signal.priceSol > 0 ? signal.priceSol : 0
    let priceSource = entryPrice > 0 ? 'signal' : 'none'

    if (entryPrice === 0 && this.poolPriceService) {
      // Try direct pool reserve read first (works for brand new tokens)
      if (signal.pool && signal.pool.length > 10) {
        try {
          const poolPrice = await this.poolPriceService.getPriceFromPool(signal.pool)
          if (poolPrice !== null && poolPrice > 0) {
            entryPrice = poolPrice
            priceSource = 'pool_reserves'
          }
        } catch (_) { }
      }

      // For migration signals without a valid pool price: use reserve estimate
      if (entryPrice === 0 && signal.type === 'migration' && signal.liquiditySol > 0) {
        entryPrice = this.poolPriceService.estimateMigrationPrice(signal.liquiditySol)
        priceSource = 'migration_estimate'
      }
    }

    // Jupiter as final fallback (works once token is indexed, ~30-60s after launch)
    if (entryPrice === 0) {
      const fetched = await this.fetchJupiterPriceSOL(signal.mint)
      if (fetched !== null && fetched > 0) {
        entryPrice = fetched
        priceSource = 'jupiter'
      }
    }

    if (entryPrice > 0) {
      this.feed.addPricePoint(signal.mint, entryPrice)
    }

    // If we still have no price, skip — we cannot paper trade without knowing what we paid
    if (entryPrice === 0) {
      console.log('[Darwin] SKIP: ' + signal.mint.slice(0, 8) + '... no price available (' + signal.type + ')')
      return
    }

    const strategies = this.population.getAll()

    // Calculate committed capital (sum of all open position sizes) to prevent over-leverage.
    // Multiple strategies can fire on the same signal in a single loop, so we track
    // how much we've allocated this signal and deduct from available capital dynamically.
    const allOpen = this.liveMode && this.liveExecutor ? this.liveExecutor.getOpenPositions() : this.paperExecutor.getOpenPositions()
    const committedCapital = allOpen.reduce((sum, p) => sum + p.sizeSol, 0)
    let availableCapital = Math.max(0, this.bankroll.getCurrentBalance() - committedCapital)

    for (const strategy of strategies) {
      try {
        if (availableCapital < 0.01) break  // No capital left — skip remaining strategies

        const openCount = this.liveMode && this.liveExecutor ? this.liveExecutor.getOpenPositionCount(strategy.id) : this.paperExecutor.getOpenPositionCount(strategy.id)
        if (openCount >= strategy.genome.risk.maxConcurrent) continue
        if (this.bankroll.isDrawdownBreached()) continue

        const priceHistory = this.feed.getPriceHistory(signal.mint)
        const fired = strategy.evaluateSignal(signal, priceHistory)

        if (fired) {
          const sizing = this.bankroll.getSizingPlan(
            strategy.genome.risk.capitalPct,
            signal.liquiditySol,
            strategy.genome.risk.maxPoolPct,
            signal.type
          )
          const dynamicLiquidityFloor = this.getDynamicLiquidityFloor(signal.type, sizing.desiredSizeSol)
          if (signal.liquiditySol > 0 && signal.liquiditySol < dynamicLiquidityFloor) continue

          const fillRatio = sizing.desiredSizeSol > 0 ? sizing.poolCapSol / sizing.desiredSizeSol : 0
          if (sizing.poolCapSol > 0 && fillRatio < MIN_MEANINGFUL_FILL_RATIO) continue

          // Size using BankrollManager (signal-type multiplier + hard cap)
          const sizeSol = Math.min(sizing.sizeSol, availableCapital * 0.95)

          if (sizeSol < 0.00001) continue  // floor: 10 lamports minimum

          // Track signal traded
          if (signal.type === 'migration') this.signalTradedLog.migration++
          else if (signal.type === 'amm_activity') this.signalTradedLog.amm++
          else if (signal.type === 'whale_buy') this.signalTradedLog.whale++
          else this.signalTradedLog.other++

          const pos = this.liveMode && this.liveExecutor
            ? await this.liveExecutor.open(signal, strategy.genome, strategy.id, sizeSol, entryPrice)
            : this.paperExecutor.open(signal, strategy.genome, strategy.id, sizeSol, entryPrice)

          if (!pos) {
            console.log('[Darwin] TX FAILED: ' + strategy.id.slice(-8) + ' | ' + signal.mint.slice(0,8) + '... (simulated failed tx)')
            continue
          }

          availableCapital -= sizeSol  // Deduct from pool for subsequent strategies

          strategy.recordEntry()

          console.log(
            '[Darwin] ENTRY: ' + strategy.id.slice(-8) + ' | ' +
            signal.mint.slice(0, 8) + '... | ' +
            signal.type + ' | ' +
            sizeSol.toFixed(4) + ' SOL @ ' + entryPrice.toFixed(8) +
            ' [' + priceSource + ']'
          )
        }
      } catch (e) {
        console.error('[Darwin] Strategy evaluation error:', e)
      }
    }
  }

  private getSignalLiquidityFloor(signalType: MarketSignal['type']): number {
    if (signalType === 'migration') return MIGRATION_MIN_LIQUIDITY_SOL
    if (signalType === 'new_pool') return NEW_POOL_MIN_LIQUIDITY_SOL
    if (signalType === 'whale_buy') return WHALE_BUY_MIN_LIQUIDITY_SOL
    return AMM_ACTIVITY_MIN_LIQUIDITY_SOL
  }

  private getDynamicLiquidityFloor(signalType: MarketSignal['type'], desiredSizeSol: number): number {
    const hardFloor = this.getSignalLiquidityFloor(signalType)
    if (desiredSizeSol <= 0 || TARGET_ENTRY_POOL_PCT <= 0) return hardFloor

    // We only want to learn on pools that could support the intended position
    // without Darwin becoming an outsized share of the liquidity.
    const dynamicFloor = desiredSizeSol / TARGET_ENTRY_POOL_PCT
    return Math.max(hardFloor, dynamicFloor)
  }

  private tickPositions(): void {
    const currentPrices = new Map<string, number>()
    const executor = this.liveMode && this.liveExecutor ? this.liveExecutor : this.paperExecutor
    const openPositions = executor.getOpenPositions()

    for (const pos of openPositions) {
      const history = this.feed.getPriceHistory(pos.mint)
      if (history.length > 0) {
        currentPrices.set(pos.mint, history[history.length - 1].price)
      }
      // Don't fall back to entry price — leave undefined so no_pump_bail doesn't fire prematurely
    }

    const genomes = new Map<string, Genome>()
    for (const strat of this.population.getAll()) {
      genomes.set(strat.genome.id, strat.genome)
    }

    const closedTrades = executor.tick(currentPrices, genomes)

    for (const trade of closedTrades) {
      const strategy = this.population.getStrategy(trade.strategyId)
      if (strategy) strategy.recordTrade(trade)

      this.bankroll.recordTrade(trade)
      this.logger.logTrade(trade)
      this.logger.logBankroll(this.bankroll.getCurrentBalance(), Date.now())

      this.totalTrades++
      this.totalTradesSinceGeneration++

      const pnlStr = (trade.pnlSol >= 0 ? '+' : '') + trade.pnlSol.toFixed(4)
      const pctStr = (trade.pnlPct >= 0 ? '+' : '') + (trade.pnlPct * 100).toFixed(1) + '%'
      console.log(
        '[Darwin] CLOSE: ' + trade.strategyId.slice(-8) + ' | ' +
        trade.mint.slice(0, 8) + '... | ' +
        pnlStr + ' SOL (' + pctStr + ') | ' +
        trade.exitReason + ' | hold: ' + Math.round(trade.holdMs / 1000) + 's'
      )
    }

    this.maybeRunGeneration()
  }

  private async pollPricesForOpenPositions(): Promise<void> {
    const openPositions = this.liveMode && this.liveExecutor ? this.liveExecutor.getOpenPositions() : this.paperExecutor.getOpenPositions()
    if (openPositions.length === 0) return

    // Collect unique mints and their associated pools
    const mintPoolMap = new Map<string, string>()
    const mintEntryPriceMap = new Map<string, number>()
    for (const pos of openPositions) {
      if (!mintPoolMap.has(pos.mint)) {
        mintPoolMap.set(pos.mint, pos.pool || '')
        mintEntryPriceMap.set(pos.mint, pos.entryPriceSol)
      }
    }

    for (const [mint, pool] of mintPoolMap) {
      try {
        let price: number | null = null

        // ONLY use pool reserves for ongoing price monitoring — no Jupiter fallback.
        // Jupiter returns stale/ghost prices for tokens whose pool vaults are closed
        // (drained/rugged), which causes phantom trillion-SOL PnL.
        // If the pool is gone, let time_stop close the position naturally.
        if (pool && pool.length > 10 && this.poolPriceService) {
          price = await this.poolPriceService.getPriceFromPool(pool)
        }

        if (price !== null && price > 0) {
          // Sanity check: reject prices more than 10,000x the entry price.
          // Real pumps are 10-100x; anything beyond signals a pool read error
          // (e.g. inverted reserves on a nearly-drained pool).
          const entryPrice = mintEntryPriceMap.get(mint) || 0
          if (entryPrice > 0 && price > entryPrice * 10_000) {
            // Silently reject — drained pool, not an error worth spamming
            continue
          }
          this.feed.addPricePoint(mint, price)
        }
      } catch (_) { }
    }
  }

  // Fetch price denominated in SOL using Jupiter v2 with vsToken=SOL
  private async fetchJupiterPriceSOL(mint: string): Promise<number | null> {
    if (mint === SOL_MINT) return 1.0

    const cached = priceCache.get(mint)
    if (cached && Date.now() - cached.ts < PRICE_CACHE_TTL) return cached.price

    try {
      const url = `https://api.jup.ag/price/v2?ids=${mint}&vsToken=${SOL_MINT}`
      const resp = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (!resp.ok) return null
      const data = await resp.json() as any
      const priceVal = data?.data?.[mint]?.price
      if (priceVal != null) {
        const price = parseFloat(priceVal)
        if (price > 0) {
          priceCache.set(mint, { price, ts: Date.now() })
          return price
        }
      }
    } catch (_) { }
    return null
  }

  private maybeRunGeneration(): void {
    const timeSinceLast = Date.now() - this.lastGenerationAt
    const tradeThreshold = this.totalTradesSinceGeneration >= GENERATION_TRADE_THRESHOLD
    const timeThreshold = timeSinceLast >= GENERATION_INTERVAL_MS

    if (tradeThreshold || timeThreshold) {
      const reason = tradeThreshold ? 'trade_threshold' : 'time_threshold'
      console.log('[Darwin] Running generation cycle (reason: ' + reason + ')')
      this.population.runGenerationCycle()
      this.lastGenerationAt = Date.now()
      this.totalTradesSinceGeneration = 0
    }
  }

  private printSignalDistribution(): void {
    const now = Date.now()
    const mins = Math.round((now - this.lastSignalDistLog) / 60000)
    this.lastSignalDistLog = now
    const d = this.signalDistLog
    const t = this.signalTradedLog
    const total = d.migration + d.amm + d.whale + d.other || 1
    const inSurvival = this.bankroll.getCurrentBalance() < this.startingBalance * 0.70
    console.log(
      '[Darwin] Signal dist (' + mins + 'min): ' +
      'migration=' + d.migration + '(traded:' + t.migration + ') ' +
      'amm=' + d.amm + '(traded:' + t.amm + ') ' +
      'whale=' + d.whale + '(traded:' + t.whale + ')' +
      (inSurvival ? ' | SURVIVAL MODE ACTIVE' : '')
    )
    // Reset counters
    this.signalDistLog = { migration: 0, amm: 0, whale: 0, other: 0 }
    this.signalTradedLog = { migration: 0, amm: 0, whale: 0, other: 0 }
  }

  private printStatus(): void {
    const strategies = this.population.getAll()
    const paper = this.population.getPaperStrategies()
    const live = this.population.getLiveStrategies()
    const balance = this.bankroll.getCurrentBalance()
    const openCount = this.liveMode && this.liveExecutor ? this.liveExecutor.getOpenPositionCount() : this.paperExecutor.getOpenPositionCount()

    const scored = strategies.map((s) => s.getFitness()).filter((f) => f.tradeCount > 0)
    scored.sort((a, b) => b.score - a.score)

    const bestFitness = scored.length > 0 ? scored[0].score : 0
    const timeSinceLast = Date.now() - this.lastGenerationAt
    const timeUntilGen = Math.max(0, GENERATION_INTERVAL_MS - timeSinceLast)
    const tradesUntilGen = Math.max(0, GENERATION_TRADE_THRESHOLD - this.totalTradesSinceGeneration)

    const h = Math.floor(timeUntilGen / (1000 * 60 * 60))
    const m = Math.floor((timeUntilGen % (1000 * 60 * 60)) / (1000 * 60))

    const inSurvivalMode = balance < this.startingBalance * 0.70
    console.log(
      '[Darwin] Mode: ' + this.runtime.mode +
      ' | Pop: ' + strategies.length + ' (' + paper.length + ' paper, ' + live.length + ' live)' +
      ' | Trades: ' + this.totalTrades +
      ' | Open: ' + openCount +
      ' | Best fitness: ' + bestFitness.toFixed(3) +
      ' | Bankroll: ' + balance.toFixed(4) + ' SOL' +
      (inSurvivalMode ? ' | ⚠ SURVIVAL MODE' : '')
    )

    if (scored.length > 0) {
      const top3 = scored.slice(0, 3)
      const top3Str = top3.map((f) =>
        f.strategyId.slice(-8) + ' (score: ' + f.score.toFixed(2) + ', ' + f.tradeCount + ' trades, best: +' + (f.bestTradeReturn * 100).toFixed(0) + '%)'
      ).join(' | ')
      console.log('[Darwin] Top 3: ' + top3Str)
    }

    const drawdownPct = this.bankroll.getDrawdownPct()
    const drawdownStr = drawdownPct > 0.1 ? ' | Drawdown: ' + (drawdownPct * 100).toFixed(1) + '%' : ''
    console.log(
      '[Darwin] Next generation in: ' + h + 'h ' + m + 'm (or after ' + tradesUntilGen + ' more trades)' + drawdownStr
    )
  }
}
