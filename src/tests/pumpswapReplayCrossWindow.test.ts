import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzePumpswapReplayCrossWindow,
  type ReplayCrossWindowGrid,
  type ReplayCrossWindowOptions,
} from '../analysis/PumpswapReplayCrossWindow'

const OPTIONS: ReplayCrossWindowOptions = {
  minWindows: 2,
  minSamplePools: 20,
  minCompletedPaths: 20,
  minCompletedPathsPerWindow: 5,
  minWinRate: 0.65,
  minRentTradableRate: 0.9,
  minAvgModeledNetReturnPct: 15,
  minWindowWinRate: 0.5,
  minWindowAvgModeledNetReturnPct: 0,
  minWindowMedianModeledNetReturnPct: 15,
}

function grid(
  generatedAt: string,
  eventFile: string,
  row: {
    pools: number
    completedPaths: number
    rentTradableRate: number
    avgModeledNetReturnPct: number
    medianModeledNetReturnPct: number
    winRate: number
  },
  entryDelayMs = 5_000
): ReplayCrossWindowGrid {
  return {
    generatedAt,
    inputs: { eventFiles: [eventFile] },
    scenarios: [
      {
        inputs: {
          entryDelayMs,
          maxHoldMs: 30_000,
          exitAfterLaterBuys: 8,
          tradeSizeSol: 0.0001,
          fixedCostSol: 0.000015966,
        },
        bySegment: [
          {
            segment: 'profile=low_buy_competition|rent=yes|target=durable',
            profile: 'low_buy_competition',
            ...row,
          },
        ],
      },
    ],
  }
}

test('cross-window replay promotes only a strategy that clears every independent window', () => {
  const report = analyzePumpswapReplayCrossWindow([
    grid('window-a', '/data/events-a.jsonl', {
      pools: 12,
      completedPaths: 11,
      rentTradableRate: 1,
      avgModeledNetReturnPct: 24,
      medianModeledNetReturnPct: 20,
      winRate: 0.73,
    }),
    grid('window-b', '/data/events-b.jsonl', {
      pools: 13,
      completedPaths: 12,
      rentTradableRate: 0.92,
      avgModeledNetReturnPct: 18,
      medianModeledNetReturnPct: 17,
      winRate: 0.67,
    }),
  ], OPTIONS)

  assert.equal(report.totals.paperCandidates, 1)
  assert.equal(report.topPaperCandidates[0].windows, 2)
  assert.equal(report.topPaperCandidates[0].completedPaths, 23)
  assert.equal(report.topPaperCandidates[0].worstWindowMedianModeledNetReturnPct, 17)
  assert.deepEqual(report.topPaperCandidates[0].blockers, [])
})

test('cross-window replay rejects overlapping event sources even when paths differ', () => {
  assert.throws(() => analyzePumpswapReplayCrossWindow([
    grid('window-a', '/server/a/events-shared.jsonl', {
      pools: 20,
      completedPaths: 20,
      rentTradableRate: 1,
      avgModeledNetReturnPct: 20,
      medianModeledNetReturnPct: 20,
      winRate: 0.8,
    }),
    grid('window-b', '/copy/b/events-shared.jsonl', {
      pools: 20,
      completedPaths: 20,
      rentTradableRate: 1,
      avgModeledNetReturnPct: 20,
      medianModeledNetReturnPct: 20,
      winRate: 0.8,
    }),
  ], OPTIONS), /Overlapping event source events-shared\.jsonl/)
})

test('cross-window replay does not let a strong window hide a negative window', () => {
  const report = analyzePumpswapReplayCrossWindow([
    grid('window-a', 'events-a.jsonl', {
      pools: 12,
      completedPaths: 12,
      rentTradableRate: 1,
      avgModeledNetReturnPct: 60,
      medianModeledNetReturnPct: 50,
      winRate: 0.92,
    }),
    grid('window-b', 'events-b.jsonl', {
      pools: 12,
      completedPaths: 12,
      rentTradableRate: 1,
      avgModeledNetReturnPct: -2,
      medianModeledNetReturnPct: -4,
      winRate: 0.42,
    }),
  ], OPTIONS)

  assert.equal(report.totals.paperCandidates, 0)
  assert.equal(report.totals.unstableAcrossWindows, 1)
  assert.ok(report.topUnstableAcrossWindows[0].blockers.includes(
    'worst_window_median_modeled_net_return_pct<=15'
  ))
})

test('cross-window replay keeps different scenario parameters separate', () => {
  const report = analyzePumpswapReplayCrossWindow([
    grid('window-a', 'events-a.jsonl', {
      pools: 20,
      completedPaths: 20,
      rentTradableRate: 1,
      avgModeledNetReturnPct: 20,
      medianModeledNetReturnPct: 20,
      winRate: 0.8,
    }, 5_000),
    grid('window-b', 'events-b.jsonl', {
      pools: 20,
      completedPaths: 20,
      rentTradableRate: 1,
      avgModeledNetReturnPct: 20,
      medianModeledNetReturnPct: 20,
      winRate: 0.8,
    }, 10_000),
  ], OPTIONS)

  assert.equal(report.totals.candidateGroups, 2)
  assert.equal(report.totals.paperCandidates, 0)
  assert.equal(report.totals.collectMore, 2)
  assert.ok(report.topCollectMore.every((candidate) => candidate.blockers.includes('windows<2')))
})
