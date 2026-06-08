export type ReplayGateMonitorState = {
  eventFile?: string
  eventSizeBytes?: number
  lastCheckedAt?: string
  lastRefreshAt?: string
  lastDecisionReason?: string
  lastGrowthBytes?: number
  lastRefreshExitStatus?: number | null
  lastRefreshStatus?: string | null
  lastTargetStatus?: string | null
  latestRefreshArtifact?: string | null
  latestFrontierArtifact?: string | null
  latestTargetArtifact?: string | null
}

export type ReplayGateMonitorDecisionInput = {
  eventFile: string
  eventSizeBytes: number
  state: ReplayGateMonitorState | null
  minGrowthBytes: number
  runOnStart: boolean
}

export type ReplayGateMonitorDecision = {
  shouldRun: boolean
  reason: string
  growthBytes: number
}

export function isReplayGateRefreshArtifactName(name: string): boolean {
  return /^replay-gate-refresh-\d{4}-\d{2}-\d{2}T.+\.json$/.test(name)
}

export function decideReplayGateRefresh(input: ReplayGateMonitorDecisionInput): ReplayGateMonitorDecision {
  if (!input.state?.eventFile || input.state.eventSizeBytes === undefined) {
    return {
      shouldRun: input.runOnStart,
      reason: input.runOnStart ? 'no_state_run_on_start' : 'no_state_record_baseline',
      growthBytes: 0,
    }
  }

  if (input.state.eventFile !== input.eventFile) {
    return {
      shouldRun: true,
      reason: 'event_file_changed',
      growthBytes: input.eventSizeBytes,
    }
  }

  const growthBytes = input.eventSizeBytes - input.state.eventSizeBytes
  if (growthBytes < 0) {
    return {
      shouldRun: true,
      reason: 'event_file_shrank_or_rotated',
      growthBytes,
    }
  }

  if (growthBytes >= input.minGrowthBytes) {
    return {
      shouldRun: true,
      reason: `event_growth>=${input.minGrowthBytes}`,
      growthBytes,
    }
  }

  return {
    shouldRun: false,
    reason: `event_growth<${input.minGrowthBytes}`,
    growthBytes,
  }
}
