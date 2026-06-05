import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluatePromotionGate, type PromotionGateEvidence } from '../promotion/PromotionGate'

function buildEvidence(overrides: Partial<PromotionGateEvidence> = {}): PromotionGateEvidence {
  const loops = Array.from({ length: 20 }, (_, index) => ({
    strategyId: 'strategy_money',
    strategyHash: 'sha256:abc123',
    buySignature: `buy_${index}`,
    sellSignature: `sell_${index}`,
    mint: `mint_${index}`,
    pool: `pool_${index}`,
    buyWalletDeltaSol: -0.00012,
    sellWalletDeltaSol: 0.00013,
    tokenDeltaRaw: '-100',
    afterTokenAmountRaw: '0',
    manualRescue: false,
    buyFinalized: true,
    sellFinalized: true,
  }))

  return {
    strategyId: 'strategy_money',
    strategyHash: 'sha256:abc123',
    wallet: 'wallet_1',
    startedAtMs: 1_000,
    endedAtMs: 2_000,
    loops,
    uncontrolledRestartEvidence: false,
    openTestPositions: [],
    ...overrides,
  }
}

test('promotion gate passes only complete positive finalized evidence', () => {
  const record = evaluatePromotionGate(buildEvidence())
  assert.equal(record.status, 'PASS')
  assert.equal(record.loopCount, 20)
  assert.ok(record.netWalletDeltaSol > 0)
  assert.deepEqual(record.failures, [])
})

test('promotion gate rejects insufficient loops', () => {
  const evidence = buildEvidence()
  evidence.loops = evidence.loops.slice(0, 19)
  const record = evaluatePromotionGate(evidence)
  assert.equal(record.status, 'FAIL')
  assert.ok(record.failures.includes('insufficient_loops:19/20'))
})

test('promotion gate rejects negative net wallet delta', () => {
  const evidence = buildEvidence({
    loops: buildEvidence().loops.map((loop) => ({
      ...loop,
      sellWalletDeltaSol: 0.0001,
    })),
  })
  const record = evaluatePromotionGate(evidence)
  assert.equal(record.status, 'FAIL')
  assert.ok(record.failures.includes('net_wallet_delta_not_positive'))
})

test('promotion gate rejects manual rescue and open test positions', () => {
  const evidence = buildEvidence({ openTestPositions: ['mint_open'] })
  evidence.loops[3] = {
    ...evidence.loops[3],
    manualRescue: true,
  }
  const record = evaluatePromotionGate(evidence)
  assert.equal(record.status, 'FAIL')
  assert.ok(record.failures.includes('open_test_positions'))
  assert.ok(record.failures.includes('loop_3:manual_rescue'))
})

test('promotion gate rejects non-finalized signatures and unflattened positions', () => {
  const evidence = buildEvidence()
  evidence.loops[5] = {
    ...evidence.loops[5],
    buyFinalized: false,
    afterTokenAmountRaw: '10',
    tokenDeltaRaw: '0',
  }
  const record = evaluatePromotionGate(evidence)
  assert.equal(record.status, 'FAIL')
  assert.ok(record.failures.includes('loop_5:buy_not_finalized'))
  assert.ok(record.failures.includes('loop_5:position_not_flattened'))
  assert.ok(record.failures.includes('loop_5:token_not_reduced'))
})

test('promotion gate rejects windows longer than 24 hours', () => {
  const record = evaluatePromotionGate(buildEvidence({
    startedAtMs: 0,
    endedAtMs: 24 * 60 * 60 * 1000 + 1,
  }))
  assert.equal(record.status, 'FAIL')
  assert.ok(record.failures.includes('window_exceeds_24h'))
})
