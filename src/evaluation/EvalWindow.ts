import path from 'path'
import Database from 'better-sqlite3'
import { getStartingBalanceSol } from '../config/mission'
import { assessTrades, meetsMicroLiveAcceptance } from '../evolution/MissionAssessment'
import { ClosedTrade, FitnessScore } from '../types'

export interface EvalWindowOptions {
  sinceTsMs: number
  dbPath?: string
  now?: number
}

type TradeRow = {
  id: string
  strategy_id: string
  genome_id: string
  mint: string
  pool: string
  entry_price_sol: number
  exit_price_sol: number
  size_sol: number
  pnl_sol: number
  pnl_pct: number
  mfe_pct: number
  mae_pct: number
  exit_reason: string
  opened_at: number
  closed_at: number
  hold_ms: number
  is_paper: number
  signal_type: ClosedTrade['signalType']
  pool_liq_sol: number | null
  desired_size_sol: number | null
  capped_size_sol: number | null
  pool_cap_sol: number | null
  fill_ratio: number | null
}

export function evaluateTradeWindow(options: EvalWindowOptions): FitnessScore {
  const dbPath = options.dbPath || path.resolve(process.cwd(), 'darwin.db')
  const db = new Database(dbPath, { readonly: true })
  try {
    let rows: TradeRow[] = []
    try {
      rows = db.prepare(`
        SELECT
          id, strategy_id, genome_id, mint, pool,
          entry_price_sol, exit_price_sol, size_sol,
          pnl_sol, pnl_pct, mfe_pct, mae_pct, exit_reason,
          opened_at, closed_at, hold_ms, is_paper, signal_type,
          pool_liq_sol, desired_size_sol, capped_size_sol, pool_cap_sol, fill_ratio
        FROM trades
        WHERE closed_at > ? AND is_paper = 1
        ORDER BY closed_at ASC
      `).all(options.sinceTsMs) as TradeRow[]
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('no such table: trades')) {
        throw error
      }
    }

    const trades = rows.map(mapTradeRow)
    return assessTrades({
      strategyId: 'paper_window',
      genomeId: 'paper_window',
      trades,
      startedAt: options.sinceTsMs,
      now: options.now,
      startingBalanceSol: getStartingBalanceSol(),
    })
  } finally {
    db.close()
  }
}

export function formatAssessmentForOutput(assessment: FitnessScore): Record<string, unknown> {
  return {
    strategy_id: assessment.strategyId,
    genome_id: assessment.genomeId,
    tier: assessment.tier,
    gate_failures: assessment.gateFailures,
    rank_key: assessment.rankKey,
    metrics: assessment.metrics,
    meets_micro_live_acceptance: meetsMicroLiveAcceptance(assessment),
    score: assessment.score,
    trades: assessment.metrics.tradeCount,
    trade_count: assessment.metrics.tradeCount,
    bankroll_growth_pct: assessment.metrics.bankrollGrowthPct,
    avg_winner_pct: assessment.metrics.avgWinnerPct,
    best_trade_pct: assessment.metrics.bestTradePct,
    migration_share: assessment.metrics.migrationShare,
    migration_win_rate: assessment.metrics.migrationWinRate,
    profit_factor: assessment.metrics.profitFactor,
    no_pump_bail_pct: assessment.metrics.noPumpBailPct,
    max_drawdown_pct: assessment.metrics.maxDrawdownPct,
    fill_ratio: assessment.metrics.fillRatio,
    migration_trades: assessment.metrics.migrationTrades,
    total_pnl_sol: assessment.metrics.totalPnlSol,
    gross_wins_sol: assessment.metrics.grossWinsSol,
    gross_losses_sol: assessment.metrics.grossLossesSol,
    winners: assessment.metrics.winners,
    losers: assessment.metrics.losers,
    no_pump_bail_count: assessment.metrics.noPumpBailCount,
    migration_winners: assessment.metrics.migrationWinners,
    disqualified: assessment.disqualified,
    disqualify_reason: assessment.disqualifyReason || null,
  }
}

function mapTradeRow(row: TradeRow): ClosedTrade {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    genomeId: row.genome_id,
    mint: row.mint,
    pool: row.pool,
    entryPriceSol: row.entry_price_sol,
    exitPriceSol: row.exit_price_sol,
    sizeSol: row.size_sol,
    pnlSol: row.pnl_sol,
    pnlPct: row.pnl_pct,
    mfePct: row.mfe_pct,
    maePct: row.mae_pct,
    exitReason: row.exit_reason,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    holdMs: row.hold_ms,
    isPaper: row.is_paper === 1,
    signalType: row.signal_type,
    poolLiqSol: row.pool_liq_sol ?? undefined,
    desiredSizeSol: row.desired_size_sol ?? undefined,
    cappedSizeSol: row.capped_size_sol ?? undefined,
    poolCapSol: row.pool_cap_sol ?? undefined,
    fillRatio: row.fill_ratio ?? undefined,
  }
}
