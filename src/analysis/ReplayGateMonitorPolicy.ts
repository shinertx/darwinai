export type ReplayGateMonitorState = {
  eventFile?: string
  eventSizeBytes?: number
  eventSummaryFile?: string | null
  eventWindowStatus?: ReplayEventWindowStatus
  eventTerminalReason?: string | null
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

export type ReplayEventWindowStatus = 'active' | 'completed' | 'invalid'

export type ReplayEventWindowClassification = {
  status: ReplayEventWindowStatus
  terminalReason: string | null
}

export type ReplayGateMonitorDecisionInput = {
  eventFile: string
  eventSizeBytes: number
  state: ReplayGateMonitorState | null
  minGrowthBytes: number
  runOnStart: boolean
  eventWindowStatus: ReplayEventWindowStatus
  eventTerminalReason?: string | null
}

export type ReplayGateMonitorDecision = {
  shouldRun: boolean
  reason: string
  growthBytes: number
}

export function isReplayGateRefreshArtifactName(name: string): boolean {
  return /^replay-gate-refresh-\d{4}-\d{2}-\d{2}T.+\.json$/.test(name)
}

export function classifyReplayEventWindow(
  summary: Record<string, unknown> | null
): ReplayEventWindowClassification {
  if (!summary) return { status: 'active', terminalReason: null }

  const terminalReason = typeof summary.reason === 'string' ? summary.reason : 'unknown'
  const ingest = summary.ingest as Record<string, unknown> | undefined
  if (terminalReason !== 'completed' || ingest?.queueOverflowed === true) {
    return {
      status: 'invalid',
      terminalReason: ingest?.queueOverflowed === true ? 'queue_overflow' : terminalReason,
    }
  }
  return { status: 'completed', terminalReason }
}

export function decideReplayGateRefresh(input: ReplayGateMonitorDecisionInput): ReplayGateMonitorDecision {
  if (input.eventWindowStatus === 'active') {
    return {
      shouldRun: false,
      reason: 'event_window_incomplete',
      growthBytes: 0,
    }
  }

  if (input.eventWindowStatus === 'invalid') {
    return {
      shouldRun: false,
      reason: `event_window_invalid:${input.eventTerminalReason || 'unknown'}`,
      growthBytes: 0,
    }
  }

  if (
    input.state?.eventFile !== input.eventFile ||
    input.state.eventWindowStatus !== 'completed'
  ) {
    return {
      shouldRun: true,
      reason: 'event_window_completed',
      growthBytes: input.eventSizeBytes,
    }
  }

  const growthBytes = input.eventSizeBytes - (input.state.eventSizeBytes ?? 0)
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
