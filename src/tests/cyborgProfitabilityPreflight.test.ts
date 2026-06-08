import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  evaluateCyborgProfitabilityPreflight,
} from '../promotion/CyborgProfitabilityPreflight'
import type { CyborgStrategyConfig } from '../observatory/cyborgStrategyConfig'

const BASE_CONFIG: CyborgStrategyConfig = {
  scorer: {
    minScore: 58,
    maxBuyCompetitors5s: 0,
    maxInteractingWallets5s: 0,
    minLiquiditySol: 0,
    requireUniqueCreator: true,
  },
  alertWindowMs: 5_000,
  executionDeferMs: 15_000,
  liveSignalMaxAgeMs: '90000',
  exitRule: {
    mode: 'immediate',
    laterBuyThreshold: 0,
    maxHoldMs: 0,
  },
  allowedStateRentSetup: {
    ataCreate: true,
    poolExtend: false,
    closeTokenAtaOnSell: true,
  },
  settlementRoute: 'direct_rpc',
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-preflight-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeResult(
  dir: string,
  overrides: Record<string, unknown> = {}
): void {
  const executedAtMs = Number(overrides.executedAtMs || 2_000)
  fs.writeFileSync(
    path.join(dir, `cyborg-canary-${executedAtMs}.json`),
    JSON.stringify({
      executedAtMs,
      sizeSol: 0.0001,
      netReturnSol: 0.000001,
      buySignature: 'buy',
      sellSignature: 'sell',
      flattened: true,
      strategyConfig: BASE_CONFIG,
      ...overrides,
    }) + '\n'
  )
}

test('cyborg profitability preflight allows when no matching failed evidence exists', () => {
  withTempDir((dir) => {
    const result = evaluateCyborgProfitabilityPreflight({
      inputDir: dir,
      canarySizeSol: 0.0001,
      strategyConfig: BASE_CONFIG,
      nowMs: 2_000,
    })

    assert.equal(result.allowed, true)
    assert.equal(result.reason, 'no_matching_evidence')
    assert.equal(result.matchingEvidenceCount, 0)
  })
})

test('cyborg profitability preflight blocks same config and size after a negative loop', () => {
  withTempDir((dir) => {
    writeResult(dir, { netReturnSol: -0.00241144 })

    const result = evaluateCyborgProfitabilityPreflight({
      inputDir: dir,
      canarySizeSol: 0.0001,
      strategyConfig: BASE_CONFIG,
      nowMs: 2_000,
    })

    assert.equal(result.allowed, false)
    assert.equal(result.reason, 'known_unprofitable')
    assert.equal(result.blockingEvidenceCount, 1)
    assert.equal(result.latestNetReturnSol, -0.00241144)
  })
})

test('cyborg profitability preflight ignores different strategy config evidence', () => {
  withTempDir((dir) => {
    writeResult(dir, {
      netReturnSol: -0.00241144,
      strategyConfig: {
        ...BASE_CONFIG,
        executionDeferMs: 0,
      },
    })

    const result = evaluateCyborgProfitabilityPreflight({
      inputDir: dir,
      canarySizeSol: 0.0001,
      strategyConfig: BASE_CONFIG,
      nowMs: 2_000,
    })

    assert.equal(result.allowed, true)
    assert.equal(result.matchingEvidenceCount, 0)
  })
})

test('cyborg profitability preflight blocks same config after an unflattened loop', () => {
  withTempDir((dir) => {
    writeResult(dir, {
      netReturnSol: -0.0070194,
      sellSignature: null,
      flattened: false,
    })

    const result = evaluateCyborgProfitabilityPreflight({
      inputDir: dir,
      canarySizeSol: 0.0001,
      strategyConfig: BASE_CONFIG,
      nowMs: 2_000,
    })

    assert.equal(result.allowed, false)
    assert.equal(result.blockingEvidenceCount, 1)
  })
})

test('cyborg profitability preflight requires explicit override for known unprofitable config', () => {
  withTempDir((dir) => {
    writeResult(dir, { netReturnSol: -0.00241144 })

    const result = evaluateCyborgProfitabilityPreflight({
      inputDir: dir,
      canarySizeSol: 0.0001,
      strategyConfig: BASE_CONFIG,
      nowMs: 2_000,
      allowKnownUnprofitable: true,
    })

    assert.equal(result.allowed, true)
    assert.equal(result.reason, 'override_known_unprofitable')
    assert.equal(result.blockingEvidenceCount, 1)
  })
})
