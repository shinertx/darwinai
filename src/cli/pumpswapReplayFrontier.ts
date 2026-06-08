import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import {
  analyzePumpswapReplayFrontier,
  type ReplayFrontierGrid,
} from '../analysis/PumpswapReplayFrontier'

dotenv.config()
try {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
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
  const configured = process.env.PUMPSWAP_REPLAY_FRONTIER_GRID_PATHS
  if (configured) {
    return configured
      .split(',')
      .map((entry) => path.resolve(process.cwd(), entry.trim()))
      .filter(Boolean)
  }
  if (!fs.existsSync(OUTPUT_DIR)) return []
  return fs.readdirSync(OUTPUT_DIR)
    .filter((name) => name.startsWith('replay-path-grid-study-') && name.endsWith('.json'))
    .map((name) => path.join(OUTPUT_DIR, name))
    .filter((filePath) => fs.statSync(filePath).size > 0)
    .sort()
    .slice(-1)
}

function readGrid(filePath: string): ReplayFrontierGrid {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ReplayFrontierGrid
}

function describeRow(row: { id: string; pools: number; completedPaths: number; winRate: number | null; medianModeledNetReturnPct: number | null; blockers: string[] }): string {
  const win = row.winRate === null ? 'n/a' : `${(row.winRate * 100).toFixed(1)}%`
  const median = row.medianModeledNetReturnPct === null ? 'n/a' : `${row.medianModeledNetReturnPct.toFixed(2)}%`
  return `${row.id} pools=${row.pools} completed=${row.completedPaths} win=${win} medianNet=${median} blockers=${row.blockers.join('|') || 'none'}`
}

async function main(): Promise<void> {
  const gridFiles = resolveGridFiles()
  if (!gridFiles.length) throw new Error('No non-empty replay grid files found')

  const report = analyzePumpswapReplayFrontier(
    gridFiles.map(readGrid),
    {
      minSamplePools: parsePositiveInt(process.env.PUMPSWAP_REPLAY_FRONTIER_MIN_SAMPLE_POOLS, 20),
      minCompletedPaths: parsePositiveInt(process.env.PUMPSWAP_REPLAY_FRONTIER_MIN_COMPLETED_PATHS, 20),
      minWinRate: parseNonNegativeFloat(process.env.PUMPSWAP_REPLAY_FRONTIER_MIN_WIN_RATE, 0.65),
      minRentTradableRate: parseNonNegativeFloat(process.env.PUMPSWAP_REPLAY_FRONTIER_MIN_RENT_TRADABLE_RATE, 0.9),
      minMedianModeledNetReturnPct: parseNonNegativeFloat(
        process.env.PUMPSWAP_REPLAY_FRONTIER_MIN_MEDIAN_MODELED_NET_RETURN_PCT,
        15
      ),
      minAvgModeledNetReturnPct: parseNonNegativeFloat(
        process.env.PUMPSWAP_REPLAY_FRONTIER_MIN_AVG_MODELED_NET_RETURN_PCT,
        15
      ),
    }
  )

  const outputPath = path.join(
    OUTPUT_DIR,
    `replay-frontier-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  )
  fs.writeFileSync(outputPath, JSON.stringify({
    ...report,
    inputs: {
      ...report.inputs,
      gridFiles,
    },
  }, null, 2) + '\n')

  console.log('[ReplayFrontier] Wrote:', outputPath)
  console.log('[ReplayFrontier] Paper candidates:', report.totals.paperCandidates)
  console.log('[ReplayFrontier] Collect more:', report.totals.collectMore)
  console.log('[ReplayFrontier] Mutate edge:', report.totals.mutateEdge)
  console.log('[ReplayFrontier] Reject rent:', report.totals.rejectRent)
  if (report.topCollectMore[0]) {
    console.log('[ReplayFrontier] Best collect-more:', describeRow(report.topCollectMore[0]))
  }
  if (report.topMutateEdge[0]) {
    console.log('[ReplayFrontier] Best mutate-edge:', describeRow(report.topMutateEdge[0]))
  }
}

main().catch((error) => {
  console.error('[ReplayFrontier] Fatal error:', error?.message || error)
  process.exit(1)
})
