import fs from 'fs'
import path from 'path'

type ReplayTargetWatchReportLite = {
  status?: string
  bestMatch?: {
    blockers?: string[]
  } | null
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
      message: options.allowReplayTargetBypass
        ? 'Diagnostic override active: allowing promotion batch without a replay target-watch artifact.'
        : 'Refusing promotion batch: no replay target-watch artifact exists. Run the offline replay gate refresh before spending live capital.',
    }
  }

  const report = readReport(targetWatchPath)
  const status = report.status || null
  const candidateCount = Array.isArray(report.candidates) ? report.candidates.length : 0
  const blockers = report.bestMatch?.blockers || []
  const ready = status === 'PAPER_CANDIDATE' && candidateCount > 0 && blockers.length === 0

  if (ready) {
    return {
      allowed: true,
      reason: 'paper_candidate',
      targetWatchPath,
      status,
      candidateCount,
      blockers,
      message: `Replay target preflight passed: latest target-watch is PAPER_CANDIDATE with ${candidateCount} candidate row(s).`,
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
    message: `Refusing promotion batch: latest replay target-watch status is ${status || 'unknown'}, not PAPER_CANDIDATE. Live remains locked until the offline replay gate clears.`,
  }
}
