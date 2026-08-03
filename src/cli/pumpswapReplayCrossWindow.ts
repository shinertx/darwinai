import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import {
  analyzePumpswapReplayCrossWindow,
  type ReplayCrossWindowCandidate,
  type ReplayCrossWindowGrid,
} from '../analysis/PumpswapReplayCrossWindow'

dotenv.config()
try {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: false })
} catch {}

const OUTPUT_DIR = path.resolve(process.cwd(), process.env.PUMPSWAP_META_OUTPUT_DIR || 'data/meta-observer')

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseNonNegativeFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value || '')
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function resolveGridFiles(): string[] {
  const configured = process.env.PUMPSWAP_REPLAY_CROSS_WINDOW_GRID_PATHS
  if (!configured) {
    throw new Error('PUMPSWAP_REPLAY_CROSS_WINDOW_GRID_PATHS is required; select final disjoint grids explicitly')
  }
  return configured
    .split(',')
    .map((entry) => path.resolve(process.cwd(), entry.trim()))
    .filter(Boolean)
}

function readGrid(filePath: string): ReplayCrossWindowGrid {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new Error(`Replay grid is missing or empty: ${filePath}`)
  }
  return {
    ...JSON.parse(fs.readFileSync(filePath, 'utf8')) as ReplayCrossWindowGrid,
    sourcePath: filePath,
  }
}

function describe(candidate: ReplayCrossWindowCandidate): string {
  const win = candidate.winRate === null ? 'n/a' : `${(candidate.winRate * 100).toFixed(1)}%`
  const worstMedian = candidate.worstWindowMedianModeledNetReturnPct === null
    ? 'n/a'
    : `${candidate.worstWindowMedianModeledNetReturnPct.toFixed(2)}%`
  return `${candidate.id} windows=${candidate.windows} pools=${candidate.pools} completed=${candidate.completedPaths} win=${win} worstMedian=${worstMedian} blockers=${candidate.blockers.join('|') || 'none'}`
}

async function main(): Promise<void> {
  const gridFiles = resolveGridFiles()
  const report = analyzePumpswapReplayCrossWindow(
    gridFiles.map(readGrid),
    {
      minWindows: parsePositiveInt(process.env.PUMPSWAP_REPLAY_CROSS_WINDOW_MIN_WINDOWS, 2),
      minSamplePools: parsePositiveInt(process.env.PUMPSWAP_REPLAY_FRONTIER_MIN_SAMPLE_POOLS, 20),
      minCompletedPaths: parsePositiveInt(process.env.PUMPSWAP_REPLAY_FRONTIER_MIN_COMPLETED_PATHS, 20),
      minCompletedPathsPerWindow: parsePositiveInt(
        process.env.PUMPSWAP_REPLAY_CROSS_WINDOW_MIN_COMPLETED_PER_WINDOW,
        5
      ),
      minWinRate: parseNonNegativeFloat(process.env.PUMPSWAP_REPLAY_FRONTIER_MIN_WIN_RATE, 0.65),
      minRentTradableRate: parseNonNegativeFloat(
        process.env.PUMPSWAP_REPLAY_FRONTIER_MIN_RENT_TRADABLE_RATE,
        0.9
      ),
      minAvgModeledNetReturnPct: parseNonNegativeFloat(
        process.env.PUMPSWAP_REPLAY_FRONTIER_MIN_AVG_MODELED_NET_RETURN_PCT,
        15
      ),
      minWindowWinRate: parseNonNegativeFloat(
        process.env.PUMPSWAP_REPLAY_CROSS_WINDOW_MIN_WINDOW_WIN_RATE,
        0.5
      ),
      minWindowAvgModeledNetReturnPct: parseNonNegativeFloat(
        process.env.PUMPSWAP_REPLAY_CROSS_WINDOW_MIN_WINDOW_AVG_NET_RETURN_PCT,
        0
      ),
      minWindowMedianModeledNetReturnPct: parseNonNegativeFloat(
        process.env.PUMPSWAP_REPLAY_CROSS_WINDOW_MIN_WINDOW_MEDIAN_NET_RETURN_PCT,
        parseNonNegativeFloat(
          process.env.PUMPSWAP_REPLAY_FRONTIER_MIN_MEDIAN_MODELED_NET_RETURN_PCT,
          15
        )
      ),
    }
  )

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const outputPath = path.join(
    OUTPUT_DIR,
    `replay-cross-window-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  )
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')

  console.log('[ReplayCrossWindow] Wrote:', outputPath)
  console.log('[ReplayCrossWindow] Independent grids:', report.totals.grids)
  console.log('[ReplayCrossWindow] Unique event files:', report.totals.eventFiles)
  console.log('[ReplayCrossWindow] Paper candidates:', report.totals.paperCandidates)
  console.log('[ReplayCrossWindow] Collect more:', report.totals.collectMore)
  console.log('[ReplayCrossWindow] Unstable:', report.totals.unstableAcrossWindows)
  if (report.topPaperCandidates[0]) {
    console.log('[ReplayCrossWindow] Best paper candidate:', describe(report.topPaperCandidates[0]))
  }
  if (report.topCollectMore[0]) {
    console.log('[ReplayCrossWindow] Best collect-more:', describe(report.topCollectMore[0]))
  }
  if (report.topUnstableAcrossWindows[0]) {
    console.log('[ReplayCrossWindow] Best unstable:', describe(report.topUnstableAcrossWindows[0]))
  }
}

main().catch((error) => {
  console.error('[ReplayCrossWindow] Fatal error:', error?.message || error)
  process.exit(1)
})
