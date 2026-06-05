import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { analyzeCyborgBreakEven } from '../promotion/CyborgBreakEven'

function parsePositiveFloat(value: string | undefined): number | null {
  const parsed = Number.parseFloat(value || '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseExpectedEdgeList(value: string | undefined): number[] {
  return (value || '1,5,10,25,50,100')
    .split(',')
    .map((entry) => Number.parseFloat(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
}

function formatSol(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(9)
}

async function main(): Promise<void> {
  dotenv.config()
  try {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
  } catch (_) {}

  const inputDir = path.resolve(process.cwd(), process.env.CYBORG_BREAKEVEN_INPUT_DIR || process.env.PUMPSWAP_META_OUTPUT_DIR || 'data/meta-observer')
  const outputDir = path.resolve(process.cwd(), process.env.CYBORG_BREAKEVEN_OUTPUT_DIR || 'data/promotion-gate')
  const sizeSol = parsePositiveFloat(process.env.CYBORG_BREAKEVEN_SIZE_SOL || process.env.PUMPSWAP_CYBORG_CANARY_SIZE_SOL)
  const lookbackMs = parsePositiveInt(
    process.env.CYBORG_BREAKEVEN_LOOKBACK_MS,
    7 * 24 * 60 * 60 * 1000
  )
  const minSamples = parsePositiveInt(process.env.CYBORG_BREAKEVEN_MIN_SAMPLES, 1)
  const expectedEdgePctList = parseExpectedEdgeList(process.env.CYBORG_BREAKEVEN_EXPECTED_EDGE_PCT_LIST)

  fs.mkdirSync(outputDir, { recursive: true })
  const report = analyzeCyborgBreakEven({
    inputDir,
    expectedEdgePctList,
    sizeSol,
    lookbackMs,
    minSamples,
  })

  const outPath = path.join(
    outputDir,
    `cyborg-break-even-${new Date(report.generatedAtMs).toISOString().replace(/[:.]/g, '-')}.json`
  )
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')

  console.log('[CyborgBreakEven] Wrote:', outPath)
  console.log('[CyborgBreakEven] Groups:', report.groups.length)
  console.log('[CyborgBreakEven] Recommendation:', report.recommendation)
  for (const group of report.groups.slice(0, 5)) {
    console.log(
      [
        `- status=${group.status}`,
        `size=${group.sizeSol}`,
        `evidence=${group.evidenceCount}`,
        `complete=${group.completeLoopCount}`,
        `flattened=${group.flattenedLoopCount}`,
        `avgNet=${formatSol(group.avgNetReturnSol)}`,
        `worstNet=${formatSol(group.worstNetReturnSol)}`,
        `lossFloor=${group.lossFloorSol.toFixed(9)}`,
        `requiredGrossEdgePct=${group.requiredGrossEdgePctAtCurrentSize.toFixed(2)}%`,
      ].join(' ')
    )
  }
}

main().catch((error) => {
  console.error('[CyborgBreakEven] Failed:', error?.message || error)
  process.exit(1)
})
