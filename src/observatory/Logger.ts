// ============================================================================
// Logger — writes to jsonl files and SQLite for human observability
// ============================================================================

import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { Genome, FitnessScore, ClosedTrade, GenerationResult, MarketSignal } from '../types'

const LOG_DIR = process.env.LOG_DIR || path.resolve(process.cwd(), 'logs')
const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'darwin.db')

export class Logger {
  private db!: Database.Database
  private graveyardPath: string
  private generationLogPath: string
  private tradesPath: string
  private bankrollPath: string
  private signalSkipsPath: string

  constructor() {
    // Ensure log dir exists
    fs.mkdirSync(LOG_DIR, { recursive: true })

    this.graveyardPath = path.join(process.cwd(), 'graveyard.jsonl')
    this.generationLogPath = path.join(LOG_DIR, 'generation_log.jsonl')
    this.tradesPath = path.join(process.cwd(), 'trades.jsonl')
    this.bankrollPath = path.join(LOG_DIR, 'bankroll.jsonl')
    this.signalSkipsPath = path.join(LOG_DIR, 'signal_skips.jsonl')
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
        is_paper INTEGER,
        signal_type TEXT,
        pool_liq_sol REAL,
        desired_size_sol REAL,
        capped_size_sol REAL,
        pool_cap_sol REAL,
        fill_ratio REAL
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

      CREATE TABLE IF NOT EXISTS genomes (
        genome_id TEXT PRIMARY KEY,
        genome_json TEXT NOT NULL,
        fitness_score REAL,
        trade_count INTEGER,
        win_rate REAL,
        total_pnl_sol REAL,
        generation INTEGER,
        saved_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_genomes_score ON genomes(fitness_score DESC);

      CREATE TABLE IF NOT EXISTS signal_skips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT,
        pool TEXT,
        signal_type TEXT,
        reason TEXT,
        details_json TEXT,
        logged_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_signal_skips_logged_at ON signal_skips(logged_at);
    `)
    this.ensureColumn('trades', 'pool_liq_sol', 'REAL')
    this.ensureColumn('trades', 'desired_size_sol', 'REAL')
    this.ensureColumn('trades', 'capped_size_sol', 'REAL')
    this.ensureColumn('trades', 'pool_cap_sol', 'REAL')
    this.ensureColumn('trades', 'fill_ratio', 'REAL')
    console.log('[Logger] DB initialized at ' + DB_PATH)
  }

  public logGraveyard(genome: Genome, fitness: FitnessScore, reason: string): void {
    const entry = {
      genomeId: genome.id,
      strategyId: fitness.strategyId,
      fitness: fitness.score,
      tradeCount: fitness.tradeCount,
      totalPnlSol: fitness.totalPnlSol,
      tier: fitness.tier,
      gateFailures: fitness.gateFailures,
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
      topTier: result.scores.length > 0 ? result.scores[0].tier : 'hard_fail',
      scores: result.scores.map((s) => ({
        strategyId: s.strategyId,
        tier: s.tier,
        score: s.score,
        tradeCount: s.tradeCount,
        totalPnlSol: s.totalPnlSol,
        bankrollGrowthPct: s.metrics.bankrollGrowthPct,
        migrationShare: s.metrics.migrationShare,
        migrationWinRate: s.metrics.migrationWinRate,
        noPumpBailPct: s.metrics.noPumpBailPct,
        fillRatio: s.metrics.fillRatio,
        disqualified: s.disqualified,
        gateFailures: s.gateFailures,
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
            opened_at, closed_at, hold_ms, is_paper, signal_type,
            pool_liq_sol, desired_size_sol, capped_size_sol, pool_cap_sol, fill_ratio
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?
          )
        `).run(
          trade.id, trade.strategyId, trade.genomeId, trade.mint, trade.pool,
          trade.entryPriceSol, trade.exitPriceSol, trade.sizeSol,
          trade.pnlSol, trade.pnlPct, trade.mfePct, trade.maePct, trade.exitReason,
          trade.openedAt, trade.closedAt, trade.holdMs, trade.isPaper ? 1 : 0,
          trade.signalType || null,
          trade.poolLiqSol ?? null,
          trade.desiredSizeSol ?? null,
          trade.cappedSizeSol ?? null,
          trade.poolCapSol ?? null,
          trade.fillRatio ?? null
        )
      } catch (e) {}
    }
  }

  public logSignalSkip(signal: MarketSignal, reason: string, details: Record<string, any> = {}): void {
    const entry = {
      timestamp: Date.now(),
      reason,
      signal,
      details,
    }
    this.appendJsonl(this.signalSkipsPath, entry)

    if (this.db) {
      try {
        this.db.prepare(`
          INSERT INTO signal_skips (mint, pool, signal_type, reason, details_json, logged_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          signal.mint,
          signal.pool,
          signal.type,
          reason,
          JSON.stringify(details),
          entry.timestamp
        )
      } catch (e) {}
    }
  }

  public logBankroll(balance: number, timestamp: number): void {
    this.appendJsonl(this.bankrollPath, { balance, timestamp })
  }

  public saveGenome(genome: Genome, fitness: FitnessScore): void {
    if (!this.db) return
    try {
      const winRate = fitness.metrics.tradeCount > 0
        ? fitness.metrics.migrationWinRate / 100
        : 0
      const insertSql = 'INSERT OR REPLACE INTO genomes (genome_id, genome_json, fitness_score, trade_count, win_rate, total_pnl_sol, generation, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      this.db.prepare(insertSql).run(
        genome.id,
        JSON.stringify(genome),
        fitness.score,
        fitness.tradeCount,
        winRate,
        fitness.totalPnlSol,
        genome.generation,
        Date.now()
      )
    } catch (e) { console.error('[Logger] saveGenome error:', e) }
  }

  public loadBestGenomes(limit = 10): Genome[] {
    if (!this.db) return []
    try {
      const selectSql = 'SELECT genome_json FROM genomes WHERE trade_count >= 3 ORDER BY fitness_score DESC LIMIT ?'
      const rows = this.db.prepare(selectSql).all(limit) as { genome_json: string }[]
      const genomes = rows.map((r) => JSON.parse(r.genome_json) as Genome)
      console.log('[Logger] Loaded ' + genomes.length + ' persisted genomes from DB')
      return genomes
    } catch (e) {
      console.error('[Logger] loadBestGenomes error:', e)
      return []
    }
  }

  private appendJsonl(filePath: string, data: any): void {
    try {
      fs.appendFileSync(filePath, JSON.stringify(data) + '\n')
    } catch (e) {
      console.error('[Logger] Failed to write to ' + filePath + ':', e)
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    if (!this.db) return
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (rows.some((row) => row.name === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}
