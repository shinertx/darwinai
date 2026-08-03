import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyInteractionEvent,
  buildCyborgAlert,
  buildSummaryMetrics,
  createPoolObservation,
  isNearTotalDrain,
  redactUrlForLog,
  resolveInteractionTimeMs,
  resolvePumpSwapMetaObserverConfig,
  resolveStrictAnchorTimeMs,
  summarizePoolObservation,
  shouldTriggerCyborgAlert,
  type NormalizedCreatePoolEvent,
  type NormalizedInteractionEvent,
  type PumpSwapMetaObserverConfig,
} from '../cli/pumpswapMetaObserver'

const BASE_CONFIG: Pick<
  PumpSwapMetaObserverConfig,
  'competitionWindowMs' | 'cyborgAlertWindowMs' | 'rugWindowMs' | 'drainThresholdPct' | 'minRemainingSolRawString'
> = {
  competitionWindowMs: 10_000,
  cyborgAlertWindowMs: 5_000,
  rugWindowMs: 60 * 60 * 1000,
  drainThresholdPct: 99,
  minRemainingSolRawString: '0.1',
}

test('redactUrlForLog removes credentials from provider URLs', () => {
  assert.equal(
    redactUrlForLog('https://user:pass@example.com/rpc?api-key=secret-token&cluster=mainnet&authToken=abc123'),
    'https://%5Bredacted%5D:%5Bredacted%5D@example.com/rpc?api-key=%5Bredacted%5D&cluster=mainnet&authToken=%5Bredacted%5D'
  )
  assert.equal(
    redactUrlForLog('not-a-url?api-key=secret-token&x=1'),
    'not-a-url?api-key=[redacted]&x=1'
  )
})

function makeCreatePoolEvent(overrides: Partial<NormalizedCreatePoolEvent> = {}): NormalizedCreatePoolEvent {
  return {
    kind: 'create_pool',
    pool: overrides.pool || 'pool_1',
    creator: overrides.creator || 'creator_1',
    coinCreator: overrides.coinCreator || 'coin_creator_1',
    baseMint: overrides.baseMint || 'mint_base',
    quoteMint: overrides.quoteMint || 'So11111111111111111111111111111111111111112',
    baseMintDecimals: overrides.baseMintDecimals ?? 6,
    quoteMintDecimals: overrides.quoteMintDecimals ?? 9,
    initialBaseReserveRaw: overrides.initialBaseReserveRaw ?? 1_000_000_000n,
    initialQuoteReserveRaw: overrides.initialQuoteReserveRaw ?? 5_000_000_000n,
    initialLiquidityRaw: overrides.initialLiquidityRaw ?? 2_000_000_000n,
    lpTokenAmountOutRaw: overrides.lpTokenAmountOutRaw ?? 2_000_000_000n,
    eventTimestampMs: overrides.eventTimestampMs ?? 1_000_000,
  }
}

function makeInteractionEvent(
  kind: NormalizedInteractionEvent['kind'],
  overrides: Partial<NormalizedInteractionEvent> = {}
): NormalizedInteractionEvent {
  return {
    kind,
    pool: overrides.pool || 'pool_1',
    user: overrides.user || 'wallet_1',
    eventTimestampMs: overrides.eventTimestampMs ?? 1_005_000,
    poolBaseReserveRaw: overrides.poolBaseReserveRaw ?? 900_000_000n,
    poolQuoteReserveRaw: overrides.poolQuoteReserveRaw ?? 4_700_000_000n,
  }
}

test('createPoolObservation captures canonical create-pool payload fields', () => {
  const event = makeCreatePoolEvent({
    pool: 'pool_capture',
    creator: 'creator_capture',
    coinCreator: 'coin_capture',
    initialBaseReserveRaw: 777n,
    initialQuoteReserveRaw: 999n,
    initialLiquidityRaw: 1234n,
    lpTokenAmountOutRaw: 987n,
  })
  const pool = createPoolObservation({
    event,
    signature: 'sig_create',
    slot: 123,
    createBlockTimeMs: 10_000,
    anchorTime: { timeMs: 10_000, source: 'blockTime' },
    signerAddresses: ['creator_capture', 'helper_signer'],
  })

  assert.equal(pool.pool, 'pool_capture')
  assert.equal(pool.creatorSigner, 'creator_capture')
  assert.equal(pool.coinCreator, 'coin_capture')
  assert.deepEqual(pool.signerAddresses, ['creator_capture', 'helper_signer'])
  assert.equal(pool.initialBaseReserveRaw, 777n)
  assert.equal(pool.initialQuoteReserveRaw, 999n)
  assert.equal(pool.lpTokenAmountOutRaw, 987n)
  assert.equal(pool.timeAnchorUnavailable, false)
})

test('resolveStrictAnchorTimeMs prefers tx blockTime then slot blockTime then unavailable', () => {
  assert.deepEqual(resolveStrictAnchorTimeMs(100, 200), {
    timeMs: 100_000,
    source: 'blockTime',
  })
  assert.deepEqual(resolveStrictAnchorTimeMs(null, 200), {
    timeMs: 200_000,
    source: 'slotBlockTime',
  })
  assert.deepEqual(resolveStrictAnchorTimeMs(null, null), {
    timeMs: null,
    source: 'unavailable',
  })
})

test('interaction timestamps avoid an RPC lookup when the event already carries time', () => {
  assert.deepEqual(resolveInteractionTimeMs(null, null, 1_005_000), {
    timeMs: 1_005_000,
    source: 'eventTimestamp',
  })
})

test('meta observer config bounds the pending websocket queue', () => {
  const defaults = resolvePumpSwapMetaObserverConfig({
    RPC_URL: 'https://rpc.example.invalid',
  })
  assert.equal(defaults.maxQueueDepth, 10_000)

  const overridden = resolvePumpSwapMetaObserverConfig({
    RPC_URL: 'https://rpc.example.invalid',
    PUMPSWAP_META_MAX_QUEUE_DEPTH: '250',
  })
  assert.equal(overridden.maxQueueDepth, 250)
})

test('competition counting excludes creator signer, dedupes wallets, and ignores late events', () => {
  const pool = createPoolObservation({
    event: makeCreatePoolEvent({ creator: 'creator_wallet' }),
    signature: 'sig_create',
    slot: 1,
    createBlockTimeMs: 1000,
    anchorTime: { timeMs: 1000, source: 'blockTime' },
    signerAddresses: ['creator_wallet'],
  })

  applyInteractionEvent(
    pool,
    makeInteractionEvent('buy', { user: 'creator_wallet' }),
    { timeMs: 2_000, source: 'slotBlockTime' },
    'sig_creator_buy',
    BASE_CONFIG
  )
  applyInteractionEvent(
    pool,
    makeInteractionEvent('buy', { user: 'wallet_a' }),
    { timeMs: 3_000, source: 'slotBlockTime' },
    'sig_a_1',
    BASE_CONFIG
  )
  applyInteractionEvent(
    pool,
    makeInteractionEvent('buy', { user: 'wallet_a' }),
    { timeMs: 4_000, source: 'slotBlockTime' },
    'sig_a_2',
    BASE_CONFIG
  )
  applyInteractionEvent(
    pool,
    makeInteractionEvent('sell', { user: 'wallet_b' }),
    { timeMs: 5_000, source: 'slotBlockTime' },
    'sig_b_1',
    BASE_CONFIG
  )
  applyInteractionEvent(
    pool,
    makeInteractionEvent('buy', { user: 'wallet_c' }),
    { timeMs: 12_500, source: 'slotBlockTime' },
    'sig_c_late',
    BASE_CONFIG
  )

  const summary = summarizePoolObservation(pool, 3_700_000, BASE_CONFIG)

  assert.equal(summary.buyCompetitorWalletCount10s, 1)
  assert.equal(summary.buyCompetitorWalletCount5s, 1)
  assert.deepEqual(summary.buyCompetitorWallets10s, ['wallet_a'])
  assert.deepEqual(summary.buyCompetitorWallets5s, ['wallet_a'])
  assert.equal(summary.interactingWalletCount10s, 2)
  assert.equal(summary.interactingWalletCount5s, 2)
  assert.deepEqual(summary.interactingWallets10s, ['wallet_a', 'wallet_b'])
  assert.deepEqual(summary.interactingWallets5s, ['wallet_a', 'wallet_b'])
  assert.deepEqual(summary.competitionInstructionCounts10s, {
    buy: 3,
    sell: 1,
    deposit: 0,
    withdraw: 0,
  })
  assert.deepEqual(summary.competitionInstructionCountsNonCreator10s, {
    buy: 2,
    sell: 1,
    deposit: 0,
    withdraw: 0,
  })
})

test('cyborg alert triggers only after 5 seconds when buy competitors stay at or below threshold', () => {
  const pool = createPoolObservation({
    event: makeCreatePoolEvent({ creator: 'creator_wallet', pool: 'pool_cyborg' }),
    signature: 'sig_create',
    slot: 10,
    createBlockTimeMs: 1_000,
    anchorTime: { timeMs: 1_000, source: 'blockTime' },
    signerAddresses: ['creator_wallet'],
  })

  applyInteractionEvent(
    pool,
    makeInteractionEvent('sell', { pool: 'pool_cyborg', user: 'wallet_sell_only' }),
    { timeMs: 3_000, source: 'slotBlockTime' },
    'sig_sell_only',
    BASE_CONFIG
  )

  assert.equal(shouldTriggerCyborgAlert(pool, 5_999, {
    cyborgAlertWindowMs: BASE_CONFIG.cyborgAlertWindowMs,
    cyborgMaxBuyCompetitors: 0,
  }), false)

  assert.equal(shouldTriggerCyborgAlert(pool, 6_000, {
    cyborgAlertWindowMs: BASE_CONFIG.cyborgAlertWindowMs,
    cyborgMaxBuyCompetitors: 0,
  }), true)

  const alert = buildCyborgAlert(pool, 6_000, {
    cyborgAlertWindowMs: BASE_CONFIG.cyborgAlertWindowMs,
  })
  assert.equal(alert.pool, 'pool_cyborg')
  assert.equal(alert.buyCompetitorWalletCount5s, 0)
  assert.equal(alert.interactingWalletCount5s, 1)
  assert.deepEqual(alert.interactingWallets5s, ['wallet_sell_only'])

  applyInteractionEvent(
    pool,
    makeInteractionEvent('buy', { pool: 'pool_cyborg', user: 'wallet_buyer' }),
    { timeMs: 4_000, source: 'slotBlockTime' },
    'sig_buyer',
    BASE_CONFIG
  )

  assert.equal(shouldTriggerCyborgAlert(pool, 6_000, {
    cyborgAlertWindowMs: BASE_CONFIG.cyborgAlertWindowMs,
    cyborgMaxBuyCompetitors: 0,
  }), false)
})

test('creator drain rule only flags creator-signed near-total drains within the rug window', () => {
  const pool = createPoolObservation({
    event: makeCreatePoolEvent({
      creator: 'creator_wallet',
      initialBaseReserveRaw: 1_000_000_000n,
      initialQuoteReserveRaw: 5_000_000_000n,
    }),
    signature: 'sig_create',
    slot: 1,
    createBlockTimeMs: 1000,
    anchorTime: { timeMs: 1000, source: 'blockTime' },
    signerAddresses: ['creator_wallet'],
  })

  applyInteractionEvent(
    pool,
    makeInteractionEvent('withdraw', {
      user: 'not_creator',
      poolBaseReserveRaw: 1n,
      poolQuoteReserveRaw: 1n,
    }),
    { timeMs: 20_000, source: 'slotBlockTime' },
    'sig_non_creator',
    BASE_CONFIG
  )
  assert.equal(pool.creatorDrainedWithin60m, false)

  applyInteractionEvent(
    pool,
    makeInteractionEvent('withdraw', {
      user: 'creator_wallet',
      poolBaseReserveRaw: 500_000_000n,
      poolQuoteReserveRaw: 3_000_000_000n,
    }),
    { timeMs: 25_000, source: 'slotBlockTime' },
    'sig_partial',
    BASE_CONFIG
  )
  assert.equal(pool.creatorDrainedWithin60m, false)

  applyInteractionEvent(
    pool,
    makeInteractionEvent('withdraw', {
      user: 'creator_wallet',
      poolBaseReserveRaw: 5_000_000n,
      poolQuoteReserveRaw: 90_000_000n,
    }),
    { timeMs: 30_000, source: 'slotBlockTime' },
    'sig_creator_drain',
    BASE_CONFIG
  )
  assert.equal(pool.creatorDrainedWithin60m, true)
  assert.equal(pool.creatorDrainSignature, 'sig_creator_drain')

  const latePool = createPoolObservation({
    event: makeCreatePoolEvent({ creator: 'creator_wallet' }),
    signature: 'sig_create_2',
    slot: 1,
    createBlockTimeMs: 1000,
    anchorTime: { timeMs: 1000, source: 'blockTime' },
    signerAddresses: ['creator_wallet'],
  })
  applyInteractionEvent(
    latePool,
    makeInteractionEvent('withdraw', {
      user: 'creator_wallet',
      poolBaseReserveRaw: 1n,
      poolQuoteReserveRaw: 1n,
    }),
    { timeMs: BASE_CONFIG.rugWindowMs + 2_000, source: 'slotBlockTime' },
    'sig_late',
    BASE_CONFIG
  )
  assert.equal(latePool.creatorDrainedWithin60m, false)
})

test('isNearTotalDrain supports both percentage and absolute remaining-SOL checks', () => {
  assert.equal(isNearTotalDrain({
    initialBaseReserveRaw: 1_000n,
    initialQuoteReserveRaw: 1_000n,
    remainingBaseReserveRaw: 10n,
    remainingQuoteReserveRaw: 10n,
    drainThresholdPct: 99,
    quoteMint: 'So11111111111111111111111111111111111111112',
    minRemainingSolRawString: '0.1',
    quoteMintDecimals: 9,
  }), true)

  assert.equal(isNearTotalDrain({
    initialBaseReserveRaw: 1_000_000_000n,
    initialQuoteReserveRaw: 5_000_000_000n,
    remainingBaseReserveRaw: 600_000_000n,
    remainingQuoteReserveRaw: 50_000_000n,
    drainThresholdPct: 99,
    quoteMint: 'So11111111111111111111111111111111111111112',
    minRemainingSolRawString: '0.1',
    quoteMintDecimals: 9,
  }), true)
})

test('buildSummaryMetrics separates eligible, excluded, drained, and legitimate pools', () => {
  const anchored = summarizePoolObservation(
    createPoolObservation({
      event: makeCreatePoolEvent({ pool: 'pool_anchored' }),
      signature: 'sig_anchored',
      slot: 1,
      createBlockTimeMs: 1000,
      anchorTime: { timeMs: 1000, source: 'blockTime' },
      signerAddresses: ['creator_1'],
    }),
    BASE_CONFIG.rugWindowMs + 5_000,
    BASE_CONFIG
  )

  const drainedPoolState = createPoolObservation({
    event: makeCreatePoolEvent({ pool: 'pool_drained', creator: 'creator_wallet' }),
    signature: 'sig_drained',
    slot: 2,
    createBlockTimeMs: 1000,
    anchorTime: { timeMs: 1000, source: 'blockTime' },
    signerAddresses: ['creator_wallet'],
  })
  applyInteractionEvent(
    drainedPoolState,
    makeInteractionEvent('withdraw', {
      pool: 'pool_drained',
      user: 'creator_wallet',
      poolBaseReserveRaw: 1n,
      poolQuoteReserveRaw: 1n,
    }),
    { timeMs: 5_000, source: 'slotBlockTime' },
    'sig_drain',
    BASE_CONFIG
  )
  const drained = summarizePoolObservation(drainedPoolState, BASE_CONFIG.rugWindowMs + 5_000, BASE_CONFIG)

  const excluded = summarizePoolObservation(
    createPoolObservation({
      event: makeCreatePoolEvent({ pool: 'pool_excluded' }),
      signature: 'sig_excluded',
      slot: 3,
      createBlockTimeMs: null,
      anchorTime: { timeMs: null, source: 'unavailable' },
      signerAddresses: ['creator_1'],
    }),
    BASE_CONFIG.rugWindowMs + 5_000,
    BASE_CONFIG
  )

  const metrics = buildSummaryMetrics([anchored, drained, excluded])

  assert.equal(metrics.totalPoolsObserved, 3)
  assert.equal(metrics.poolsEligibleForPrimaryMetrics, 2)
  assert.equal(metrics.poolsExcludedForMissingAnchor, 1)
  assert.equal(metrics.completedRugWindowPools, 2)
  assert.equal(metrics.creatorDrainedWithin60mPools, 1)
  assert.equal(metrics.legitimatePools, 1)
  assert.equal(metrics.cyborgEligiblePools5s, 2)
  assert.equal(metrics.cyborgTriggeredPools5s, 0)
})
