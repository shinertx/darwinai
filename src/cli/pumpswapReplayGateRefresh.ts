import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import dotenv from 'dotenv'

dotenv.config()
try {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
} catch {}

const OUTPUT_DIR = path.resolve(process.cwd(), process.env.PUMPSWAP_META_OUTPUT_DIR || 'data/meta-observer')

type StepResult = {
  name: string
  command: string
  status: number | null
}

function latestFile(prefix: string, suffix: string): string | null {
  if (!fs.existsSync(OUTPUT_DIR)) return null
  const candidates = fs.readdirSync(OUTPUT_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => path.join(OUTPUT_DIR, name))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).size > 0
      } catch {
        return false
      }
    })
    .sort()
  return candidates.at(-1) || null
}

function runStep(name: string, command: string, env: NodeJS.ProcessEnv): StepResult {
  console.log(`[ReplayGateRefresh] ${name}: ${command}`)
  const result = spawnSync(command, {
    cwd: process.cwd(),
    env,
    shell: true,
    stdio: 'inherit',
  })
  return {
    name,
    command,
    status: result.status,
  }
}

function defaultEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
  }
}

function readJson(filePath: string | null): Record<string, unknown> | null {
  if (!filePath) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const eventFile = process.env.PUMPSWAP_REPLAY_REFRESH_EVENT_PATH
    ? path.resolve(process.cwd(), process.env.PUMPSWAP_REPLAY_REFRESH_EVENT_PATH)
    : latestFile('events-', '.jsonl')
  if (!eventFile) throw new Error('No non-empty PumpSwap events file found')

  const steps: StepResult[] = []
  steps.push(runStep('rent_audit', 'node scripts/ops/audit_pumpswap_first_buyer_rent.mjs', defaultEnv({
    PUMPSWAP_AUDIT_EVENTS_PATH: eventFile,
    PUMPSWAP_AUDIT_WINDOW_MS: process.env.PUMPSWAP_AUDIT_WINDOW_MS || '5000',
  })))
  if (steps.at(-1)?.status !== 0) throw new Error('rent_audit failed')

  const rentAuditFile = latestFile('first-buyer-rent-audit-', '.json')
  if (!rentAuditFile) throw new Error('No rent audit file found after audit step')

  steps.push(runStep('replay_grid', 'node dist/cli/pumpswapReplayPaths.js', defaultEnv({
    PUMPSWAP_REPLAY_EVENT_PATHS: eventFile,
    PUMPSWAP_REPLAY_RENT_AUDIT_PATHS: rentAuditFile,
    PUMPSWAP_REPLAY_ENTRY_DELAY_MS_LIST: process.env.PUMPSWAP_REPLAY_ENTRY_DELAY_MS_LIST || '3000,5000,7500,10000,15000',
    PUMPSWAP_REPLAY_MAX_HOLD_MS_LIST: process.env.PUMPSWAP_REPLAY_MAX_HOLD_MS_LIST || '15000,30000,45000,60000',
    PUMPSWAP_REPLAY_EXIT_AFTER_LATER_BUYS_LIST: process.env.PUMPSWAP_REPLAY_EXIT_AFTER_LATER_BUYS_LIST || '3,5,8,9,10,12',
    PUMPSWAP_REPLAY_FIXED_COST_SOL_LIST: process.env.PUMPSWAP_REPLAY_FIXED_COST_SOL_LIST || '0.000015966',
    PUMPSWAP_REPLAY_MIN_PROMOTION_SAMPLE_POOLS: process.env.PUMPSWAP_REPLAY_MIN_PROMOTION_SAMPLE_POOLS || '20',
    PUMPSWAP_REPLAY_MIN_WIN_RATE: process.env.PUMPSWAP_REPLAY_MIN_WIN_RATE || '0.65',
    PUMPSWAP_REPLAY_MIN_RENT_TRADABLE_RATE: process.env.PUMPSWAP_REPLAY_MIN_RENT_TRADABLE_RATE || '0.9',
    PUMPSWAP_REPLAY_MIN_MEDIAN_MODELED_NET_RETURN_PCT: process.env.PUMPSWAP_REPLAY_MIN_MEDIAN_MODELED_NET_RETURN_PCT || '15',
    PUMPSWAP_REPLAY_MIN_AVG_MODELED_NET_RETURN_PCT: process.env.PUMPSWAP_REPLAY_MIN_AVG_MODELED_NET_RETURN_PCT || '15',
  })))
  if (steps.at(-1)?.status !== 0) throw new Error('replay_grid failed')

  const replayGridFile = latestFile('replay-path-grid-study-', '.json')
  if (!replayGridFile) throw new Error('No replay grid file found after replay step')

  steps.push(runStep('target_watch', 'node dist/cli/pumpswapReplayTargetWatch.js', defaultEnv({
    PUMPSWAP_REPLAY_TARGET_GRID_PATHS: replayGridFile,
  })))
  if (steps.at(-1)?.status !== 0) throw new Error('target_watch failed')

  const targetWatchFile = latestFile('replay-target-watch-', '.json')
  const targetWatch = readJson(targetWatchFile)
  const outputPath = path.join(
    OUTPUT_DIR,
    `replay-gate-refresh-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  )
  fs.writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: 'offline_non_trading',
    artifacts: {
      eventFile,
      rentAuditFile,
      replayGridFile,
      targetWatchFile,
    },
    targetStatus: targetWatch?.status || null,
    targetTotals: targetWatch?.totals || null,
    targetBestMatch: targetWatch?.bestMatch || null,
    steps,
  }, null, 2) + '\n')

  console.log('[ReplayGateRefresh] Wrote:', outputPath)
  console.log('[ReplayGateRefresh] Target status:', targetWatch?.status || 'unknown')
}

main().catch((error) => {
  console.error('[ReplayGateRefresh] Fatal error:', error?.message || error)
  process.exit(1)
})
