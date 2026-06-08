import fs from 'fs'
import path from 'path'
import readline from 'readline'
import dotenv from 'dotenv'
import {
  createPumpswapReplayPathCollector,
  type PumpSwapReplayEvent,
  type PumpSwapReplayRentAuditRow,
} from '../analysis/PumpswapReplayPath'

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

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value || '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parsePositiveIntList(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback
  const parsed = value
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
  return parsed.length ? parsed : fallback
}

function parsePositiveFloatList(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback
  const parsed = value
    .split(',')
    .map((entry) => Number.parseFloat(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
  return parsed.length ? parsed : fallback
}

function resolveInputFiles(envName: string, prefix: string, suffix: string): string[] {
  const configured = process.env[envName]
  if (configured) {
    return configured
      .split(',')
      .map((entry) => path.resolve(process.cwd(), entry.trim()))
      .filter(Boolean)
  }
  if (!fs.existsSync(OUTPUT_DIR)) return []
  return fs.readdirSync(OUTPUT_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => path.join(OUTPUT_DIR, name))
    .filter((filePath) => fs.statSync(filePath).size > 0)
    .sort()
}

async function ingestJsonlFiles(
  filePaths: string[],
  ingest: (row: PumpSwapReplayEvent) => void
): Promise<void> {
  for (const filePath of filePaths) {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line) continue
      try {
        ingest(JSON.parse(line) as PumpSwapReplayEvent)
      } catch {
        // Keep analysis moving over partially written observer files.
      }
    }
  }
}

function readRentAuditFiles(filePaths: string[]): PumpSwapReplayRentAuditRow[] {
  const rows: PumpSwapReplayRentAuditRow[] = []
  for (const filePath of filePaths) {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
    if (Array.isArray(payload)) {
      rows.push(...payload as PumpSwapReplayRentAuditRow[])
      continue
    }
    const record = payload as Record<string, unknown>
    const nested = record.analyzed || record.rows || []
    if (Array.isArray(nested)) {
      rows.push(...nested as PumpSwapReplayRentAuditRow[])
    }
  }
  return rows
}

function formatPct(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(2)}%`
}

function baseOptions() {
  return {
    entryDelayMs: parsePositiveInt(process.env.PUMPSWAP_REPLAY_ENTRY_DELAY_MS, 15_000),
    maxHoldMs: parsePositiveInt(process.env.PUMPSWAP_REPLAY_MAX_HOLD_MS, 300_000),
    exitAfterLaterBuys: parsePositiveInt(process.env.PUMPSWAP_REPLAY_EXIT_AFTER_LATER_BUYS, 3),
    tradeSizeSol: parsePositiveFloat(process.env.PUMPSWAP_REPLAY_TRADE_SIZE_SOL, 0.0001),
    fixedCostSol: parseNonNegativeFloat(process.env.PUMPSWAP_REPLAY_FIXED_COST_SOL, 0),
    minPromotionSamplePools: parsePositiveInt(process.env.PUMPSWAP_REPLAY_MIN_PROMOTION_SAMPLE_POOLS, 20),
    minWinRate: parsePositiveFloat(process.env.PUMPSWAP_REPLAY_MIN_WIN_RATE, 0.65),
    minRentTradableRate: parseNonNegativeFloat(process.env.PUMPSWAP_REPLAY_MIN_RENT_TRADABLE_RATE, 0),
    minMedianModeledNetReturnPct: parseNonNegativeFloat(
      process.env.PUMPSWAP_REPLAY_MIN_MEDIAN_MODELED_NET_RETURN_PCT,
      0
    ),
    minAvgModeledNetReturnPct: parseNonNegativeFloat(
      process.env.PUMPSWAP_REPLAY_MIN_AVG_MODELED_NET_RETURN_PCT,
      0
    ),
  }
}

function shouldRunGrid(): boolean {
  return Boolean(
    process.env.PUMPSWAP_REPLAY_ENTRY_DELAY_MS_LIST ||
    process.env.PUMPSWAP_REPLAY_EXIT_AFTER_LATER_BUYS_LIST ||
    process.env.PUMPSWAP_REPLAY_FIXED_COST_SOL_LIST ||
    process.env.PUMPSWAP_REPLAY_MAX_HOLD_MS_LIST
  )
}

async function main(): Promise<void> {
  const eventFiles = resolveInputFiles('PUMPSWAP_REPLAY_EVENT_PATHS', 'events-', '.jsonl')
  const rentAuditFiles = resolveInputFiles('PUMPSWAP_REPLAY_RENT_AUDIT_PATHS', 'first-buyer-rent-audit-', '.json')
  if (!eventFiles.length) throw new Error('No non-empty events files found')

  const collector = createPumpswapReplayPathCollector()
  await ingestJsonlFiles(eventFiles, collector.ingestEvent)
  const rentAuditRows = readRentAuditFiles(rentAuditFiles)
  const options = baseOptions()

  if (shouldRunGrid()) {
    const entryDelayMsList = parsePositiveIntList(process.env.PUMPSWAP_REPLAY_ENTRY_DELAY_MS_LIST, [options.entryDelayMs])
    const maxHoldMsList = parsePositiveIntList(process.env.PUMPSWAP_REPLAY_MAX_HOLD_MS_LIST, [options.maxHoldMs])
    const exitAfterLaterBuysList = parsePositiveIntList(
      process.env.PUMPSWAP_REPLAY_EXIT_AFTER_LATER_BUYS_LIST,
      [options.exitAfterLaterBuys]
    )
    const fixedCostSolList = parsePositiveFloatList(process.env.PUMPSWAP_REPLAY_FIXED_COST_SOL_LIST, [options.fixedCostSol])
    const scenarios = []

    for (const entryDelayMs of entryDelayMsList) {
      for (const maxHoldMs of maxHoldMsList) {
        for (const exitAfterLaterBuys of exitAfterLaterBuysList) {
          for (const fixedCostSol of fixedCostSolList) {
            const report = collector.report(rentAuditRows, {
              ...options,
              entryDelayMs,
              maxHoldMs,
              exitAfterLaterBuys,
              fixedCostSol,
            })
            scenarios.push({
              inputs: report.inputs,
              totals: report.totals,
              byProfile: report.byProfile,
              bySegment: report.bySegment,
              paperCandidates: report.byProfile.filter((row) => row.promotionStatus === 'PAPER_CANDIDATE'),
              paperSegmentCandidates: report.bySegment.filter((row) => row.promotionStatus === 'PAPER_CANDIDATE'),
            })
          }
        }
      }
    }

    const outputPath = path.join(
      OUTPUT_DIR,
      `replay-path-grid-study-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    )
    fs.writeFileSync(outputPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      inputs: {
        eventFiles,
        rentAuditFiles,
        entryDelayMsList,
        maxHoldMsList,
        exitAfterLaterBuysList,
        fixedCostSolList,
      },
      scenarios,
    }, null, 2) + '\n')

    console.log('[ReplayPathGrid] Wrote:', outputPath)
    console.log('[ReplayPathGrid] Scenarios:', scenarios.length)
    const ranked = scenarios
      .flatMap((scenario) => scenario.byProfile.map((profile) => ({ scenario, profile })))
      .sort((a, b) => (
        (b.profile.promotionStatus === 'PAPER_CANDIDATE' ? 1 : 0) - (a.profile.promotionStatus === 'PAPER_CANDIDATE' ? 1 : 0)
        || (b.profile.winRate || 0) - (a.profile.winRate || 0)
        || (b.profile.medianModeledNetReturnPct ?? Number.NEGATIVE_INFINITY) - (a.profile.medianModeledNetReturnPct ?? Number.NEGATIVE_INFINITY)
      ))
    for (const row of ranked.slice(0, 10)) {
      console.log(
        `- ${row.profile.profile}: entry=${row.scenario.inputs.entryDelayMs}ms exitBuys=${row.scenario.inputs.exitAfterLaterBuys} maxHold=${row.scenario.inputs.maxHoldMs}ms cost=${row.scenario.inputs.fixedCostSol} pools=${row.profile.pools} win=${row.profile.winRate === null ? 'n/a' : `${(row.profile.winRate * 100).toFixed(1)}%`} medianNet=${formatPct(row.profile.medianModeledNetReturnPct)} status=${row.profile.promotionStatus}`
      )
    }
    const rankedSegments = scenarios
      .flatMap((scenario) => scenario.bySegment.map((segment) => ({ scenario, segment })))
      .sort((a, b) => (
        (b.segment.promotionStatus === 'PAPER_CANDIDATE' ? 1 : 0) - (a.segment.promotionStatus === 'PAPER_CANDIDATE' ? 1 : 0)
        || (b.segment.winRate || 0) - (a.segment.winRate || 0)
        || (b.segment.medianModeledNetReturnPct ?? Number.NEGATIVE_INFINITY) - (a.segment.medianModeledNetReturnPct ?? Number.NEGATIVE_INFINITY)
      ))
    console.log('[ReplayPathGrid] Top segments:')
    for (const row of rankedSegments.slice(0, 10)) {
      console.log(
        `- ${row.segment.segment}: entry=${row.scenario.inputs.entryDelayMs}ms exitBuys=${row.scenario.inputs.exitAfterLaterBuys} maxHold=${row.scenario.inputs.maxHoldMs}ms cost=${row.scenario.inputs.fixedCostSol} pools=${row.segment.pools} win=${row.segment.winRate === null ? 'n/a' : `${(row.segment.winRate * 100).toFixed(1)}%`} medianNet=${formatPct(row.segment.medianModeledNetReturnPct)} status=${row.segment.promotionStatus}`
      )
    }
    return
  }

  const report = collector.report(rentAuditRows, options)

  const outputPath = path.join(
    OUTPUT_DIR,
    `replay-path-study-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  )
  fs.writeFileSync(outputPath, JSON.stringify({
    ...report,
    inputs: {
      ...report.inputs,
      eventFiles,
      rentAuditFiles,
    },
  }, null, 2) + '\n')

  console.log('[ReplayPath] Wrote:', outputPath)
  console.log('[ReplayPath] Pools:', report.totals.pools)
  console.log('[ReplayPath] Completed paths:', report.totals.completedPaths)
  for (const row of report.byProfile.slice(0, 8)) {
    console.log(
      `- ${row.profile}: pools=${row.pools}, completed=${row.completedPaths}, win=${row.winRate === null ? 'n/a' : `${(row.winRate * 100).toFixed(1)}%`}, medianNet=${formatPct(row.medianModeledNetReturnPct)}, status=${row.promotionStatus}`
    )
  }
  console.log('[ReplayPath] Top segments:')
  for (const row of report.bySegment.slice(0, 8)) {
    console.log(
      `- ${row.segment}: pools=${row.pools}, completed=${row.completedPaths}, win=${row.winRate === null ? 'n/a' : `${(row.winRate * 100).toFixed(1)}%`}, medianNet=${formatPct(row.medianModeledNetReturnPct)}, status=${row.promotionStatus}`
    )
  }
}

main().catch((error) => {
  console.error('[ReplayPath] Fatal error:', error?.message || error)
  process.exit(1)
})
