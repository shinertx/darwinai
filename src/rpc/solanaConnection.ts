import { Connection, type Commitment, type ConnectionConfig, type FetchFn } from '@solana/web3.js'

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractEndpoint(info: Parameters<FetchFn>[0]): string {
  if (typeof info === 'string') return info
  if (info instanceof URL) return info.toString()
  return info.url
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null

  const seconds = Number.parseFloat(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000)
  }

  const retryAt = Date.parse(value)
  if (Number.isFinite(retryAt)) {
    return Math.max(0, retryAt - Date.now())
  }

  return null
}

const RPC_MAX_CONCURRENT = parsePositiveInt(process.env.DARWIN_RPC_MAX_CONCURRENT, 2)
const RPC_MIN_SPACING_MS = parsePositiveInt(process.env.DARWIN_RPC_MIN_SPACING_MS, 150)
const RPC_MAX_429_RETRIES = parsePositiveInt(process.env.DARWIN_RPC_MAX_429_RETRIES, 2)
const RPC_BASE_BACKOFF_MS = parsePositiveInt(process.env.DARWIN_RPC_BASE_BACKOFF_MS, 400)
const RPC_MAX_BACKOFF_MS = parsePositiveInt(process.env.DARWIN_RPC_MAX_BACKOFF_MS, 4000)

class RpcRequestBudget {
  private active = 0
  private queue: Array<() => void> = []
  private nextAllowedAt = 0
  private rateLimitedUntil = 0
  private pumpTimer: NodeJS.Timeout | null = null
  private lastRateLimitLogAt = 0

  public async acquire(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.queue.push(resolve)
      this.pump()
    })
  }

  public release(): void {
    this.active = Math.max(0, this.active - 1)
    this.pump()
  }

  public noteRateLimit(response: Response, attempt: number): number {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
    const computedBackoffMs = Math.min(
      RPC_MAX_BACKOFF_MS,
      RPC_BASE_BACKOFF_MS * Math.pow(2, attempt)
    )
    const backoffMs = retryAfterMs ?? computedBackoffMs
    this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + backoffMs)

    const now = Date.now()
    if (now - this.lastRateLimitLogAt > 15000) {
      console.warn('[RPC] 429 from Solana RPC. Backing off for ' + backoffMs + 'ms.')
      this.lastRateLimitLogAt = now
    }

    return backoffMs
  }

  private pump(): void {
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer)
      this.pumpTimer = null
    }

    while (this.queue.length > 0 && this.active < RPC_MAX_CONCURRENT) {
      const now = Date.now()
      const waitMs = Math.max(0, this.nextAllowedAt - now, this.rateLimitedUntil - now)
      if (waitMs > 0) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = null
          this.pump()
        }, waitMs)
        return
      }

      const next = this.queue.shift()
      if (!next) return

      this.active += 1
      this.nextAllowedAt = now + RPC_MIN_SPACING_MS
      next()
    }
  }
}

const rpcBudgets = new Map<string, RpcRequestBudget>()

function getBudget(endpoint: string): RpcRequestBudget {
  let budget = rpcBudgets.get(endpoint)
  if (!budget) {
    budget = new RpcRequestBudget()
    rpcBudgets.set(endpoint, budget)
  }
  return budget
}

const rateLimitedFetch: FetchFn = async (info, init) => {
  const endpoint = extractEndpoint(info)
  const budget = getBudget(endpoint)

  await budget.acquire()
  try {
    for (let attempt = 0; attempt <= RPC_MAX_429_RETRIES; attempt++) {
      const response = await fetch(info, init)
      if (response.status !== 429) {
        return response
      }

      const backoffMs = budget.noteRateLimit(response, attempt)
      if (attempt === RPC_MAX_429_RETRIES) {
        return response
      }

      try {
        await response.arrayBuffer()
      } catch (_) {}
      await sleep(backoffMs)
    }

    return fetch(info, init)
  } finally {
    budget.release()
  }
}

export function createSolanaConnection(
  endpoint: string,
  commitment: Commitment,
  extraConfig: Omit<ConnectionConfig, 'commitment' | 'fetch' | 'disableRetryOnRateLimit'> = {}
): Connection {
  return new Connection(endpoint, {
    ...extraConfig,
    commitment,
    fetch: rateLimitedFetch,
    disableRetryOnRateLimit: true,
  })
}
