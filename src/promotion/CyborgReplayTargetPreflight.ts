import fs from 'fs'
import path from 'path'

type ReplayTargetScenarioInputs = {
  entryDelayMs?: number
  maxHoldMs?: number
  exitAfterLaterBuys?: number
}

type ReplayTargetBestMatch = {
  segment?: string
  scenarioInputs?: ReplayTargetScenarioInputs
  blockers?: string[]
}

type ReplayTargetWatchReportLite = {
  status?: string
  bestMatch?: ReplayTargetBestMatch | null
  candidates?: unknown[]
}

export type CyborgReplayTargetPreflightOptions = {
  inputDir: string
  targetWatchPath?: string
  allowReplayTargetBypass?: boolean
}

export type CyborgReplayTargetPreflightResult = {
  allowed: boolean
  reason: 'paper_candidate' | 'target_not_ready' | 'missing_target_watch' | 'override_target_not_ready'
  targetWatchPath: string | null
  status: string | null
  candidateCount: number
  blockers: string[]
  recommendedEnv: Record<string, string>
  message: string
}

function latestTargetWatchFile(inputDir: string): string | null {
  if (!fs.existsSync(inputDir)) return null
  const files = fs.readdirSync(inputDir)
    .filter((name) => name.startsWith('replay-target-watch-') && name.endsWith('.json'))
    .map((name) => path.join(inputDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return files[0] || null
}

function readReport(filePath: string): ReplayTargetWatchReportLite {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ReplayTargetWatchReportLite
}

function setPositiveNumberEnv(env: Record<string, string>, key: string, value: number | undefined): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return
  env[key] = Math.trunc(value).toString()
}

function segmentIncludes(segment: string, token: string): boolean {
  return segment.split('|').includes(token)
}

function buildRecommendedEnv(bestMatch?: ReplayTargetBestMatch | null): Record<string, string> {
  const env: Record<string, string> = {}
  const inputs = bestMatch?.scenarioInputs
  setPositiveNumberEnv(env, 'PUMPSWAP_CYBORG_EXECUTION_DEFER_MS', inputs?.entryDelayMs)
  setPositiveNumberEnv(env, 'PUMPSWAP_CYBORG_EXIT_AFTER_LATER_BUYS', inputs?.exitAfterLaterBuys)
  setPositiveNumberEnv(env, 'PUMPSWAP_CYBORG_MAX_HOLD_MS', inputs?.maxHoldMs)

  const segment = bestMatch?.segment || ''
  if (!segment) return env

  if (segmentIncludes(segment, 'profile=strict_zero')) {
    env.PUMPSWAP_CYBORG_SCORER_MIN_SCORE = '70'
    env.PUMPSWAP_CYBORG_SCORER_MIN_BUY_COMPETITORS_5S = '0'
    env.PUMPSWAP_CYBORG_SCORER_MAX_BUY_COMPETITORS_5S = '0'
    env.PUMPSWAP_CYBORG_SCORER_MIN_INTERACTIONS_5S = '0'
    env.PUMPSWAP_CYBORG_SCORER_MAX_INTERACTIONS_5S = '0'
  } else if (segmentIncludes(segment, 'profile=low_buy_competition')) {
    env.PUMPSWAP_CYBORG_SCORER_MIN_SCORE = '58'
    env.PUMPSWAP_CYBORG_SCORER_MIN_BUY_COMPETITORS_5S = '0'
    env.PUMPSWAP_CYBORG_SCORER_MAX_BUY_COMPETITORS_5S = '2'
    env.PUMPSWAP_CYBORG_SCORER_MIN_INTERACTIONS_5S = '0'
    env.PUMPSWAP_CYBORG_SCORER_MAX_INTERACTIONS_5S = '12'
  } else if (segmentIncludes(segment, 'profile=crowded')) {
    env.PUMPSWAP_CYBORG_SCORER_MIN_SCORE = '18'
    env.PUMPSWAP_CYBORG_SCORER_MIN_BUY_COMPETITORS_5S = '3'
    env.PUMPSWAP_CYBORG_SCORER_MAX_BUY_COMPETITORS_5S = '999'
    env.PUMPSWAP_CYBORG_SCORER_MIN_INTERACTIONS_5S = '1'
    env.PUMPSWAP_CYBORG_SCORER_MAX_INTERACTIONS_5S = '999'
  }

  if (segmentIncludes(segment, 'initial_liquidity=75_to_125_sol')) {
    env.PUMPSWAP_CYBORG_SCORER_MIN_LIQUIDITY_SOL = '75'
  }
  if (segmentIncludes(segment, 'pre_entry_buys=3_to_5')) {
    env.PUMPSWAP_CYBORG_SCORER_MIN_BUY_COMPETITORS_5S = '3'
    env.PUMPSWAP_CYBORG_SCORER_MAX_BUY_COMPETITORS_5S = '5'
  }
  if (segmentIncludes(segment, 'pre_entry_buys=2')) {
    env.PUMPSWAP_CYBORG_SCORER_MIN_BUY_COMPETITORS_5S = '2'
    env.PUMPSWAP_CYBORG_SCORER_MAX_BUY_COMPETITORS_5S = '2'
  }
  if (segmentIncludes(segment, 'pre_entry_buys=1')) {
    env.PUMPSWAP_CYBORG_SCORER_MIN_BUY_COMPETITORS_5S = '1'
    env.PUMPSWAP_CYBORG_SCORER_MAX_BUY_COMPETITORS_5S = '1'
  }
  if (segmentIncludes(segment, 'pre_entry_interactions=11_plus')) {
    env.PUMPSWAP_CYBORG_SCORER_MIN_INTERACTIONS_5S = '11'
    env.PUMPSWAP_CYBORG_SCORER_MAX_INTERACTIONS_5S = '999'
  }

  return env
}

export function evaluateCyborgReplayTargetPreflight(
  options: CyborgReplayTargetPreflightOptions
): CyborgReplayTargetPreflightResult {
  const targetWatchPath = options.targetWatchPath
    ? path.resolve(options.targetWatchPath)
    : latestTargetWatchFile(options.inputDir)

  if (!targetWatchPath || !fs.existsSync(targetWatchPath)) {
    return {
      allowed: Boolean(options.allowReplayTargetBypass),
      reason: options.allowReplayTargetBypass ? 'override_target_not_ready' : 'missing_target_watch',
      targetWatchPath: targetWatchPath || null,
      status: null,
      candidateCount: 0,
      blockers: ['missing_replay_target_watch'],
      recommendedEnv: {},
      message: options.allowReplayTargetBypass
        ? 'Diagnostic override active: allowing promotion batch without a replay target-watch artifact.'
        : 'Refusing promotion batch: no replay target-watch artifact exists. Run the offline replay gate refresh before spending live capital.',
    }
  }

  const report = readReport(targetWatchPath)
  const status = report.status || null
  const candidateCount = Array.isArray(report.candidates) ? report.candidates.length : 0
  const blockers = report.bestMatch?.blockers || []
  const recommendedEnv = buildRecommendedEnv(report.bestMatch)
  const ready = status === 'PAPER_CANDIDATE' && candidateCount > 0 && blockers.length === 0

  if (ready) {
    return {
      allowed: true,
      reason: 'paper_candidate',
      targetWatchPath,
      status,
      candidateCount,
      blockers,
      recommendedEnv,
      message: `Replay target preflight passed: latest target-watch is PAPER_CANDIDATE with ${candidateCount} candidate row(s); target-derived live config is available.`,
    }
  }

  if (options.allowReplayTargetBypass) {
    return {
      allowed: true,
      reason: 'override_target_not_ready',
      targetWatchPath,
      status,
      candidateCount,
      blockers,
      recommendedEnv,
      message: `Diagnostic override active: allowing promotion batch even though replay target status is ${status || 'unknown'}.`,
    }
  }

  return {
    allowed: false,
    reason: 'target_not_ready',
    targetWatchPath,
    status,
    candidateCount,
    blockers,
    recommendedEnv,
    message: `Refusing promotion batch: latest replay target-watch status is ${status || 'unknown'}, not PAPER_CANDIDATE. Live remains locked until the offline replay gate clears.`,
  }
}
