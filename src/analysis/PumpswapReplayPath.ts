export type ReplayProfile =
  | 'strict_zero'
  | 'sell_only_probe'
  | 'liquidity_noise'
  | 'non_buy_noise'
  | 'one_buy_probe'
  | 'delayed_crowding'
  | 'low_buy_competition'
  | 'crowded'

export type PumpSwapReplayEvent = {
  kind: string
  pool?: string
  signature?: string
  creator?: string
  creatorSigner?: string
  user?: string
  anchorTimeMs?: number | null
  resolvedTimeMs?: number | null
  baseMint?: string
  quoteMint?: string
  baseMintDecimals?: number
  quoteMintDecimals?: number
  initialBaseReserveRaw?: string
  initialQuoteReserveRaw?: string
  poolBaseReserveRaw?: string
  poolQuoteReserveRaw?: string
}

export type PumpSwapReplayRentAuditRow = {
  pool?: string
  tradable?: boolean
  transactionFound?: boolean
  hasPoolExtend?: boolean
  hasAtaCreate?: boolean
}

export type PumpswapReplayOptions = {
  entryDelayMs: number
  maxHoldMs: number
  exitAfterLaterBuys: number
  tradeSizeSol: number
  fixedCostSol: number
  minPromotionSamplePools: number
  minWinRate: number
}

export type ReplayPathResult = {
  pool: string
  profile: ReplayProfile
  creatorSigner: string | null
  rentTradable: boolean
  entryTimeMs: number
  exitTimeMs: number | null
  entryPriceSolPerToken: number | null
  exitPriceSolPerToken: number | null
  grossReturnPct: number | null
  costPctOnSize: number
  modeledNetReturnPct: number | null
  laterBuyWalletsAfterEntry: number
  exitReason: 'later_buy_threshold' | 'max_hold' | 'last_snapshot' | 'missing_exit'
}

export type ReplayProfileSummary = {
  profile: ReplayProfile
  pools: number
  completedPaths: number
  rentTradableRate: number | null
  avgGrossReturnPct: number | null
  medianGrossReturnPct: number | null
  avgModeledNetReturnPct: number | null
  medianModeledNetReturnPct: number | null
  winRate: number | null
  avgLaterBuyWalletsAfterEntry: number | null
  promotionStatus: 'PAPER_CANDIDATE' | 'BLOCKED'
  promotionBlockers: string[]
}

export type PumpswapReplayReport = {
  generatedAt: string
  inputs: PumpswapReplayOptions
  totals: {
    pools: number
    completedPaths: number
    rentAuditedPools: number
  }
  byProfile: ReplayProfileSummary[]
  paths: ReplayPathResult[]
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const WINDOW_5S_MS = 5_000
const WINDOW_10S_MS = 10_000

type Snapshot = {
  timeMs: number
  kind: string
  user: string | null
  priceSolPerToken: number | null
}

type PoolState = {
  pool: string
  creatorSigner: string | null
  anchorTimeMs: number
  baseMint: string | null
  quoteMint: string | null
  baseMintDecimals: number
  quoteMintDecimals: number
  initialBaseReserveRaw: string
  initialQuoteReserveRaw: string
  buyCompetitorWallets5s: Set<string>
  interactingWallets5s: Set<string>
  buyCompetitorWallets10s: Set<string>
  instructionCounts5s: Map<string, number>
  snapshots: Snapshot[]
}

function average(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => Number.isFinite(value))
  if (!filtered.length) return null
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length
}

function median(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => Number.isFinite(value)).sort((a, b) => a - b)
  if (!filtered.length) return null
  return filtered[Math.floor(filtered.length / 2)]
}

function ratio(numerator: number, denominator: number): number | null {
  if (!denominator) return null
  return numerator / denominator
}

function toBigInt(value: string | undefined): bigint | null {
  if (!value) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function rawToUi(raw: bigint, decimals: number): number {
  return Number(raw) / (10 ** decimals)
}

function priceSolPerToken(
  pool: Pick<PoolState, 'baseMint' | 'quoteMint' | 'baseMintDecimals' | 'quoteMintDecimals'>,
  baseReserveRaw: string | undefined,
  quoteReserveRaw: string | undefined
): number | null {
  const baseRaw = toBigInt(baseReserveRaw)
  const quoteRaw = toBigInt(quoteReserveRaw)
  if (baseRaw === null || quoteRaw === null) return null
  if (baseRaw <= 0n || quoteRaw <= 0n) return null

  if (pool.baseMint === WSOL_MINT && pool.quoteMint !== WSOL_MINT) {
    const sol = rawToUi(baseRaw, pool.baseMintDecimals)
    const token = rawToUi(quoteRaw, pool.quoteMintDecimals)
    return token > 0 ? sol / token : null
  }
  if (pool.quoteMint === WSOL_MINT && pool.baseMint !== WSOL_MINT) {
    const sol = rawToUi(quoteRaw, pool.quoteMintDecimals)
    const token = rawToUi(baseRaw, pool.baseMintDecimals)
    return token > 0 ? sol / token : null
  }
  return null
}

function createPoolState(row: PumpSwapReplayEvent): PoolState | null {
  if (!row.pool || row.anchorTimeMs === null || row.anchorTimeMs === undefined) return null
  const pool: PoolState = {
    pool: row.pool,
    creatorSigner: row.creator || row.creatorSigner || null,
    anchorTimeMs: row.anchorTimeMs,
    baseMint: row.baseMint || null,
    quoteMint: row.quoteMint || null,
    baseMintDecimals: row.baseMintDecimals ?? 9,
    quoteMintDecimals: row.quoteMintDecimals ?? 9,
    initialBaseReserveRaw: row.initialBaseReserveRaw || row.poolBaseReserveRaw || '0',
    initialQuoteReserveRaw: row.initialQuoteReserveRaw || row.poolQuoteReserveRaw || '0',
    buyCompetitorWallets5s: new Set(),
    interactingWallets5s: new Set(),
    buyCompetitorWallets10s: new Set(),
    instructionCounts5s: new Map(),
    snapshots: [],
  }
  pool.snapshots.push({
    timeMs: row.anchorTimeMs,
    kind: 'create_pool',
    user: pool.creatorSigner,
    priceSolPerToken: priceSolPerToken(pool, pool.initialBaseReserveRaw, pool.initialQuoteReserveRaw),
  })
  return pool
}

function addInstructionCount(map: Map<string, number>, kind: string): void {
  map.set(kind, (map.get(kind) || 0) + 1)
}

function determineProfile(pool: PoolState): ReplayProfile {
  const buys5 = pool.buyCompetitorWallets5s.size
  const interacting5 = pool.interactingWallets5s.size
  const sells5 = pool.instructionCounts5s.get('sell') || 0
  const deposits5 = pool.instructionCounts5s.get('deposit') || 0
  const withdraws5 = pool.instructionCounts5s.get('withdraw') || 0
  const buys10 = pool.buyCompetitorWallets10s.size

  if (buys5 === 0 && interacting5 === 0) return 'strict_zero'
  if (buys5 === 0 && sells5 > 0 && deposits5 === 0 && withdraws5 === 0) return 'sell_only_probe'
  if (buys5 === 0 && (deposits5 > 0 || withdraws5 > 0)) return 'liquidity_noise'
  if (buys5 === 0) return 'non_buy_noise'
  if (buys5 === 1 && interacting5 <= 2) return 'one_buy_probe'
  if (buys5 === 1 && buys10 > buys5) return 'delayed_crowding'
  if (buys5 <= 2) return 'low_buy_competition'
  return 'crowded'
}

function rentAuditTradable(row: PumpSwapReplayRentAuditRow | undefined): boolean {
  if (!row) return false
  if (row.tradable === true) return true
  return row.transactionFound === true && row.hasPoolExtend === false && row.hasAtaCreate === false
}

function ingestReplayEvent(pools: Map<string, PoolState>, row: PumpSwapReplayEvent): void {
  if (row.kind === 'create_pool') {
    const pool = createPoolState(row)
    if (pool) pools.set(pool.pool, pool)
    return
  }

  const pool = row.pool ? pools.get(row.pool) : undefined
  if (!pool || row.resolvedTimeMs === null || row.resolvedTimeMs === undefined) return
  if (row.resolvedTimeMs < pool.anchorTimeMs) return

  const user = row.user || null
  const isCreator = user !== null && user === pool.creatorSigner
  const ageMs = row.resolvedTimeMs - pool.anchorTimeMs
  if (ageMs <= WINDOW_5S_MS && user && !isCreator) {
    pool.interactingWallets5s.add(user)
    addInstructionCount(pool.instructionCounts5s, row.kind)
    if (row.kind === 'buy') pool.buyCompetitorWallets5s.add(user)
  }
  if (ageMs <= WINDOW_10S_MS && user && !isCreator && row.kind === 'buy') {
    pool.buyCompetitorWallets10s.add(user)
  }

  pool.snapshots.push({
    timeMs: row.resolvedTimeMs,
    kind: row.kind,
    user,
    priceSolPerToken: priceSolPerToken(pool, row.poolBaseReserveRaw, row.poolQuoteReserveRaw),
  })
}

function preparePools(pools: Map<string, PoolState>): void {
  for (const pool of pools.values()) {
    pool.snapshots.sort((a, b) => a.timeMs - b.timeMs)
  }
}

function collectPools(rows: PumpSwapReplayEvent[]): Map<string, PoolState> {
  const pools = new Map<string, PoolState>()
  for (const row of rows) {
    ingestReplayEvent(pools, row)
  }
  preparePools(pools)
  return pools
}

function snapshotAtOrBefore(snapshots: Snapshot[], timeMs: number): Snapshot | null {
  let selected: Snapshot | null = null
  for (const snapshot of snapshots) {
    if (snapshot.timeMs > timeMs) break
    if (snapshot.priceSolPerToken !== null) selected = snapshot
  }
  return selected
}

function replayPool(
  pool: PoolState,
  rentByPool: Map<string, PumpSwapReplayRentAuditRow>,
  options: PumpswapReplayOptions
): ReplayPathResult {
  const entryTimeMs = pool.anchorTimeMs + options.entryDelayMs
  const entrySnapshot = snapshotAtOrBefore(pool.snapshots, entryTimeMs)
  const maxExitTimeMs = entryTimeMs + options.maxHoldMs
  const laterBuyWallets = new Set<string>()
  let thresholdExit: Snapshot | null = null
  let maxHoldExit: Snapshot | null = null
  let lastExit: Snapshot | null = null

  for (const snapshot of pool.snapshots) {
    if (snapshot.timeMs <= entryTimeMs || snapshot.priceSolPerToken === null) continue
    if (snapshot.user && snapshot.user !== pool.creatorSigner && snapshot.kind === 'buy') {
      laterBuyWallets.add(snapshot.user)
      if (!thresholdExit && laterBuyWallets.size >= options.exitAfterLaterBuys) {
        thresholdExit = snapshot
      }
    }
    if (!maxHoldExit && snapshot.timeMs >= maxExitTimeMs) {
      maxHoldExit = snapshot
    }
    lastExit = snapshot
  }

  const exitSnapshot = thresholdExit || maxHoldExit || lastExit
  const exitReason = thresholdExit
    ? 'later_buy_threshold'
    : maxHoldExit
      ? 'max_hold'
      : lastExit
        ? 'last_snapshot'
        : 'missing_exit'
  const grossReturnPct = entrySnapshot?.priceSolPerToken && exitSnapshot?.priceSolPerToken
    ? ((exitSnapshot.priceSolPerToken / entrySnapshot.priceSolPerToken) - 1) * 100
    : null
  const costPctOnSize = options.tradeSizeSol > 0 ? (options.fixedCostSol / options.tradeSizeSol) * 100 : 0
  const modeledNetReturnPct = grossReturnPct === null ? null : grossReturnPct - costPctOnSize

  return {
    pool: pool.pool,
    profile: determineProfile(pool),
    creatorSigner: pool.creatorSigner,
    rentTradable: rentAuditTradable(rentByPool.get(pool.pool)),
    entryTimeMs,
    exitTimeMs: exitSnapshot?.timeMs ?? null,
    entryPriceSolPerToken: entrySnapshot?.priceSolPerToken ?? null,
    exitPriceSolPerToken: exitSnapshot?.priceSolPerToken ?? null,
    grossReturnPct,
    costPctOnSize,
    modeledNetReturnPct,
    laterBuyWalletsAfterEntry: laterBuyWallets.size,
    exitReason,
  }
}

function summarizeProfile(
  profile: ReplayProfile,
  paths: ReplayPathResult[],
  options: PumpswapReplayOptions
): ReplayProfileSummary {
  const rows = paths.filter((path) => path.profile === profile)
  const completed = rows.filter((path) => path.modeledNetReturnPct !== null)
  const wins = completed.filter((path) => (path.modeledNetReturnPct ?? Number.NEGATIVE_INFINITY) > 0)
  const promotionBlockers: string[] = []
  const medianModeledNetReturnPct = median(completed.map((path) => path.modeledNetReturnPct))
  const avgModeledNetReturnPct = average(completed.map((path) => path.modeledNetReturnPct))
  const winRate = ratio(wins.length, completed.length)

  if (rows.length < options.minPromotionSamplePools) {
    promotionBlockers.push(`sample_pools<${options.minPromotionSamplePools}`)
  }
  if (completed.length === 0) {
    promotionBlockers.push('no_completed_replay_paths')
  }
  if (!rows.some((path) => path.rentTradable)) {
    promotionBlockers.push('no_rent_free_first_buyer_evidence')
  }
  if (medianModeledNetReturnPct === null || medianModeledNetReturnPct <= 0) {
    promotionBlockers.push('median_modeled_net_return_pct<=0')
  }
  if (avgModeledNetReturnPct === null || avgModeledNetReturnPct <= 0) {
    promotionBlockers.push('avg_modeled_net_return_pct<=0')
  }
  if (winRate === null || winRate < options.minWinRate) {
    promotionBlockers.push(`win_rate<${options.minWinRate}`)
  }

  return {
    profile,
    pools: rows.length,
    completedPaths: completed.length,
    rentTradableRate: ratio(rows.filter((path) => path.rentTradable).length, rows.length),
    avgGrossReturnPct: average(completed.map((path) => path.grossReturnPct)),
    medianGrossReturnPct: median(completed.map((path) => path.grossReturnPct)),
    avgModeledNetReturnPct,
    medianModeledNetReturnPct,
    winRate,
    avgLaterBuyWalletsAfterEntry: average(rows.map((path) => path.laterBuyWalletsAfterEntry)),
    promotionStatus: promotionBlockers.length === 0 ? 'PAPER_CANDIDATE' : 'BLOCKED',
    promotionBlockers,
  }
}

function reportFromPools(
  pools: Map<string, PoolState>,
  rentAuditRows: PumpSwapReplayRentAuditRow[],
  options: PumpswapReplayOptions
): PumpswapReplayReport {
  preparePools(pools)
  const rentByPool = new Map<string, PumpSwapReplayRentAuditRow>()
  for (const row of rentAuditRows) {
    if (row.pool) rentByPool.set(row.pool, row)
  }
  const paths = [...pools.values()].map((pool) => replayPool(pool, rentByPool, options))
  const profileNames = Array.from(new Set(paths.map((path) => path.profile)))
  const byProfile = profileNames
    .map((profile) => summarizeProfile(profile, paths, options))
    .sort((a, b) => (
      (b.medianModeledNetReturnPct ?? Number.NEGATIVE_INFINITY)
      - (a.medianModeledNetReturnPct ?? Number.NEGATIVE_INFINITY)
    ))

  return {
    generatedAt: new Date().toISOString(),
    inputs: options,
    totals: {
      pools: pools.size,
      completedPaths: paths.filter((path) => path.modeledNetReturnPct !== null).length,
      rentAuditedPools: paths.filter((path) => rentByPool.has(path.pool)).length,
    },
    byProfile,
    paths,
  }
}

export function analyzePumpswapReplayPaths(
  events: PumpSwapReplayEvent[],
  rentAuditRows: PumpSwapReplayRentAuditRow[],
  options: PumpswapReplayOptions
): PumpswapReplayReport {
  return reportFromPools(collectPools(events), rentAuditRows, options)
}

export function createPumpswapReplayPathCollector(): {
  ingestEvent: (row: PumpSwapReplayEvent) => void
  report: (
    rentAuditRows: PumpSwapReplayRentAuditRow[],
    options: PumpswapReplayOptions
  ) => PumpswapReplayReport
} {
  const pools = new Map<string, PoolState>()
  return {
    ingestEvent: (row) => ingestReplayEvent(pools, row),
    report: (rentAuditRows, options) => reportFromPools(pools, rentAuditRows, options),
  }
}
