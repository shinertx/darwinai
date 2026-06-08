import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import dotenv from 'dotenv'
import {
  decideReplayGateRefresh,
  isReplayGateRefreshArtifactName,
  type ReplayGateMonitorState,
} from '../analysis/ReplayGateMonitorPolicy'

dotenv.config()
try {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
} catch {}

const OUTPUT_DIR = path.resolve(process.cwd(), process.env.PUMPSWAP_META_OUTPUT_DIR || 'data/meta-observer')
const STATE_FILE = path.resolve(
  process.cwd(),
  process.env.PUMPSWAP_REPLAY_GATE_MONITOR_STATE_PATH ||
    path.join(process.env.PUMPSWAP_META_OUTPUT_DIR || 'data/meta-observer', 'replay-gate-refresh-monitor-state.json')
)
const LOCK_FILE = path.resolve(
  process.cwd(),
  process.env.PUMPSWAP_REPLAY_GATE_MONITOR_LOCK_PATH ||
    path.join(process.env.PUMPSWAP_META_OUTPUT_DIR || 'data/meta-observer', 'replay-gate-refresh.lock')
)

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function latestFile(prefix: string, suffix: string, includeName: (name: string) => boolean = () => true): string | null {
  if (!fs.existsSync(OUTPUT_DIR)) return null
  const candidates = fs.readdirSync(OUTPUT_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .filter(includeName)
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

function readJson(filePath: string | null): Record<string, unknown> | null {
  if (!filePath) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function readState(): ReplayGateMonitorState | null {
  const parsed = readJson(STATE_FILE)
  return parsed as ReplayGateMonitorState | null
}

function writeState(state: ReplayGateMonitorState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
}

function withLock<T>(fn: () => T): T {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true })
  let fd: number | null = null
  try {
    fd = fs.openSync(LOCK_FILE, 'wx')
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n')
    return fn()
  } finally {
    if (fd !== null) fs.closeSync(fd)
    try {
      fs.unlinkSync(LOCK_FILE)
    } catch {}
  }
}

function runRefresh(): number | null {
  console.log('[ReplayGateMonitor] Running offline replay gate refresh')
  const result = spawnSync('node dist/cli/pumpswapReplayGateRefresh.js', {
    cwd: process.cwd(),
    env: process.env,
    shell: true,
    stdio: 'inherit',
  })
  return result.status
}

function latestRefreshSummary(): Pick<
  ReplayGateMonitorState,
  'latestRefreshArtifact' | 'latestFrontierArtifact' | 'latestTargetArtifact' | 'lastRefreshStatus' | 'lastTargetStatus'
> {
  const latestRefreshArtifact = latestFile('replay-gate-refresh-', '.json', isReplayGateRefreshArtifactName)
  const refresh = readJson(latestRefreshArtifact)
  const latestFrontierArtifact = latestFile('replay-frontier-', '.json')
  const latestTargetArtifact = latestFile('replay-target-watch-', '.json')
  const targetWatch = readJson(latestTargetArtifact)
  return {
    latestRefreshArtifact,
    latestFrontierArtifact: typeof latestFrontierArtifact === 'string' ? latestFrontierArtifact : null,
    latestTargetArtifact: typeof latestTargetArtifact === 'string' ? latestTargetArtifact : null,
    lastRefreshStatus: latestRefreshArtifact ? 'written' : null,
    lastTargetStatus: typeof targetWatch?.status === 'string'
      ? targetWatch.status
      : typeof refresh?.targetStatus === 'string'
        ? refresh.targetStatus
        : null,
  }
}

async function tick(config: {
  minGrowthBytes: number
  runOnStart: boolean
}): Promise<void> {
  const eventFile = latestFile('events-', '.jsonl')
  const checkedAt = new Date().toISOString()
  if (!eventFile) {
    writeState({
      ...readState(),
      lastCheckedAt: checkedAt,
      lastDecisionReason: 'no_event_file',
    })
    console.log('[ReplayGateMonitor] No non-empty events file found')
    return
  }

  const eventSizeBytes = fs.statSync(eventFile).size
  const state = readState()
  const decision = decideReplayGateRefresh({
    eventFile,
    eventSizeBytes,
    state,
    minGrowthBytes: config.minGrowthBytes,
    runOnStart: config.runOnStart,
  })

  const nextState: ReplayGateMonitorState = {
    ...state,
    eventFile,
    eventSizeBytes,
    lastCheckedAt: checkedAt,
    lastDecisionReason: decision.reason,
    lastGrowthBytes: decision.growthBytes,
    ...latestRefreshSummary(),
  }

  if (!decision.shouldRun) {
    writeState(nextState)
    console.log(`[ReplayGateMonitor] Waiting: ${decision.reason}`)
    return
  }

  if (fs.existsSync(LOCK_FILE)) {
    writeState({
      ...nextState,
      lastDecisionReason: 'refresh_lock_exists',
    })
    console.log('[ReplayGateMonitor] Refresh already locked; skipping this tick')
    return
  }

  const refreshExitStatus = withLock(runRefresh)
  writeState({
    ...nextState,
    lastRefreshAt: new Date().toISOString(),
    lastRefreshExitStatus: refreshExitStatus,
    ...latestRefreshSummary(),
  })
  console.log(`[ReplayGateMonitor] Refresh exited with status ${refreshExitStatus}`)
}

async function main(): Promise<void> {
  const intervalMs = parsePositiveInt(process.env.PUMPSWAP_REPLAY_GATE_MONITOR_INTERVAL_MS, 600_000)
  const minGrowthBytes = parsePositiveInt(
    process.env.PUMPSWAP_REPLAY_GATE_MONITOR_MIN_EVENT_GROWTH_BYTES,
    25_000_000
  )
  const runOnStart = parseBool(process.env.PUMPSWAP_REPLAY_GATE_MONITOR_RUN_ON_START, false)

  console.log(
    `[ReplayGateMonitor] Started intervalMs=${intervalMs} minGrowthBytes=${minGrowthBytes} runOnStart=${runOnStart}`
  )
  await tick({ minGrowthBytes, runOnStart })
  setInterval(() => {
    tick({ minGrowthBytes, runOnStart }).catch((error) => {
      console.error('[ReplayGateMonitor] Tick failed:', error?.message || error)
    })
  }, intervalMs)
}

main().catch((error) => {
  console.error('[ReplayGateMonitor] Fatal error:', error?.message || error)
  process.exit(1)
})
