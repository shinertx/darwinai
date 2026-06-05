import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

type CyborgCanaryResultLite = {
  executedAtMs?: number
  sizeSol?: number
  netReturnSol?: number
  buySignature?: string | null
  sellSignature?: string | null
  flattened?: boolean
  strategyConfig?: unknown
}

export type CyborgBreakEvenOptions = {
  inputDir: string
  expectedEdgePctList: number[]
  sizeSol?: number | null
  lookbackMs?: number
  nowMs?: number
  minSamples?: number
}

export type CyborgBreakEvenScenario = {
  expectedGrossEdgePct: number
  expectedGrossEdgeSolAtCurrentSize: number
  canCurrentSizeClearLossFloor: boolean
  breakEvenSizeSol: number | null
}

export type CyborgBreakEvenGroup = {
  strategyConfigHash: string
  sizeSol: number
  evidenceCount: number
  completeLoopCount: number
  flattenedLoopCount: number
  positiveLoopCount: number
  nonPositiveLoopCount: number
  incompleteOrUnflattenedCount: number
  avgNetReturnSol: number | null
  worstNetReturnSol: number | null
  bestNetReturnSol: number | null
  lossFloorSol: number
  requiredGrossEdgePctAtCurrentSize: number
  scenarios: CyborgBreakEvenScenario[]
  status: 'BLOCKED_COST_FLOOR' | 'NEEDS_MORE_EVIDENCE' | 'NO_OBSERVED_LOSS_FLOOR'
  evidenceFiles: string[]
}

export type CyborgBreakEvenReport = {
  generatedAtMs: number
  inputDir: string
  minSamples: number
  expectedEdgePctList: number[]
  groups: CyborgBreakEvenGroup[]
  worstGroup: CyborgBreakEvenGroup | null
  recommendation: string
}

const DEFAULT_EXPECTED_EDGE_PCT_LIST = [1, 5, 10, 25, 50, 100]
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_MIN_SAMPLES = 1
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
    .filter((name) => name.startsWith('cyborg-canary-') && name.endsWith('.json'))
    .map((name) => path.join(inputDir, name))
    .sort()
}

function finiteNumbers(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sizeMatches(actual: number | undefined, expected: number | null | undefined): boolean {
  if (typeof actual !== 'number' || !Number.isFinite(actual) || actual <= 0) return false
  if (expected == null) return true
  return Math.abs(actual - expected) <= SIZE_EPSILON_SOL
}

function normalizeExpectedEdges(values: number[]): number[] {
  const normalized = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
  return normalized.length > 0 ? normalized : DEFAULT_EXPECTED_EDGE_PCT_LIST
}

function statusForGroup(
  evidenceCount: number,
  minSamples: number,
  lossFloorSol: number,
  incompleteOrUnflattenedCount: number,
  nonPositiveLoopCount: number
): CyborgBreakEvenGroup['status'] {
  if (evidenceCount < minSamples) return 'NEEDS_MORE_EVIDENCE'
  if (lossFloorSol > 0 || incompleteOrUnflattenedCount > 0 || nonPositiveLoopCount > 0) return 'BLOCKED_COST_FLOOR'
  return 'NO_OBSERVED_LOSS_FLOOR'
}

export function analyzeCyborgBreakEven(options: CyborgBreakEvenOptions): CyborgBreakEvenReport {
  const nowMs = options.nowMs ?? Date.now()
  const sinceMs = nowMs - (options.lookbackMs ?? DEFAULT_LOOKBACK_MS)
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES
  const expectedEdgePctList = normalizeExpectedEdges(options.expectedEdgePctList)
  const groups = new Map<string, Array<{ filePath: string; result: CyborgCanaryResultLite }>>()

  for (const filePath of resultFiles(options.inputDir)) {
    const result = readResult(filePath)
    if (!result) continue
    if (typeof result.executedAtMs !== 'number' || result.executedAtMs < sinceMs) continue
    if (!sizeMatches(result.sizeSol, options.sizeSol)) continue
    if (!result.strategyConfig) continue

    const strategyConfigHash = sha256(result.strategyConfig)
    const key = `${strategyConfigHash}:${result.sizeSol}`
    const entries = groups.get(key) || []
    entries.push({ filePath, result })
    groups.set(key, entries)
  }

  const analyzedGroups: CyborgBreakEvenGroup[] = [...groups.entries()].map(([key, entries]) => {
    const [strategyConfigHash] = key.split(':')
    const sorted = entries.sort((a, b) => (a.result.executedAtMs || 0) - (b.result.executedAtMs || 0))
    const sizeSol = sorted[0].result.sizeSol || 0
    const complete = sorted.filter(({ result }) => result.buySignature && result.sellSignature)
    const flattened = complete.filter(({ result }) => result.flattened === true)
    const netReturns = finiteNumbers(sorted.map(({ result }) => result.netReturnSol))
    const nonPositive = complete.filter(({ result }) => (
      typeof result.netReturnSol !== 'number'
      || !Number.isFinite(result.netReturnSol)
      || result.netReturnSol <= 0
    ))
    const incompleteOrUnflattened = sorted.filter(({ result }) => (
      !result.buySignature
      || !result.sellSignature
      || result.flattened !== true
    ))
    const losses = netReturns.filter((value) => value <= 0).map((value) => Math.abs(value))
    const lossFloorSol = losses.length > 0 ? Math.max(...losses) : 0
    const requiredGrossEdgePctAtCurrentSize = sizeSol > 0 ? (lossFloorSol / sizeSol) * 100 : 0

    return {
      strategyConfigHash,
      sizeSol,
      evidenceCount: sorted.length,
      completeLoopCount: complete.length,
      flattenedLoopCount: flattened.length,
      positiveLoopCount: complete.length - nonPositive.length,
      nonPositiveLoopCount: nonPositive.length,
      incompleteOrUnflattenedCount: incompleteOrUnflattened.length,
      avgNetReturnSol: avg(netReturns),
      worstNetReturnSol: netReturns.length > 0 ? Math.min(...netReturns) : null,
      bestNetReturnSol: netReturns.length > 0 ? Math.max(...netReturns) : null,
      lossFloorSol,
      requiredGrossEdgePctAtCurrentSize,
      scenarios: expectedEdgePctList.map((expectedGrossEdgePct) => {
        const expectedGrossEdgeSolAtCurrentSize = sizeSol * (expectedGrossEdgePct / 100)
        return {
          expectedGrossEdgePct,
          expectedGrossEdgeSolAtCurrentSize,
          canCurrentSizeClearLossFloor: expectedGrossEdgeSolAtCurrentSize > lossFloorSol,
          breakEvenSizeSol: expectedGrossEdgePct > 0 ? lossFloorSol / (expectedGrossEdgePct / 100) : null,
        }
      }),
      status: statusForGroup(
        sorted.length,
        minSamples,
        lossFloorSol,
        incompleteOrUnflattened.length,
        nonPositive.length
      ),
      evidenceFiles: sorted.map(({ filePath }) => filePath),
    }
  }).sort((a, b) => (
    b.lossFloorSol - a.lossFloorSol
    || b.incompleteOrUnflattenedCount - a.incompleteOrUnflattenedCount
    || b.evidenceCount - a.evidenceCount
  ))

  const worstGroup = analyzedGroups[0] || null
  const blockedGroups = analyzedGroups.filter((group) => group.status === 'BLOCKED_COST_FLOOR')
  const recommendation = blockedGroups.length > 0
    ? 'Keep live promotion locked for blocked config/size groups. Use paper or historical cohort analysis to find a config whose expected gross edge clears the observed wallet-delta loss floor before another live canary.'
    : analyzedGroups.length === 0
      ? 'No matching cyborg canary evidence found. Collect paper/historical cohort evidence before live canary promotion.'
      : 'No observed cyborg loss floor in the selected evidence, but Promotion Gate v1 is still required before any size increase.'

  return {
    generatedAtMs: nowMs,
    inputDir: options.inputDir,
    minSamples,
    expectedEdgePctList,
    groups: analyzedGroups,
    worstGroup,
    recommendation,
  }
}
