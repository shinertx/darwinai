export type ReplayFrontierMetricRow = {
  segment?: string
  profile?: string
  pools: number
  completedPaths: number
  rentTradableRate: number | null
  avgModeledNetReturnPct: number | null
  medianModeledNetReturnPct: number | null
  winRate: number | null
  promotionStatus?: string
  promotionBlockers?: string[]
}

export type ReplayFrontierScenario = {
  inputs?: {
    entryDelayMs?: number
    maxHoldMs?: number
    exitAfterLaterBuys?: number
    fixedCostSol?: number
  }
  byProfile?: ReplayFrontierMetricRow[]
  bySegment?: ReplayFrontierMetricRow[]
}

export type ReplayFrontierGrid = {
  generatedAt?: string
  scenarios?: ReplayFrontierScenario[]
}

export type ReplayFrontierOptions = {
  minSamplePools: number
  minCompletedPaths: number
  minWinRate: number
  minRentTradableRate: number
  minMedianModeledNetReturnPct: number
  minAvgModeledNetReturnPct: number
}

export type ReplayFrontierAction =
  | 'PAPER_CANDIDATE'
  | 'COLLECT_MORE'
  | 'MUTATE_EDGE'
  | 'REJECT_RENT'
  | 'REJECT_SAMPLE_AND_EDGE'

export type ReplayFrontierCandidate = ReplayFrontierMetricRow & {
  kind: 'profile' | 'segment'
  id: string
  scenarioInputs?: ReplayFrontierScenario['inputs']
  action: ReplayFrontierAction
  blockers: string[]
}

export type ReplayFrontierReport = {
  generatedAt: string
  inputs: ReplayFrontierOptions & {
    gridGeneratedAts: string[]
  }
  totals: {
    grids: number
    scenarios: number
    rows: number
    paperCandidates: number
    collectMore: number
    mutateEdge: number
    rejectRent: number
    rejectSampleAndEdge: number
  }
  topPaperCandidates: ReplayFrontierCandidate[]
  topCollectMore: ReplayFrontierCandidate[]
  topMutateEdge: ReplayFrontierCandidate[]
  topRejectRent: ReplayFrontierCandidate[]
}

const SAMPLE_BLOCKERS = new Set(['sample_pools', 'completed_paths'])
const RENT_BLOCKERS = new Set(['no_rent_free_first_buyer_evidence', 'rent_tradable_rate'])
const EDGE_BLOCKERS = new Set([
  'median_modeled_net_return_pct',
  'avg_modeled_net_return_pct',
  'win_rate',
])

function valueOrNegativeInfinity(value: number | null | undefined): number {
  return value ?? Number.NEGATIVE_INFINITY
}

function blockerKind(blocker: string): string {
  if (blocker.startsWith('sample_pools')) return 'sample_pools'
  if (blocker.startsWith('completed_paths')) return 'completed_paths'
  if (blocker.startsWith('rent_tradable_rate')) return 'rent_tradable_rate'
  if (blocker.startsWith('median_modeled_net_return_pct')) return 'median_modelled_net_return_pct'.replace('modelled', 'modeled')
  if (blocker.startsWith('avg_modeled_net_return_pct')) return 'avg_modeled_net_return_pct'
  if (blocker.startsWith('win_rate')) return 'win_rate'
  return blocker
}

function blockersFor(row: ReplayFrontierMetricRow, options: ReplayFrontierOptions): string[] {
  const blockers: string[] = []
  if (row.pools < options.minSamplePools) blockers.push(`sample_pools<${options.minSamplePools}`)
  if (row.completedPaths < options.minCompletedPaths) blockers.push(`completed_paths<${options.minCompletedPaths}`)
  if (row.rentTradableRate === null || row.rentTradableRate < options.minRentTradableRate) {
    blockers.push(`rent_tradable_rate<${options.minRentTradableRate}`)
  }
  if (row.medianModeledNetReturnPct === null || row.medianModeledNetReturnPct <= options.minMedianModeledNetReturnPct) {
    blockers.push(`median_modeled_net_return_pct<=${options.minMedianModeledNetReturnPct}`)
  }
  if (row.avgModeledNetReturnPct === null || row.avgModeledNetReturnPct <= options.minAvgModeledNetReturnPct) {
    blockers.push(`avg_modeled_net_return_pct<=${options.minAvgModeledNetReturnPct}`)
  }
  if (row.winRate === null || row.winRate < options.minWinRate) {
    blockers.push(`win_rate<${options.minWinRate}`)
  }
  return blockers
}

function actionFor(blockers: string[]): ReplayFrontierAction {
  if (blockers.length === 0) return 'PAPER_CANDIDATE'
  const kinds = blockers.map(blockerKind)
  if (kinds.every((kind) => SAMPLE_BLOCKERS.has(kind))) return 'COLLECT_MORE'
  if (kinds.some((kind) => RENT_BLOCKERS.has(kind))) return 'REJECT_RENT'
  if (kinds.some((kind) => EDGE_BLOCKERS.has(kind))) {
    return kinds.some((kind) => SAMPLE_BLOCKERS.has(kind)) ? 'REJECT_SAMPLE_AND_EDGE' : 'MUTATE_EDGE'
  }
  return 'REJECT_SAMPLE_AND_EDGE'
}

function rank(a: ReplayFrontierCandidate, b: ReplayFrontierCandidate): number {
  return (
    valueOrNegativeInfinity(b.medianModeledNetReturnPct) - valueOrNegativeInfinity(a.medianModeledNetReturnPct)
    || valueOrNegativeInfinity(b.avgModeledNetReturnPct) - valueOrNegativeInfinity(a.avgModeledNetReturnPct)
    || valueOrNegativeInfinity(b.winRate) - valueOrNegativeInfinity(a.winRate)
    || b.completedPaths - a.completedPaths
    || b.pools - a.pools
  )
}

function candidateFrom(
  kind: 'profile' | 'segment',
  row: ReplayFrontierMetricRow,
  scenarioInputs: ReplayFrontierScenario['inputs'],
  options: ReplayFrontierOptions
): ReplayFrontierCandidate {
  const blockers = blockersFor(row, options)
  return {
    ...row,
    kind,
    id: kind === 'segment' ? row.segment || 'unknown_segment' : row.profile || 'unknown_profile',
    scenarioInputs,
    blockers,
    action: actionFor(blockers),
  }
}

export function analyzePumpswapReplayFrontier(
  grids: ReplayFrontierGrid[],
  options: ReplayFrontierOptions
): ReplayFrontierReport {
  const candidates: ReplayFrontierCandidate[] = []
  let scenarios = 0

  for (const grid of grids) {
    for (const scenario of grid.scenarios || []) {
      scenarios += 1
      for (const row of scenario.byProfile || []) {
        candidates.push(candidateFrom('profile', row, scenario.inputs, options))
      }
      for (const row of scenario.bySegment || []) {
        candidates.push(candidateFrom('segment', row, scenario.inputs, options))
      }
    }
  }

  const byAction = (action: ReplayFrontierAction) => candidates
    .filter((candidate) => candidate.action === action)
    .sort(rank)

  const topPaperCandidates = byAction('PAPER_CANDIDATE')
  const topCollectMore = byAction('COLLECT_MORE')
  const topMutateEdge = byAction('MUTATE_EDGE')
  const topRejectRent = byAction('REJECT_RENT')
  const rejectSampleAndEdge = byAction('REJECT_SAMPLE_AND_EDGE')

  return {
    generatedAt: new Date().toISOString(),
    inputs: {
      ...options,
      gridGeneratedAts: grids.map((grid) => grid.generatedAt || 'unknown'),
    },
    totals: {
      grids: grids.length,
      scenarios,
      rows: candidates.length,
      paperCandidates: topPaperCandidates.length,
      collectMore: topCollectMore.length,
      mutateEdge: topMutateEdge.length,
      rejectRent: topRejectRent.length,
      rejectSampleAndEdge: rejectSampleAndEdge.length,
    },
    topPaperCandidates: topPaperCandidates.slice(0, 20),
    topCollectMore: topCollectMore.slice(0, 20),
    topMutateEdge: topMutateEdge.slice(0, 20),
    topRejectRent: topRejectRent.slice(0, 20),
  }
}
