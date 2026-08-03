import fs from 'fs'
import path from 'path'
import readline from 'readline'
import dotenv from 'dotenv'
import { Connection } from '@solana/web3.js'

dotenv.config()
try {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
} catch {}

const WSOL_MINT = 'So11111111111111111111111111111111111111112'

const OUTPUT_DIR = path.resolve(process.cwd(), process.env.PUMPSWAP_META_OUTPUT_DIR || 'data/meta-observer')
const BUY_COMPETITOR_MAX_5S = Number.parseInt(process.env.PUMPSWAP_EXITABILITY_BUY_COMPETITOR_MAX_5S || '1', 10) || 1
const INTERACTING_MAX_5S = parseOptionalInt(process.env.PUMPSWAP_EXITABILITY_INTERACTING_MAX_5S)
const FOLLOW_ON_WINDOW_MS = Number.parseInt(process.env.PUMPSWAP_EXITABILITY_FOLLOW_ON_WINDOW_MS || '300000', 10) || 300000
const REQUIRE_LEGITIMATE = parseBool(process.env.PUMPSWAP_EXITABILITY_REQUIRE_LEGITIMATE, false)
const NO_RPC_FALLBACK = parseBool(process.env.PUMPSWAP_EXITABILITY_NO_RPC_FALLBACK, false)
const RPC_URL = ((process.env.RPC_URLS || process.env.RPC_URL || '').split(',')[0] || '').trim()
const WINDOW_5S_MS = 5_000

const poolsFile = process.env.PUMPSWAP_EXITABILITY_POOLS_PATH
  ? path.resolve(process.cwd(), process.env.PUMPSWAP_EXITABILITY_POOLS_PATH)
  : resolveLatestMatchedFile(OUTPUT_DIR, 'pools-')

const eventsFile = process.env.PUMPSWAP_EXITABILITY_EVENTS_PATH
  ? path.resolve(process.cwd(), process.env.PUMPSWAP_EXITABILITY_EVENTS_PATH)
  : poolsFile
    ? path.join(path.dirname(poolsFile), path.basename(poolsFile).replace(/^pools-/, 'events-'))
    : null

const rentAuditFile = process.env.PUMPSWAP_EXITABILITY_RENT_AUDIT_PATH
  ? path.resolve(process.cwd(), process.env.PUMPSWAP_EXITABILITY_RENT_AUDIT_PATH)
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

if (!RPC_URL && !NO_RPC_FALLBACK) {
  throw new Error('RPC_URL or RPC_URLS not set')
}

const connection = NO_RPC_FALLBACK ? null : new Connection(RPC_URL, 'confirmed')

function parseOptionalInt(value) {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function parseBool(value, fallback) {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  return fallback
}

function resolveLatestMatchedFile(outputDir, prefix) {
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

async function readJsonl(filePath) {
  const rows = []
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line) continue
    try {
      rows.push(JSON.parse(line))
    } catch {}
  }

  return rows
}

async function collectPoolWindowData(filePath, poolById) {
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

    const poolSummary = poolById.get(row.pool)
    if (!poolSummary || row.resolvedTimeMs === null) {
      continue
    }

    const anchorTimeMs = poolSummary.anchorTimeMs || 0
    if (row.resolvedTimeMs < anchorTimeMs) {
      continue
    }

    const followOnEndMs = anchorTimeMs + FOLLOW_ON_WINDOW_MS
    const inFiveSecondWindow = row.resolvedTimeMs <= anchorTimeMs + WINDOW_5S_MS
    const inFollowOnWindow = row.resolvedTimeMs <= followOnEndMs
    const isCreator = row.user === poolSummary.creatorSigner

    if (!inFiveSecondWindow && !(row.kind === 'buy' && inFollowOnWindow && !isCreator)) {
      continue
    }

    if (!stateByPool.has(row.pool)) {
      stateByPool.set(row.pool, {
        buyCompetitorWallets5s: new Set(),
        interactingWallets5s: new Set(),
        buyEventsWithinWindow: [],
      })
    }

    const state = stateByPool.get(row.pool)
    if (inFiveSecondWindow && !isCreator) {
      state.interactingWallets5s.add(row.user)
      if (row.kind === 'buy') {
        state.buyCompetitorWallets5s.add(row.user)
      }
    }

    if (row.kind === 'buy' && inFollowOnWindow && !isCreator) {
      state.buyEventsWithinWindow.push(row)
    }
  }

  for (const state of stateByPool.values()) {
    state.buyEventsWithinWindow.sort((a, b) => a.resolvedTimeMs - b.resolvedTimeMs)
  }

  return stateByPool
}

function getSolReserveRaw(poolSummary, eventRow) {
  if (poolSummary.baseMint === WSOL_MINT) return BigInt(eventRow.poolBaseReserveRaw || '0')
  if (poolSummary.quoteMint === WSOL_MINT) return BigInt(eventRow.poolQuoteReserveRaw || '0')
  return null
}

function toSolAmount(poolSummary, solReserveRaw) {
  if (solReserveRaw === null) return null
  const decimals = poolSummary.baseMint === WSOL_MINT ? poolSummary.baseMintDecimals : poolSummary.quoteMintDecimals
  return Number(solReserveRaw) / (10 ** decimals)
}

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value))
  if (filtered.length === 0) return null
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length
}

function median(values) {
  const filtered = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (filtered.length === 0) return null
  return filtered[Math.floor(filtered.length / 2)]
}

async function fetchParsedTransaction(signature) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
    }
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      })
      if (tx) return tx
    } catch {}
  }
  return null
}

function analyzeLogs(logs) {
  const safeLogs = Array.isArray(logs) ? logs : []
  return {
    hasPoolExtend: safeLogs.some((line) => line.includes('Instruction: ExtendAccount')),
    hasAtaCreate: safeLogs.some((line) => line.includes('Instruction: CreateIdempotent')),
  }
}

async function resolveFirstBuyTradability(firstBuy, existingAudit) {
  if (!firstBuy) {
    return {
      transactionFound: false,
      hasPoolExtend: null,
      hasAtaCreate: null,
    }
  }

  if (existingAudit) {
    return {
      transactionFound: existingAudit.transactionFound,
      hasPoolExtend: existingAudit.hasPoolExtend,
      hasAtaCreate: existingAudit.hasAtaCreate,
    }
  }

  if (NO_RPC_FALLBACK) {
    return {
      transactionFound: false,
      hasPoolExtend: null,
      hasAtaCreate: null,
    }
  }

  const tx = await fetchParsedTransaction(firstBuy.signature)
  if (!tx) {
    return {
      transactionFound: false,
      hasPoolExtend: null,
      hasAtaCreate: null,
    }
  }

  const logFlags = analyzeLogs(tx.meta?.logMessages)
  return {
    transactionFound: true,
    hasPoolExtend: logFlags.hasPoolExtend,
    hasAtaCreate: logFlags.hasAtaCreate,
  }
}

async function analyzePool(poolSummary, rentAuditByPool, poolWindowState) {
  const buyCompetitorWalletCount5s = poolWindowState?.buyCompetitorWallets5s.size || 0
  const interactingWalletCount5s = poolWindowState?.interactingWallets5s.size || 0
  const lowCompetition = buyCompetitorWalletCount5s <= BUY_COMPETITOR_MAX_5S
    && (INTERACTING_MAX_5S === null || interactingWalletCount5s <= INTERACTING_MAX_5S)
    && (!REQUIRE_LEGITIMATE || poolSummary.legitimatePool === true)

  if (!lowCompetition) {
    return null
  }

  const rentAudit = rentAuditByPool.get(poolSummary.pool) || null

  const buysInWindow = poolWindowState?.buyEventsWithinWindow || []
  const firstBuy = buysInWindow[0] || null
  const firstBuyAudit = await resolveFirstBuyTradability(firstBuy, rentAudit)
  const firstBuyRentFree = firstBuyAudit.transactionFound === true
    && firstBuyAudit.hasPoolExtend === false
    && firstBuyAudit.hasAtaCreate === false
  const laterBuys = firstBuy
    ? buysInWindow.filter((row) => row.resolvedTimeMs > firstBuy.resolvedTimeMs)
    : []

  const laterBuyWallets = new Set(laterBuys.map((row) => row.user))
  const allBuyWallets = new Set(buysInWindow.map((row) => row.user))

  let maxSolReserveAfterFirstBuyRaw = null
  let firstBuySolReserveRaw = null
  if (firstBuy) {
    firstBuySolReserveRaw = getSolReserveRaw(poolSummary, firstBuy)
    for (const buy of laterBuys) {
      const reserveRaw = getSolReserveRaw(poolSummary, buy)
      if (reserveRaw === null) continue
      if (maxSolReserveAfterFirstBuyRaw === null || reserveRaw > maxSolReserveAfterFirstBuyRaw) {
        maxSolReserveAfterFirstBuyRaw = reserveRaw
      }
    }
  }

  const solReserveIncreaseRaw = firstBuySolReserveRaw !== null && maxSolReserveAfterFirstBuyRaw !== null
    ? maxSolReserveAfterFirstBuyRaw - firstBuySolReserveRaw
    : null

  return {
    pool: poolSummary.pool,
    createSignature: poolSummary.createSignature,
    creatorSigner: poolSummary.creatorSigner,
    legitimatePool: poolSummary.legitimatePool,
    buyCompetitorWalletCount5s,
    interactingWalletCount5s,
    buyCompetitorWalletCount10s: poolSummary.buyCompetitorWalletCount10s,
    interactingWalletCount10s: poolSummary.interactingWalletCount10s,
    firstBuyRentFree,
    firstBuyTransactionFound: firstBuyAudit.transactionFound,
    firstBuyHasPoolExtend: firstBuyAudit.hasPoolExtend,
    firstBuyHasAtaCreate: firstBuyAudit.hasAtaCreate,
    firstBuySignature: firstBuy?.signature || null,
    firstBuyAtMs: firstBuy?.resolvedTimeMs || null,
    buyCountWithinWindow: buysInWindow.length,
    uniqueBuyWalletsWithinWindow: allBuyWallets.size,
    laterBuyCountWithinWindow: laterBuys.length,
    laterBuyWalletsWithinWindow: laterBuyWallets.size,
    hasAnyLaterBuyFlow: laterBuys.length > 0,
    hasThreePlusLaterBuyWallets: laterBuyWallets.size >= 3,
    firstBuySolReserve: toSolAmount(poolSummary, firstBuySolReserveRaw),
    maxSolReserveAfterFirstBuy: toSolAmount(poolSummary, maxSolReserveAfterFirstBuyRaw),
    solReserveIncreaseAfterFirstBuy: toSolAmount(poolSummary, solReserveIncreaseRaw),
  }
}

async function main() {
  console.log('[Exitability] Pools file:', poolsFile)
  console.log('[Exitability] Events file:', eventsFile)
  console.log('[Exitability] Rent audit file:', rentAuditFile)
  console.log('[Exitability] Buy competitor max 5s:', BUY_COMPETITOR_MAX_5S)
  console.log('[Exitability] Follow-on window ms:', FOLLOW_ON_WINDOW_MS)
  console.log('[Exitability] No RPC fallback:', NO_RPC_FALLBACK)

  const poolRows = await readJsonl(poolsFile)
  const rentAuditPayload = readJson(rentAuditFile)
  const poolById = new Map(poolRows.map((row) => [row.pool, row]))
  const poolWindowData = await collectPoolWindowData(eventsFile, poolById)
  console.log('[Exitability] Pools with captured early-window data:', poolWindowData.size)

  const rentAuditByPool = new Map((rentAuditPayload.analyzed || []).map((row) => [row.pool, row]))

  const analyzedPools = []
  for (const poolSummary of poolRows) {
    const analyzed = await analyzePool(poolSummary, rentAuditByPool, poolWindowData.get(poolSummary.pool))
    if (analyzed) {
      analyzedPools.push(analyzed)
    }
  }

  const rentFreeTradable = analyzedPools.filter((row) => row.firstBuyRentFree)
  const withLaterBuyFlow = rentFreeTradable.filter((row) => row.hasAnyLaterBuyFlow)
  const withThreePlusLater = rentFreeTradable.filter((row) => row.hasThreePlusLaterBuyWallets)

  const summary = {
    poolsFile,
    eventsFile,
    rentAuditFile,
    buyCompetitorMax5s: BUY_COMPETITOR_MAX_5S,
    interactingMax5s: INTERACTING_MAX_5S,
    followOnWindowMs: FOLLOW_ON_WINDOW_MS,
    requireLegitimate: REQUIRE_LEGITIMATE,
    noRpcFallback: NO_RPC_FALLBACK,
    totalPoolsInSummary: poolRows.length,
    lowCompetitionPools: analyzedPools.length,
    lowCompetitionRentFreeTradable: rentFreeTradable.length,
    lowCompetitionRentFreeWithAnyLaterBuyFlow: withLaterBuyFlow.length,
    lowCompetitionRentFreeWithThreePlusLaterBuyWallets: withThreePlusLater.length,
    lowCompetitionRentFreeLaterBuyFlowRate: rentFreeTradable.length > 0
      ? withLaterBuyFlow.length / rentFreeTradable.length
      : null,
    lowCompetitionRentFreeThreePlusRate: rentFreeTradable.length > 0
      ? withThreePlusLater.length / rentFreeTradable.length
      : null,
    averageLaterBuyCountWithinWindow: average(rentFreeTradable.map((row) => row.laterBuyCountWithinWindow)),
    medianLaterBuyCountWithinWindow: median(rentFreeTradable.map((row) => row.laterBuyCountWithinWindow)),
    averageLaterBuyWalletsWithinWindow: average(rentFreeTradable.map((row) => row.laterBuyWalletsWithinWindow)),
    medianLaterBuyWalletsWithinWindow: median(rentFreeTradable.map((row) => row.laterBuyWalletsWithinWindow)),
    averageSolReserveIncreaseAfterFirstBuy: average(rentFreeTradable.map((row) => row.solReserveIncreaseAfterFirstBuy)),
    medianSolReserveIncreaseAfterFirstBuy: median(rentFreeTradable.map((row) => row.solReserveIncreaseAfterFirstBuy)),
    sampleBestExitability: rentFreeTradable
      .sort((a, b) => (
        b.laterBuyWalletsWithinWindow - a.laterBuyWalletsWithinWindow
        || (b.solReserveIncreaseAfterFirstBuy || 0) - (a.solReserveIncreaseAfterFirstBuy || 0)
      ))
      .slice(0, 20),
    sampleNoLaterFlow: rentFreeTradable
      .filter((row) => !row.hasAnyLaterBuyFlow)
      .slice(0, 20),
  }

  const outPath = path.join(
    OUTPUT_DIR,
    `early-exitability-study-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  )

  fs.writeFileSync(outPath, JSON.stringify({ summary, analyzedPools }, null, 2) + '\n')
  console.log('[Exitability] Low-competition pools:', summary.lowCompetitionPools)
  console.log('[Exitability] Rent-free tradable:', summary.lowCompetitionRentFreeTradable)
  console.log('[Exitability] Rent-free with any later buy flow:', summary.lowCompetitionRentFreeWithAnyLaterBuyFlow)
  console.log('[Exitability] Rent-free with 3+ later buy wallets:', summary.lowCompetitionRentFreeWithThreePlusLaterBuyWallets)
  console.log('[Exitability] Result written:', outPath)
}

main().catch((error) => {
  console.error('[Exitability] Fatal error:', error)
  process.exit(1)
})
