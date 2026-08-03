import crypto from 'crypto'

export type PromotionGateStatus = 'PASS' | 'FAIL'

export type PromotionLoopEvidence = {
  strategyId?: string
  strategyHash?: string
  buySignature: string
  sellSignature: string
  mint: string
  pool: string
  buyWalletDeltaSol: number | string
  sellWalletDeltaSol: number | string
  tokenDeltaRaw: string
  afterTokenAmountRaw: string
  manualRescue?: boolean
  buyFinalized?: boolean
  sellFinalized?: boolean
}

export type PromotionGateEvidence = {
  strategyId: string
  strategyHash: string
  wallet: string
  startedAtMs: number
  endedAtMs: number
  loops: PromotionLoopEvidence[]
  failedAttemptWalletDeltaSol?: number | string
  uncontrolledRestartEvidence?: boolean
  openTestPositions?: string[]
}

export type PromotionGateConfig = {
  minLoops: number
  maxWindowMs: number
  requireFinalized: boolean
}

export type PromotionGateRecord = {
  id: string
  evaluatedAtMs: number
  status: PromotionGateStatus
  strategyId: string
  strategyHash: string
  wallet: string
  loopCount: number
  netWalletDeltaSol: number
  failures: string[]
  config: PromotionGateConfig
  evidenceHash: string
}

export const DEFAULT_PROMOTION_GATE_CONFIG: PromotionGateConfig = {
  minLoops: 20,
  maxWindowMs: 24 * 60 * 60 * 1000,
  requireFinalized: true,
}

function asFiniteNumber(value: number | string): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function asBigInt(value: string): bigint | null {
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort())
}

export function hashPromotionEvidence(evidence: PromotionGateEvidence): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(evidence))
    .digest('hex')
}

export function evaluatePromotionGate(
  evidence: PromotionGateEvidence,
  config: Partial<PromotionGateConfig> = {}
): PromotionGateRecord {
  const resolvedConfig: PromotionGateConfig = {
    ...DEFAULT_PROMOTION_GATE_CONFIG,
    ...config,
  }
  const failures: string[] = []
  const loops = Array.isArray(evidence.loops) ? evidence.loops : []

  if (!evidence.strategyId) failures.push('missing_strategy_id')
  if (!evidence.strategyHash) failures.push('missing_strategy_hash')
  if (!evidence.wallet) failures.push('missing_wallet')
  if (!Number.isFinite(evidence.startedAtMs)) failures.push('missing_started_at_ms')
  if (!Number.isFinite(evidence.endedAtMs)) failures.push('missing_ended_at_ms')
  if (Number.isFinite(evidence.startedAtMs) && Number.isFinite(evidence.endedAtMs)) {
    const windowMs = evidence.endedAtMs - evidence.startedAtMs
    if (windowMs < 0) failures.push('invalid_time_window')
    if (windowMs > resolvedConfig.maxWindowMs) failures.push('window_exceeds_24h')
  }

  if (loops.length < resolvedConfig.minLoops) {
    failures.push(`insufficient_loops:${loops.length}/${resolvedConfig.minLoops}`)
  }

  if (evidence.uncontrolledRestartEvidence) failures.push('uncontrolled_restart_evidence')
  if ((evidence.openTestPositions || []).length > 0) failures.push('open_test_positions')

  const failedAttemptWalletDeltaSol = evidence.failedAttemptWalletDeltaSol === undefined
    ? 0
    : asFiniteNumber(evidence.failedAttemptWalletDeltaSol)
  if (failedAttemptWalletDeltaSol === null) {
    failures.push('invalid_failed_attempt_wallet_delta')
  }

  let netWalletDeltaSol = failedAttemptWalletDeltaSol ?? 0
  const seenBuySignatures = new Set<string>()
  const seenSellSignatures = new Set<string>()

  loops.forEach((loop, index) => {
    const prefix = `loop_${index}`
    if (loop.strategyId && loop.strategyId !== evidence.strategyId) failures.push(`${prefix}:strategy_id_mismatch`)
    if (loop.strategyHash && loop.strategyHash !== evidence.strategyHash) failures.push(`${prefix}:strategy_hash_mismatch`)
    if (!loop.buySignature) failures.push(`${prefix}:missing_buy_signature`)
    if (!loop.sellSignature) failures.push(`${prefix}:missing_sell_signature`)
    if (!loop.mint) failures.push(`${prefix}:missing_mint`)
    if (!loop.pool) failures.push(`${prefix}:missing_pool`)

    if (loop.buySignature) {
      if (seenBuySignatures.has(loop.buySignature)) failures.push(`${prefix}:duplicate_buy_signature`)
      seenBuySignatures.add(loop.buySignature)
    }
    if (loop.sellSignature) {
      if (seenSellSignatures.has(loop.sellSignature)) failures.push(`${prefix}:duplicate_sell_signature`)
      seenSellSignatures.add(loop.sellSignature)
    }

    if (resolvedConfig.requireFinalized) {
      if (loop.buyFinalized !== true) failures.push(`${prefix}:buy_not_finalized`)
      if (loop.sellFinalized !== true) failures.push(`${prefix}:sell_not_finalized`)
    }

    const buyDelta = asFiniteNumber(loop.buyWalletDeltaSol)
    const sellDelta = asFiniteNumber(loop.sellWalletDeltaSol)
    if (buyDelta === null) failures.push(`${prefix}:invalid_buy_wallet_delta`)
    if (sellDelta === null) failures.push(`${prefix}:invalid_sell_wallet_delta`)
    if (buyDelta !== null && sellDelta !== null) {
      netWalletDeltaSol += buyDelta + sellDelta
    }

    const afterTokenRaw = asBigInt(loop.afterTokenAmountRaw)
    const tokenDeltaRaw = asBigInt(loop.tokenDeltaRaw)
    if (afterTokenRaw === null) failures.push(`${prefix}:invalid_after_token_amount_raw`)
    if (tokenDeltaRaw === null) failures.push(`${prefix}:invalid_token_delta_raw`)
    if (afterTokenRaw !== null && afterTokenRaw !== 0n) failures.push(`${prefix}:position_not_flattened`)
    if (tokenDeltaRaw !== null && tokenDeltaRaw >= 0n) failures.push(`${prefix}:token_not_reduced`)
    if (loop.manualRescue) failures.push(`${prefix}:manual_rescue`)
  })

  if (netWalletDeltaSol <= 0) failures.push('net_wallet_delta_not_positive')

  return {
    id: crypto.randomUUID(),
    evaluatedAtMs: Date.now(),
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    strategyId: evidence.strategyId,
    strategyHash: evidence.strategyHash,
    wallet: evidence.wallet,
    loopCount: loops.length,
    netWalletDeltaSol,
    failures,
    config: resolvedConfig,
    evidenceHash: hashPromotionEvidence(evidence),
  }
}
