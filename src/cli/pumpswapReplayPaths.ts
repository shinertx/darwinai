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

async function main(): Promise<void> {
  const eventFiles = resolveInputFiles('PUMPSWAP_REPLAY_EVENT_PATHS', 'events-', '.jsonl')
  const rentAuditFiles = resolveInputFiles('PUMPSWAP_REPLAY_RENT_AUDIT_PATHS', 'first-buyer-rent-audit-', '.json')
  if (!eventFiles.length) throw new Error('No non-empty events files found')

  const collector = createPumpswapReplayPathCollector()
  await ingestJsonlFiles(eventFiles, collector.ingestEvent)
  const rentAuditRows = readRentAuditFiles(rentAuditFiles)
  const report = collector.report(rentAuditRows, {
    entryDelayMs: parsePositiveInt(process.env.PUMPSWAP_REPLAY_ENTRY_DELAY_MS, 15_000),
    maxHoldMs: parsePositiveInt(process.env.PUMPSWAP_REPLAY_MAX_HOLD_MS, 300_000),
    exitAfterLaterBuys: parsePositiveInt(process.env.PUMPSWAP_REPLAY_EXIT_AFTER_LATER_BUYS, 3),
    tradeSizeSol: parsePositiveFloat(process.env.PUMPSWAP_REPLAY_TRADE_SIZE_SOL, 0.0001),
    fixedCostSol: parseNonNegativeFloat(process.env.PUMPSWAP_REPLAY_FIXED_COST_SOL, 0),
    minPromotionSamplePools: parsePositiveInt(process.env.PUMPSWAP_REPLAY_MIN_PROMOTION_SAMPLE_POOLS, 20),
    minWinRate: parsePositiveFloat(process.env.PUMPSWAP_REPLAY_MIN_WIN_RATE, 0.65),
  })

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
}

main().catch((error) => {
  console.error('[ReplayPath] Fatal error:', error?.message || error)
  process.exit(1)
})
