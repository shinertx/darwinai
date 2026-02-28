// ============================================================================
// FitnessScorer — computes fitness for a strategy's trade history
// ============================================================================

import { ClosedTrade, FitnessScore } from '../types'

const PROFIT_FACTOR_CAP = 10

export class FitnessScorer {
  public score(
    strategyId: string,
    genomeId: string,
    trades: ClosedTrade[],
    startedAt: number
  ): FitnessScore {
    const now = Date.now()
    const hoursActive = Math.max((now - startedAt) / (1000 * 60 * 60), 0.001)

    // Disqualifiers
    if (hoursActive >= 4 && trades.length < 30) {
      return this.disqualified(strategyId, genomeId, trades, hoursActive, 'less_than_30_trades_after_4hrs')
    }

    const maxDrawdownPct = this.computeMaxDrawdown(trades)

    if (maxDrawdownPct > 0.60) {
      return this.disqualified(strategyId, genomeId, trades, hoursActive, 'drawdown_exceeds_60pct')
    }

    if (trades.length >= 100) {
      const bestReturn = trades.length > 0 ? Math.max(...trades.map((t) => t.pnlPct)) : 0
      if (bestReturn < 0.20) {
        return this.disqualified(strategyId, genomeId, trades, hoursActive, 'best_return_under_20pct_after_100_trades')
      }
    }

    const winners = trades.filter((t) => t.pnlSol > 0)
    const losers = trades.filter((t) => t.pnlSol <= 0)

    const upsideCapture = winners.length > 0
      ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length
      : 0

    const bestTradeReturn = trades.length > 0
      ? Math.max(...trades.map((t) => t.pnlPct))
      : 0

    const grossWins = winners.reduce((s, t) => s + t.pnlSol, 0)
    const grossLosses = Math.abs(losers.reduce((s, t) => s + t.pnlSol, 0))
    const profitFactor = grossLosses === 0
      ? (grossWins > 0 ? PROFIT_FACTOR_CAP : 1)
      : Math.min(grossWins / grossLosses, PROFIT_FACTOR_CAP)

    // Normalize trade frequency: 5-20 trades/hr = 1.0
    const tradesPerHour = trades.length / hoursActive
    const tradeFrequency = Math.min(tradesPerHour / 20, 1.0)

    const totalPnlSol = trades.reduce((s, t) => s + t.pnlSol, 0)

    // Fitness formula from GENESIS.md
    const score = (
      upsideCapture * 0.35 +
      bestTradeReturn * 0.20 +
      profitFactor * 0.20 +
      tradeFrequency * 0.15 -
      maxDrawdownPct * 0.10
    )

    return {
      strategyId,
      genomeId,
      tradeCount: trades.length,
      upsideCapture,
      bestTradeReturn,
      profitFactor,
      tradeFrequency,
      maxDrawdownPct,
      totalPnlSol,
      score,
      computedAt: now,
      disqualified: false,
    }
  }

  private disqualified(
    strategyId: string,
    genomeId: string,
    trades: ClosedTrade[],
    hoursActive: number,
    reason: string
  ): FitnessScore {
    return {
      strategyId,
      genomeId,
      tradeCount: trades.length,
      upsideCapture: 0,
      bestTradeReturn: 0,
      profitFactor: 0,
      tradeFrequency: trades.length / Math.max(hoursActive, 0.001),
      maxDrawdownPct: this.computeMaxDrawdown(trades),
      totalPnlSol: trades.reduce((s, t) => s + t.pnlSol, 0),
      score: -999,
      computedAt: Date.now(),
      disqualified: true,
      disqualifyReason: reason,
    }
  }

  private computeMaxDrawdown(trades: ClosedTrade[]): number {
    if (trades.length === 0) return 0
    let peak = 0
    let running = 0
    let maxDD = 0
    for (const t of trades) {
      running += t.pnlSol
      if (running > peak) peak = running
      const dd = peak > 0 ? (peak - running) / peak : 0
      if (dd > maxDD) maxDD = dd
    }
    return maxDD
  }
}
