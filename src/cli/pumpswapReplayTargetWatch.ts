import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import {
  analyzePumpswapReplayTargetWatch,
  type ReplayTargetWatchGrid,
} from '../analysis/PumpswapReplayTargetWatch'

dotenv.config()
try {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
} catch {}

const OUTPUT_DIR = path.resolve(process.cwd(), process.env.PUMPSWAP_META_OUTPUT_DIR || 'data/meta-observer')

const DEFAULT_TARGET_SEGMENT_INCLUDES = [
  'profile=crowded',
  'rent=yes',
  'initial_liquidity=75_to_125_sol',
  'entry_liquidity_growth=0_to_10_pct',
  'entry_momentum=0_to_10_pct',
  'pre_entry_buys=3_to_5',
  'pre_entry_interactions=11_plus',
]

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseNonNegativeFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value || '')
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback
  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return parsed.length ? parsed : fallback
}

function resolveGridFiles(): string[] {
  const configured = process.env.PUMPSWAP_REPLAY_TARGET_GRID_PATHS
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

function readGrid(filePath: string): ReplayTargetWatchGrid {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ReplayTargetWatchGrid
}

async function main(): Promise<void> {
  const gridFiles = resolveGridFiles()
  if (!gridFiles.length) throw new Error('No non-empty replay grid files found')

  const report = analyzePumpswapReplayTargetWatch(
    gridFiles.map(readGrid),
    {
      targetSegmentIncludes: parseStringList(
        process.env.PUMPSWAP_REPLAY_TARGET_SEGMENT_INCLUDES,
        DEFAULT_TARGET_SEGMENT_INCLUDES
      ),
      minSamplePools: parsePositiveInt(process.env.PUMPSWAP_REPLAY_TARGET_MIN_SAMPLE_POOLS, 20),
      minCompletedPaths: parsePositiveInt(process.env.PUMPSWAP_REPLAY_TARGET_MIN_COMPLETED_PATHS, 20),
      minWinRate: parseNonNegativeFloat(process.env.PUMPSWAP_REPLAY_TARGET_MIN_WIN_RATE, 0.65),
      minRentTradableRate: parseNonNegativeFloat(process.env.PUMPSWAP_REPLAY_TARGET_MIN_RENT_TRADABLE_RATE, 0.9),
      minMedianModeledNetReturnPct: parseNonNegativeFloat(
        process.env.PUMPSWAP_REPLAY_TARGET_MIN_MEDIAN_MODELED_NET_RETURN_PCT,
        15
      ),
      minAvgModeledNetReturnPct: parseNonNegativeFloat(
        process.env.PUMPSWAP_REPLAY_TARGET_MIN_AVG_MODELED_NET_RETURN_PCT,
        15
      ),
    }
  )

  const outputPath = path.join(
    OUTPUT_DIR,
    `replay-target-watch-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  )
  fs.writeFileSync(outputPath, JSON.stringify({
    ...report,
    inputs: {
      ...report.inputs,
      gridFiles,
    },
  }, null, 2) + '\n')

  console.log('[ReplayTargetWatch] Wrote:', outputPath)
  console.log('[ReplayTargetWatch] Status:', report.status)
  console.log('[ReplayTargetWatch] Matching rows:', report.totals.matchingRows)
  console.log('[ReplayTargetWatch] Candidate rows:', report.totals.candidateRows)
  if (report.bestMatch) {
    console.log(
      `[ReplayTargetWatch] Best: pools=${report.bestMatch.pools} completed=${report.bestMatch.completedPaths} win=${report.bestMatch.winRate === null ? 'n/a' : `${(report.bestMatch.winRate * 100).toFixed(1)}%`} medianNet=${report.bestMatch.medianModeledNetReturnPct === null ? 'n/a' : `${report.bestMatch.medianModeledNetReturnPct.toFixed(2)}%`} blockers=${report.bestMatch.blockers.join('|') || 'none'}`
    )
  }
}

main().catch((error) => {
  console.error('[ReplayTargetWatch] Fatal error:', error?.message || error)
  process.exit(1)
})
