import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { CyborgStrategyConfig } from '../observatory/cyborgStrategyConfig'

type CyborgCanaryResultLite = {
  executedAtMs?: number
  sizeSol?: number
  dryRun?: boolean
  netReturnSol?: number
  modeledNetReturnSol?: number | null
  buySignature?: string | null
  sellSignature?: string | null
  flattened?: boolean
  strategyConfig?: unknown
}

export type CyborgProfitabilityPreflightOptions = {
  inputDir: string
  canarySizeSol: number
  strategyConfig: CyborgStrategyConfig
  nowMs?: number
  lookbackMs?: number
  minObservedLoops?: number
  allowKnownUnprofitable?: boolean
}

export type CyborgProfitabilityPreflightResult = {
  allowed: boolean
  reason: 'no_matching_evidence' | 'known_unprofitable' | 'override_known_unprofitable'
  matchingEvidenceCount: number
  blockingEvidenceCount: number
  worstNetReturnSol: number | null
  latestNetReturnSol: number | null
  evidenceFiles: string[]
  message: string
}

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_MIN_OBSERVED_LOOPS = 1
const SIZE_EPSILON_SOL = 0.000000001

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex')
}

function normalizeDryRunBlockingConfig(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(normalizeDryRunBlockingConfig)

  const record = value as Record<string, unknown>
  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (key === 'liveSignalMaxAgeMs') continue
    normalized[key] = normalizeDryRunBlockingConfig(record[key])
  }
  return normalized
}

function readResult(filePath: string): CyborgCanaryResultLite | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as CyborgCanaryResultLite
  } catch {
    return null
  }
}

function resultFiles(inputDir: string): string[] {
  if (!fs.existsSync(inputDir)) return []
  return fs.readdirSync(inputDir)
    .filter((name) => (
      name.startsWith('cyborg-canary-')
      || name.startsWith('cyborg-dry-run-')
    ) && name.endsWith('.json'))
    .map((name) => path.join(inputDir, name))
    .sort()
}

function isSameSize(result: CyborgCanaryResultLite, canarySizeSol: number): boolean {
  return typeof result.sizeSol === 'number'
    && Number.isFinite(result.sizeSol)
    && Math.abs(result.sizeSol - canarySizeSol) <= SIZE_EPSILON_SOL
}

function isCompleteLoop(result: CyborgCanaryResultLite): boolean {
  return Boolean(result.buySignature && result.sellSignature)
}

function resultReturnSol(result: CyborgCanaryResultLite): number | null {
  const value = result.dryRun ? result.modeledNetReturnSol : result.netReturnSol
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isBlockingEvidence(result: CyborgCanaryResultLite): boolean {
  if (result.dryRun) {
    const modeledNetReturnSol = resultReturnSol(result)
    return modeledNetReturnSol === null || modeledNetReturnSol <= 0
  }
  if (!isCompleteLoop(result)) return true
  if (result.flattened !== true) return true
  const netReturnSol = resultReturnSol(result)
  return netReturnSol !== null && netReturnSol <= 0
}

export function evaluateCyborgProfitabilityPreflight(
  options: CyborgProfitabilityPreflightOptions
): CyborgProfitabilityPreflightResult {
  const nowMs = options.nowMs ?? Date.now()
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS
  const minObservedLoops = options.minObservedLoops ?? DEFAULT_MIN_OBSERVED_LOOPS
  const configHash = sha256(options.strategyConfig)
  const dryRunBlockingConfigHash = sha256(normalizeDryRunBlockingConfig(options.strategyConfig))
  const sinceMs = nowMs - lookbackMs

  const matching = resultFiles(options.inputDir)
    .map((filePath) => ({ filePath, result: readResult(filePath) }))
    .filter((entry): entry is { filePath: string; result: CyborgCanaryResultLite } => entry.result !== null)
    .filter(({ result }) => typeof result.executedAtMs === 'number' && result.executedAtMs >= sinceMs)
    .filter(({ result }) => isSameSize(result, options.canarySizeSol))
    .filter(({ result }) => {
      if (!result.strategyConfig) return false
      if (result.dryRun) {
        return sha256(normalizeDryRunBlockingConfig(result.strategyConfig)) === dryRunBlockingConfigHash
      }
      return sha256(result.strategyConfig) === configHash
    })
    .sort((a, b) => (a.result.executedAtMs || 0) - (b.result.executedAtMs || 0))

  const blocking = matching.filter(({ result }) => isBlockingEvidence(result))

  const netReturns = matching
    .map(({ result }) => resultReturnSol(result))
    .filter((value): value is number => value !== null)
  const latest = [...matching].reverse().find(({ result }) => resultReturnSol(result) !== null)
  const evidenceFiles = blocking.map(({ filePath }) => filePath)
  const blocked = blocking.length >= minObservedLoops

  if (blocked && !options.allowKnownUnprofitable) {
    return {
      allowed: false,
      reason: 'known_unprofitable',
      matchingEvidenceCount: matching.length,
      blockingEvidenceCount: blocking.length,
      worstNetReturnSol: netReturns.length > 0 ? Math.min(...netReturns) : null,
      latestNetReturnSol: latest ? resultReturnSol(latest.result) : null,
      evidenceFiles,
      message: `Refusing promotion batch: this exact cyborg config and ${options.canarySizeSol} SOL size already produced ${blocking.length} non-positive, incomplete, unflattened, or modeled-negative live/shadow evidence item(s). Rewrite or prove a new config in paper/offline analysis before spending another live canary.`,
    }
  }

  if (blocked && options.allowKnownUnprofitable) {
    return {
      allowed: true,
      reason: 'override_known_unprofitable',
      matchingEvidenceCount: matching.length,
      blockingEvidenceCount: blocking.length,
      worstNetReturnSol: netReturns.length > 0 ? Math.min(...netReturns) : null,
      latestNetReturnSol: latest ? resultReturnSol(latest.result) : null,
      evidenceFiles,
      message: `Diagnostic override active: allowing a promotion batch despite ${blocking.length} known non-positive, incomplete, unflattened, or modeled-negative live/shadow evidence item(s) for this exact config and size.`,
    }
  }

  return {
    allowed: true,
    reason: 'no_matching_evidence',
    matchingEvidenceCount: matching.length,
    blockingEvidenceCount: blocking.length,
    worstNetReturnSol: netReturns.length > 0 ? Math.min(...netReturns) : null,
    latestNetReturnSol: latest ? resultReturnSol(latest.result) : null,
    evidenceFiles,
    message: 'No matching known-unprofitable cyborg live/shadow evidence found for this config and size.',
  }
}
