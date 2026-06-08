import { type resolveCyborgShapeScoringConfig } from './cyborgShapeScoring'

type CyborgShapeScoringConfig = ReturnType<typeof resolveCyborgShapeScoringConfig>

function parseBooleanFlag(value: string | undefined): boolean {
  return ['true', '1', 'yes', 'on'].includes((value || '').trim().toLowerCase())
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export type CyborgStrategyConfig = {
  scorer: {
    minScore: number
    maxBuyCompetitors5s: number
    maxInteractingWallets5s: number
    minLiquiditySol: number
    requireUniqueCreator: boolean
  }
  alertWindowMs: number
  executionDeferMs: number
  liveSignalMaxAgeMs: string | null
  exitRule: {
    mode: 'immediate' | 'later_buy_threshold'
    laterBuyThreshold: number
    maxHoldMs: number
  }
  allowedStateRentSetup: {
    ataCreate: boolean
    poolExtend: boolean
    closeTokenAtaOnSell: boolean
  }
  settlementRoute: 'direct_rpc'
}

export function resolveCyborgStrategyConfig(
  env: NodeJS.ProcessEnv,
  shapeConfig: CyborgShapeScoringConfig,
  alertWindowMs: number,
  executionDeferMs: number
): CyborgStrategyConfig {
  const laterBuyThreshold = parseNonNegativeInt(env.PUMPSWAP_CYBORG_EXIT_AFTER_LATER_BUYS, 0)
  const maxHoldMs = parseNonNegativeInt(env.PUMPSWAP_CYBORG_MAX_HOLD_MS, 0)
  const delayedExitEnabled = laterBuyThreshold > 0 && maxHoldMs > 0

  return {
    scorer: {
      minScore: shapeConfig.minScore,
      maxBuyCompetitors5s: shapeConfig.maxBuyCompetitors5s,
      maxInteractingWallets5s: shapeConfig.maxInteractingWallets5s,
      minLiquiditySol: shapeConfig.minLiquiditySol,
      requireUniqueCreator: shapeConfig.requireUniqueCreator,
    },
    alertWindowMs,
    executionDeferMs,
    liveSignalMaxAgeMs: env.DARWIN_LIVE_SIGNAL_MAX_AGE_MS || null,
    exitRule: {
      mode: delayedExitEnabled ? 'later_buy_threshold' : 'immediate',
      laterBuyThreshold: delayedExitEnabled ? laterBuyThreshold : 0,
      maxHoldMs: delayedExitEnabled ? maxHoldMs : 0,
    },
    allowedStateRentSetup: {
      ataCreate: parseBooleanFlag(env.DARWIN_LIVE_ALLOW_ATA_CREATE),
      poolExtend: parseBooleanFlag(env.DARWIN_LIVE_ALLOW_POOL_EXTEND),
      closeTokenAtaOnSell: parseBooleanFlag(env.DARWIN_LIVE_CLOSE_TOKEN_ATA_ON_SELL),
    },
    settlementRoute: 'direct_rpc',
  }
}
