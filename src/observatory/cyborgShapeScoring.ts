export type CyborgShapeProfile = 'strict_zero' | 'low_competition' | 'crowded'

export type CyborgShapeInput = {
  buyCompetitorWalletCount5s: number
  interactingWalletCount5s: number
  liquiditySol: number
  uniqueCreatorInRun: boolean
}

export type CyborgShapeScoringConfig = {
  minScore: number
  maxBuyCompetitors5s: number
  maxInteractingWallets5s: number
  minLiquiditySol: number
  requireUniqueCreator: boolean
}

export type CyborgShapeScore = {
  profile: CyborgShapeProfile
  score: number
  maxScore: number
  qualified: boolean
  estimatedLaterBuyFlowRate: number | null
  estimatedThreePlusLaterBuyWalletRate: number | null
  reasons: string[]
  blockers: string[]
}

const DEFAULT_MIN_SCORE = 70
const DEFAULT_MAX_BUY_COMPETITORS_5S = 1
const DEFAULT_MAX_INTERACTING_WALLETS_5S = 12
const DEFAULT_MIN_LIQUIDITY_SOL = 20
const DEFAULT_REQUIRE_UNIQUE_CREATOR = true
const MAX_SCORE = 100

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value || '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export function resolveCyborgShapeScoringConfig(
  env: NodeJS.ProcessEnv = process.env
): CyborgShapeScoringConfig {
  return {
    minScore: parsePositiveInt(env.PUMPSWAP_CYBORG_SCORER_MIN_SCORE, DEFAULT_MIN_SCORE),
    maxBuyCompetitors5s: parseNonNegativeInt(
      env.PUMPSWAP_CYBORG_SCORER_MAX_BUY_COMPETITORS_5S,
      DEFAULT_MAX_BUY_COMPETITORS_5S
    ),
    maxInteractingWallets5s: parseNonNegativeInt(
      env.PUMPSWAP_CYBORG_SCORER_MAX_INTERACTIONS_5S,
      DEFAULT_MAX_INTERACTING_WALLETS_5S
    ),
    minLiquiditySol: parsePositiveFloat(
      env.PUMPSWAP_CYBORG_SCORER_MIN_LIQUIDITY_SOL,
      DEFAULT_MIN_LIQUIDITY_SOL
    ),
    requireUniqueCreator: parseBool(
      env.PUMPSWAP_CYBORG_SCORER_REQUIRE_UNIQUE_CREATOR,
      DEFAULT_REQUIRE_UNIQUE_CREATOR
    ),
  }
}

function determineProfile(input: CyborgShapeInput): CyborgShapeProfile {
  if (input.buyCompetitorWalletCount5s === 0 && input.interactingWalletCount5s === 0) {
    return 'strict_zero'
  }
  if (input.buyCompetitorWalletCount5s <= 1) {
    return 'low_competition'
  }
  return 'crowded'
}

export function scoreCyborgShape(
  input: CyborgShapeInput,
  config: CyborgShapeScoringConfig
): CyborgShapeScore {
  const profile = determineProfile(input)
  const blockers: string[] = []
  const reasons: string[] = []

  if (config.requireUniqueCreator && !input.uniqueCreatorInRun) {
    blockers.push('repeat_creator')
  }
  if (input.buyCompetitorWalletCount5s > config.maxBuyCompetitors5s) {
    blockers.push(`buy_competitors_5s>${config.maxBuyCompetitors5s}`)
  }
  if (input.interactingWalletCount5s > config.maxInteractingWallets5s) {
    blockers.push(`interactions_5s>${config.maxInteractingWallets5s}`)
  }
  if (!Number.isFinite(input.liquiditySol) || input.liquiditySol < config.minLiquiditySol) {
    blockers.push(`liquidity_sol<${config.minLiquiditySol}`)
  }

  let score = 0
  let estimatedLaterBuyFlowRate: number | null = null
  let estimatedThreePlusLaterBuyWalletRate: number | null = null

  if (profile === 'strict_zero') {
    score += 55
    estimatedLaterBuyFlowRate = 0.985
    estimatedThreePlusLaterBuyWalletRate = 0.901
    reasons.push('strict_zero_5s_window')
  } else if (profile === 'low_competition') {
    score += 40
    estimatedLaterBuyFlowRate = 0.975
    estimatedThreePlusLaterBuyWalletRate = 0.806
    reasons.push('low_buy_competition_5s_window')
  } else {
    reasons.push('crowded_early_window')
  }

  if (input.interactingWalletCount5s === 0) {
    score += 20
    reasons.push('no_non_creator_interactions_5s')
  } else if (input.interactingWalletCount5s <= 2) {
    score += 12
    reasons.push('very_low_interactions_5s')
  } else if (input.interactingWalletCount5s <= 5) {
    score += 6
    reasons.push('low_interactions_5s')
  }

  if (input.uniqueCreatorInRun) {
    score += 8
    reasons.push('unique_creator_in_run')
  }

  if (input.liquiditySol >= Math.max(50, config.minLiquiditySol)) {
    score += 10
    reasons.push('liquidity_sol>=50')
  } else if (input.liquiditySol >= config.minLiquiditySol) {
    score += 6
    reasons.push(`liquidity_sol>=${config.minLiquiditySol}`)
  }

  const qualified = blockers.length === 0 && score >= config.minScore

  return {
    profile,
    score: Math.min(score, MAX_SCORE),
    maxScore: MAX_SCORE,
    qualified,
    estimatedLaterBuyFlowRate,
    estimatedThreePlusLaterBuyWalletRate,
    reasons,
    blockers,
  }
}
