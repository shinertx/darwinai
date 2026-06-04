import { getTierPriority } from './mission'
import { MarketSignal, StrategyAssessment, StrategyAssessmentTier } from '../types'

export type LiveQualifiedTier = Extract<StrategyAssessmentTier, 'tier_a' | 'tier_b'>

export interface LiveExecutionConfig {
  allowedSignalTypes: MarketSignal['type'][]
  minQualifiedTier: LiveQualifiedTier
  minAssessmentTrades: number
  maxNewEntries: number
  autoStopAfterEntry: boolean
  canaryAllowUnqualified: boolean
  signalMaxAgeMs: number
  migrationMaxAgeMs: number
  migrationReadyDelayMs: number
  mintAttemptCooldownMs: number
  migrationPoolRetryAttempts: number
  migrationPoolRetryDelayMs: number
  poolLookupTimeoutMs: number
  priorityMicro: number
  migrationPriorityMicro: number
  buySlippagePct: number
  migrationBuySlippagePct: number
  sellSlippagePct: number
}

export interface LiveSignalWindow {
  status: 'ready' | 'too_early' | 'stale'
  ageMs: number
  minAgeMs: number
  maxAgeMs: number
  waitMs: number
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value || '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
}

function parseMinQualifiedTier(value: string | undefined): LiveQualifiedTier {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'tier_a' ? 'tier_a' : 'tier_b'
}

function parseAllowedSignalTypes(value: string | undefined): MarketSignal['type'][] {
  const allowed = new Set<MarketSignal['type']>()
  for (const raw of (value || 'migration').split(',')) {
    const normalized = raw.trim().toLowerCase()
    if (
      normalized === 'migration' ||
      normalized === 'amm_activity' ||
      normalized === 'whale_buy' ||
      normalized === 'new_pool'
    ) {
      allowed.add(normalized)
    }
  }

  if (allowed.size === 0) {
    allowed.add('migration')
  }

  return Array.from(allowed)
}

export function resolveLiveExecutionConfig(
  env: NodeJS.ProcessEnv = process.env
): LiveExecutionConfig {
  return {
    allowedSignalTypes: parseAllowedSignalTypes(env.DARWIN_LIVE_ALLOWED_SIGNAL_TYPES),
    minQualifiedTier: parseMinQualifiedTier(env.DARWIN_LIVE_MIN_QUALIFIED_TIER),
    minAssessmentTrades: parsePositiveInt(env.DARWIN_LIVE_MIN_ASSESSMENT_TRADES, 10),
    maxNewEntries: parsePositiveInt(env.DARWIN_LIVE_MAX_NEW_ENTRIES, 1),
    autoStopAfterEntry: parseBooleanFlag(env.DARWIN_LIVE_AUTO_STOP_AFTER_ENTRY, true),
    canaryAllowUnqualified: parseBooleanFlag(env.DARWIN_LIVE_CANARY_ALLOW_UNQUALIFIED, false),
    signalMaxAgeMs: parsePositiveInt(env.DARWIN_LIVE_SIGNAL_MAX_AGE_MS, 12_000),
    migrationMaxAgeMs: parsePositiveInt(env.DARWIN_LIVE_MIGRATION_MAX_AGE_MS, 6_000),
    migrationReadyDelayMs: parseNonNegativeInt(env.DARWIN_LIVE_MIGRATION_READY_DELAY_MS, 0),
    mintAttemptCooldownMs: parsePositiveInt(env.DARWIN_LIVE_MINT_ATTEMPT_COOLDOWN_MS, 30_000),
    migrationPoolRetryAttempts: parsePositiveInt(env.DARWIN_LIVE_MIGRATION_POOL_RETRY_ATTEMPTS, 2),
    migrationPoolRetryDelayMs: parsePositiveInt(env.DARWIN_LIVE_MIGRATION_POOL_RETRY_DELAY_MS, 200),
    poolLookupTimeoutMs: parsePositiveInt(env.DARWIN_LIVE_POOL_LOOKUP_TIMEOUT_MS, 700),
    priorityMicro: parsePositiveInt(env.DARWIN_LIVE_PRIORITY_MICRO, 200_000),
    migrationPriorityMicro: parsePositiveInt(env.DARWIN_LIVE_MIGRATION_PRIORITY_MICRO, 600_000),
    buySlippagePct: parsePositiveNumber(env.DARWIN_LIVE_BUY_SLIPPAGE_PCT, 15),
    migrationBuySlippagePct: parsePositiveNumber(env.DARWIN_LIVE_MIGRATION_BUY_SLIPPAGE_PCT, 25),
    sellSlippagePct: parsePositiveNumber(env.DARWIN_LIVE_SELL_SLIPPAGE_PCT, 20),
  }
}

export function getLiveSignalAgeMs(
  signal: Pick<MarketSignal, 'timestamp'>,
  now = Date.now()
): number {
  return Math.max(0, now - signal.timestamp)
}

export function getLiveSignalWindow(
  signal: Pick<MarketSignal, 'type' | 'timestamp'>,
  config: LiveExecutionConfig,
  now = Date.now()
): LiveSignalWindow {
  const ageMs = getLiveSignalAgeMs(signal, now)
  const isMigration = signal.type === 'migration'
  const minAgeMs = isMigration ? config.migrationReadyDelayMs : 0
  const maxAgeMs = isMigration ? config.migrationMaxAgeMs : config.signalMaxAgeMs

  if (ageMs > maxAgeMs) {
    return {
      status: 'stale',
      ageMs,
      minAgeMs,
      maxAgeMs,
      waitMs: 0,
    }
  }

  if (ageMs < minAgeMs) {
    return {
      status: 'too_early',
      ageMs,
      minAgeMs,
      maxAgeMs,
      waitMs: minAgeMs - ageMs,
    }
  }

  return {
    status: 'ready',
    ageMs,
    minAgeMs,
    maxAgeMs,
    waitMs: 0,
  }
}

export function getLiveAttemptCooldownRemainingMs(
  lastAttemptAt: number | undefined,
  config: LiveExecutionConfig,
  now = Date.now()
): number {
  if (!lastAttemptAt) return 0
  return Math.max(0, config.mintAttemptCooldownMs - (now - lastAttemptAt))
}

export function isLiveEntryCapReached(
  openedEntries: number,
  config: Pick<LiveExecutionConfig, 'maxNewEntries'>
): boolean {
  return openedEntries >= config.maxNewEntries
}

export function isAssessmentQualifiedForLive(
  assessment: Pick<StrategyAssessment, 'tier' | 'tradeCount'>,
  config: LiveExecutionConfig
): boolean {
  if (assessment.tradeCount < config.minAssessmentTrades) {
    return false
  }

  return getTierPriority(assessment.tier) >= getTierPriority(config.minQualifiedTier)
}

export function isCanaryQualificationBypassAllowed(
  config: Pick<LiveExecutionConfig, 'canaryAllowUnqualified' | 'maxNewEntries' | 'autoStopAfterEntry'>
): boolean {
  return config.canaryAllowUnqualified && config.maxNewEntries === 1 && config.autoStopAfterEntry
}

export function resolveLivePriorityMicro(
  action: 'buy' | 'sell',
  signalType: MarketSignal['type'] | undefined,
  config: LiveExecutionConfig
): number {
  if (signalType === 'migration') {
    return config.migrationPriorityMicro
  }

  if (action === 'buy') {
    return config.priorityMicro
  }

  return config.priorityMicro
}

export function resolveLiveBuySlippagePct(
  signalType: MarketSignal['type'],
  config: LiveExecutionConfig
): number {
  if (signalType === 'migration') {
    return config.migrationBuySlippagePct
  }

  return config.buySlippagePct
}
