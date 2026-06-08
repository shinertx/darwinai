import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzePumpswapReplayFrontier } from '../analysis/PumpswapReplayFrontier'

const OPTIONS = {
  minSamplePools: 20,
  minCompletedPaths: 20,
  minWinRate: 0.65,
  minRentTradableRate: 0.9,
  minMedianModeledNetReturnPct: 15,
  minAvgModeledNetReturnPct: 15,
}

test('replay frontier promotes clean rows and marks edge-shaped small rows as collect-more', () => {
  const report = analyzePumpswapReplayFrontier([
    {
      generatedAt: 'grid-a',
      scenarios: [
        {
          inputs: { entryDelayMs: 3000, maxHoldMs: 15000, exitAfterLaterBuys: 12, fixedCostSol: 0.000015966 },
          bySegment: [
            {
              segment: 'profile=low_buy_competition|rent=yes|target=small',
              profile: 'low_buy_competition',
              pools: 3,
              completedPaths: 3,
              rentTradableRate: 1,
              avgModeledNetReturnPct: 17.3,
              medianModeledNetReturnPct: 16.03,
              winRate: 1,
            },
            {
              segment: 'profile=low_buy_competition|rent=yes|target=ready',
              profile: 'low_buy_competition',
              pools: 20,
              completedPaths: 20,
              rentTradableRate: 1,
              avgModeledNetReturnPct: 21,
              medianModeledNetReturnPct: 18,
              winRate: 0.8,
            },
          ],
        },
      ],
    },
  ], OPTIONS)

  assert.equal(report.totals.paperCandidates, 1)
  assert.equal(report.totals.collectMore, 1)
  assert.equal(report.topPaperCandidates[0].action, 'PAPER_CANDIDATE')
  assert.equal(report.topCollectMore[0].action, 'COLLECT_MORE')
  assert.deepEqual(report.topCollectMore[0].blockers, ['sample_pools<20', 'completed_paths<20'])
})

test('replay frontier separates rent failures from adequately sampled thin edges', () => {
  const report = analyzePumpswapReplayFrontier([
    {
      generatedAt: 'grid-b',
      scenarios: [
        {
          byProfile: [
            {
              profile: 'strict_zero',
              pools: 55,
              completedPaths: 52,
              rentTradableRate: 0,
              avgModeledNetReturnPct: 24,
              medianModeledNetReturnPct: 19,
              winRate: 0.7,
            },
            {
              profile: 'low_buy_competition',
              pools: 89,
              completedPaths: 86,
              rentTradableRate: 1,
              avgModeledNetReturnPct: 10,
              medianModeledNetReturnPct: 3,
              winRate: 0.64,
            },
          ],
        },
      ],
    },
  ], OPTIONS)

  assert.equal(report.totals.rejectRent, 1)
  assert.equal(report.totals.mutateEdge, 1)
  assert.equal(report.topRejectRent[0].id, 'strict_zero')
  assert.equal(report.topMutateEdge[0].id, 'low_buy_competition')
  assert.ok(report.topMutateEdge[0].blockers.includes('median_modeled_net_return_pct<=15'))
})

test('replay frontier ranks collect-more rows by sample depth before edge size', () => {
  const report = analyzePumpswapReplayFrontier([
    {
      scenarios: [
        {
          bySegment: [
            {
              segment: 'profile=small_moonshot|rent=yes',
              pools: 1,
              completedPaths: 1,
              rentTradableRate: 1,
              avgModeledNetReturnPct: 900,
              medianModeledNetReturnPct: 900,
              winRate: 1,
            },
            {
              segment: 'profile=deeper_target|rent=yes',
              pools: 8,
              completedPaths: 8,
              rentTradableRate: 1,
              avgModeledNetReturnPct: 20,
              medianModeledNetReturnPct: 16,
              winRate: 0.8,
            },
          ],
        },
      ],
    },
  ], OPTIONS)

  assert.equal(report.topCollectMore[0].id, 'profile=deeper_target|rent=yes')
})
