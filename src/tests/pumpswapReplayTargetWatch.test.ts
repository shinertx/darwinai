import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzePumpswapReplayTargetWatch } from '../analysis/PumpswapReplayTargetWatch'

const TARGET = [
  'profile=low_buy_competition',
  'rent=yes',
  'initial_liquidity=75_to_125_sol',
]

const OPTIONS = {
  targetSegmentIncludes: TARGET,
  minSamplePools: 20,
  minCompletedPaths: 20,
  minWinRate: 0.65,
  minRentTradableRate: 0.9,
  minMedianModeledNetReturnPct: 15,
  minAvgModeledNetReturnPct: 15,
}

test('target watch waits on the best matching segment when sample is too small', () => {
  const report = analyzePumpswapReplayTargetWatch([
    {
      generatedAt: 'grid-a',
      scenarios: [
        {
          inputs: { entryDelayMs: 5000, maxHoldMs: 60000, exitAfterLaterBuys: 12, fixedCostSol: 0.000015966 },
          bySegment: [
            {
              segment: 'profile=low_buy_competition|rent=yes|initial_liquidity=75_to_125_sol',
              profile: 'low_buy_competition',
              pools: 8,
              completedPaths: 8,
              rentTradableRate: 1,
              avgModeledNetReturnPct: 121.39,
              medianModeledNetReturnPct: 16.9,
              winRate: 1,
            },
          ],
        },
      ],
    },
  ], OPTIONS)

  assert.equal(report.status, 'WAIT')
  assert.equal(report.bestMatch?.pools, 8)
  assert.deepEqual(report.bestMatch?.blockers, ['sample_pools<20', 'completed_paths<20'])
})

test('target watch promotes only when target sample and edge constraints clear', () => {
  const report = analyzePumpswapReplayTargetWatch([
    {
      generatedAt: 'grid-b',
      scenarios: [
        {
          inputs: { entryDelayMs: 5000, maxHoldMs: 60000, exitAfterLaterBuys: 12, fixedCostSol: 0.000015966 },
          bySegment: [
            {
              segment: 'profile=low_buy_competition|rent=yes|initial_liquidity=75_to_125_sol',
              profile: 'low_buy_competition',
              pools: 20,
              completedPaths: 20,
              rentTradableRate: 1,
              avgModeledNetReturnPct: 22,
              medianModeledNetReturnPct: 18,
              winRate: 0.8,
            },
          ],
        },
      ],
    },
  ], OPTIONS)

  assert.equal(report.status, 'PAPER_CANDIDATE')
  assert.equal(report.totals.candidateRows, 1)
  assert.equal(report.bestMatch?.blockers.length, 0)
})

test('target watch blocks a paper candidate when matching shadow dry-run evidence failed', () => {
  const report = analyzePumpswapReplayTargetWatch([
    {
      generatedAt: 'grid-shadow',
      scenarios: [
        {
          inputs: { entryDelayMs: 5000, maxHoldMs: 15000, exitAfterLaterBuys: 9, fixedCostSol: 0.000015966 },
          bySegment: [
            {
              segment: 'profile=low_buy_competition|rent=yes|initial_liquidity=75_to_125_sol',
              profile: 'low_buy_competition',
              pools: 20,
              completedPaths: 20,
              rentTradableRate: 1,
              avgModeledNetReturnPct: 22,
              medianModeledNetReturnPct: 18,
              winRate: 0.8,
            },
          ],
        },
      ],
    },
  ], {
    ...OPTIONS,
    shadowFailures: [{
      segmentIncludes: TARGET,
      scenarioInputs: { entryDelayMs: 5000, maxHoldMs: 15000, exitAfterLaterBuys: 9 },
      evidenceFile: 'cyborg-dry-run-negative.json',
      reason: 'modeled_net_return_sol<=0',
    }],
  })

  assert.equal(report.status, 'WAIT')
  assert.equal(report.totals.candidateRows, 0)
  assert.deepEqual(report.bestMatch?.blockers, [
    'shadow_failure:modeled_net_return_sol<=0:cyborg-dry-run-negative.json',
  ])
})

test('target watch reports target missing when no segment matches the configured includes', () => {
  const report = analyzePumpswapReplayTargetWatch([
    {
      generatedAt: 'grid-c',
      scenarios: [
        {
          bySegment: [
            {
              segment: 'profile=strict_zero|rent=no',
              pools: 40,
              completedPaths: 40,
              rentTradableRate: 0,
              avgModeledNetReturnPct: 40,
              medianModeledNetReturnPct: 30,
              winRate: 0.7,
            },
          ],
        },
      ],
    },
  ], OPTIONS)

  assert.equal(report.status, 'TARGET_NOT_FOUND')
  assert.equal(report.bestMatch, null)
})
