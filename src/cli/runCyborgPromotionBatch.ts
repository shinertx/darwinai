import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value || '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseBool(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function runNodeScript(scriptPath: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

function latestFile(dir: string, prefix: string): string | null {
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return files[0] || null
}

function latestBatchResult(outputDir: string, startedAtMs: number): { netReturnSol: number; filePath: string } | null {
  const latest = latestFile(outputDir, 'cyborg-canary-')
  if (!latest) return null
  const parsed = JSON.parse(fs.readFileSync(latest, 'utf8')) as {
    executedAtMs?: number
    netReturnSol?: number
  }
  if (!parsed.executedAtMs || parsed.executedAtMs < startedAtMs) return null
  if (typeof parsed.netReturnSol !== 'number' || !Number.isFinite(parsed.netReturnSol)) return null
  return { netReturnSol: parsed.netReturnSol, filePath: latest }
}

async function main(): Promise<void> {
  dotenv.config()
  try {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
  } catch (_) {}

  const targetLoops = parsePositiveInt(process.env.CYBORG_PROMOTION_TARGET_LOOPS, 20)
  const maxAttempts = parsePositiveInt(process.env.CYBORG_PROMOTION_MAX_ATTEMPTS, targetLoops * 5)
  const maxRuntimeMs = parsePositiveInt(process.env.CYBORG_PROMOTION_MAX_RUNTIME_MS, 24 * 60 * 60 * 1000)
  const attemptTimeoutMs = parsePositiveInt(process.env.PUMPSWAP_CYBORG_CANARY_TIMEOUT_MS, 20 * 60 * 1000)
  const canarySizeSol = parsePositiveFloat(process.env.PUMPSWAP_CYBORG_CANARY_SIZE_SOL, 0.0001)
  const stopOnNonPositiveLoop = parseBool(process.env.CYBORG_PROMOTION_STOP_ON_NON_POSITIVE_LOOP, false)
  const outputDir = path.resolve(process.cwd(), process.env.PUMPSWAP_META_OUTPUT_DIR || 'data/meta-observer')
  const promotionDir = path.resolve(process.cwd(), process.env.PROMOTION_GATE_OUTPUT_DIR || 'data/promotion-gate')
  const startedAtMs = Date.now()
  const cyborgScript = path.resolve(process.cwd(), 'dist/cli/cyborgCanary.js')
  const evidenceScript = path.resolve(process.cwd(), 'dist/cli/buildCyborgPromotionEvidence.js')
  const gateScript = path.resolve(process.cwd(), 'dist/cli/promotionGate.js')

  if (!fs.existsSync(cyborgScript) || !fs.existsSync(evidenceScript) || !fs.existsSync(gateScript)) {
    throw new Error('Batch runner requires built dist files. Run npm run build first.')
  }

  fs.mkdirSync(outputDir, { recursive: true })
  fs.mkdirSync(promotionDir, { recursive: true })

  console.log('[CyborgPromotionBatch] Target loops:', targetLoops)
  console.log('[CyborgPromotionBatch] Max attempts:', maxAttempts)
  console.log('[CyborgPromotionBatch] Canary size SOL:', canarySizeSol.toFixed(6))
  console.log('[CyborgPromotionBatch] Stop on non-positive loop:', stopOnNonPositiveLoop)
  console.log('[CyborgPromotionBatch] Started at:', new Date(startedAtMs).toISOString())

  let successes = 0
  let attempts = 0
  let stopReason = 'target_reached'

  while (successes < targetLoops && attempts < maxAttempts && Date.now() - startedAtMs < maxRuntimeMs) {
    attempts += 1
    console.log(`[CyborgPromotionBatch] Attempt ${attempts}/${maxAttempts} | successes ${successes}/${targetLoops}`)
    const code = await runNodeScript(cyborgScript, {
      ...process.env,
      PUMPSWAP_META_OUTPUT_DIR: outputDir,
      PUMPSWAP_CYBORG_CANARY_SIZE_SOL: canarySizeSol.toString(),
      PUMPSWAP_CYBORG_CANARY_TIMEOUT_MS: attemptTimeoutMs.toString(),
      DARWIN_MODE: 'live',
      LIVE_TRADE_SIZE_SOL: canarySizeSol.toString(),
      LIVE_MIN_BALANCE_SOL: process.env.LIVE_MIN_BALANCE_SOL || '0.003',
      DARWIN_LIVE_ALLOW_ATA_CREATE: 'true',
      DARWIN_LIVE_ALLOW_POOL_EXTEND: process.env.DARWIN_LIVE_ALLOW_POOL_EXTEND || 'false',
      DARWIN_LIVE_CLOSE_TOKEN_ATA_ON_SELL: 'true',
    })

    if (code === 0) {
      successes += 1
      const latestResult = latestBatchResult(outputDir, startedAtMs)
      if (!latestResult) {
        stopReason = 'missing_success_result'
        console.log('[CyborgPromotionBatch] Stopping because a successful canary did not write a result file.')
        break
      }
      console.log(
        '[CyborgPromotionBatch] Latest loop net SOL:',
        latestResult.netReturnSol.toFixed(9),
        '| result:',
        latestResult.filePath
      )
      if (stopOnNonPositiveLoop && latestResult.netReturnSol <= 0) {
        stopReason = 'non_positive_loop_net'
        console.log('[CyborgPromotionBatch] Stopping because the latest completed loop was not net-positive.')
        break
      }
      continue
    }

    if (code === 2) {
      console.log('[CyborgPromotionBatch] Attempt timed out without trade; continuing.')
      continue
    }

    if (code === 3) {
      stopReason = 'unflattened_position'
      console.log('[CyborgPromotionBatch] Stopping because a canary did not flatten.')
      break
    }

    stopReason = `canary_error_exit_${code}`
    console.log('[CyborgPromotionBatch] Stopping on canary error exit:', code)
    break
  }

  if (successes < targetLoops && stopReason === 'target_reached') {
    stopReason = attempts >= maxAttempts ? 'max_attempts' : 'max_runtime'
  }

  const endedAtMs = Date.now()
  const evidenceCode = await runNodeScript(evidenceScript, {
    ...process.env,
    CYBORG_PROMOTION_INPUT_DIR: outputDir,
    CYBORG_PROMOTION_SINCE_MS: startedAtMs.toString(),
    CYBORG_PROMOTION_UNTIL_MS: endedAtMs.toString(),
    PROMOTION_GATE_MIN_LOOPS: targetLoops.toString(),
    PROMOTION_EXPECT_SIZE_SOL: canarySizeSol.toString(),
    PROMOTION_FAILED_ATTEMPT_WALLET_DELTA_SOL: process.env.PROMOTION_FAILED_ATTEMPT_WALLET_DELTA_SOL || '0',
    PROMOTION_OPEN_TEST_POSITIONS: stopReason === 'unflattened_position' ? 'unknown_unflattened_canary' : '',
    PROMOTION_UNCONTROLLED_RESTART_EVIDENCE: 'false',
  })

  if (evidenceCode !== 0) {
    console.log('[CyborgPromotionBatch] Evidence build failed with exit:', evidenceCode)
    process.exit(evidenceCode)
  }

  const evidencePath = latestFile(promotionDir, 'evidence-cyborg-canary-')
  if (!evidencePath) {
    throw new Error('Evidence file was not produced')
  }

  const gateCode = await runNodeScript(gateScript, {
    ...process.env,
    PROMOTION_GATE_INPUT: evidencePath,
    PROMOTION_GATE_VERIFY_ONCHAIN: 'true',
    PROMOTION_GATE_OUTPUT_DIR: promotionDir,
    PROMOTION_GATE_MIN_LOOPS: targetLoops.toString(),
  })

  console.log('[CyborgPromotionBatch] Attempts:', attempts)
  console.log('[CyborgPromotionBatch] Successful loops:', successes)
  console.log('[CyborgPromotionBatch] Stop reason:', stopReason)
  console.log('[CyborgPromotionBatch] Evidence:', evidencePath)
  process.exit(gateCode)
}

main().catch((error) => {
  console.error('[CyborgPromotionBatch] Failed:', error?.message || error)
  process.exit(1)
})
