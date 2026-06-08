import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzePumpswapReplayPaths,
  type PumpSwapReplayEvent,
} from '../analysis/PumpswapReplayPath'

const WSOL = 'So11111111111111111111111111111111111111112'

const OPTIONS = {
  entryDelayMs: 15_000,
  maxHoldMs: 300_000,
  exitAfterLaterBuys: 2,
  tradeSizeSol: 0.0001,
  fixedCostSol: 0.00001,
  minPromotionSamplePools: 1,
  minWinRate: 0.5,
}

function poolRows(pool: string, overrides: Partial<PumpSwapReplayEvent> = {}): PumpSwapReplayEvent[] {
  return [
    {
      kind: 'create_pool',
      pool,
      creator: 'creator',
      anchorTimeMs: 1_000,
      baseMint: WSOL,
      quoteMint: 'TOKEN',
      baseMintDecimals: 9,
      quoteMintDecimals: 6,
      initialBaseReserveRaw: '100000000000',
      initialQuoteReserveRaw: '100000000',
      ...overrides,
    },
    {
      kind: 'buy',
      pool,
      user: 'buyer-1',
      resolvedTimeMs: 18_000,
      poolBaseReserveRaw: '120000000000',
      poolQuoteReserveRaw: '80000000',
      creatorSigner: 'creator',
    },
    {
      kind: 'buy',
      pool,
      user: 'buyer-2',
      resolvedTimeMs: 22_000,
      poolBaseReserveRaw: '150000000000',
      poolQuoteReserveRaw: '60000000',
      creatorSigner: 'creator',
    },
  ]
}

test('replay paths estimate gross and modeled net return from reserve snapshots', () => {
  const report = analyzePumpswapReplayPaths(
    poolRows('pool-a'),
    [{ pool: 'pool-a', tradable: true }],
    OPTIONS
  )

  assert.equal(report.totals.pools, 1)
  assert.equal(report.totals.completedPaths, 1)
  assert.equal(report.paths[0].profile, 'strict_zero')
  assert.equal(report.paths[0].exitReason, 'later_buy_threshold')
  assert.equal(report.paths[0].preEntryBuyWallets, 0)
  assert.equal(report.paths[0].preEntryInteractingWallets, 0)
  assert.equal(report.paths[0].entryMomentumPct, 0)
  assert.equal(Math.round(report.paths[0].grossReturnPct ?? 0), 150)
  assert.equal(Math.round(report.paths[0].modeledNetReturnPct ?? 0), 140)
  assert.equal(report.byProfile[0].promotionStatus, 'PAPER_CANDIDATE')
})

test('replay profile is blocked when the live fixed-cost floor overwhelms modeled return', () => {
  const report = analyzePumpswapReplayPaths(
    poolRows('pool-a'),
    [{ pool: 'pool-a', tradable: true }],
    {
      ...OPTIONS,
      fixedCostSol: 0.00241144,
    }
  )

  assert.equal(report.paths[0].costPctOnSize, 2411.44)
  assert.equal(report.byProfile[0].promotionStatus, 'BLOCKED')
  assert.ok(report.byProfile[0].promotionBlockers.includes('median_modeled_net_return_pct<=0'))
})

test('replay profile records missing rent-free evidence as a blocker', () => {
  const report = analyzePumpswapReplayPaths(poolRows('pool-a'), [], OPTIONS)

  assert.equal(report.paths[0].rentTradable, false)
  assert.equal(report.byProfile[0].promotionStatus, 'BLOCKED')
  assert.ok(report.byProfile[0].promotionBlockers.includes('no_rent_free_first_buyer_evidence'))
})

test('replay profile can require a high rent-tradable rate before paper promotion', () => {
  const rows = [
    ...poolRows('pool-a'),
    ...poolRows('pool-b'),
  ]
  const report = analyzePumpswapReplayPaths(
    rows,
    [{ pool: 'pool-a', tradable: true }],
    {
      ...OPTIONS,
      minPromotionSamplePools: 2,
      minRentTradableRate: 0.75,
    }
  )

  assert.equal(report.byProfile[0].rentTradableRate, 0.5)
  assert.equal(report.byProfile[0].promotionStatus, 'BLOCKED')
  assert.ok(report.byProfile[0].promotionBlockers.includes('rent_tradable_rate<0.75'))
})

test('replay profile can require modeled edge margin above the fixed cost floor', () => {
  const report = analyzePumpswapReplayPaths(
    poolRows('pool-a'),
    [{ pool: 'pool-a', tradable: true }],
    {
      ...OPTIONS,
      minMedianModeledNetReturnPct: 150,
      minAvgModeledNetReturnPct: 150,
    }
  )

  assert.equal(report.byProfile[0].promotionStatus, 'BLOCKED')
  assert.ok(report.byProfile[0].promotionBlockers.includes('median_modeled_net_return_pct<=150'))
  assert.ok(report.byProfile[0].promotionBlockers.includes('avg_modeled_net_return_pct<=150'))
})

test('replay profiles separate early-window sell-only probes from strict-zero pools', () => {
  const rows = [
    ...poolRows('pool-a'),
    ...poolRows('pool-b'),
  ]
  rows.splice(4, 0, {
    kind: 'sell',
    pool: 'pool-b',
    user: 'seller-1',
    resolvedTimeMs: 3_000,
    poolBaseReserveRaw: '101000000000',
    poolQuoteReserveRaw: '99000000',
    creatorSigner: 'creator',
  })

  const report = analyzePumpswapReplayPaths(
    rows,
    [
      { pool: 'pool-a', tradable: true },
      { pool: 'pool-b', tradable: true },
    ],
    OPTIONS
  )

  assert.equal(report.paths.find((path) => path.pool === 'pool-a')?.profile, 'strict_zero')
  assert.equal(report.paths.find((path) => path.pool === 'pool-b')?.profile, 'sell_only_probe')
})

test('replay profiles separate rent-seeded low-noise pools from broad low competition', () => {
  const rows = [
    ...poolRows('pool-a'),
    {
      kind: 'buy',
      pool: 'pool-a',
      user: 'seed-buyer',
      resolvedTimeMs: 2_000,
      poolBaseReserveRaw: '101000000000',
      poolQuoteReserveRaw: '99000000',
      creatorSigner: 'creator',
    },
    {
      kind: 'deposit',
      pool: 'pool-a',
      user: 'lp-1',
      resolvedTimeMs: 3_000,
      poolBaseReserveRaw: '102000000000',
      poolQuoteReserveRaw: '98000000',
      creatorSigner: 'creator',
    },
    {
      kind: 'withdraw',
      pool: 'pool-a',
      user: 'lp-2',
      resolvedTimeMs: 4_000,
      poolBaseReserveRaw: '103000000000',
      poolQuoteReserveRaw: '97000000',
      creatorSigner: 'creator',
    },
  ]

  const report = analyzePumpswapReplayPaths(
    rows,
    [{ pool: 'pool-a', tradable: true }],
    OPTIONS
  )

  assert.equal(report.paths[0].profile, 'rent_seeded_low_noise')
})

test('replay segments capture pre-entry momentum and crowding cohorts', () => {
  const rows = [
    ...poolRows('pool-a'),
    {
      kind: 'buy',
      pool: 'pool-a',
      user: 'early-buyer',
      resolvedTimeMs: 3_000,
      poolBaseReserveRaw: '110000000000',
      poolQuoteReserveRaw: '90000000',
      creatorSigner: 'creator',
    },
  ]

  const report = analyzePumpswapReplayPaths(
    rows,
    [{ pool: 'pool-a', tradable: true }],
    OPTIONS
  )
  const path = report.paths[0]
  const segment = report.bySegment.find((row) => row.segment.includes('entry_momentum=10_to_25_pct'))

  assert.equal(path.profile, 'one_buy_probe')
  assert.equal(path.buyCompetitorWallets5s, 1)
  assert.equal(path.preEntryBuyWallets, 1)
  assert.equal(path.preEntryInteractingWallets, 1)
  assert.equal(Math.round(path.entryMomentumPct ?? 0), 22)
  assert.ok(segment)
  assert.ok(segment?.segment.includes('rent=yes'))
  assert.ok(segment?.segment.includes('pre_entry_buys=1'))
})
