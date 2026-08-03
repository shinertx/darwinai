import fs from 'fs'
import path from 'path'
import readline from 'readline'
import dotenv from 'dotenv'
import { Connection } from '@solana/web3.js'

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

dotenv.config()
try {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: false })
} catch {}

const WINDOW_MS = parsePositiveInt(process.env.PUMPSWAP_AUDIT_WINDOW_MS, 5000)
const RPC_MIN_SPACING_MS = parsePositiveInt(process.env.PUMPSWAP_AUDIT_RPC_MIN_SPACING_MS, 750)
const OUTPUT_DIR = path.resolve(process.cwd(), process.env.PUMPSWAP_META_OUTPUT_DIR || 'data/meta-observer')
const RPC_URL = ((process.env.RPC_URLS || process.env.RPC_URL || '').split(',')[0] || '').trim()

if (!RPC_URL) {
  throw new Error('RPC_URL or RPC_URLS not set')
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true })

const eventsFile = process.env.PUMPSWAP_AUDIT_EVENTS_PATH
  ? path.resolve(process.cwd(), process.env.PUMPSWAP_AUDIT_EVENTS_PATH)
  : resolveLatestEventsPath(OUTPUT_DIR)

if (!eventsFile || !fs.existsSync(eventsFile)) {
  throw new Error(`Events file not found: ${eventsFile || 'none resolved'}`)
}

const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  disableRetryOnRateLimit: true,
})
let nextRpcAtMs = 0

async function waitForRpcBudget() {
  const waitMs = Math.max(0, nextRpcAtMs - Date.now())
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  nextRpcAtMs = Date.now() + RPC_MIN_SPACING_MS
}

function resolveLatestEventsPath(outputDir) {
  const candidates = fs
    .readdirSync(outputDir)
    .filter((name) => name.startsWith('events-') && name.endsWith('.jsonl'))
    .map((name) => path.join(outputDir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).size > 0
      } catch {
        return false
      }
    })
    .sort()
  return candidates.at(-1) || null
}

function shouldReplaceFirstBuy(previous, next) {
  if (!previous) return true
  if (next.resolvedTimeMs !== previous.resolvedTimeMs) {
    return next.resolvedTimeMs < previous.resolvedTimeMs
  }
  return next.slot < previous.slot
}

async function fetchParsedTransaction(signature) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
    }
    try {
      await waitForRpcBudget()
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

async function main() {
  console.log('[Audit] Events file:', eventsFile)
  console.log('[Audit] Window ms:', WINDOW_MS)
  console.log('[Audit] RPC min spacing ms:', RPC_MIN_SPACING_MS)

  const pools = new Map()
  const firstBuys = new Map()
  const rl = readline.createInterface({
    input: fs.createReadStream(eventsFile, { encoding: 'utf8' }),
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
      pools.set(row.pool, {
        creator: row.creator,
        anchorTimeMs: row.anchorTimeMs,
        signature: row.signature,
      })
      continue
    }

    if (row.kind !== 'buy') {
      continue
    }

    const pool = pools.get(row.pool)
    if (!pool) continue
    if (pool.anchorTimeMs == null || row.resolvedTimeMs == null) continue
    if (row.user === pool.creator) continue
    if (row.resolvedTimeMs < pool.anchorTimeMs || row.resolvedTimeMs >= pool.anchorTimeMs + WINDOW_MS) continue

    const candidate = {
      pool: row.pool,
      createSignature: pool.signature,
      creator: pool.creator,
      signature: row.signature,
      user: row.user,
      resolvedTimeMs: row.resolvedTimeMs,
      slot: row.slot,
    }

    if (shouldReplaceFirstBuy(firstBuys.get(row.pool), candidate)) {
      firstBuys.set(row.pool, candidate)
    }
  }

  console.log('[Audit] First-buyer pools in window:', firstBuys.size)

  const analyzed = []
  let missingTransactions = 0

  for (const candidate of firstBuys.values()) {
    const tx = await fetchParsedTransaction(candidate.signature)
    if (!tx) {
      missingTransactions += 1
      analyzed.push({
        ...candidate,
        transactionFound: false,
        hasPoolExtend: null,
        hasAtaCreate: null,
      })
      continue
    }

    const logFlags = analyzeLogs(tx.meta?.logMessages)
    analyzed.push({
      ...candidate,
      transactionFound: true,
      feeLamports: tx.meta?.fee ?? null,
      hasPoolExtend: logFlags.hasPoolExtend,
      hasAtaCreate: logFlags.hasAtaCreate,
    })
  }

  const found = analyzed.filter((row) => row.transactionFound)
  const withoutPoolExtend = found.filter((row) => !row.hasPoolExtend)
  const summary = {
    eventsFile,
    windowMs: WINDOW_MS,
    rpcMinSpacingMs: RPC_MIN_SPACING_MS,
    poolsWithFirstBuyerInWindow: firstBuys.size,
    transactionsFound: found.length,
    transactionsMissing: missingTransactions,
    withPoolExtend: found.filter((row) => row.hasPoolExtend).length,
    withoutPoolExtend: withoutPoolExtend.length,
    withAtaCreate: found.filter((row) => row.hasAtaCreate).length,
    withoutAtaCreate: found.filter((row) => !row.hasAtaCreate).length,
    rentFreeFirstBuyerPossible: withoutPoolExtend.length > 0,
    sampleWithoutPoolExtend: withoutPoolExtend.slice(0, 10),
    sampleWithPoolExtend: found.filter((row) => row.hasPoolExtend).slice(0, 10),
  }

  const outPath = path.join(
    OUTPUT_DIR,
    `first-buyer-rent-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  )
  fs.writeFileSync(outPath, JSON.stringify({ summary, analyzed }, null, 2) + '\n')

  console.log('[Audit] Transactions found:', summary.transactionsFound)
  console.log('[Audit] With pool_extend:', summary.withPoolExtend)
  console.log('[Audit] Without pool_extend:', summary.withoutPoolExtend)
  console.log('[Audit] Rent-free first buyer possible:', summary.rentFreeFirstBuyerPossible)
  console.log('[Audit] Result written:', outPath)
}

main().catch((error) => {
  console.error('[Audit] Fatal error:', error)
  process.exit(1)
})
