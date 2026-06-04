import fs from 'fs'
import path from 'path'
import readline from 'readline'
import dotenv from 'dotenv'

dotenv.config()
try {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
} catch {}

const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const OUTPUT_DIR = path.resolve(process.cwd(), process.env.PUMPSWAP_META_OUTPUT_DIR || 'data/meta-observer')
const FOLLOW_ON_WINDOW_MS = Number.parseInt(process.env.PUMPSWAP_ALT_EDGE_FOLLOW_ON_WINDOW_MS || '300000', 10) || 300000
const WINDOW_5S_MS = 5_000
const WINDOW_10S_MS = 10_000

const poolsFile = process.env.PUMPSWAP_ALT_EDGE_POOLS_PATH
  ? path.resolve(process.cwd(), process.env.PUMPSWAP_ALT_EDGE_POOLS_PATH)
  : resolveLatestMatchedFile(OUTPUT_DIR, 'pools-')

const eventsFile = process.env.PUMPSWAP_ALT_EDGE_EVENTS_PATH
  ? path.resolve(process.cwd(), process.env.PUMPSWAP_ALT_EDGE_EVENTS_PATH)
  : poolsFile
    ? path.join(path.dirname(poolsFile), path.basename(poolsFile).replace(/^pools-/, 'events-'))
    : null

const rentAuditFile = process.env.PUMPSWAP_ALT_EDGE_RENT_AUDIT_PATH
  ? path.resolve(process.cwd(), process.env.PUMPSWAP_ALT_EDGE_RENT_AUDIT_PATH)
  : resolveLatestMatchedFile(OUTPUT_DIR, 'first-buyer-rent-audit-')

if (!poolsFile || !fs.existsSync(poolsFile)) {
  throw new Error(`Pools file not found: ${poolsFile || 'none resolved'}`)
}
if (!eventsFile || !fs.existsSync(eventsFile)) {
  throw new Error(`Events file not found: ${eventsFile || 'none resolved'}`)
}
if (!rentAuditFile || !fs.existsSync(rentAuditFile)) {
  throw new Error(`Rent audit file not found: ${rentAuditFile || 'none resolved'}`)
}

function resolveLatestMatchedFile(outputDir, prefix) {
  if (!fs.existsSync(outputDir)) return null
  const candidates = fs
    .readdirSync(outputDir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(outputDir, name))
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value))
  if (!filtered.length) return null
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length
}

function median(values) {
  const filtered = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!filtered.length) return null
  return filtered[Math.floor(filtered.length / 2)]
}

function ratio(numerator, denominator) {
  if (!denominator) return null
  return numerator / denominator
}

function determineAltProfile(pool) {
  const nonCreator5s = pool.competitionInstructionCountsNonCreator5s || {}
  const buys5s = Number(nonCreator5s.buy || 0)
  const sells5s = Number(nonCreator5s.sell || 0)
  const deposits5s = Number(nonCreator5s.deposit || 0)
  const withdraws5s = Number(nonCreator5s.withdraw || 0)
  const interacting5s = Number(pool.interactingWalletCount5s || 0)
  const buys10s = Number(pool.buyCompetitorWalletCount10s || 0)
  const buys5Wallets = Number(pool.buyCompetitorWalletCount5s || 0)

  if (buys5Wallets === 0 && interacting5s === 0) return 'strict_zero'
  if (buys5Wallets === 0 && sells5s > 0 && deposits5s === 0 && withdraws5s === 0) return 'sell_only_probe'
  if (buys5Wallets === 0 && (deposits5s > 0 || withdraws5s > 0)) return 'liquidity_noise'
  if (buys5Wallets === 0) return 'non_buy_noise'
  if (buys5Wallets === 1 && interacting5s <= 2) return 'one_buy_probe'
  if (buys5Wallets === 1 && buys10s > buys5Wallets) return 'delayed_crowding'
  if (buys5Wallets <= 2) return 'low_buy_competition'
  return 'crowded'
}

function liquiditySol(pool) {
  const baseRaw = BigInt(pool.initialBaseReserveRaw || '0')
  const quoteRaw = BigInt(pool.initialQuoteReserveRaw || '0')
  if (pool.baseMint === WSOL_MINT) {
    return Number(baseRaw) / (10 ** (pool.baseMintDecimals || 9))
  }
  if (pool.quoteMint === WSOL_MINT) {
    return Number(quoteRaw) / (10 ** (pool.quoteMintDecimals || 9))
  }
  return null
}

function solReserveRaw(pool, row) {
  if (pool.baseMint === WSOL_MINT) return BigInt(row.poolBaseReserveRaw || '0')
  if (pool.quoteMint === WSOL_MINT) return BigInt(row.poolQuoteReserveRaw || '0')
  return null
}

function solAmount(pool, reserveRaw) {
  if (reserveRaw === null) return null
  const decimals = pool.baseMint === WSOL_MINT ? pool.baseMintDecimals : pool.quoteMintDecimals
  return Number(reserveRaw) / (10 ** decimals)
}

async function collectFollowOnData(filePath, poolById) {
  const stateByPool = new Map()
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }

    const pool = poolById.get(row.pool)
    if (!pool || row.resolvedTimeMs == null || pool.anchorTimeMs == null) continue
    if (row.resolvedTimeMs < pool.anchorTimeMs) continue

    if (!stateByPool.has(row.pool)) {
      stateByPool.set(row.pool, {
        laterBuyWallets: new Set(),
        laterBuyEvents: [],
        reserveDeltaSol: null,
        reservePeakSol: null,
      })
    }

    const state = stateByPool.get(row.pool)
    const isCreator = row.user === pool.creatorSigner
    const inFollowOn = row.resolvedTimeMs <= pool.anchorTimeMs + FOLLOW_ON_WINDOW_MS
    if (row.kind === 'buy' && inFollowOn && !isCreator) {
      state.laterBuyWallets.add(row.user)
      state.laterBuyEvents.push(row)
      const reserveRaw = solReserveRaw(pool, row)
      const reserveSol = solAmount(pool, reserveRaw)
      if (reserveSol != null) {
        if (state.reservePeakSol == null || reserveSol > state.reservePeakSol) {
          state.reservePeakSol = reserveSol
        }
      }
    }
  }

  for (const [poolId, state] of stateByPool.entries()) {
    const pool = poolById.get(poolId)
    const initialReserveSol = liquiditySol(pool)
    if (initialReserveSol != null && state.reservePeakSol != null) {
      state.reserveDeltaSol = state.reservePeakSol - initialReserveSol
    }
  }

  return stateByPool
}

function summarizeGroup(pools, followOnByPool, rentByPool, creatorCounts, extraFilter = () => true) {
  const rows = pools.filter(extraFilter)
  const laterFlowHits = rows.filter((pool) => (followOnByPool.get(pool.pool)?.laterBuyWallets.size || 0) > 0)
  const threePlusHits = rows.filter((pool) => (followOnByPool.get(pool.pool)?.laterBuyWallets.size || 0) >= 3)
  const rentFreeHits = rows.filter((pool) => rentByPool.get(pool.pool)?.tradable === true)
  const legitimateHits = rows.filter((pool) => pool.legitimatePool === true)
  const creatorUniqueHits = rows.filter((pool) => (creatorCounts.get(pool.creatorSigner) || 0) === 1)

  return {
    pools: rows.length,
    rentFreeRate: ratio(rentFreeHits.length, rows.length),
    legitimateRate: ratio(legitimateHits.length, rows.length),
    uniqueCreatorRate: ratio(creatorUniqueHits.length, rows.length),
    laterBuyFlowRate: ratio(laterFlowHits.length, rows.length),
    threePlusLaterBuyWalletRate: ratio(threePlusHits.length, rows.length),
    avgLaterBuyWallets: average(rows.map((pool) => followOnByPool.get(pool.pool)?.laterBuyWallets.size || 0)),
    medianLaterBuyWallets: median(rows.map((pool) => followOnByPool.get(pool.pool)?.laterBuyWallets.size || 0)),
    avgReserveDeltaSol: average(rows.map((pool) => followOnByPool.get(pool.pool)?.reserveDeltaSol)),
    medianLiquiditySol: median(rows.map((pool) => liquiditySol(pool))),
  }
}

async function main() {
  const pools = readJson(poolsFile)
  const rentAudit = readJson(rentAuditFile)
  const poolById = new Map(pools.map((pool) => [pool.pool, pool]))
  const rentByPool = new Map((Array.isArray(rentAudit) ? rentAudit : rentAudit.rows || []).map((row) => [row.pool, row]))
  const creatorCounts = new Map()
  for (const pool of pools) {
    creatorCounts.set(pool.creatorSigner, (creatorCounts.get(pool.creatorSigner) || 0) + 1)
  }

  const followOnByPool = await collectFollowOnData(eventsFile, poolById)

  const profileNames = Array.from(new Set(pools.map(determineAltProfile)))
  const byProfile = profileNames.map((profile) => ({
    profile,
    ...summarizeGroup(pools, followOnByPool, rentByPool, creatorCounts, (pool) => determineAltProfile(pool) === profile),
  })).sort((a, b) => (b.threePlusLaterBuyWalletRate || 0) - (a.threePlusLaterBuyWalletRate || 0))

  const focusedSlices = {
    strictZeroRentFreeLegitUnique: summarizeGroup(
      pools,
      followOnByPool,
      rentByPool,
      creatorCounts,
      (pool) =>
        determineAltProfile(pool) === 'strict_zero' &&
        rentByPool.get(pool.pool)?.tradable === true &&
        pool.legitimatePool === true &&
        (creatorCounts.get(pool.creatorSigner) || 0) === 1
    ),
    sellOnlyProbeRentFreeLegitUnique: summarizeGroup(
      pools,
      followOnByPool,
      rentByPool,
      creatorCounts,
      (pool) =>
        determineAltProfile(pool) === 'sell_only_probe' &&
        rentByPool.get(pool.pool)?.tradable === true &&
        pool.legitimatePool === true &&
        (creatorCounts.get(pool.creatorSigner) || 0) === 1
    ),
    oneBuyProbeRentFreeLegitUnique: summarizeGroup(
      pools,
      followOnByPool,
      rentByPool,
      creatorCounts,
      (pool) =>
        determineAltProfile(pool) === 'one_buy_probe' &&
        rentByPool.get(pool.pool)?.tradable === true &&
        pool.legitimatePool === true &&
        (creatorCounts.get(pool.creatorSigner) || 0) === 1
    ),
    delayedCrowdingRentFreeLegitUnique: summarizeGroup(
      pools,
      followOnByPool,
      rentByPool,
      creatorCounts,
      (pool) =>
        determineAltProfile(pool) === 'delayed_crowding' &&
        rentByPool.get(pool.pool)?.tradable === true &&
        pool.legitimatePool === true &&
        (creatorCounts.get(pool.creatorSigner) || 0) === 1
    ),
  }

  const report = {
    generatedAt: new Date().toISOString(),
    inputs: {
      poolsFile,
      eventsFile,
      rentAuditFile,
      followOnWindowMs: FOLLOW_ON_WINDOW_MS,
      window5sMs: WINDOW_5S_MS,
      window10sMs: WINDOW_10S_MS,
    },
    totals: {
      pools: pools.length,
      poolsWithFollowOnData: followOnByPool.size,
    },
    byProfile,
    focusedSlices,
  }

  const outputPath = path.join(
    path.dirname(poolsFile),
    `alt-edge-study-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  )
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2))

  console.log('[AltEdge] Wrote:', outputPath)
  console.log('[AltEdge] Top profiles by three-plus-later-wallet rate:')
  for (const row of byProfile.slice(0, 6)) {
    console.log(
      `- ${row.profile}: pools=${row.pools}, laterFlow=${formatPct(row.laterBuyFlowRate)}, threePlus=${formatPct(row.threePlusLaterBuyWalletRate)}, avgLaterWallets=${formatNum(row.avgLaterBuyWallets)}, avgReserveDeltaSol=${formatNum(row.avgReserveDeltaSol)}`
    )
  }
  console.log('[AltEdge] Focused slices:')
  for (const [name, row] of Object.entries(focusedSlices)) {
    console.log(
      `- ${name}: pools=${row.pools}, laterFlow=${formatPct(row.laterBuyFlowRate)}, threePlus=${formatPct(row.threePlusLaterBuyWalletRate)}, avgLaterWallets=${formatNum(row.avgLaterBuyWallets)}, avgReserveDeltaSol=${formatNum(row.avgReserveDeltaSol)}`
    )
  }
}

function formatPct(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

function formatNum(value) {
  return value == null ? 'n/a' : value.toFixed(2)
}

main().catch((error) => {
  console.error('[AltEdge] Fatal error:', error?.message || error)
  process.exit(1)
})
