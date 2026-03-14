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

    // Disqualifiers — only apply after sufficient time
    if (hoursActive >= 4 && trades.length < 30) {
      return this.disqualified(strategyId, genomeId, trades, hoursActive, 'less_than_30_trades_after_4hrs')
    }

    // Sanitize — cap overflow values from near-zero price tokens
    trades = trades.map(t => ({
      ...t,
      pnlPct: Math.max(-1.0, Math.min(t.pnlPct, 100.0)),
      pnlSol: Math.max(-t.sizeSol, Math.min(t.pnlSol, t.sizeSol * 100)),
    }))
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

    const grossWins = winners.reduce((s, t) => s + t.pnlSol, 0)
    const grossLosses = Math.abs(losers.reduce((s, t) => s + t.pnlSol, 0))
    const profitFactor = grossLosses === 0
      ? (grossWins > 0 ? PROFIT_FACTOR_CAP : 1)
      : Math.min(grossWins / grossLosses, PROFIT_FACTOR_CAP)

    const winRate = trades.length > 0 ? winners.length / trades.length : 0
    const tradesPerHour = trades.length / hoursActive
    const totalPnlSol = trades.reduce((s, t) => s + t.pnlSol, 0)

    // Migration analysis — the core alpha signal
    const migrationTrades = trades.filter((t) => (t as any).signalType === 'migration')
    const migrationWins = migrationTrades.filter((t) => t.pnlSol > 0)
    const migrationLosers = migrationTrades.filter((t) => t.pnlSol <= 0)
    const migrationWinRate = migrationTrades.length > 0
      ? migrationWins.length / migrationTrades.length
      : 0
    const migrationRatio = trades.length > 0
      ? migrationTrades.length / trades.length
      : 0

    // Non-migration trade analysis
    const nonMigrationTrades = trades.filter((t) => (t as any).signalType !== 'migration')
    const nonMigrationLosers = nonMigrationTrades.filter((t) => t.pnlSol <= 0)

    // no_pump_bail analysis — trades that exit with no price action are pure noise
    const noPumpBailTrades = trades.filter((t) => (t as any).exitReason === 'no_pump_bail')
    const noPumpBailPct = trades.length > 0 ? noPumpBailTrades.length / trades.length : 0

    // === SCORING ===
    // Migration performance is almost everything.

    let score = 0

    // --- MIGRATION WINS: the primary fitness signal ---
    // Each migration win is worth a lot
    score += migrationWins.length * 5.00

    // Bonus for migration win profitability (big winners matter)
    const migrationWinPnl = migrationWins.reduce((s, t) => s + t.pnlPct, 0)
    if (migrationWinPnl > 0) {
      score += Math.min(migrationWinPnl * 0.50, 10.0)
    }

    // Bonus for migration win rate
    if (migrationTrades.length >= 2 && migrationWinRate > 0.10) {
      score += (migrationWinRate - 0.10) * 10.0
    }

    // Strong bonus for high migration win rate
    if (migrationTrades.length >= 3 && migrationWinRate > 0.40) {
      score += (migrationWinRate - 0.40) * 12.0
    }

    // --- MIGRATION LOSSES: moderate penalty ---
    score -= migrationLosers.length * 0.25

    // --- NON-MIGRATION PENALTY ---
    // Each non-migration trade is devastatingly penalized
    score -= nonMigrationTrades.length * 6.00

    // Each non-migration LOSING trade is even more penalized
    score -= nonMigrationLosers.length * 5.00

    // Actual SOL lost on non-migration trades
    const nonMigrationLossSum = Math.abs(nonMigrationLosers.reduce((s, t) => s + t.pnlSol, 0))
    score -= nonMigrationLossSum * 10.00

    // --- NO_PUMP_BAIL PENALTY ---
    // Direct penalty for each no_pump_bail exit — these are wasted trades
    score -= noPumpBailTrades.length * 2.00

    // Extra penalty if no_pump_bail dominates (>40% of trades)
    if (trades.length >= 3 && noPumpBailPct > 0.40) {
      score -= (noPumpBailPct - 0.40) * 10.0
    }

    // Crushing penalty if no_pump_bail is >65%
    if (trades.length >= 4 && noPumpBailPct > 0.65) {
      score -= (noPumpBailPct - 0.65) * 20.0
    }

    // --- GENERAL COMPONENTS (small weight) ---
    score += Math.min(profitFactor, PROFIT_FACTOR_CAP) * 0.05
    score += winRate * 0.30
    score += totalPnlSol * 0.10
    score -= maxDrawdownPct * 0.15

    // --- STRUCTURAL BONUSES AND PENALTIES ---

    // Reward genomes that have at least 1 migration win
    if (migrationWins.length >= 1) {
      score += 4.00
    }
    if (migrationWins.length >= 2) {
      score += 3.00
    }
    if (migrationWins.length >= 3) {
      score += 2.00
    }

    // Bonus for genomes that are 100% migration
    if (trades.length >= 2 && nonMigrationTrades.length === 0) {
      score += 12.00
    }

    // Small encouragement for genomes trying migration but not winning yet
    if (migrationTrades.length > 0 && migrationWins.length === 0 && migrationTrades.length <= 3) {
      score += 0.10
    }

    // Frequency spam tax
    if (tradesPerHour > 4) {
      score -= (tradesPerHour - 4) * 0.05
    }

    // Win rate floor
    if (winRate < 0.08 && trades.length >= 5) {
      score -= (0.08 - winRate) * 1.5
    }

    // === THE KEY GATE: Migration ratio multiplier ===
    // After enough trades, if migration ratio is too low, crush the score.
    // This is the strongest evolutionary pressure — genomes MUST trade migrations ONLY.
    if (trades.length >= 2) {
      if (migrationRatio >= 1.0) {
        // Pure migration genome — maximum bonus multiplier
        score *= 2.5
      } else if (migrationRatio >= 0.95) {
        // Nearly pure — strong boost
        score *= 1.8
      } else if (migrationRatio >= 0.90) {
        // Mostly migration — moderate boost
        score *= 1.2
      } else if (migrationRatio >= 0.80) {
        // Too many non-migration — penalize
        score *= 0.4
      } else if (migrationRatio >= 0.70) {
        // Bad ratio — heavy penalty
        score *= 0.10
      } else {
        // Dominated by non-migration — near-zero
        score *= 0.01
      }
    }

    // Hard disqualifier: 5+ trades, zero migration, 10+ minutes
    if (trades.length >= 5 && migrationTrades.length === 0 && hoursActive > 0.167) {
      score = Math.min(score, -20.0)
    }

    // Hard disqualifier: 3+ trades, zero migration
    if (trades.length >= 3 && migrationTrades.length === 0) {
      score = Math.min(score, -15.0)
    }

    // Hard disqualifier: high no_pump_bail with many trades
    if (trades.length >= 5 && noPumpBailPct > 0.75) {
      score = Math.min(score, -8.0)
    }

    // Hard disqualifier: any genome with ANY non-migration trade after 2+ total trades
    // This is the key change — zero tolerance for non-migration signals
    if (trades.length >= 2 && nonMigrationTrades.length >= 1) {
      // Scale penalty by how many non-migration trades there are
      const nonMigPenaltyFactor = Math.max(0.02, Math.pow(0.08, nonMigrationTrades.length))
      score = Math.min(score, score * nonMigPenaltyFactor)
    }

    const upsideCapture = winners.length > 0
      ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length
      : 0
    const bestTradeReturn = trades.length > 0
      ? Math.max(...trades.map((t) => t.pnlPct))
      : 0

    const tradeFrequency = winRate

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