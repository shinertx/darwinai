type CachedPoolSwapState = {
  state: any
  storedAt: number
}

const CACHE_TTL_MS = 10_000
const poolSwapStateCache = new Map<string, CachedPoolSwapState>()

export function rememberPoolSwapState(pool: string, state: any): void {
  if (!pool || !state) return
  poolSwapStateCache.set(pool, {
    state,
    storedAt: Date.now(),
  })
}

export function getRecentPoolSwapState(pool: string, maxAgeMs = CACHE_TTL_MS): any | null {
  const cached = poolSwapStateCache.get(pool)
  if (!cached) return null

  if (Date.now() - cached.storedAt > maxAgeMs) {
    poolSwapStateCache.delete(pool)
    return null
  }

  return cached.state
}

export function clearExpiredPoolSwapStates(maxAgeMs = CACHE_TTL_MS): void {
  const now = Date.now()
  for (const [pool, cached] of poolSwapStateCache) {
    if (now - cached.storedAt > maxAgeMs) {
      poolSwapStateCache.delete(pool)
    }
  }
}
