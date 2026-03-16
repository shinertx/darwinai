import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { assessTrades, compareAssessments } from '../evolution/MissionAssessment'
import { evaluateTradeWindow } from '../evaluation/EvalWindow'
import { buildTierATrades, buildTierBTrades, makeTrade } from './helpers'

test('mission assessment hard-fails sparse 4h strategies', () => {
  const now = 10 * 60 * 60 * 1000
  const startedAt = now - 5 * 60 * 60 * 1000
  const trades = Array.from({ length: 12 }, (_, index) => makeTrade(index))

  const assessment = assessTrades({
    strategyId: 'strategy_sparse',
    genomeId: 'genome_sparse',
    trades,
    startedAt,
    now,
    startingBalanceSol: 1,
  })

  assert.equal(assessment.tier, 'hard_fail')
  assert.match(assessment.gateFailures[0], /less_than_30_trades_after_4h/)
})

test('mission assessment assigns tier A and orders stronger growth first', () => {
  const now = 60 * 60 * 1000
  const startedAt = now - 30 * 60 * 1000
  const stronger = assessTrades({
    strategyId: 'strategy_strong',
    genomeId: 'genome_strong',
    trades: buildTierATrades(),
    startedAt,
    now,
    startingBalanceSol: 1,
  })
  const weaker = assessTrades({
    strategyId: 'strategy_weaker',
    genomeId: 'genome_weaker',
    trades: buildTierBTrades(),
    startedAt,
    now,
    startingBalanceSol: 1,
  })

  assert.equal(stronger.tier, 'tier_a')
  assert.equal(weaker.tier, 'tier_b')
  assert.ok(compareAssessments(stronger, weaker) < 0)
})

test('eval window uses the shared mission assessment logic', () => {
  const previousStart = process.env.STARTING_BALANCE_SOL
  process.env.STARTING_BALANCE_SOL = '1'

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-eval-'))
  const dbPath = path.join(tmpDir, 'darwin.db')
  const db = new Database(dbPath)

  db.exec(`
    CREATE TABLE trades (
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
  `)

  const insert = db.prepare(`
    INSERT INTO trades (
      id, strategy_id, genome_id, mint, pool,
      entry_price_sol, exit_price_sol, size_sol,
      pnl_sol, pnl_pct, mfe_pct, mae_pct, exit_reason,
      opened_at, closed_at, hold_ms, is_paper, signal_type,
      pool_liq_sol, desired_size_sol, capped_size_sol, pool_cap_sol, fill_ratio
    ) VALUES (
      @id, @strategyId, @genomeId, @mint, @pool,
      @entryPriceSol, @exitPriceSol, @sizeSol,
      @pnlSol, @pnlPct, @mfePct, @maePct, @exitReason,
      @openedAt, @closedAt, @holdMs, @isPaper, @signalType,
      @poolLiqSol, @desiredSizeSol, @cappedSizeSol, @poolCapSol, @fillRatio
    )
  `)

  const trades = buildTierATrades()
  for (const trade of trades) {
    insert.run({
      ...trade,
      isPaper: trade.isPaper ? 1 : 0,
    })
  }
  db.close()

  const sinceTsMs = 0
  const runtimeAssessment = assessTrades({
    strategyId: 'paper_window',
    genomeId: 'paper_window',
    trades,
    startedAt: sinceTsMs,
    now: Math.max(...trades.map((trade) => trade.closedAt)),
    startingBalanceSol: 1,
  })
  const evalAssessment = evaluateTradeWindow({
    sinceTsMs,
    dbPath,
    now: Math.max(...trades.map((trade) => trade.closedAt)),
  })

  assert.equal(evalAssessment.tier, runtimeAssessment.tier)
  assert.deepEqual(evalAssessment.rankKey, runtimeAssessment.rankKey)
  assert.equal(evalAssessment.metrics.migrationShare, runtimeAssessment.metrics.migrationShare)
  assert.equal(evalAssessment.metrics.bestTradePct, runtimeAssessment.metrics.bestTradePct)

  if (previousStart == null) delete process.env.STARTING_BALANCE_SOL
  else process.env.STARTING_BALANCE_SOL = previousStart
})

test('eval window defaults to the stable lane when split data exists', () => {
  const previousStart = process.env.STARTING_BALANCE_SOL
  const previousDbPath = process.env.DB_PATH
  const previousCwd = process.cwd()
  process.env.STARTING_BALANCE_SOL = '1'
  delete process.env.DB_PATH

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-eval-split-'))
  const stableDir = path.join(tmpDir, 'data', 'stable')
  fs.mkdirSync(stableDir, { recursive: true })

  const stableDbPath = path.join(stableDir, 'darwin.db')
  const rootDbPath = path.join(tmpDir, 'darwin.db')
  const stableDb = new Database(stableDbPath)
  const rootDb = new Database(rootDbPath)
  const trades = buildTierATrades()

  const schema = `
    CREATE TABLE trades (
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
  `

  stableDb.exec(schema)
  rootDb.exec(schema)

  const insertStable = stableDb.prepare(`
    INSERT INTO trades (
      id, strategy_id, genome_id, mint, pool,
      entry_price_sol, exit_price_sol, size_sol,
      pnl_sol, pnl_pct, mfe_pct, mae_pct, exit_reason,
      opened_at, closed_at, hold_ms, is_paper, signal_type,
      pool_liq_sol, desired_size_sol, capped_size_sol, pool_cap_sol, fill_ratio
    ) VALUES (
      @id, @strategyId, @genomeId, @mint, @pool,
      @entryPriceSol, @exitPriceSol, @sizeSol,
      @pnlSol, @pnlPct, @mfePct, @maePct, @exitReason,
      @openedAt, @closedAt, @holdMs, @isPaper, @signalType,
      @poolLiqSol, @desiredSizeSol, @cappedSizeSol, @poolCapSol, @fillRatio
    )
  `)

  for (const trade of trades) {
    insertStable.run({
      ...trade,
      isPaper: trade.isPaper ? 1 : 0,
    })
  }

  stableDb.close()
  rootDb.close()

  const assessment = (() => {
    process.chdir(tmpDir)
    try {
      return evaluateTradeWindow({
        sinceTsMs: 0,
        now: 60 * 60 * 1000,
      })
    } finally {
      process.chdir(previousCwd)
    }
  })()

  assert.equal(assessment.tier, 'tier_a')
  assert.equal(assessment.metrics.tradeCount, trades.length)

  if (previousStart == null) delete process.env.STARTING_BALANCE_SOL
  else process.env.STARTING_BALANCE_SOL = previousStart
  if (previousDbPath == null) delete process.env.DB_PATH
  else process.env.DB_PATH = previousDbPath
})
