import { StrategyAssessmentTier } from '../types'

export interface MissionGateConfig {
  minTradesAfter4h: number
  maxDrawdownPct: number
  minBestTradePctAfter100Trades: number
  migrationRequiredTrades: number
  migrationRequiredMinutes: number
  maxNonMigrationSharePctAfter10Trades: number
  maxNoPumpBailPctAfter10Trades: number
}

export interface MissionTierThresholds {
  migrationSharePct: number
  migrationWinRatePct: number
  maxNoPumpBailPct: number
  minBestTradePct: number
  maxDrawdownPct: number
  minFillRatio: number
}

export interface MissionConfig {
  profitFactorCap: number
  hardFail: MissionGateConfig
  tiers: Record<'tier_a' | 'tier_b', MissionTierThresholds>
  microLiveAcceptance: {
    minMigrationTrades: number
    minMigrationSharePct: number
    minMigrationWinRatePct: number
    maxNoPumpBailPct: number
    maxDrawdownPct: number
    minBestTradePct: number
    minTotalPnlSol: number
  }
}

export const MISSION_CONFIG: MissionConfig = {
  profitFactorCap: 10,
  hardFail: {
    minTradesAfter4h: 30,
    maxDrawdownPct: 60,
    minBestTradePctAfter100Trades: 20,
    migrationRequiredTrades: 5,
    migrationRequiredMinutes: 15,
    maxNonMigrationSharePctAfter10Trades: 40,
    maxNoPumpBailPctAfter10Trades: 80,
  },
  tiers: {
    tier_a: {
      migrationSharePct: 85,
      migrationWinRatePct: 50,
      maxNoPumpBailPct: 45,
      minBestTradePct: 50,
      maxDrawdownPct: 15,
      minFillRatio: 0.7,
    },
    tier_b: {
      migrationSharePct: 75,
      migrationWinRatePct: 45,
      maxNoPumpBailPct: 55,
      minBestTradePct: 25,
      maxDrawdownPct: 20,
      minFillRatio: 0.5,
    },
  },
  microLiveAcceptance: {
    minMigrationTrades: 60,
    minMigrationSharePct: 80,
    minMigrationWinRatePct: 55,
    maxNoPumpBailPct: 45,
    maxDrawdownPct: 15,
    minBestTradePct: 50,
    minTotalPnlSol: 0.000001,
  },
}

const TIER_PRIORITY: Record<StrategyAssessmentTier, number> = {
  hard_fail: 0,
  tier_c: 1,
  tier_b: 2,
  tier_a: 3,
}

export function getTierPriority(tier: StrategyAssessmentTier): number {
  return TIER_PRIORITY[tier]
}

export function getStartingBalanceSol(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseFloat(env.STARTING_BALANCE_SOL || '1.0')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1.0
}

export function resolveGenerationCadence(env: NodeJS.ProcessEnv = process.env): {
  intervalMin: number
  intervalMs: number
  tradeThreshold: number
} {
  const parsedInterval = parseInt(env.DARWIN_GENERATION_INTERVAL_MIN || '60', 10)
  const parsedTrades = parseInt(env.DARWIN_GENERATION_TRADE_THRESHOLD || '75', 10)
  const intervalMin = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 60
  const tradeThreshold = Number.isFinite(parsedTrades) && parsedTrades > 0 ? parsedTrades : 75

  return {
    intervalMin,
    intervalMs: intervalMin * 60 * 1000,
    tradeThreshold,
  }
}
