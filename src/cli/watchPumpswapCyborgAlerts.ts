import readline from 'readline'
import { spawn } from 'child_process'

type CreatePoolEventLine = {
  kind: 'create_pool'
  pool: string
  creator: string
  coinCreator?: string
  baseMint: string
  quoteMint: string
  signature: string
  anchorTimeMs: number | null
  timeAnchorUnavailable?: boolean
}

type InteractionEventLine = {
  kind: 'buy' | 'sell' | 'deposit' | 'withdraw'
  pool: string
  user: string
  resolvedTimeMs: number | null
}

type PoolWatchState = {
  pool: string
  creator: string
  coinCreator: string | null
  baseMint: string
  quoteMint: string
  createSignature: string
  anchorTimeMs: number
  interactingWallets5s: Set<string>
  buyCompetitorWallets5s: Set<string>
  alertEmitted: boolean
  timer: NodeJS.Timeout | null
}

function getEnv(name: string, fallback: string): string {
  const value = (process.env[name] || '').trim()
  return value || fallback
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function truncateMiddle(value: string, prefix = 4, suffix = 4): string {
  if (value.length <= prefix + suffix + 3) return value
  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`
}

function isWithinWindow(anchorTimeMs: number, resolvedTimeMs: number | null, windowMs: number): boolean {
  if (resolvedTimeMs === null) return false
  return resolvedTimeMs >= anchorTimeMs && resolvedTimeMs < anchorTimeMs + windowMs
}

function formatAlert(state: PoolWatchState, windowMs: number): string {
  return [
    '[CyborgStrict]',
    new Date().toISOString(),
    `pool=${state.pool}`,
    `creator=${truncateMiddle(state.creator, 6, 6)}`,
    `buy5s=${state.buyCompetitorWallets5s.size}`,
    `interactions5s=${state.interactingWallets5s.size}`,
    `windowMs=${windowMs}`,
    `base=${truncateMiddle(state.baseMint, 6, 6)}`,
    `quote=${truncateMiddle(state.quoteMint, 6, 6)}`,
    `createSig=${truncateMiddle(state.createSignature, 6, 6)}`,
  ].join(' ')
}

async function main(): Promise<void> {
  const sshHost = getEnv('PUMPSWAP_CYBORG_SSH_HOST', 'meme-snipe-v19-vm')
  const remoteCwd = getEnv('PUMPSWAP_CYBORG_REMOTE_CWD', '/home/benjijmac/darwin')
  const cyborgAlertWindowMs = parseNonNegativeInt(
    process.env.PUMPSWAP_CYBORG_ALERT_WINDOW_MS,
    5_000
  )
  const remoteCommand =
    `cd ${JSON.stringify(remoteCwd)} && ` +
    `latest=$(ls -1t data/meta-observer/events-*.jsonl 2>/dev/null | head -1) && ` +
    `[ -n "$latest" ] || { echo "__CYBORG_NO_EVENTS__"; exit 1; } && ` +
    `echo "__CYBORG_FILE__:$latest" && ` +
    `tail -n 0 -F "$latest"`

  console.log(`[CyborgStrict] Watching ${sshHost}:${remoteCwd}/data/meta-observer/events-*.jsonl`)
  console.log(`[CyborgStrict] Filter: 0 total non-creator interactions in first ${cyborgAlertWindowMs} ms`)

  const child = spawn('ssh', [sshHost, remoteCommand], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  const lineReader = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  })

  const pools = new Map<string, PoolWatchState>()

  const emitIfEligible = (state: PoolWatchState): void => {
    if (state.alertEmitted) return
    state.alertEmitted = true
    if (state.interactingWallets5s.size === 0) {
      console.log(formatAlert(state, cyborgAlertWindowMs))
    }
  }

  const scheduleAlert = (state: PoolWatchState): void => {
    if (state.timer) {
      clearTimeout(state.timer)
    }
    const delayMs = Math.max(0, state.anchorTimeMs + cyborgAlertWindowMs - Date.now())
    state.timer = setTimeout(() => {
      emitIfEligible(state)
    }, delayMs)
  }

  lineReader.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    if (trimmed === '__CYBORG_NO_EVENTS__') {
      console.error('[CyborgStrict] No remote events file found.')
      return
    }
    if (trimmed.startsWith('__CYBORG_FILE__:')) {
      console.log(`[CyborgStrict] Source ${trimmed.slice('__CYBORG_FILE__:'.length)}`)
      return
    }

    try {
      const parsed = JSON.parse(trimmed) as CreatePoolEventLine | InteractionEventLine

      if (parsed.kind === 'create_pool') {
        if (parsed.anchorTimeMs === null || parsed.timeAnchorUnavailable) {
          return
        }
        const state: PoolWatchState = {
          pool: parsed.pool,
          creator: parsed.creator,
          coinCreator: parsed.coinCreator || null,
          baseMint: parsed.baseMint,
          quoteMint: parsed.quoteMint,
          createSignature: parsed.signature,
          anchorTimeMs: parsed.anchorTimeMs,
          interactingWallets5s: new Set<string>(),
          buyCompetitorWallets5s: new Set<string>(),
          alertEmitted: false,
          timer: null,
        }
        pools.set(state.pool, state)
        scheduleAlert(state)
        return
      }

      const state = pools.get(parsed.pool)
      if (!state || state.alertEmitted) {
        return
      }
      if (!isWithinWindow(state.anchorTimeMs, parsed.resolvedTimeMs, cyborgAlertWindowMs)) {
        return
      }
      if (parsed.user === state.creator) {
        return
      }

      state.interactingWallets5s.add(parsed.user)
      if (parsed.kind === 'buy') {
        state.buyCompetitorWallets5s.add(parsed.user)
      }
    } catch (_) {
      console.log(trimmed)
    }
  })

  child.on('exit', (code) => {
    for (const state of pools.values()) {
      if (state.timer) {
        clearTimeout(state.timer)
      }
    }
    process.exit(code ?? 0)
  })
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[CyborgStrict] Watcher fatal error:', error)
    process.exit(1)
  })
}
