import { MISSION_CONFIG, getStartingBalanceSol, getTierPriority } from '../config/mission'
import {
  ClosedTrade,
  FitnessScore,
  StrategyAssessment,
  StrategyAssessmentMetrics,
  StrategyAssessmentTier,
} from '../types'

const SCORE_BASE: Record<StrategyAssessmentTier, number> = {
  hard_fail: -1000,
  tier_c: 100,
  tier_b: 200,
  tier_a: 300,
}

export interface AssessTradesOptions {
  strategyId: string
  genomeId: string
  trades: ClosedTrade[]
  startedAt: number
  now?: number
  startingBalanceSol?: number
}

export function assessTrades(options: AssessTradesOptions): StrategyAssessment {
  const now = options.now ?? Date.now()
  const startedAt = options.startedAt
  const elapsedMs = Math.max(0, now - startedAt)
  const startingBalanceSol = options.startingBalanceSol ?? getStartingBalanceSol()
  const trades = sanitizeTrades(options.trades)
  const metrics = computeMetrics(trades, elapsedMs, startingBalanceSol)
  const gateFailures = computeGateFailures(metrics, elapsedMs)
  const tier = resolveTier(metrics, gateFailures)
  const rankKey = buildRankKey(metrics)
  const score = buildCompatibilityScore(tier, metrics)

  return {
    strategyId: options.strategyId,
    genomeId: options.genomeId,
    metrics,
    tier,
    gateFailures,
    rankKey,
    tradeCount: metrics.tradeCount,
    upsideCapture: metrics.avgWinnerPct / 100,
    bestTradeReturn: metrics.bestTradePct / 100,
    profitFactor: metrics.profitFactor,
    tradeFrequency: metrics.tradesPerHour,
    maxDrawdownPct: metrics.maxDrawdownPct / 100,
    totalPnlSol: metrics.totalPnlSol,
    score,
    computedAt: now,
    disqualified: tier === 'hard_fail',
    disqualifyReason: gateFailures[0],
  }
}

export function compareAssessments(a: FitnessScore, b: FitnessScore): number {
  const tierDelta = getTierPriority(b.tier) - getTierPriority(a.tier)
  if (tierDelta !== 0) return tierDelta
  return compareRankKeys(b.rankKey, a.rankKey)
}

export function compareRankKeys(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const aValue = a[index] ?? 0
    const bValue = b[index] ?? 0
    if (aValue === bValue) continue
    return aValue > bValue ? 1 : -1
  }
  return 0
}

export function meetsMicroLiveAcceptance(assessment: StrategyAssessment): boolean {
  const metrics = assessment.metrics
  const acceptance = MISSION_CONFIG.microLiveAcceptance
  return (
    assessment.tier === 'tier_a' &&
    metrics.migrationTrades >= acceptance.minMigrationTrades &&
    metrics.migrationShare >= acceptance.minMigrationSharePct &&
    metrics.migrationWinRate >= acceptance.minMigrationWinRatePct &&
    metrics.noPumpBailPct <= acceptance.maxNoPumpBailPct &&
    metrics.maxDrawdownPct <= acceptance.maxDrawdownPct &&
    metrics.bestTradePct >= acceptance.minBestTradePct &&
    metrics.totalPnlSol > acceptance.minTotalPnlSol
  )
}

function sanitizeTrades(trades: ClosedTrade[]): ClosedTrade[] {
  return trades.map((trade) => ({
    ...trade,
    pnlPct: Math.max(-1.0, Math.min(trade.pnlPct, 100.0)),
    pnlSol: Math.max(-trade.sizeSol, Math.min(trade.pnlSol, trade.sizeSol * 100)),
  }))
}

function computeMetrics(
  trades: ClosedTrade[],
  elapsedMs: number,
  startingBalanceSol: number
): StrategyAssessmentMetrics {
  const winners = trades.filter((trade) => trade.pnlSol > 0)
  const losers = trades.filter((trade) => trade.pnlSol <= 0)
  const grossWinsSol = winners.reduce((sum, trade) => sum + trade.pnlSol, 0)
  const grossLossesSol = Math.abs(losers.reduce((sum, trade) => sum + trade.pnlSol, 0))
  const profitFactor = grossLossesSol === 0
    ? (grossWinsSol > 0 ? MISSION_CONFIG.profitFactorCap : 0)
    : Math.min(grossWinsSol / grossLossesSol, MISSION_CONFIG.profitFactorCap)

  const totalPnlSol = trades.reduce((sum, trade) => sum + trade.pnlSol, 0)
  const migrationTrades = trades.filter((trade) => trade.signalType === 'migration')
  const migrationWinners = migrationTrades.filter((trade) => trade.pnlSol > 0)
  const noPumpBailCount = trades.filter((trade) => trade.exitReason === 'no_pump_bail').length
  const trackedFillTrades = trades.filter((trade) => typeof trade.fillRatio === 'number')

  return {
    bankrollGrowthPct: toPct(totalPnlSol / Math.max(startingBalanceSol, 0.000001)),
    avgWinnerPct: winners.length > 0
      ? winners.reduce((sum, trade) => sum + trade.pnlPct, 0) / winners.length * 100
      : 0,
    bestTradePct: trades.length > 0 ? Math.max(...trades.map((trade) => trade.pnlPct * 100)) : 0,
    migrationShare: trades.length > 0 ? toPct(migrationTrades.length / trades.length) : 0,
    migrationWinRate: migrationTrades.length > 0 ? toPct(migrationWinners.length / migrationTrades.length) : 0,
    profitFactor,
    noPumpBailPct: trades.length > 0 ? toPct(noPumpBailCount / trades.length) : 0,
    maxDrawdownPct: computeMaxDrawdownPct(trades, startingBalanceSol),
    tradeCount: trades.length,
    migrationTrades: migrationTrades.length,
    fillRatio: trackedFillTrades.length > 0
      ? trackedFillTrades.reduce((sum, trade) => sum + (trade.fillRatio || 0), 0) / trackedFillTrades.length
      : 1,
    totalPnlSol,
    tradesPerHour: trades.length / Math.max(elapsedMs / (1000 * 60 * 60), 0.001),
    winners: winners.length,
    losers: losers.length,
    grossWinsSol,
    grossLossesSol,
    noPumpBailCount,
    migrationWinners: migrationWinners.length,
    currentBalanceSol: startingBalanceSol + totalPnlSol,
    startingBalanceSol,
  }
}

function computeGateFailures(metrics: StrategyAssessmentMetrics, elapsedMs: number): string[] {
  const failures: string[] = []
  const elapsedHours = elapsedMs / (1000 * 60 * 60)
  const elapsedMinutes = elapsedMs / (1000 * 60)
  const nonMigrationShare = 100 - metrics.migrationShare

  if (elapsedHours >= 4 && metrics.tradeCount < MISSION_CONFIG.hardFail.minTradesAfter4h) {
    failures.push('less_than_30_trades_after_4h')
  }
  if (metrics.maxDrawdownPct > MISSION_CONFIG.hardFail.maxDrawdownPct) {
    failures.push('drawdown_exceeds_60pct')
  }
  if (
    metrics.tradeCount >= 100 &&
    metrics.bestTradePct < MISSION_CONFIG.hardFail.minBestTradePctAfter100Trades
  ) {
    failures.push('best_trade_below_20pct_after_100_trades')
  }
  if (
    metrics.migrationTrades === 0 &&
    (metrics.tradeCount >= MISSION_CONFIG.hardFail.migrationRequiredTrades ||
      elapsedMinutes >= MISSION_CONFIG.hardFail.migrationRequiredMinutes)
  ) {
    failures.push('zero_migration_trades_after_5_trades_or_15m')
  }
  if (
    metrics.tradeCount >= 10 &&
    nonMigrationShare > MISSION_CONFIG.hardFail.maxNonMigrationSharePctAfter10Trades
  ) {
    failures.push('non_migration_share_above_40pct_after_10_trades')
  }
  if (
    metrics.tradeCount >= 10 &&
    metrics.noPumpBailPct > MISSION_CONFIG.hardFail.maxNoPumpBailPctAfter10Trades
  ) {
    failures.push('no_pump_bail_above_80pct_after_10_trades')
  }

  return failures
}

function resolveTier(
  metrics: StrategyAssessmentMetrics,
  gateFailures: string[]
): StrategyAssessmentTier {
  if (gateFailures.length > 0) return 'hard_fail'

  if (meetsTierThreshold(metrics, MISSION_CONFIG.tiers.tier_a)) {
    return 'tier_a'
  }

  if (meetsTierThreshold(metrics, MISSION_CONFIG.tiers.tier_b)) {
    return 'tier_b'
  }

  return 'tier_c'
}

function meetsTierThreshold(
  metrics: StrategyAssessmentMetrics,
  thresholds: {
    migrationSharePct: number
    migrationWinRatePct: number
    maxNoPumpBailPct: number
    minBestTradePct: number
    maxDrawdownPct: number
    minFillRatio: number
  }
): boolean {
  return (
    metrics.migrationShare >= thresholds.migrationSharePct &&
    metrics.migrationWinRate >= thresholds.migrationWinRatePct &&
    metrics.noPumpBailPct <= thresholds.maxNoPumpBailPct &&
    metrics.bestTradePct >= thresholds.minBestTradePct &&
    metrics.maxDrawdownPct <= thresholds.maxDrawdownPct &&
    metrics.fillRatio >= thresholds.minFillRatio
  )
}

function buildRankKey(metrics: StrategyAssessmentMetrics): number[] {
  return [
    roundMetric(metrics.bankrollGrowthPct),
    roundMetric(metrics.bestTradePct),
    roundMetric(metrics.avgWinnerPct),
    roundMetric(metrics.migrationWinRate),
    roundMetric(metrics.profitFactor),
    roundMetric(-metrics.noPumpBailPct),
    roundMetric(-metrics.maxDrawdownPct),
  ]
}

function buildCompatibilityScore(
  tier: StrategyAssessmentTier,
  metrics: StrategyAssessmentMetrics
): number {
  const base = SCORE_BASE[tier]
  const fillBonus = metrics.fillRatio >= 0.5 ? metrics.fillRatio * 5 : -(0.5 - metrics.fillRatio) * 20
  return roundMetric(
    base +
    metrics.bankrollGrowthPct * 2 +
    metrics.bestTradePct * 0.25 +
    metrics.avgWinnerPct * 0.1 +
    metrics.migrationWinRate * 0.08 +
    metrics.profitFactor * 3 +
    fillBonus -
    metrics.noPumpBailPct * 0.1 -
    metrics.maxDrawdownPct * 0.1
  )
}

function computeMaxDrawdownPct(trades: ClosedTrade[], startingBalanceSol: number): number {
  if (trades.length === 0) return 0

  let peakEquity = startingBalanceSol
  let equity = startingBalanceSol
  let maxDrawdown = 0

  for (const trade of trades) {
    equity += trade.pnlSol
    if (equity > peakEquity) peakEquity = equity
    const drawdown = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0
    if (drawdown > maxDrawdown) maxDrawdown = drawdown
  }

  return toPct(maxDrawdown)
}

function toPct(value: number): number {
  return roundMetric(value * 100)
}

function roundMetric(value: number): number {
  return Math.round(value * 10000) / 10000
}
