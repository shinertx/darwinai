// ============================================================================
// Orchestrator — main event loop coordinating all Darwin systems
// ============================================================================

import { Connection } from '@solana/web3.js'
import { MarketFeed } from './market/MarketFeed'
import { PopulationManager } from './population/PopulationManager'
import { PaperExecutor } from './execution/PaperExecutor'
import { BankrollManager } from './execution/BankrollManager'
import { Logger } from './observatory/Logger'
import { PoolPriceService } from './market/PoolPriceService'
import { createRandom } from './genome/GenomeFactory'
import { MarketSignal, PricePoint, Genome, ClosedTrade } from './types'

const GENERATION_INTERVAL_MS = 4 * 60 * 60 * 1000
const GENERATION_TRADE_THRESHOLD = 300
const STATUS_INTERVAL_MS = 30 * 1000
const TICK_INTERVAL_MS = 1000
const PRICE_POLL_INTERVAL_MS = 3000

// Jupiter price cache
const priceCache: Map<string, { price: number; ts: number }> = new Map()
const PRICE_CACHE_TTL = 3000
const SOL_MINT = 'So11111111111111111111111111111111111111112'

export class Orchestrator {
  private feed: MarketFeed
  private population: PopulationManager
  private paperExecutor: PaperExecutor
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

  constructor() {
    this.logger = new Logger()
    this.logger.initDb()
    this.feed = new MarketFeed()
    this.population = new PopulationManager(this.logger)
    this.paperExecutor = new PaperExecutor()
    this.bankroll = new BankrollManager()
  }

  public async start(): Promise<void> {
    console.log('[Darwin] ===== DARWIN ORGANISM STARTING =====')
    console.log('[Darwin] Paper trading: ' + (process.env.PAPER_TRADE !== 'false' ? 'YES' : 'NO'))
    console.log('[Darwin] Population size: ' + parseInt(process.env.DARWIN_POP_SIZE || '16', 10))
    console.log('[Darwin] Starting balance: ' + this.bankroll.getCurrentBalance().toFixed(4) + ' SOL')

    const rpcUrl = (process.env.RPC_URLS || process.env.RPC_URL || '').split(',')[0].trim()
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
    this.feed.start()

    this.tickHandle = setInterval(() => this.tickPositions(), TICK_INTERVAL_MS)
    this.statusHandle = setInterval(() => this.printStatus(), STATUS_INTERVAL_MS)
    this.pricePollHandle = setInterval(() => this.pollPricesForOpenPositions(), PRICE_POLL_INTERVAL_MS)

    setTimeout(() => this.printStatus(), 5000)
    console.log('[Darwin] All systems running. Waiting for market signals...')
  }

  private seedPopulation(): void {
    const popSize = parseInt(process.env.DARWIN_POP_SIZE || '16', 10)
    console.log('[Darwin] Seeding initial population of ' + popSize + ' strategies...')
    for (let i = 0; i < popSize; i++) {
      const genome = createRandom(0)
      this.population.spawn(genome, true)
    }
    console.log('[Darwin] Population seeded: ' + this.population.size() + ' strategies ready')
  }

  private async onSignal(signal: MarketSignal): Promise<void> {
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
    const allOpen = this.paperExecutor.getOpenPositions()
    const committedCapital = allOpen.reduce((sum, p) => sum + p.sizeSol, 0)
    let availableCapital = Math.max(0, this.bankroll.getCurrentBalance() - committedCapital)

    for (const strategy of strategies) {
      try {
        if (availableCapital < 0.01) break  // No capital left — skip remaining strategies

        const openCount = this.paperExecutor.getOpenPositionCount(strategy.id)
        if (openCount >= strategy.genome.risk.maxConcurrent) continue
        if (this.bankroll.isDrawdownBreached()) continue

        const priceHistory = this.feed.getPriceHistory(signal.mint)
        const fired = strategy.evaluateSignal(signal, priceHistory)

        if (fired) {
          // Size against available capital, not total balance, to prevent over-leverage
          const sizeSol = Math.min(
            availableCapital * strategy.genome.risk.capitalPct,
            signal.liquiditySol * strategy.genome.risk.maxPoolPct,
            availableCapital * 0.95
          )

          if (sizeSol < 0.001) continue

          const pos = this.paperExecutor.open(
            signal,
            strategy.genome,
            strategy.id,
            sizeSol,
            entryPrice
          )

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

  private tickPositions(): void {
    const currentPrices = new Map<string, number>()
    const openPositions = this.paperExecutor.getOpenPositions()

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

    const closedTrades = this.paperExecutor.tick(currentPrices, genomes)

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
    const openPositions = this.paperExecutor.getOpenPositions()
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
            console.warn(
              '[Darwin] PRICE SANITY REJECTED: ' + mint.slice(0, 8) +
              '... price=' + price.toFixed(8) +
              ' entry=' + entryPrice.toFixed(8) +
              ' ratio=' + (price / entryPrice).toFixed(0) + 'x (pool likely drained)'
            )
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

  private printStatus(): void {
    const strategies = this.population.getAll()
    const paper = this.population.getPaperStrategies()
    const live = this.population.getLiveStrategies()
    const balance = this.bankroll.getCurrentBalance()
    const openCount = this.paperExecutor.getOpenPositionCount()

    const scored = strategies.map((s) => s.getFitness()).filter((f) => f.tradeCount > 0)
    scored.sort((a, b) => b.score - a.score)

    const bestFitness = scored.length > 0 ? scored[0].score : 0
    const timeSinceLast = Date.now() - this.lastGenerationAt
    const timeUntilGen = Math.max(0, GENERATION_INTERVAL_MS - timeSinceLast)
    const tradesUntilGen = Math.max(0, GENERATION_TRADE_THRESHOLD - this.totalTradesSinceGeneration)

    const h = Math.floor(timeUntilGen / (1000 * 60 * 60))
    const m = Math.floor((timeUntilGen % (1000 * 60 * 60)) / (1000 * 60))

    console.log(
      '[Darwin] Pop: ' + strategies.length + ' (' + paper.length + ' paper, ' + live.length + ' live)' +
      ' | Trades: ' + this.totalTrades +
      ' | Open: ' + openCount +
      ' | Best fitness: ' + bestFitness.toFixed(3) +
      ' | Bankroll: ' + balance.toFixed(4) + ' SOL'
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
