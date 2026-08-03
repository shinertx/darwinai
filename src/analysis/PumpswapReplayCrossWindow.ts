import type {
  ReplayFrontierGrid,
  ReplayFrontierMetricRow,
  ReplayFrontierScenario,
} from './PumpswapReplayFrontier'

export type ReplayCrossWindowGrid = ReplayFrontierGrid & {
  sourcePath?: string
  inputs?: {
    eventFiles?: string[]
  }
}

export type ReplayCrossWindowOptions = {
  minWindows: number
  minSamplePools: number
  minCompletedPaths: number
  minCompletedPathsPerWindow: number
  minWinRate: number
  minRentTradableRate: number
  minAvgModeledNetReturnPct: number
  minWindowWinRate: number
  minWindowAvgModeledNetReturnPct: number
  minWindowMedianModeledNetReturnPct: number
}

export type ReplayCrossWindowAction =
  | 'PAPER_CANDIDATE'
  | 'COLLECT_MORE'
  | 'UNSTABLE_ACROSS_WINDOWS'
  | 'MUTATE_EDGE'
  | 'REJECT_RENT'
  | 'REJECT_SAMPLE_AND_EDGE'

type CandidateKind = 'profile' | 'segment'

type WindowObservation = {
  windowId: string
  sourcePath: string | null
  pools: number
  completedPaths: number
  rentTradableRate: number | null
  avgModeledNetReturnPct: number | null
  medianModeledNetReturnPct: number | null
  winRate: number | null
}

export type ReplayCrossWindowCandidate = {
  kind: CandidateKind
  id: string
  scenarioInputs: ReplayFrontierScenario['inputs']
  windows: number
  windowIds: string[]
  pools: number
  completedPaths: number
  minCompletedPathsPerWindow: number
  rentTradableRate: number | null
  avgModeledNetReturnPct: number | null
  winRate: number | null
  worstWindowRentTradableRate: number | null
  worstWindowAvgModeledNetReturnPct: number | null
  worstWindowMedianModeledNetReturnPct: number | null
  worstWindowWinRate: number | null
  action: ReplayCrossWindowAction
  blockers: string[]
  observations: WindowObservation[]
}

export type ReplayCrossWindowReport = {
  generatedAt: string
  inputs: ReplayCrossWindowOptions & {
    grids: Array<{
      sourcePath: string | null
      generatedAt: string
      eventFiles: string[]
      windowId: string
    }>
  }
  totals: {
    grids: number
    eventFiles: number
    scenarios: number
    candidateGroups: number
    paperCandidates: number
    collectMore: number
    unstableAcrossWindows: number
    mutateEdge: number
    rejectRent: number
    rejectSampleAndEdge: number
  }
  topPaperCandidates: ReplayCrossWindowCandidate[]
  topCollectMore: ReplayCrossWindowCandidate[]
  topUnstableAcrossWindows: ReplayCrossWindowCandidate[]
  topMutateEdge: ReplayCrossWindowCandidate[]
  topRejectRent: ReplayCrossWindowCandidate[]
}

type CandidateAccumulator = {
  kind: CandidateKind
  id: string
  scenarioInputs: ReplayFrontierScenario['inputs']
  observations: WindowObservation[]
}

const SAMPLE_BLOCKER_PREFIXES = [
  'windows<',
  'sample_pools<',
  'completed_paths<',
  'min_completed_paths_per_window<',
]

const STABILITY_BLOCKER_PREFIXES = [
  'worst_window_avg_modeled_net_return_pct<=',
  'worst_window_median_modeled_net_return_pct<=',
  'worst_window_win_rate<',
]

const RENT_BLOCKER_PREFIXES = [
  'rent_tradable_rate<',
  'worst_window_rent_tradable_rate<',
]

const EDGE_BLOCKER_PREFIXES = [
  'avg_modeled_net_return_pct<=',
  'win_rate<',
]

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function eventFilesFor(grid: ReplayCrossWindowGrid): string[] {
  const eventFiles = (grid.inputs?.eventFiles || []).map(basename).sort()
  if (!eventFiles.length) {
    throw new Error(`Replay grid has no eventFiles: ${grid.sourcePath || grid.generatedAt || 'unknown'}`)
  }
  const unique = new Set(eventFiles)
  if (unique.size !== eventFiles.length) {
    throw new Error(`Replay grid repeats an event source: ${grid.sourcePath || grid.generatedAt || 'unknown'}`)
  }
  return eventFiles
}

function numericKey(value: number | undefined): string {
  return Number.isFinite(value) ? String(value) : 'missing'
}

function candidateKey(
  kind: CandidateKind,
  id: string,
  inputs: ReplayFrontierScenario['inputs']
): string {
  return JSON.stringify([
    kind,
    id,
    numericKey(inputs?.entryDelayMs),
    numericKey(inputs?.maxHoldMs),
    numericKey(inputs?.exitAfterLaterBuys),
    numericKey(inputs?.tradeSizeSol),
    numericKey(inputs?.fixedCostSol),
  ])
}

function finiteMinimum(values: Array<number | null>): number | null {
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null
  return Math.min(...values as number[])
}

function weightedAverage(
  observations: WindowObservation[],
  value: (observation: WindowObservation) => number | null,
  weight: (observation: WindowObservation) => number
): number | null {
  let numerator = 0
  let denominator = 0
  for (const observation of observations) {
    const metric = value(observation)
    const metricWeight = weight(observation)
    if (metricWeight <= 0) continue
    if (!Number.isFinite(metric)) return null
    numerator += (metric as number) * metricWeight
    denominator += metricWeight
  }
  return denominator > 0 ? numerator / denominator : null
}

function belowOrMissing(value: number | null, threshold: number): boolean {
  return value === null || value <= threshold
}

function lowerThanOrMissing(value: number | null, threshold: number): boolean {
  return value === null || value < threshold
}

function blockersFor(
  candidate: Omit<ReplayCrossWindowCandidate, 'action' | 'blockers'>,
  options: ReplayCrossWindowOptions
): string[] {
  const blockers: string[] = []
  if (candidate.windows < options.minWindows) blockers.push(`windows<${options.minWindows}`)
  if (candidate.pools < options.minSamplePools) blockers.push(`sample_pools<${options.minSamplePools}`)
  if (candidate.completedPaths < options.minCompletedPaths) {
    blockers.push(`completed_paths<${options.minCompletedPaths}`)
  }
  if (candidate.minCompletedPathsPerWindow < options.minCompletedPathsPerWindow) {
    blockers.push(`min_completed_paths_per_window<${options.minCompletedPathsPerWindow}`)
  }
  if (lowerThanOrMissing(candidate.rentTradableRate, options.minRentTradableRate)) {
    blockers.push(`rent_tradable_rate<${options.minRentTradableRate}`)
  }
  if (lowerThanOrMissing(candidate.worstWindowRentTradableRate, options.minRentTradableRate)) {
    blockers.push(`worst_window_rent_tradable_rate<${options.minRentTradableRate}`)
  }
  if (belowOrMissing(candidate.avgModeledNetReturnPct, options.minAvgModeledNetReturnPct)) {
    blockers.push(`avg_modeled_net_return_pct<=${options.minAvgModeledNetReturnPct}`)
  }
  if (lowerThanOrMissing(candidate.winRate, options.minWinRate)) {
    blockers.push(`win_rate<${options.minWinRate}`)
  }
  if (belowOrMissing(
    candidate.worstWindowAvgModeledNetReturnPct,
    options.minWindowAvgModeledNetReturnPct
  )) {
    blockers.push(`worst_window_avg_modeled_net_return_pct<=${options.minWindowAvgModeledNetReturnPct}`)
  }
  if (belowOrMissing(
    candidate.worstWindowMedianModeledNetReturnPct,
    options.minWindowMedianModeledNetReturnPct
  )) {
    blockers.push(`worst_window_median_modeled_net_return_pct<=${options.minWindowMedianModeledNetReturnPct}`)
  }
  if (lowerThanOrMissing(candidate.worstWindowWinRate, options.minWindowWinRate)) {
    blockers.push(`worst_window_win_rate<${options.minWindowWinRate}`)
  }
  return blockers
}

function hasPrefix(blockers: string[], prefixes: string[]): boolean {
  return blockers.some((blocker) => prefixes.some((prefix) => blocker.startsWith(prefix)))
}

function actionFor(blockers: string[]): ReplayCrossWindowAction {
  if (!blockers.length) return 'PAPER_CANDIDATE'
  if (hasPrefix(blockers, RENT_BLOCKER_PREFIXES)) return 'REJECT_RENT'
  if (hasPrefix(blockers, STABILITY_BLOCKER_PREFIXES)) return 'UNSTABLE_ACROSS_WINDOWS'
  const hasSampleBlocker = hasPrefix(blockers, SAMPLE_BLOCKER_PREFIXES)
  const hasEdgeBlocker = hasPrefix(blockers, EDGE_BLOCKER_PREFIXES)
  if (hasSampleBlocker && !hasEdgeBlocker) return 'COLLECT_MORE'
  if (hasEdgeBlocker) return hasSampleBlocker ? 'REJECT_SAMPLE_AND_EDGE' : 'MUTATE_EDGE'
  return 'REJECT_SAMPLE_AND_EDGE'
}

function candidateFrom(
  accumulator: CandidateAccumulator,
  options: ReplayCrossWindowOptions
): ReplayCrossWindowCandidate {
  const observations = accumulator.observations.sort((a, b) => a.windowId.localeCompare(b.windowId))
  const pools = observations.reduce((sum, row) => sum + row.pools, 0)
  const completedPaths = observations.reduce((sum, row) => sum + row.completedPaths, 0)
  const base = {
    kind: accumulator.kind,
    id: accumulator.id,
    scenarioInputs: accumulator.scenarioInputs,
    windows: observations.length,
    windowIds: observations.map((row) => row.windowId),
    pools,
    completedPaths,
    minCompletedPathsPerWindow: Math.min(...observations.map((row) => row.completedPaths)),
    rentTradableRate: weightedAverage(observations, (row) => row.rentTradableRate, (row) => row.pools),
    avgModeledNetReturnPct: weightedAverage(
      observations,
      (row) => row.avgModeledNetReturnPct,
      (row) => row.completedPaths
    ),
    winRate: weightedAverage(observations, (row) => row.winRate, (row) => row.completedPaths),
    worstWindowRentTradableRate: finiteMinimum(observations.map((row) => row.rentTradableRate)),
    worstWindowAvgModeledNetReturnPct: finiteMinimum(
      observations.map((row) => row.avgModeledNetReturnPct)
    ),
    worstWindowMedianModeledNetReturnPct: finiteMinimum(
      observations.map((row) => row.medianModeledNetReturnPct)
    ),
    worstWindowWinRate: finiteMinimum(observations.map((row) => row.winRate)),
    observations,
  }
  const blockers = blockersFor(base, options)
  return {
    ...base,
    blockers,
    action: actionFor(blockers),
  }
}

function valueOrNegativeInfinity(value: number | null): number {
  return value ?? Number.NEGATIVE_INFINITY
}

function rank(a: ReplayCrossWindowCandidate, b: ReplayCrossWindowCandidate): number {
  return (
    b.windows - a.windows
    || b.completedPaths - a.completedPaths
    || valueOrNegativeInfinity(b.worstWindowMedianModeledNetReturnPct)
      - valueOrNegativeInfinity(a.worstWindowMedianModeledNetReturnPct)
    || valueOrNegativeInfinity(b.avgModeledNetReturnPct)
      - valueOrNegativeInfinity(a.avgModeledNetReturnPct)
    || valueOrNegativeInfinity(b.winRate) - valueOrNegativeInfinity(a.winRate)
  )
}

function rankCollectMore(a: ReplayCrossWindowCandidate, b: ReplayCrossWindowCandidate): number {
  return (
    b.windows - a.windows
    || b.minCompletedPathsPerWindow - a.minCompletedPathsPerWindow
    || b.completedPaths - a.completedPaths
    || b.pools - a.pools
    || rank(a, b)
  )
}

function rowId(kind: CandidateKind, row: ReplayFrontierMetricRow): string {
  return kind === 'segment' ? row.segment || 'unknown_segment' : row.profile || 'unknown_profile'
}

export function analyzePumpswapReplayCrossWindow(
  grids: ReplayCrossWindowGrid[],
  options: ReplayCrossWindowOptions
): ReplayCrossWindowReport {
  if (!grids.length) throw new Error('No replay grids provided')

  const seenEventFiles = new Map<string, string>()
  const gridInputs = grids.map((grid) => {
    const eventFiles = eventFilesFor(grid)
    const windowId = eventFiles.join(',')
    for (const eventFile of eventFiles) {
      const previous = seenEventFiles.get(eventFile)
      if (previous) {
        throw new Error(`Overlapping event source ${eventFile}: ${previous} and ${windowId}`)
      }
      seenEventFiles.set(eventFile, windowId)
    }
    return {
      sourcePath: grid.sourcePath || null,
      generatedAt: grid.generatedAt || 'unknown',
      eventFiles,
      windowId,
    }
  })

  const accumulators = new Map<string, CandidateAccumulator>()
  let scenarios = 0
  grids.forEach((grid, gridIndex) => {
    const gridInput = gridInputs[gridIndex]
    const seenInWindow = new Set<string>()
    for (const scenario of grid.scenarios || []) {
      scenarios += 1
      const addRows = (kind: CandidateKind, rows: ReplayFrontierMetricRow[]) => {
        for (const row of rows) {
          const id = rowId(kind, row)
          const key = candidateKey(kind, id, scenario.inputs)
          if (seenInWindow.has(key)) {
            throw new Error(`Duplicate candidate in window ${gridInput.windowId}: ${id}`)
          }
          seenInWindow.add(key)
          const accumulator = accumulators.get(key) || {
            kind,
            id,
            scenarioInputs: scenario.inputs,
            observations: [],
          }
          accumulator.observations.push({
            windowId: gridInput.windowId,
            sourcePath: gridInput.sourcePath,
            pools: row.pools,
            completedPaths: row.completedPaths,
            rentTradableRate: row.rentTradableRate,
            avgModeledNetReturnPct: row.avgModeledNetReturnPct,
            medianModeledNetReturnPct: row.medianModeledNetReturnPct,
            winRate: row.winRate,
          })
          accumulators.set(key, accumulator)
        }
      }
      addRows('profile', scenario.byProfile || [])
      addRows('segment', scenario.bySegment || [])
    }
  })

  const candidates = [...accumulators.values()].map((accumulator) => candidateFrom(accumulator, options))
  const byAction = (action: ReplayCrossWindowAction, sorter: typeof rank = rank) => candidates
    .filter((candidate) => candidate.action === action)
    .sort(sorter)

  const paperCandidates = byAction('PAPER_CANDIDATE')
  const collectMore = byAction('COLLECT_MORE', rankCollectMore)
  const unstableAcrossWindows = byAction('UNSTABLE_ACROSS_WINDOWS')
  const mutateEdge = byAction('MUTATE_EDGE')
  const rejectRent = byAction('REJECT_RENT')
  const rejectSampleAndEdge = byAction('REJECT_SAMPLE_AND_EDGE')

  return {
    generatedAt: new Date().toISOString(),
    inputs: {
      ...options,
      grids: gridInputs,
    },
    totals: {
      grids: grids.length,
      eventFiles: seenEventFiles.size,
      scenarios,
      candidateGroups: candidates.length,
      paperCandidates: paperCandidates.length,
      collectMore: collectMore.length,
      unstableAcrossWindows: unstableAcrossWindows.length,
      mutateEdge: mutateEdge.length,
      rejectRent: rejectRent.length,
      rejectSampleAndEdge: rejectSampleAndEdge.length,
    },
    topPaperCandidates: paperCandidates.slice(0, 20),
    topCollectMore: collectMore.slice(0, 20),
    topUnstableAcrossWindows: unstableAcrossWindows.slice(0, 20),
    topMutateEdge: mutateEdge.slice(0, 20),
    topRejectRent: rejectRent.slice(0, 20),
  }
}
