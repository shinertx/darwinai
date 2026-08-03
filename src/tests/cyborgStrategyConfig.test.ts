import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCyborgShapeScoringConfig } from '../observatory/cyborgShapeScoring'
import { resolveCyborgStrategyConfig } from '../observatory/cyborgStrategyConfig'

test('cyborg strategy config defaults to immediate exit', () => {
  const shapeConfig = resolveCyborgShapeScoringConfig({})
  const config = resolveCyborgStrategyConfig({}, shapeConfig, 5_000, 0)

  assert.deepEqual(config.exitRule, {
    mode: 'immediate',
    laterBuyThreshold: 0,
    maxHoldMs: 0,
  })
})

test('cyborg strategy config records replay-backed later-buyer exit rule', () => {
  const shapeConfig = resolveCyborgShapeScoringConfig({
    PUMPSWAP_CYBORG_SCORER_MIN_INTERACTIONS_5S: '11',
  })
  const config = resolveCyborgStrategyConfig({
    PUMPSWAP_CYBORG_EXIT_AFTER_LATER_BUYS: '10',
    PUMPSWAP_CYBORG_MAX_HOLD_MS: '60000',
  }, shapeConfig, 5_000, 10_000)

  assert.deepEqual(config.exitRule, {
    mode: 'later_buy_threshold',
    laterBuyThreshold: 10,
    maxHoldMs: 60_000,
  })
  assert.equal(config.scorer.minInteractingWallets5s, 11)
})

test('cyborg strategy config requires threshold and max-hold before delayed exit is active', () => {
  const shapeConfig = resolveCyborgShapeScoringConfig({})
  const config = resolveCyborgStrategyConfig({
    PUMPSWAP_CYBORG_EXIT_AFTER_LATER_BUYS: '10',
  }, shapeConfig, 5_000, 10_000)

  assert.equal(config.exitRule.mode, 'immediate')
})
