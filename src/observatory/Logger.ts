// ============================================================================
// Logger — writes to jsonl files and SQLite for human observability
// ============================================================================

import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { Genome, FitnessScore, ClosedTrade, GenerationResult } from '../types'

const LOG_DIR = process.env.LOG_DIR || path.resolve(process.cwd(), 'logs')
const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'darwin.db')

export class Logger {
  private db!: Database.Database
  private graveyardPath: string
  private generationLogPath: string
  private tradesPath: string
  private bankrollPath: string

  constructor() {
    // Ensure log dir exists
    fs.mkdirSync(LOG_DIR, { recursive: true })

    this.graveyardPath = path.join(process.cwd(), 'graveyard.jsonl')
    this.generationLogPath = path.join(LOG_DIR, 'generation_log.jsonl')
    this.tradesPath = path.join(process.cwd(), 'trades.jsonl')
    this.bankrollPath = path.join(LOG_DIR, 'bankroll.jsonl')
  }

  public initDb(): void {
    this.db = new Database(DB_PATH)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        strategy_id TEXT,
        genome_id TEXT,
        mint TEXT,
        pool TEXT,
        entry_price_sol REAL,
        exit_price_sol REAL,
        size_sol REAL,
        pnl_sol REAL,
        pnl_pct REAL,
        mfe_pct REAL,
        mae_pct REAL,
        exit_reason TEXT,
        opened_at INTEGER,
        closed_at INTEGER,
        hold_ms INTEGER,
        is_paper INTEGER
      );

      CREATE TABLE IF NOT EXISTS graveyard (
        genome_id TEXT,
        strategy_id TEXT,
        score REAL,
        trade_count INTEGER,
        reason TEXT,
        died_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_id);
      CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
      CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades(closed_at);
    `)
    console.log('[Logger] DB initialized at ' + DB_PATH)
  }

  public logGraveyard(genome: Genome, fitness: FitnessScore, reason: string): void {
    const entry = {
      genomeId: genome.id,
      strategyId: fitness.strategyId,
      fitness: fitness.score,
      tradeCount: fitness.tradeCount,
      totalPnlSol: fitness.totalPnlSol,
      reason,
      diedAt: Date.now(),
      genome,
    }
    this.appendJsonl(this.graveyardPath, entry)

    if (this.db) {
      try {
        this.db.prepare(`
          INSERT OR IGNORE INTO graveyard (genome_id, strategy_id, score, trade_count, reason, died_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(genome.id, fitness.strategyId, fitness.score, fitness.tradeCount, reason, Date.now())
      } catch (e) {}
    }
  }

  public logGeneration(result: GenerationResult): void {
    const entry = {
      generation: result.generation,
      timestamp: Date.now(),
      killed: result.kill.length,
      preserved: result.preserve.length,
      newGenomes: result.newGenomes.length,
      topScore: result.scores.length > 0 ? result.scores[0].score : 0,
      scores: result.scores.map((s) => ({
        strategyId: s.strategyId,
        score: s.score,
        tradeCount: s.tradeCount,
        totalPnlSol: s.totalPnlSol,
        disqualified: s.disqualified,
      })),
    }
    this.appendJsonl(this.generationLogPath, entry)
  }

  public logTrade(trade: ClosedTrade): void {
    this.appendJsonl(this.tradesPath, trade)

    if (this.db) {
      try {
        this.db.prepare(`
          INSERT OR IGNORE INTO trades (
            id, strategy_id, genome_id, mint, pool,
            entry_price_sol, exit_price_sol, size_sol,
            pnl_sol, pnl_pct, mfe_pct, mae_pct, exit_reason,
            opened_at, closed_at, hold_ms, is_paper
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?
          )
        `).run(
          trade.id, trade.strategyId, trade.genomeId, trade.mint, trade.pool,
          trade.entryPriceSol, trade.exitPriceSol, trade.sizeSol,
          trade.pnlSol, trade.pnlPct, trade.mfePct, trade.maePct, trade.exitReason,
          trade.openedAt, trade.closedAt, trade.holdMs, trade.isPaper ? 1 : 0
        )
      } catch (e) {}
    }
  }

  public logBankroll(balance: number, timestamp: number): void {
    this.appendJsonl(this.bankrollPath, { balance, timestamp })
  }

  private appendJsonl(filePath: string, data: any): void {
    try {
      fs.appendFileSync(filePath, JSON.stringify(data) + '\n')
    } catch (e) {
      console.error('[Logger] Failed to write to ' + filePath + ':', e)
    }
  }
}
