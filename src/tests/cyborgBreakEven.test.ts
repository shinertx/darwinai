import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { analyzeCyborgBreakEven } from '../promotion/CyborgBreakEven'

const STRATEGY_CONFIG = {
  scorer: {
    minScore: 58,
    maxBuyCompetitors5s: 1,
    maxInteractingWallets5s: 12,
    minLiquiditySol: 20,
    requireUniqueCreator: true,
  },
  alertWindowMs: 5_000,
  executionDeferMs: 15_000,
  liveSignalMaxAgeMs: '90000',
  allowedStateRentSetup: {
    ataCreate: true,
    poolExtend: false,
    closeTokenAtaOnSell: true,
  },
  settlementRoute: 'direct_rpc',
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-breakeven-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeResult(dir: string, name: string, overrides: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(dir, name),
    JSON.stringify({
      executedAtMs: 2_000,
      sizeSol: 0.0001,
      netReturnSol: -0.00241144,
      buySignature: 'buy',
      sellSignature: 'sell',
      flattened: true,
      strategyConfig: STRATEGY_CONFIG,
      ...overrides,
    }) + '\n'
  )
}

test('cyborg break-even report converts observed live loss into required gross edge', () => {
  withTempDir((dir) => {
    writeResult(dir, 'cyborg-canary-loss.json', {})

    const report = analyzeCyborgBreakEven({
      inputDir: dir,
      expectedEdgePctList: [1, 100, 2500],
      sizeSol: 0.0001,
      nowMs: 2_000,
    })

    assert.equal(report.groups.length, 1)
    const group = report.groups[0]
    assert.equal(group.status, 'BLOCKED_COST_FLOOR')
    assert.equal(group.lossFloorSol, 0.00241144)
    assert.equal(group.requiredGrossEdgePctAtCurrentSize, 2411.44)
    assert.equal(group.scenarios[0].canCurrentSizeClearLossFloor, false)
    assert.equal(group.scenarios[1].breakEvenSizeSol, 0.00241144)
    assert.equal(group.scenarios[2].canCurrentSizeClearLossFloor, true)
  })
})

test('cyborg break-even report blocks incomplete or unflattened evidence even with positive net', () => {
  withTempDir((dir) => {
    writeResult(dir, 'cyborg-canary-unflat.json', {
      netReturnSol: 0.001,
      sellSignature: null,
      flattened: false,
    })

    const report = analyzeCyborgBreakEven({
      inputDir: dir,
      expectedEdgePctList: [10],
      sizeSol: 0.0001,
      nowMs: 2_000,
    })

    const group = report.groups[0]
    assert.equal(group.status, 'BLOCKED_COST_FLOOR')
    assert.equal(group.incompleteOrUnflattenedCount, 1)
  })
})

test('cyborg break-even report separates strategy configs and size filters', () => {
  withTempDir((dir) => {
    writeResult(dir, 'cyborg-canary-loss-a.json', {})
    writeResult(dir, 'cyborg-canary-loss-b.json', {
      sizeSol: 0.0002,
      strategyConfig: {
        ...STRATEGY_CONFIG,
        executionDeferMs: 0,
      },
    })

    const report = analyzeCyborgBreakEven({
      inputDir: dir,
      expectedEdgePctList: [10],
      sizeSol: 0.0001,
      nowMs: 2_000,
    })

    assert.equal(report.groups.length, 1)
    assert.equal(report.groups[0].sizeSol, 0.0001)
  })
})

test('cyborg break-even report marks empty evidence as needing research', () => {
  withTempDir((dir) => {
    const report = analyzeCyborgBreakEven({
      inputDir: dir,
      expectedEdgePctList: [10],
      sizeSol: 0.0001,
      nowMs: 2_000,
    })

    assert.equal(report.groups.length, 0)
    assert.equal(report.worstGroup, null)
    assert.match(report.recommendation, /No matching cyborg canary evidence/)
  })
})
