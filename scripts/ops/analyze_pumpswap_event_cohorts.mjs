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
const FOLLOW_ON_WINDOW_MS = parsePositiveInt(process.env.PUMPSWAP_EVENT_COHORT_FOLLOW_ON_WINDOW_MS, 300_000)
const REQUIRED_GROSS_EDGE_PCT = parseOptionalPositiveFloat(process.env.PUMPSWAP_EVENT_COHORT_REQUIRED_GROSS_EDGE_PCT)
const MIN_PROMOTION_SAMPLE_POOLS = parsePositiveInt(process.env.PUMPSWAP_EVENT_COHORT_MIN_PROMOTION_SAMPLE_POOLS, 20)
const REQUIRE_LEGITIMATE_FOR_PROMOTION = parseBool(process.env.PUMPSWAP_EVENT_COHORT_REQUIRE_LEGITIMATE_FOR_PROMOTION, true)
const WINDOW_5S_MS = 5_000
const WINDOW_10S_MS = 10_000

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseOptionalPositiveFloat(value) {
  if (!value) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parseBool(value, fallback) {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function resolveInputFiles(envName, prefix, suffix) {
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function loadRentAudits(filePaths) {
  const byPool = new Map()
  for (const filePath of filePaths) {
    const payload = readJson(filePath)
    const rows = Array.isArray(payload) ? payload : payload.analyzed || payload.rows || []
    for (const row of rows) {
      byPool.set(row.pool, row)
    }
  }
  return byPool
}

function rentAuditTradable(row) {
  if (!row) return false
  if (row.tradable === true) return true
  return row.transactionFound === true
    && row.hasPoolExtend === false
    && row.hasAtaCreate === false
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

function addInstructionCount(map, kind) {
  map.set(kind, (map.get(kind) || 0) + 1)
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

function liquiditySol(pool) {
  const baseRaw = BigInt(pool.initialBaseReserveRaw || '0')
  const quoteRaw = BigInt(pool.initialQuoteReserveRaw || '0')
  if (pool.baseMint === WSOL_MINT) return Number(baseRaw) / (10 ** (pool.baseMintDecimals || 9))
  if (pool.quoteMint === WSOL_MINT) return Number(quoteRaw) / (10 ** (pool.quoteMintDecimals || 9))
  return null
}

function determineProfile(pool) {
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

function createPoolFromRow(row, sourceFile) {
  return {
    pool: row.pool,
    createSignature: row.signature,
    creatorSigner: row.creator || row.creatorSigner,
    anchorTimeMs: row.anchorTimeMs,
    baseMint: row.baseMint,
    quoteMint: row.quoteMint,
    baseMintDecimals: row.baseMintDecimals ?? 9,
    quoteMintDecimals: row.quoteMintDecimals ?? 9,
    initialBaseReserveRaw: row.initialBaseReserveRaw || row.poolBaseReserveRaw || '0',
    initialQuoteReserveRaw: row.initialQuoteReserveRaw || row.poolQuoteReserveRaw || '0',
    legitimatePool: row.legitimatePool === true,
    sourceFile,
    buyCompetitorWallets5s: new Set(),
    interactingWallets5s: new Set(),
    buyCompetitorWallets10s: new Set(),
    interactingWallets10s: new Set(),
    laterBuyWallets: new Set(),
    instructionCounts5s: new Map(),
    reservePeakSol: null,
    reserveDeltaSol: null,
  }
}

async function collectPools(eventFiles) {
  const pools = new Map()

  for (const eventFile of eventFiles) {
    const rl = readline.createInterface({
      input: fs.createReadStream(eventFile, { encoding: 'utf8' }),
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

      if (row.kind === 'create_pool') {
        if (row.pool && row.anchorTimeMs !== null && row.anchorTimeMs !== undefined) {
          pools.set(row.pool, createPoolFromRow(row, eventFile))
        }
        continue
      }

      const pool = pools.get(row.pool)
      if (!pool || row.resolvedTimeMs === null || row.resolvedTimeMs === undefined) continue
      if (row.resolvedTimeMs < pool.anchorTimeMs) continue

      const isCreator = row.user === pool.creatorSigner
      const ageMs = row.resolvedTimeMs - pool.anchorTimeMs
      if (ageMs <= WINDOW_5S_MS && !isCreator) {
        pool.interactingWallets5s.add(row.user)
        addInstructionCount(pool.instructionCounts5s, row.kind)
        if (row.kind === 'buy') pool.buyCompetitorWallets5s.add(row.user)
      }
      if (ageMs <= WINDOW_10S_MS && !isCreator) {
        pool.interactingWallets10s.add(row.user)
        if (row.kind === 'buy') pool.buyCompetitorWallets10s.add(row.user)
      }
      if (row.kind === 'buy' && ageMs <= FOLLOW_ON_WINDOW_MS && !isCreator) {
        pool.laterBuyWallets.add(row.user)
        const reserveSol = solAmount(pool, solReserveRaw(pool, row))
        if (reserveSol !== null && (pool.reservePeakSol === null || reserveSol > pool.reservePeakSol)) {
          pool.reservePeakSol = reserveSol
        }
      }
    }
  }

  for (const pool of pools.values()) {
    const initial = liquiditySol(pool)
    if (initial !== null && pool.reservePeakSol !== null) {
      pool.reserveDeltaSol = pool.reservePeakSol - initial
    }
  }

  return [...pools.values()]
}

function summarizeGroup(pools, rentByPool, extraFilter = () => true) {
  const rows = pools.filter(extraFilter)
  const rentFreeHits = rows.filter((pool) => rentAuditTradable(rentByPool.get(pool.pool)))
  const legitimateHits = rows.filter((pool) => pool.legitimatePool === true)
  const creatorCounts = new Map()
  for (const pool of pools) {
    creatorCounts.set(pool.creatorSigner, (creatorCounts.get(pool.creatorSigner) || 0) + 1)
  }
  const uniqueCreatorHits = rows.filter((pool) => (creatorCounts.get(pool.creatorSigner) || 0) === 1)
  const laterFlowHits = rows.filter((pool) => pool.laterBuyWallets.size > 0)
  const threePlusHits = rows.filter((pool) => pool.laterBuyWallets.size >= 3)
  const avgReserveDeltaSol = average(rows.map((pool) => pool.reserveDeltaSol))
  const medianLiquiditySol = median(rows.map(liquiditySol))
  const reserveDeltaPctOfMedianLiquidity = avgReserveDeltaSol !== null && medianLiquiditySol !== null && medianLiquiditySol > 0
    ? (avgReserveDeltaSol / medianLiquiditySol) * 100
    : null
  const promotionBlockers = []
  if (rows.length < MIN_PROMOTION_SAMPLE_POOLS) promotionBlockers.push(`sample_pools<${MIN_PROMOTION_SAMPLE_POOLS}`)
  if (rentFreeHits.length === 0) promotionBlockers.push('no_rent_free_first_buyer_evidence')
  if (REQUIRE_LEGITIMATE_FOR_PROMOTION && legitimateHits.length === 0) promotionBlockers.push('no_legitimate_pool_evidence')
  if (REQUIRED_GROSS_EDGE_PCT !== null) {
    if (reserveDeltaPctOfMedianLiquidity === null) {
      promotionBlockers.push('missing_reserve_delta_edge_proxy')
    } else if (reserveDeltaPctOfMedianLiquidity < REQUIRED_GROSS_EDGE_PCT) {
      promotionBlockers.push(`reserve_delta_proxy_below_required_gross_edge:${reserveDeltaPctOfMedianLiquidity.toFixed(2)}<${REQUIRED_GROSS_EDGE_PCT.toFixed(2)}`)
    }
  }

  return {
    pools: rows.length,
    rentFreeRate: ratio(rentFreeHits.length, rows.length),
    legitimateRate: ratio(legitimateHits.length, rows.length),
    uniqueCreatorRate: ratio(uniqueCreatorHits.length, rows.length),
    laterBuyFlowRate: ratio(laterFlowHits.length, rows.length),
    threePlusLaterBuyWalletRate: ratio(threePlusHits.length, rows.length),
    avgLaterBuyWallets: average(rows.map((pool) => pool.laterBuyWallets.size)),
    medianLaterBuyWallets: median(rows.map((pool) => pool.laterBuyWallets.size)),
    avgReserveDeltaSol,
    medianLiquiditySol,
    reserveDeltaPctOfMedianLiquidity,
    requiredGrossEdgePct: REQUIRED_GROSS_EDGE_PCT,
    promotionStatus: promotionBlockers.length === 0 ? 'PAPER_CANDIDATE' : 'BLOCKED',
    promotionBlockers,
  }
}

async function main() {
  const eventFiles = resolveInputFiles('PUMPSWAP_EVENT_COHORT_EVENTS_PATHS', 'events-', '.jsonl')
  const rentAuditFiles = resolveInputFiles('PUMPSWAP_EVENT_COHORT_RENT_AUDIT_PATHS', 'first-buyer-rent-audit-', '.json')
  if (eventFiles.length === 0) throw new Error('No non-empty events files found')

  const rentByPool = loadRentAudits(rentAuditFiles)
  const pools = await collectPools(eventFiles)
  const profileNames = Array.from(new Set(pools.map(determineProfile)))
  const byProfile = profileNames.map((profile) => ({
    profile,
    ...summarizeGroup(pools, rentByPool, (pool) => determineProfile(pool) === profile),
  })).sort((a, b) => (
    (b.threePlusLaterBuyWalletRate || 0) - (a.threePlusLaterBuyWalletRate || 0)
    || (b.reserveDeltaPctOfMedianLiquidity || 0) - (a.reserveDeltaPctOfMedianLiquidity || 0)
  ))

  const report = {
    generatedAt: new Date().toISOString(),
    inputs: {
      eventFiles,
      rentAuditFiles,
      followOnWindowMs: FOLLOW_ON_WINDOW_MS,
      window5sMs: WINDOW_5S_MS,
      window10sMs: WINDOW_10S_MS,
      requiredGrossEdgePct: REQUIRED_GROSS_EDGE_PCT,
      minPromotionSamplePools: MIN_PROMOTION_SAMPLE_POOLS,
      requireLegitimateForPromotion: REQUIRE_LEGITIMATE_FOR_PROMOTION,
    },
    totals: {
      pools: pools.length,
      poolsWithRentAudit: pools.filter((pool) => rentByPool.has(pool.pool)).length,
    },
    byProfile,
  }

  const outputPath = path.join(
    OUTPUT_DIR,
    `event-cohort-study-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  )
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')

  console.log('[EventCohort] Wrote:', outputPath)
  console.log('[EventCohort] Pools:', report.totals.pools)
  console.log('[EventCohort] Pools with rent audit:', report.totals.poolsWithRentAudit)
  for (const row of byProfile.slice(0, 8)) {
    console.log(
      `- ${row.profile}: pools=${row.pools}, rentFree=${formatPct(row.rentFreeRate)}, laterFlow=${formatPct(row.laterBuyFlowRate)}, threePlus=${formatPct(row.threePlusLaterBuyWalletRate)}, edgeProxy=${formatPctValue(row.reserveDeltaPctOfMedianLiquidity)}, status=${row.promotionStatus}`
    )
  }
}

function formatPct(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

function formatPctValue(value) {
  return value == null ? 'n/a' : `${value.toFixed(2)}%`
}

main().catch((error) => {
  console.error('[EventCohort] Fatal error:', error?.message || error)
  process.exit(1)
})
