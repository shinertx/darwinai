import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveCyborgShapeScoringConfig,
  scoreCyborgShape,
} from '../observatory/cyborgShapeScoring'

test('strict-zero rent-safe shape scores as a high-quality candidate', () => {
  const config = resolveCyborgShapeScoringConfig({})
  const score = scoreCyborgShape({
    buyCompetitorWalletCount5s: 0,
    interactingWalletCount5s: 0,
    liquiditySol: 48,
    uniqueCreatorInRun: true,
  }, config)

  assert.equal(score.profile, 'strict_zero')
  assert.equal(score.qualified, true)
  assert.equal(score.blockers.length, 0)
  assert.equal(score.estimatedLaterBuyFlowRate, 0.985)
  assert.equal(score.estimatedThreePlusLaterBuyWalletRate, 0.901)
  assert.ok(score.score >= config.minScore)
})

test('low-competition shapes can still qualify when interactions stay low', () => {
  const config = resolveCyborgShapeScoringConfig({})
  const score = scoreCyborgShape({
    buyCompetitorWalletCount5s: 1,
    interactingWalletCount5s: 2,
    liquiditySol: 60,
    uniqueCreatorInRun: true,
  }, config)

  assert.equal(score.profile, 'low_competition')
  assert.equal(score.qualified, true)
  assert.equal(score.blockers.length, 0)
  assert.equal(score.estimatedLaterBuyFlowRate, 0.975)
  assert.equal(score.estimatedThreePlusLaterBuyWalletRate, 0.806)
})

test('rent-seeded mode requires an early non-creator buy', () => {
  const config = resolveCyborgShapeScoringConfig({
    PUMPSWAP_CYBORG_SCORER_MIN_BUY_COMPETITORS_5S: '1',
    PUMPSWAP_CYBORG_SCORER_MAX_BUY_COMPETITORS_5S: '1',
    PUMPSWAP_CYBORG_SCORER_MAX_INTERACTIONS_5S: '2',
    PUMPSWAP_CYBORG_SCORER_MIN_SCORE: '70',
  })
  const strictZero = scoreCyborgShape({
    buyCompetitorWalletCount5s: 0,
    interactingWalletCount5s: 0,
    liquiditySol: 60,
    uniqueCreatorInRun: true,
  }, config)
  const rentSeeded = scoreCyborgShape({
    buyCompetitorWalletCount5s: 1,
    interactingWalletCount5s: 2,
    liquiditySol: 60,
    uniqueCreatorInRun: true,
  }, config)

  assert.equal(strictZero.qualified, false)
  assert.ok(strictZero.blockers.includes('buy_competitors_5s<1'))
  assert.equal(rentSeeded.qualified, true)
  assert.ok(rentSeeded.reasons.includes('rent_seeded_buy_competitor_5s'))
})

test('crowded target mode can require minimum early interactions', () => {
  const config = resolveCyborgShapeScoringConfig({
    PUMPSWAP_CYBORG_SCORER_MIN_SCORE: '18',
    PUMPSWAP_CYBORG_SCORER_MIN_BUY_COMPETITORS_5S: '3',
    PUMPSWAP_CYBORG_SCORER_MAX_BUY_COMPETITORS_5S: '5',
    PUMPSWAP_CYBORG_SCORER_MIN_INTERACTIONS_5S: '11',
    PUMPSWAP_CYBORG_SCORER_MAX_INTERACTIONS_5S: '999',
    PUMPSWAP_CYBORG_SCORER_MIN_LIQUIDITY_SOL: '75',
  })
  const tooQuiet = scoreCyborgShape({
    buyCompetitorWalletCount5s: 3,
    interactingWalletCount5s: 5,
    liquiditySol: 100,
    uniqueCreatorInRun: true,
  }, config)
  const crowdedTarget = scoreCyborgShape({
    buyCompetitorWalletCount5s: 3,
    interactingWalletCount5s: 11,
    liquiditySol: 100,
    uniqueCreatorInRun: true,
  }, config)

  assert.equal(tooQuiet.qualified, false)
  assert.ok(tooQuiet.blockers.includes('interactions_5s<11'))
  assert.equal(crowdedTarget.profile, 'crowded')
  assert.equal(crowdedTarget.qualified, true)
})

test('repeat creators and noisy 5-second windows are blocked', () => {
  const config = resolveCyborgShapeScoringConfig({})
  const score = scoreCyborgShape({
    buyCompetitorWalletCount5s: 1,
    interactingWalletCount5s: 18,
    liquiditySol: 45,
    uniqueCreatorInRun: false,
  }, config)

  assert.equal(score.qualified, false)
  assert.deepEqual(score.blockers, ['repeat_creator', `interactions_5s>${config.maxInteractingWallets5s}`])
})

test('liquidity floor remains configurable for tighter live admission', () => {
  const config = resolveCyborgShapeScoringConfig({
    PUMPSWAP_CYBORG_SCORER_MIN_LIQUIDITY_SOL: '35',
    PUMPSWAP_CYBORG_SCORER_MAX_BUY_COMPETITORS_5S: '1',
    PUMPSWAP_CYBORG_SCORER_MAX_INTERACTIONS_5S: '12',
    PUMPSWAP_CYBORG_SCORER_MIN_SCORE: '70',
  })
  const score = scoreCyborgShape({
    buyCompetitorWalletCount5s: 0,
    interactingWalletCount5s: 0,
    liquiditySol: 20,
    uniqueCreatorInRun: true,
  }, config)

  assert.equal(score.qualified, false)
  assert.deepEqual(score.blockers, ['liquidity_sol<35'])
})
