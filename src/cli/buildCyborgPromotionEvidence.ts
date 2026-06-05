import crypto from 'crypto'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import type { PromotionGateEvidence, PromotionLoopEvidence } from '../promotion/PromotionGate'

type CyborgCanaryResult = {
  executedAtMs: number
  observedAtMs?: number
  pool: string
  mint: string
  wallet: string
  sizeSol: number
  beforeBalanceSol: number
  afterSellBalanceSol: number
  afterBuyTokenAmountRaw: string
  afterSellTokenAmountRaw: string
  buyWalletDeltaSol: number | null
  sellWalletDeltaSol: number | null
  buySignature: string | null
  sellSignature: string | null
  flattened: boolean
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value || '')
  return Number.isFinite(parsed) ? parsed : fallback
}

function getGitHead(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function readJsonFile(filePath: string): CyborgCanaryResult {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as CyborgCanaryResult
}

function tokenDeltaRaw(result: CyborgCanaryResult): string {
  return (BigInt(result.afterSellTokenAmountRaw) - BigInt(result.afterBuyTokenAmountRaw)).toString()
}

function findResultFiles(inputDir: string): string[] {
  return fs.readdirSync(inputDir)
    .filter((name) => name.startsWith('cyborg-canary-') && name.endsWith('.json'))
    .map((name) => path.join(inputDir, name))
    .sort()
}

async function main(): Promise<void> {
  dotenv.config()
  try {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
  } catch (_) {}

  const inputDir = path.resolve(process.cwd(), process.env.CYBORG_PROMOTION_INPUT_DIR || process.env.PUMPSWAP_META_OUTPUT_DIR || 'data/meta-observer')
  const outputDir = path.resolve(process.cwd(), process.env.PROMOTION_GATE_OUTPUT_DIR || 'data/promotion-gate')
  const strategyId = (process.env.PROMOTION_STRATEGY_ID || 'cyborg-canary').trim()
  const requiredLoops = parsePositiveInt(process.env.PROMOTION_GATE_MIN_LOOPS, 20)
  const failedAttemptWalletDeltaSol = parseNumber(process.env.PROMOTION_FAILED_ATTEMPT_WALLET_DELTA_SOL, 0)
  const openTestPositions = (process.env.PROMOTION_OPEN_TEST_POSITIONS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const uncontrolledRestartEvidence = ['true', '1', 'yes', 'on'].includes(
    (process.env.PROMOTION_UNCONTROLLED_RESTART_EVIDENCE || 'false').toLowerCase()
  )
  const expectedSizeSol = process.env.PROMOTION_EXPECT_SIZE_SOL
    ? Number.parseFloat(process.env.PROMOTION_EXPECT_SIZE_SOL)
    : null
  fs.mkdirSync(outputDir, { recursive: true })

  const files = findResultFiles(inputDir)
  if (files.length === 0) {
    throw new Error(`No cyborg-canary result files found in ${inputDir}`)
  }

  const results = files
    .map((filePath) => ({ filePath, result: readJsonFile(filePath) }))
    .filter(({ result }) => {
      if (expectedSizeSol === null) return true
      return Math.abs(result.sizeSol - expectedSizeSol) < 0.000000001
    })
    .filter(({ result }) => result.buySignature && result.sellSignature)
    .sort((a, b) => a.result.executedAtMs - b.result.executedAtMs)
    .slice(-requiredLoops)

  if (results.length === 0) {
    throw new Error('No complete cyborg-canary buy/sell results found')
  }

  const wallet = results[0].result.wallet
  const sizeSol = results[0].result.sizeSol
  const gitHead = getGitHead()
  const strategyHash = process.env.PROMOTION_STRATEGY_HASH || sha256({
    strategyId,
    source: 'src/cli/cyborgCanary.ts',
    codeCommit: gitHead,
    sizeSol,
  })

  const loops: PromotionLoopEvidence[] = results.map(({ result }) => ({
    strategyId,
    strategyHash,
    buySignature: result.buySignature || '',
    sellSignature: result.sellSignature || '',
    mint: result.mint,
    pool: result.pool,
    buyWalletDeltaSol: result.buyWalletDeltaSol ?? '',
    sellWalletDeltaSol: result.sellWalletDeltaSol ?? '',
    tokenDeltaRaw: tokenDeltaRaw(result),
    afterTokenAmountRaw: result.afterSellTokenAmountRaw,
    manualRescue: false,
  }))

  const evidence: PromotionGateEvidence = {
    strategyId,
    strategyHash,
    wallet,
    startedAtMs: Math.min(...results.map(({ result }) => result.executedAtMs)),
    endedAtMs: Math.max(...results.map(({ result }) => result.executedAtMs)),
    loops,
    failedAttemptWalletDeltaSol,
    uncontrolledRestartEvidence,
    openTestPositions,
  }

  const outPath = path.join(
    outputDir,
    `evidence-${strategyId}-${new Date(evidence.endedAtMs).toISOString().replace(/[:.]/g, '-')}.json`
  )
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2) + '\n')
  console.log('[BuildPromotionEvidence] Results scanned:', files.length)
  console.log('[BuildPromotionEvidence] Complete loops selected:', loops.length)
  console.log('[BuildPromotionEvidence] Strategy hash:', strategyHash)
  console.log('[BuildPromotionEvidence] Evidence:', outPath)
}

main().catch((error) => {
  console.error('[BuildPromotionEvidence] Failed:', error?.message || error)
  process.exit(1)
})
