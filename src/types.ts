// ============================================================================
// Darwin Types — All interfaces for the evolutionary trading organism
// ============================================================================

export type SignalType =
  | 'migration_signal' | 'new_pool_age' | 'liquidity_depth'
  | 'volume_spike' | 'buy_pressure' | 'large_tx_count'
  | 'price_momentum' | 'price_breakout' | 'acceleration'
  | 'whale_entry' | 'holder_concentration' | 'deployer_history'
  | 'AND' | 'OR' | 'NOT' | 'THRESHOLD' | 'SEQUENCE' | 'WEIGHTED_SUM'

export interface SignalNode {
  id: string
  type: SignalType
  params: Record<string, number>
  inputs: string[]  // node IDs feeding into this
}

export interface EntryGenome {
  nodes: SignalNode[]
  outputNodeId: string
}

export interface ExitGenome {
  takeProfitPct: number        // e.g. 0.5 = 50%
  trailingActivatePct: number  // activate trail at this gain
  trailingDistancePct: number  // trail this far below peak
  timeStopMs: number           // max hold time
  noPumpBailMs: number         // bail if no movement after entry
  fadeGivebackPct: number      // exit when pump reverses this much from peak
  moonbagPct: number           // keep this % of position open after main exit (0 = disabled)
}

export interface RiskGenome {
  capitalPct: number           // 0.0-1.0, fraction of bankroll per trade
  maxConcurrent: number        // max open positions
  drawdownPausePct: number     // pause if bankroll drops this % from peak
  cooldownMs: number           // min ms between entries
  maxPoolPct: number           // never enter if position > this % of pool liq
}

export interface Genome {
  id: string
  entry: EntryGenome
  exit: ExitGenome
  risk: RiskGenome
  generation: number
  parentIds: string[]
  createdAt: number
}

export interface MarketSignal {
  type: 'migration' | 'whale_buy' | 'new_pool' | 'amm_activity'
  mint: string
  pool: string
  liquiditySol: number
  poolAgeMs: number
  priceSol: number
  eventData: Record<string, any>
  timestamp: number
}

export interface PricePoint {
  price: number
  timestamp: number
  volume?: number
}

export interface Position {
  id: string
  strategyId: string
  genomeId: string
  mint: string
  pool: string
  entryPriceSol: number
  sizeSol: number
  openedAt: number
  peakPriceSol: number
  lowestPriceSol: number
  isPaper: boolean
  poolLiqSol: number
}

export interface ClosedTrade {
  id: string
  strategyId: string
  genomeId: string
  mint: string
  pool: string
  entryPriceSol: number
  exitPriceSol: number
  sizeSol: number
  pnlSol: number
  pnlPct: number
  mfePct: number         // max favorable excursion
  maePct: number         // max adverse excursion
  exitReason: string
  openedAt: number
  closedAt: number
  holdMs: number
  isPaper: boolean
}

export interface FitnessScore {
  strategyId: string
  genomeId: string
  tradeCount: number
  upsideCapture: number     // avg return on winning trades
  bestTradeReturn: number   // best single trade %
  profitFactor: number      // gross wins / gross losses
  tradeFrequency: number    // trades per hour
  maxDrawdownPct: number
  totalPnlSol: number
  score: number             // composite fitness
  computedAt: number
  disqualified: boolean
  disqualifyReason?: string
}

export interface StrategyRecord {
  id: string
  genomeId: string
  genome: Genome
  trades: ClosedTrade[]
  startedAt: number
  isPaper: boolean
}

export interface GenerationResult {
  kill: string[]
  preserve: string[]
  newGenomes: Genome[]
  generation: number
  scores: FitnessScore[]
}
