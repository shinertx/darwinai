import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import {
  getSignalCooldownKey,
  isActionableWsolPool,
  MarketFeed,
  resolveMigrationFeedReadinessConfig,
} from '../market/MarketFeed'
import { MarketSignal, SignalSkipEvent } from '../types'

function makeSignal(
  overrides: Partial<MarketSignal> = {}
): MarketSignal {
  return {
    type: overrides.type || 'migration',
    mint: overrides.mint || 'mint_1',
    pool: overrides.pool || 'pool_1',
    liquiditySol: overrides.liquiditySol ?? 100,
    poolAgeMs: overrides.poolAgeMs ?? 0,
    priceSol: overrides.priceSol ?? 0,
    eventData: overrides.eventData || {},
    timestamp: overrides.timestamp ?? 1_000,
  }
}

test('market feed cooldown buckets are separated by signal type', () => {
  const migrationKey = getSignalCooldownKey({ mint: 'mint_1', type: 'migration' })
  const ammKey = getSignalCooldownKey({ mint: 'mint_1', type: 'amm_activity' })
  const whaleKey = getSignalCooldownKey({ mint: 'mint_1', type: 'whale_buy' })

  assert.notEqual(migrationKey, ammKey)
  assert.notEqual(migrationKey, whaleKey)
  assert.notEqual(ammKey, whaleKey)
})

test('migration feed readiness config defaults to a fast live queue', () => {
  const config = resolveMigrationFeedReadinessConfig({ DARWIN_MODE: 'live' })

  assert.equal(config.enabled, true)
  assert.equal(config.attempts, 6)
  assert.equal(config.intervalMs, 250)
  assert.equal(config.lookupTimeoutMs, 900)
  assert.equal(config.emitTxFallbackOnExpiry, false)
})

test('migration feed readiness can opt into tx fallback on expiry', () => {
  const config = resolveMigrationFeedReadinessConfig({
    DARWIN_MODE: 'live',
    DARWIN_MIGRATION_EMIT_TX_FALLBACK_ON_EXPIRY: 'true',
  })

  assert.equal(config.emitTxFallbackOnExpiry, true)
})

test('migration feed readiness accepts either WSOL pool orientation', () => {
  const wsol = new PublicKey('So11111111111111111111111111111111111111112')
  const token = new PublicKey('11111111111111111111111111111112')

  assert.equal(isActionableWsolPool({ baseMint: token, quoteMint: wsol }), true)
  assert.equal(isActionableWsolPool({ baseMint: wsol, quoteMint: token }), true)
  assert.equal(isActionableWsolPool({ baseMint: token, quoteMint: token }), false)
})

test('pending migration emits only after the pool is actionable', async () => {
  const feed = new MarketFeed() as any
  const detectedAt = 10_000
  const readyAt = 10_420
  const signal = makeSignal({
    mint: 'mint_ready',
    pool: 'pool_ready',
    eventData: { signature: 'sig_ready', detectedAt },
    timestamp: detectedAt,
  })

  let emitted: MarketSignal | null = null
  feed.on('signal', (nextSignal: MarketSignal) => {
    emitted = nextSignal
  })
  feed.waitForMigrationPoolReady = async () => ({ readyAt, pool: signal.pool })
  feed.pendingMigrationSignals.set(signal.pool, {
    signal,
    detectedAt,
    expiresAt: detectedAt + 5_000,
  })

  await feed.processPendingMigration(signal.pool)

  const emittedSignal = emitted as MarketSignal | null
  if (!emittedSignal) {
    assert.fail('expected actionable migration signal to emit')
  }
  assert.equal(emittedSignal.timestamp, readyAt)
  assert.equal(emittedSignal.poolAgeMs, 420)
  assert.equal(emittedSignal.eventData.detectedAt, detectedAt)
  assert.equal(emittedSignal.eventData.readyAt, readyAt)
  assert.equal(emittedSignal.eventData.readyLatencyMs, 420)
  assert.equal(feed.pendingMigrationSignals.size, 0)
})

test('pending migration timeout logs the feed readiness skip reason and emits nothing', async () => {
  const feed = new MarketFeed() as any
  const detectedAt = 25_000
  const signal = makeSignal({
    mint: 'mint_timeout',
    pool: 'pool_timeout',
    eventData: { signature: 'sig_timeout', detectedAt },
    timestamp: detectedAt,
  })

  let emitted = false
  let skipped: SignalSkipEvent | null = null
  feed.on('signal', () => {
    emitted = true
  })
  feed.on('signal_skipped', (event: SignalSkipEvent) => {
    skipped = event
  })
  feed.pendingMigrationLifecycle = { ttlMs: 1, ammExtensionMs: 1 }
  feed.waitForMigrationPoolReady = async () => null
  feed.pendingMigrationSignals.set(signal.pool, {
    signal,
    detectedAt,
    expiresAt: 0,
  })

  await feed.processPendingMigration(signal.pool)

  assert.equal(emitted, false)
  const skippedEvent = skipped as SignalSkipEvent | null
  if (!skippedEvent) {
    assert.fail('expected migration readiness timeout skip event')
  }
  assert.equal(skippedEvent.reason, 'migration_pool_not_ready_in_feed')
  assert.equal(skippedEvent.signal.mint, signal.mint)
  assert.equal(feed.pendingMigrationSignals.size, 0)
})

test('pending migration expiry can emit tx fallback when explicitly enabled', async () => {
  const feed = new MarketFeed() as any
  const detectedAt = Date.now() - 5_000
  const signal = makeSignal({
    mint: 'mint_tx_fallback',
    pool: 'pool_tx_fallback',
    liquiditySol: 75,
    eventData: { signature: 'sig_tx_fallback', detectedAt },
    timestamp: detectedAt,
  })

  let emitted: MarketSignal | null = null
  let skipped = false
  feed.on('signal', (nextSignal: MarketSignal) => {
    emitted = nextSignal
  })
  feed.on('signal_skipped', () => {
    skipped = true
  })
  feed.migrationReadinessConfig = {
    enabled: true,
    attempts: 1,
    intervalMs: 1,
    lookupTimeoutMs: 1,
    emitTxFallbackOnExpiry: true,
  }
  feed.waitForMigrationPoolReady = async () => null
  feed.pendingMigrationSignals.set(signal.pool, {
    signal,
    detectedAt,
    expiresAt: 0,
  })

  await feed.processPendingMigration(signal.pool)

  const emittedSignal = emitted as MarketSignal | null
  if (!emittedSignal) {
    assert.fail('expected tx fallback migration to emit')
  }
  assert.equal(skipped, false)
  assert.equal(emittedSignal.mint, signal.mint)
  assert.equal(emittedSignal.pool, signal.pool)
  assert.equal(emittedSignal.eventData.readySource, 'tx_fallback')
  assert.equal(feed.pendingMigrationSignals.size, 0)
})

test('pending migration keeps rechecking until actionable or expired', async () => {
  const feed = new MarketFeed() as any
  const detectedAt = Date.now()
  const signal = makeSignal({
    mint: 'mint_retry_ready',
    pool: 'pool_retry_ready',
    eventData: { signature: 'sig_retry_ready', detectedAt },
    timestamp: detectedAt,
  })

  let emitted: MarketSignal | null = null
  let attempts = 0
  feed.on('signal', (nextSignal: MarketSignal) => {
    emitted = nextSignal
  })
  feed.pendingMigrationLifecycle = { ttlMs: 100, ammExtensionMs: 1, recheckMs: 5 }
  feed.waitForMigrationPoolReady = async () => {
    attempts += 1
    if (attempts < 2) return null
    return { readyAt: detectedAt + 50, pool: signal.pool }
  }
  feed.pendingMigrationSignals.set(signal.pool, {
    signal,
    detectedAt,
    expiresAt: Date.now() + 100,
  })

  await feed.processPendingMigration(signal.pool)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const emittedSignal = emitted as MarketSignal | null
  if (!emittedSignal) {
    assert.fail('expected pending migration to emit after a retry')
  }
  assert.equal(attempts >= 2, true)
  assert.equal(emittedSignal.pool, signal.pool)
  assert.equal(feed.pendingMigrationSignals.size, 0)
})

test('migration readiness checks only the primary pool candidate', async () => {
  const feed = new MarketFeed() as any
  const detectedAt = Date.now()
  const primaryPool = 'BzFzZwYWakHKwVmrBExnoTLRMhh4GVLstL7gpNmy5oSe'
  const secondaryPool = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw'
  const signal = makeSignal({
    mint: 'mint_primary_candidate',
    pool: primaryPool,
    eventData: {
      signature: 'sig_primary_candidate',
      detectedAt,
      detectedPoolCandidates: [
        primaryPool,
        secondaryPool,
      ],
    },
    timestamp: detectedAt,
  })

  const attemptedPools: string[] = []
  feed.migrationReadinessConfig = {
    enabled: true,
    attempts: 1,
    intervalMs: 1,
    lookupTimeoutMs: 1,
    emitTxFallbackOnExpiry: false,
  }
  feed.migrationReadinessSdk = {
    swapSolanaState: async (pool: PublicKey) => {
      attemptedPools.push(pool.toBase58())
      return null
    },
  }

  await feed.waitForMigrationPoolReady(signal)

  assert.deepEqual(attemptedPools, [
    primaryPool,
  ])
})

test('amm activity re-polls readiness on the promoted pool before emitting', async () => {
  const feed = new MarketFeed() as any
  const detectedAt = Date.now() - 250
  const signal = makeSignal({
    mint: 'mint_amm_ready',
    pool: 'pool_detected',
    eventData: { signature: 'sig_amm_ready', detectedAt },
    timestamp: detectedAt,
  })
  const readyPool = 'pool_live_amm'

  let emitted: MarketSignal | null = null
  feed.on('signal', (nextSignal: MarketSignal) => {
    emitted = nextSignal
  })
  feed.waitForMigrationPoolReady = async (candidate: MarketSignal) => {
    assert.equal(candidate.pool, readyPool)
    return { readyAt: detectedAt + 500, pool: readyPool }
  }
  feed.pendingMigrationSignals.set(signal.pool, {
    signal,
    detectedAt,
    expiresAt: detectedAt + 5_000,
  })

  const promoted = feed.promotePendingMigrationFromAmm(readyPool, signal.mint, 88.8)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(promoted, true)
  const emittedSignal = emitted as MarketSignal | null
  if (!emittedSignal) {
    assert.fail('expected amm activity to promote pending migration')
  }
  assert.equal(emittedSignal.pool, readyPool)
  assert.equal(emittedSignal.liquiditySol, 100)
  assert.equal(emittedSignal.eventData.readySource, 'swap_state')
  assert.equal(emittedSignal.eventData.detectedPool, 'pool_detected')
  assert.equal(emittedSignal.eventData.readyPool, readyPool)
  assert.equal(feed.pendingMigrationSignals.size, 0)
})
