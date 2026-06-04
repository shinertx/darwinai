import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import {
  getLiveAttemptCooldownRemainingMs,
  getLiveSignalWindow,
  isCanaryQualificationBypassAllowed,
  isLiveEntryCapReached,
  isAssessmentQualifiedForLive,
  resolveLiveExecutionConfig,
} from '../config/liveExecution'
import {
  detectStateRentBlockReason,
  detectStateRentBlockReasons,
  detectStateRentBlockReasonFromLogs,
  detectStateRentBlockReasonsFromLogs,
  getExecutionPoolCandidates,
  getSignalPoolCandidates,
  getWsolPoolSide,
} from '../execution/LiveExecutor'
import { MarketSignal } from '../types'

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

test('live execution config exposes conservative defaults', () => {
  const config = resolveLiveExecutionConfig({})

  assert.deepEqual(config.allowedSignalTypes, ['migration'])
  assert.equal(config.minQualifiedTier, 'tier_b')
  assert.equal(config.minAssessmentTrades, 10)
  assert.equal(config.maxNewEntries, 1)
  assert.equal(config.autoStopAfterEntry, true)
  assert.equal(config.canaryAllowUnqualified, false)
  assert.equal(config.migrationMaxAgeMs, 6000)
  assert.equal(config.migrationReadyDelayMs, 0)
  assert.equal(config.migrationPoolRetryAttempts, 2)
  assert.equal(config.migrationPoolRetryDelayMs, 200)
  assert.equal(config.poolLookupTimeoutMs, 700)
  assert.equal(config.migrationPriorityMicro, 600000)
})

test('migration live signals are immediately ready, then expire quickly', () => {
  const config = resolveLiveExecutionConfig({})
  const signal = makeSignal({ type: 'migration', timestamp: 10_000 })

  const ready = getLiveSignalWindow(signal, config, 10_500)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.waitMs, 0)

  const stale = getLiveSignalWindow(signal, config, 16_100)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.maxAgeMs, 6000)
})

test('non-migration live signals use the generic freshness window', () => {
  const config = resolveLiveExecutionConfig({})
  const signal = makeSignal({ type: 'whale_buy', timestamp: 20_000 })

  const ready = getLiveSignalWindow(signal, config, 21_000)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.minAgeMs, 0)
  assert.equal(ready.maxAgeMs, 12_000)

  const stale = getLiveSignalWindow(signal, config, 32_500)
  assert.equal(stale.status, 'stale')
})

test('live attempt cooldown blocks repeated mint entries briefly', () => {
  const config = resolveLiveExecutionConfig({})

  assert.equal(getLiveAttemptCooldownRemainingMs(undefined, config, 50_000), 0)
  assert.equal(getLiveAttemptCooldownRemainingMs(50_000, config, 50_500), 29_500)
  assert.equal(getLiveAttemptCooldownRemainingMs(50_000, config, 81_000), 0)
})

test('live canary cap blocks entries after the configured limit', () => {
  const config = resolveLiveExecutionConfig({})

  assert.equal(isLiveEntryCapReached(0, config), false)
  assert.equal(isLiveEntryCapReached(1, config), true)
  assert.equal(isLiveEntryCapReached(2, config), true)
})

test('live qualification requires both tier and enough observed trades', () => {
  const config = resolveLiveExecutionConfig({})

  assert.equal(
    isAssessmentQualifiedForLive({ tier: 'tier_b', tradeCount: 10 }, config),
    true
  )
  assert.equal(
    isAssessmentQualifiedForLive({ tier: 'tier_a', tradeCount: 9 }, config),
    false
  )
  assert.equal(
    isAssessmentQualifiedForLive({ tier: 'tier_c', tradeCount: 25 }, config),
    false
  )
})

test('live canary qualification bypass is explicit and requires one-entry auto-stop guards', () => {
  const defaultConfig = resolveLiveExecutionConfig({})
  assert.equal(isCanaryQualificationBypassAllowed(defaultConfig), false)

  const guardedConfig = resolveLiveExecutionConfig({
    DARWIN_LIVE_CANARY_ALLOW_UNQUALIFIED: 'true',
    DARWIN_LIVE_MAX_NEW_ENTRIES: '1',
    DARWIN_LIVE_AUTO_STOP_AFTER_ENTRY: 'true',
  })
  assert.equal(isCanaryQualificationBypassAllowed(guardedConfig), true)

  const multiEntryConfig = resolveLiveExecutionConfig({
    DARWIN_LIVE_CANARY_ALLOW_UNQUALIFIED: 'true',
    DARWIN_LIVE_MAX_NEW_ENTRIES: '2',
    DARWIN_LIVE_AUTO_STOP_AFTER_ENTRY: 'true',
  })
  assert.equal(isCanaryQualificationBypassAllowed(multiEntryConfig), false)

  const noAutoStopConfig = resolveLiveExecutionConfig({
    DARWIN_LIVE_CANARY_ALLOW_UNQUALIFIED: 'true',
    DARWIN_LIVE_MAX_NEW_ENTRIES: '1',
    DARWIN_LIVE_AUTO_STOP_AFTER_ENTRY: 'false',
  })
  assert.equal(isCanaryQualificationBypassAllowed(noAutoStopConfig), false)
})

test('live signal type allowlist defaults to migration and accepts explicit overrides', () => {
  const defaultConfig = resolveLiveExecutionConfig({})
  assert.deepEqual(defaultConfig.allowedSignalTypes, ['migration'])

  const overrideConfig = resolveLiveExecutionConfig({
    DARWIN_LIVE_ALLOWED_SIGNAL_TYPES: 'migration,whale_buy,invalid',
  })
  assert.deepEqual(overrideConfig.allowedSignalTypes, ['migration', 'whale_buy'])
})

test('live executor recognizes both valid WSOL pool orientations', () => {
  const wsol = new PublicKey('So11111111111111111111111111111111111111112')
  const token = new PublicKey('11111111111111111111111111111112')

  assert.equal(getWsolPoolSide({ baseMint: token, quoteMint: wsol }), 'quote')
  assert.equal(getWsolPoolSide({ baseMint: wsol, quoteMint: token }), 'base')
  assert.equal(getWsolPoolSide({ baseMint: token, quoteMint: token }), null)
})

test('migration execution retries only the primary pool candidate', () => {
  const signal = makeSignal({
    type: 'migration',
    pool: 'pool_primary_111111111111111111111111111111',
    eventData: {
      detectedPoolCandidates: [
        'pool_primary_111111111111111111111111111111',
        'token_mint_2222222222222222222222222222222',
        'program_id_333333333333333333333333333333',
      ],
    },
  })

  assert.deepEqual(getSignalPoolCandidates(signal), [
    'pool_primary_111111111111111111111111111111',
    'token_mint_2222222222222222222222222222222',
    'program_id_333333333333333333333333333333',
  ])
  assert.deepEqual(getExecutionPoolCandidates(signal), [
    'pool_primary_111111111111111111111111111111',
  ])
})

test('non-migration execution keeps fallback pool candidates', () => {
  const signal = makeSignal({
    type: 'amm_activity',
    pool: 'pool_primary_111111111111111111111111111111',
    eventData: {
      detectedPoolCandidates: [
        'pool_primary_111111111111111111111111111111',
        'pool_secondary_222222222222222222222222222',
      ],
    },
  })

  assert.deepEqual(getExecutionPoolCandidates(signal), [
    'pool_primary_111111111111111111111111111111',
    'pool_secondary_222222222222222222222222222',
  ])
})

test('state-rent preflight detects associated token account creation instructions', () => {
  const associatedTokenProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
  const instruction = new TransactionInstruction({
    programId: associatedTokenProgram,
    keys: [],
    data: Buffer.alloc(0),
  })

  assert.equal(detectStateRentBlockReason([instruction]), 'ata_create')
})

test('state-rent preflight detects PumpSwap extend-account instructions', () => {
  const pumpAmmProgram = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
  const extendDiscriminator = Uint8Array.from([234, 102, 194, 203, 150, 72, 62, 229])
  const instruction = new TransactionInstruction({
    programId: pumpAmmProgram,
    keys: [],
    data: Buffer.from(extendDiscriminator),
  })

  assert.equal(detectStateRentBlockReason([instruction]), 'pool_extend')
})

test('state-rent simulation log detection catches ATA create and extend account', () => {
  assert.equal(
    detectStateRentBlockReasonFromLogs([
      'Program log: Instruction: CreateIdempotent',
    ]),
    'ata_create'
  )
  assert.equal(
    detectStateRentBlockReasonFromLogs([
      'Program log: Instruction: ExtendAccount',
    ]),
    'pool_extend'
  )
  assert.equal(detectStateRentBlockReasonFromLogs(null), null)
})

test('state-rent detection preserves multiple setup reasons in order', () => {
  const associatedTokenProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
  const pumpAmmProgram = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
  const extendDiscriminator = Uint8Array.from([234, 102, 194, 203, 150, 72, 62, 229])

  const ataCreate = new TransactionInstruction({
    programId: associatedTokenProgram,
    keys: [],
    data: Buffer.alloc(0),
  })
  const poolExtend = new TransactionInstruction({
    programId: pumpAmmProgram,
    keys: [],
    data: Buffer.from(extendDiscriminator),
  })

  assert.deepEqual(detectStateRentBlockReasons([ataCreate, poolExtend]), ['ata_create', 'pool_extend'])
  assert.deepEqual(
    detectStateRentBlockReasonsFromLogs([
      'Program log: Instruction: CreateIdempotent',
      'Program log: Instruction: ExtendAccount',
    ]),
    ['ata_create', 'pool_extend']
  )
})
