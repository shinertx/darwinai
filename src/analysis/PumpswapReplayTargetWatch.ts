export type ReplayTargetWatchSegment = {
  segment: string
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

export type ReplayTargetWatchScenario = {
  inputs?: {
    entryDelayMs?: number
    maxHoldMs?: number
    exitAfterLaterBuys?: number
    fixedCostSol?: number
  }
  bySegment?: ReplayTargetWatchSegment[]
}

export type ReplayTargetWatchGrid = {
  generatedAt?: string
  inputs?: unknown
  scenarios?: ReplayTargetWatchScenario[]
}

export type ReplayTargetWatchOptions = {
  targetSegmentIncludes: string[]
  minSamplePools: number
  minCompletedPaths: number
  minWinRate: number
  minRentTradableRate: number
  minMedianModeledNetReturnPct: number
  minAvgModeledNetReturnPct: number
}

export type ReplayTargetWatchMatch = ReplayTargetWatchSegment & {
  scenarioInputs?: ReplayTargetWatchScenario['inputs']
  blockers: string[]
}

export type ReplayTargetWatchReport = {
  generatedAt: string
  inputs: ReplayTargetWatchOptions & {
    gridGeneratedAts: string[]
  }
  totals: {
    grids: number
    scenarios: number
    matchingRows: number
    candidateRows: number
  }
  status: 'PAPER_CANDIDATE' | 'WAIT' | 'TARGET_NOT_FOUND'
  bestMatch: ReplayTargetWatchMatch | null
  candidates: ReplayTargetWatchMatch[]
  matches: ReplayTargetWatchMatch[]
}

function valueOrNegativeInfinity(value: number | null | undefined): number {
  return value ?? Number.NEGATIVE_INFINITY
}

function targetMatches(segment: string, includes: string[]): boolean {
  return includes.every((entry) => segment.includes(entry))
}

function blockersFor(row: ReplayTargetWatchSegment, options: ReplayTargetWatchOptions): string[] {
  const blockers: string[] = []
  if (row.pools < options.minSamplePools) {
    blockers.push(`sample_pools<${options.minSamplePools}`)
  }
  if (row.completedPaths < options.minCompletedPaths) {
    blockers.push(`completed_paths<${options.minCompletedPaths}`)
  }
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

function rankMatches(a: ReplayTargetWatchMatch, b: ReplayTargetWatchMatch): number {
  return (
    a.blockers.length - b.blockers.length
    || b.pools - a.pools
    || valueOrNegativeInfinity(b.medianModeledNetReturnPct) - valueOrNegativeInfinity(a.medianModeledNetReturnPct)
    || valueOrNegativeInfinity(b.avgModeledNetReturnPct) - valueOrNegativeInfinity(a.avgModeledNetReturnPct)
    || valueOrNegativeInfinity(b.winRate) - valueOrNegativeInfinity(a.winRate)
  )
}

export function analyzePumpswapReplayTargetWatch(
  grids: ReplayTargetWatchGrid[],
  options: ReplayTargetWatchOptions
): ReplayTargetWatchReport {
  const matches: ReplayTargetWatchMatch[] = []
  let scenarios = 0

  for (const grid of grids) {
    for (const scenario of grid.scenarios || []) {
      scenarios += 1
      for (const row of scenario.bySegment || []) {
        if (!targetMatches(row.segment, options.targetSegmentIncludes)) continue
        matches.push({
          ...row,
          scenarioInputs: scenario.inputs,
          blockers: blockersFor(row, options),
        })
      }
    }
  }

  matches.sort(rankMatches)
  const candidates = matches.filter((row) => row.blockers.length === 0)

  return {
    generatedAt: new Date().toISOString(),
    inputs: {
      ...options,
      gridGeneratedAts: grids.map((grid) => grid.generatedAt || 'unknown'),
    },
    totals: {
      grids: grids.length,
      scenarios,
      matchingRows: matches.length,
      candidateRows: candidates.length,
    },
    status: candidates.length > 0 ? 'PAPER_CANDIDATE' : matches.length > 0 ? 'WAIT' : 'TARGET_NOT_FOUND',
    bestMatch: matches[0] || null,
    candidates,
    matches,
  }
}
