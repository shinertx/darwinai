import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { BorshCoder, EventParser, type Idl } from '@coral-xyz/anchor'
import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js'
import { PUMP_AMM_PROGRAM_ID, pumpAmmJson } from '@pump-fun/pump-swap-sdk'
import { createSolanaConnection } from '../rpc/solanaConnection'
import { getPrimaryRpcUrl } from '../config/runtime'

type PumpAmmEventName =
  | 'CreatePoolEvent'
  | 'BuyEvent'
  | 'SellEvent'
  | 'DepositEvent'
  | 'WithdrawEvent'

type NormalizedEventKind =
  | 'create_pool'
  | 'buy'
  | 'sell'
  | 'deposit'
  | 'withdraw'

type ResolvedTimeSource =
  | 'blockTime'
  | 'slotBlockTime'
  | 'eventTimestamp'
  | 'unavailable'

export type CompetitionInstructionCounts = {
  buy: number
  sell: number
  deposit: number
  withdraw: number
}

export type WalletFirstSeen = {
  wallet: string
  firstSeenAtMs: number | null
  firstInstruction: Exclude<NormalizedEventKind, 'create_pool'>
}

export type NormalizedCreatePoolEvent = {
  kind: 'create_pool'
  pool: string
  creator: string
  coinCreator: string
  baseMint: string
  quoteMint: string
  baseMintDecimals: number
  quoteMintDecimals: number
  initialBaseReserveRaw: bigint
  initialQuoteReserveRaw: bigint
  initialLiquidityRaw: bigint
  lpTokenAmountOutRaw: bigint
  eventTimestampMs: number | null
}

export type NormalizedInteractionEvent = {
  kind: Exclude<NormalizedEventKind, 'create_pool'>
  pool: string
  user: string
  eventTimestampMs: number | null
  poolBaseReserveRaw: bigint
  poolQuoteReserveRaw: bigint
}

export type PumpAmmDecodedEvent =
  | { name: 'CreatePoolEvent'; data: NormalizedCreatePoolEvent }
  | { name: 'BuyEvent' | 'SellEvent' | 'DepositEvent' | 'WithdrawEvent'; data: NormalizedInteractionEvent }

export interface PumpSwapMetaObserverConfig {
  rpcUrl: string
  wsUrl: string | null
  outputDir: string
  logDir: string
  runHours: number
  competitionWindowMs: number
  cyborgAlertWindowMs: number
  cyborgMaxBuyCompetitors: number
  rugWindowMs: number
  drainThresholdPct: number
  minRemainingSolRawString: string
  heartbeatMs: number
  cleanupIntervalMs: number
  maxQueueDepth: number
}

export interface ResolvedEventTime {
  timeMs: number | null
  source: ResolvedTimeSource
}

export interface PoolSummary {
  pool: string
  createSignature: string
  createSlot: number
  createBlockTimeMs: number | null
  anchorTimeMs: number | null
  anchorTimeSource: Exclude<ResolvedTimeSource, 'eventTimestamp'>
  timeAnchorUnavailable: boolean
  baseMint: string
  quoteMint: string
  baseMintDecimals: number
  quoteMintDecimals: number
  creatorSigner: string
  poolCreator: string
  coinCreator: string
  signerAddresses: string[]
  initialBaseReserveRaw: string
  initialQuoteReserveRaw: string
  initialLiquidityRaw: string
  lpTokenAmountOutRaw: string
  buyCompetitorWalletCount5s: number
  buyCompetitorWallets5s: string[]
  interactingWalletCount5s: number
  interactingWallets5s: string[]
  firstSeenWallets5s: WalletFirstSeen[]
  competitionInstructionCounts5s: CompetitionInstructionCounts
  competitionInstructionCountsNonCreator5s: CompetitionInstructionCounts
  cyborgAlertWindowMs: number
  cyborgEligibleAt5s: boolean
  cyborgAlertTriggered: boolean
  cyborgAlertTriggeredAtMs: number | null
  buyCompetitorWalletCount10s: number
  buyCompetitorWallets10s: string[]
  interactingWalletCount10s: number
  interactingWallets10s: string[]
  firstSeenWallets10s: WalletFirstSeen[]
  competitionInstructionCounts10s: CompetitionInstructionCounts
  competitionInstructionCountsNonCreator10s: CompetitionInstructionCounts
  creatorDrainedWithin60m: boolean
  creatorDrainSignature: string | null
  creatorDrainDetectedAtMs: number | null
  creatorDrainRemainingBaseRaw: string | null
  creatorDrainRemainingQuoteRaw: string | null
  completedCompetitionWindow: boolean
  completedRugWindow: boolean
  eligibleForPrimaryMetrics: boolean
  legitimatePool: boolean | null
}

export type PoolObservationState = {
  pool: string
  createSignature: string
  createSlot: number
  createBlockTimeMs: number | null
  anchorTimeMs: number | null
  anchorTimeSource: Exclude<ResolvedTimeSource, 'eventTimestamp'>
  timeAnchorUnavailable: boolean
  baseMint: string
  quoteMint: string
  baseMintDecimals: number
  quoteMintDecimals: number
  creatorSigner: string
  poolCreator: string
  coinCreator: string
  signerAddresses: string[]
  initialBaseReserveRaw: bigint
  initialQuoteReserveRaw: bigint
  initialLiquidityRaw: bigint
  lpTokenAmountOutRaw: bigint
  buyCompetitorWallets5s: Set<string>
  interactingWallets5s: Set<string>
  firstSeenWallets5s: Map<string, WalletFirstSeen>
  competitionInstructionCounts5s: CompetitionInstructionCounts
  competitionInstructionCountsNonCreator5s: CompetitionInstructionCounts
  buyCompetitorWallets10s: Set<string>
  interactingWallets10s: Set<string>
  firstSeenWallets10s: Map<string, WalletFirstSeen>
  competitionInstructionCounts10s: CompetitionInstructionCounts
  competitionInstructionCountsNonCreator10s: CompetitionInstructionCounts
  cyborgAlertTriggered: boolean
  cyborgAlertTriggeredAtMs: number | null
  creatorDrainedWithin60m: boolean
  creatorDrainSignature: string | null
  creatorDrainDetectedAtMs: number | null
  creatorDrainRemainingBaseRaw: bigint | null
  creatorDrainRemainingQuoteRaw: bigint | null
  finalized: boolean
}

export type SummaryMetrics = {
  totalPoolsObserved: number
  poolsWithStrictAnchor: number
  poolsExcludedForMissingAnchor: number
  poolsEligibleForPrimaryMetrics: number
  completedRugWindowPools: number
  pendingRugWindowPools: number
  creatorDrainedWithin60mPools: number
  legitimatePools: number
  creatorDrainRatio: number | null
  cyborgEligiblePools5s: number
  cyborgTriggeredPools5s: number
  avgBuyCompetitorWallets10s: number | null
  medianBuyCompetitorWallets10s: number | null
  maxBuyCompetitorWallets10s: number | null
}

export type CyborgAlert = {
  kind: 'cyborg_candidate'
  observedAtMs: number
  pool: string
  createSignature: string
  createSlot: number
  anchorTimeMs: number
  cyborgAlertWindowMs: number
  creatorSigner: string
  poolCreator: string
  coinCreator: string
  baseMint: string
  quoteMint: string
  buyCompetitorWalletCount5s: number
  buyCompetitorWallets5s: string[]
  interactingWalletCount5s: number
  interactingWallets5s: string[]
  firstSeenWallets5s: WalletFirstSeen[]
  competitionInstructionCounts5s: CompetitionInstructionCounts
  competitionInstructionCountsNonCreator5s: CompetitionInstructionCounts
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

const DEFAULT_RUN_HOURS = 24
const DEFAULT_COMPETITION_WINDOW_MS = 10_000
const DEFAULT_CYBORG_ALERT_WINDOW_MS = 5_000
const DEFAULT_CYBORG_MAX_BUY_COMPETITORS = 0
const DEFAULT_RUG_WINDOW_MS = 60 * 60 * 1000
const DEFAULT_DRAIN_THRESHOLD_PCT = 99
const DEFAULT_MIN_REMAINING_SOL_RAW_STRING = '0.1'
const DEFAULT_HEARTBEAT_MS = 60_000
const DEFAULT_CLEANUP_INTERVAL_MS = 15_000
const DEFAULT_MAX_QUEUE_DEPTH = 10_000
const MAX_SLOT_BLOCK_TIME_CACHE_ENTRIES = 10_000

const PUMP_AMM_EVENT_PARSER = new EventParser(
  PUMP_AMM_PROGRAM_ID,
  new BorshCoder(pumpAmmJson as Idl)
)

const ZERO_COUNTS = (): CompetitionInstructionCounts => ({
  buy: 0,
  sell: 0,
  deposit: 0,
  withdraw: 0,
})

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value || '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function resolvePathFromEnv(value: string | undefined, fallback: string): string {
  if (!value) {
    return path.resolve(process.cwd(), fallback)
  }
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value)
}

export function redactUrlForLog(value: string): string {
  try {
    const url = new URL(value)
    for (const key of url.searchParams.keys()) {
      if (/key|token|secret|password|auth|signature/i.test(key)) {
        url.searchParams.set(key, '[redacted]')
      }
    }
    if (url.username) url.username = '[redacted]'
    if (url.password) url.password = '[redacted]'
    return url.toString()
  } catch {
    return value.replace(/([?&][^=]*(?:key|token|secret|password|auth|signature)[^=]*=)[^&\s]+/gi, '$1[redacted]')
  }
}

function bigintToJson(value: bigint | null): string | null {
  return value === null ? null : value.toString()
}

function toBase58(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof PublicKey) return value.toBase58()
  if (value && typeof value === 'object' && 'toBase58' in value && typeof (value as any).toBase58 === 'function') {
    return (value as any).toBase58()
  }
  if (value && typeof value === 'object' && 'toString' in value && typeof (value as any).toString === 'function') {
    return (value as any).toString()
  }
  return String(value)
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string') return BigInt(value)
  if (value && typeof value === 'object') {
    if ('toString' in value && typeof (value as any).toString === 'function') {
      return BigInt((value as any).toString())
    }
  }
  throw new Error('Unable to coerce value to bigint')
}

function toMillisecondsFromSeconds(value: unknown): number | null {
  if (value == null) return null
  const asNumber = Number(value)
  if (!Number.isFinite(asNumber)) return null
  return Math.trunc(asNumber * 1000)
}

function readEventField(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key]
    }
  }
  return undefined
}

function normalizeInstructionKind(eventName: PumpAmmEventName): NormalizedEventKind {
  switch (eventName) {
    case 'CreatePoolEvent':
      return 'create_pool'
    case 'BuyEvent':
      return 'buy'
    case 'SellEvent':
      return 'sell'
    case 'DepositEvent':
      return 'deposit'
    case 'WithdrawEvent':
      return 'withdraw'
  }
}

function incrementInstructionCount(
  counts: CompetitionInstructionCounts,
  kind: Exclude<NormalizedEventKind, 'create_pool'>
): void {
  counts[kind] += 1
}

function extractSignerAddresses(tx: ParsedTransactionWithMeta | null): string[] {
  const messageKeys = tx?.transaction.message.accountKeys || []
  const signers = messageKeys
    .filter((key: any) => {
      if (typeof key === 'string') return false
      return key.signer === true
    })
    .map((key: any) => {
      const pubkey = key.pubkey
      return typeof pubkey === 'string' ? pubkey : pubkey.toBase58()
    })
  return Array.from(new Set(signers))
}

export function resolveStrictAnchorTimeMs(
  blockTimeSeconds: number | null | undefined,
  slotBlockTimeSeconds: number | null | undefined
): ResolvedEventTime {
  if (typeof blockTimeSeconds === 'number') {
    return { timeMs: Math.trunc(blockTimeSeconds * 1000), source: 'blockTime' }
  }
  if (typeof slotBlockTimeSeconds === 'number') {
    return { timeMs: Math.trunc(slotBlockTimeSeconds * 1000), source: 'slotBlockTime' }
  }
  return { timeMs: null, source: 'unavailable' }
}

export function resolveInteractionTimeMs(
  blockTimeSeconds: number | null | undefined,
  slotBlockTimeSeconds: number | null | undefined,
  eventTimestampMs: number | null
): ResolvedEventTime {
  const strictTime = resolveStrictAnchorTimeMs(blockTimeSeconds, slotBlockTimeSeconds)
  if (strictTime.timeMs !== null) {
    return strictTime
  }
  if (eventTimestampMs !== null) {
    return { timeMs: eventTimestampMs, source: 'eventTimestamp' }
  }
  return { timeMs: null, source: 'unavailable' }
}

export function isEventInWindow(
  anchorTimeMs: number | null,
  eventTimeMs: number | null,
  windowMs: number
): boolean {
  if (anchorTimeMs === null || eventTimeMs === null) return false
  return eventTimeMs >= anchorTimeMs && eventTimeMs < anchorTimeMs + windowMs
}

function decimalToRawUnits(value: string, decimals: number): bigint {
  const [wholePart, fractionalPart = ''] = value.trim().split('.')
  const sanitizedWhole = wholePart === '' ? '0' : wholePart
  const sanitizedFractional = fractionalPart.replace(/[^0-9]/g, '').slice(0, decimals)
  const paddedFractional = sanitizedFractional.padEnd(decimals, '0')
  return BigInt(`${sanitizedWhole}${paddedFractional}`)
}

export function isNearTotalDrain(params: {
  initialBaseReserveRaw: bigint
  initialQuoteReserveRaw: bigint
  remainingBaseReserveRaw: bigint
  remainingQuoteReserveRaw: bigint
  drainThresholdPct: number
  quoteMint: string
  minRemainingSolRawString: string
  quoteMintDecimals: number
}): boolean {
  const drainThresholdBasis = BigInt(Math.max(0, Math.min(100, params.drainThresholdPct)))
  const remainingPctBasis = 100n - drainThresholdBasis

  const baseWithinThreshold = params.initialBaseReserveRaw > 0n &&
    params.remainingBaseReserveRaw * 100n <= params.initialBaseReserveRaw * remainingPctBasis
  const quoteWithinThreshold = params.initialQuoteReserveRaw > 0n &&
    params.remainingQuoteReserveRaw * 100n <= params.initialQuoteReserveRaw * remainingPctBasis

  const isWsolQuote = params.quoteMint === 'So11111111111111111111111111111111111111112'
  const remainingQuoteBelowSolFloor = isWsolQuote &&
    params.remainingQuoteReserveRaw <= decimalToRawUnits(
      params.minRemainingSolRawString,
      params.quoteMintDecimals
    )

  return (baseWithinThreshold && quoteWithinThreshold) || remainingQuoteBelowSolFloor
}

export function resolvePumpSwapMetaObserverConfig(
  env: NodeJS.ProcessEnv = process.env
): PumpSwapMetaObserverConfig {
  const rpcUrl = getPrimaryRpcUrl(env)
  if (!rpcUrl) {
    throw new Error('Set RPC_URL or RPC_URLS before starting the PumpSwap meta observer.')
  }

  return {
    rpcUrl,
    wsUrl: (env.WSS_URL || '').trim() || null,
    outputDir: resolvePathFromEnv(env.PUMPSWAP_META_OUTPUT_DIR, 'data/meta-observer'),
    logDir: resolvePathFromEnv(env.PUMPSWAP_META_LOG_DIR, 'logs/meta-observer'),
    runHours: parsePositiveFloat(env.PUMPSWAP_META_RUN_HOURS, DEFAULT_RUN_HOURS),
    competitionWindowMs: parsePositiveInt(env.PUMPSWAP_META_COMPETITION_WINDOW_MS, DEFAULT_COMPETITION_WINDOW_MS),
    cyborgAlertWindowMs: parsePositiveInt(env.PUMPSWAP_CYBORG_ALERT_WINDOW_MS, DEFAULT_CYBORG_ALERT_WINDOW_MS),
    cyborgMaxBuyCompetitors: parseNonNegativeInt(
      env.PUMPSWAP_CYBORG_MAX_BUY_COMPETITORS,
      DEFAULT_CYBORG_MAX_BUY_COMPETITORS
    ),
    rugWindowMs: parsePositiveInt(env.PUMPSWAP_META_RUG_WINDOW_MS, DEFAULT_RUG_WINDOW_MS),
    drainThresholdPct: parsePositiveInt(env.PUMPSWAP_META_DRAIN_THRESHOLD_PCT, DEFAULT_DRAIN_THRESHOLD_PCT),
    minRemainingSolRawString: (env.PUMPSWAP_META_MIN_REMAINING_SOL || DEFAULT_MIN_REMAINING_SOL_RAW_STRING).trim(),
    heartbeatMs: parsePositiveInt(env.PUMPSWAP_META_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS),
    cleanupIntervalMs: parsePositiveInt(env.PUMPSWAP_META_CLEANUP_INTERVAL_MS, DEFAULT_CLEANUP_INTERVAL_MS),
    maxQueueDepth: parsePositiveInt(env.PUMPSWAP_META_MAX_QUEUE_DEPTH, DEFAULT_MAX_QUEUE_DEPTH),
  }
}

export function extractTrackedPumpAmmEvents(logs: string[]): PumpAmmDecodedEvent[] {
  let decoded: ReturnType<typeof PUMP_AMM_EVENT_PARSER.parseLogs> extends Iterable<infer T> ? T[] : never[]
  try {
    decoded = Array.from(PUMP_AMM_EVENT_PARSER.parseLogs(logs)) as typeof decoded
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('Expected the stack to have elements')) {
      return []
    }
    throw error
  }
  const results: PumpAmmDecodedEvent[] = []

  for (const event of decoded) {
    const name = event.name as PumpAmmEventName
    const data = event.data as Record<string, unknown>
    if (
      name !== 'CreatePoolEvent' &&
      name !== 'BuyEvent' &&
      name !== 'SellEvent' &&
      name !== 'DepositEvent' &&
      name !== 'WithdrawEvent'
    ) {
      continue
    }

    if (name === 'CreatePoolEvent') {
      results.push({
        name,
        data: {
          kind: 'create_pool',
          pool: toBase58(readEventField(data, 'pool')),
          creator: toBase58(readEventField(data, 'creator')),
          coinCreator: toBase58(readEventField(data, 'coinCreator', 'coin_creator')),
          baseMint: toBase58(readEventField(data, 'baseMint', 'base_mint')),
          quoteMint: toBase58(readEventField(data, 'quoteMint', 'quote_mint')),
          baseMintDecimals: Number(readEventField(data, 'baseMintDecimals', 'base_mint_decimals')),
          quoteMintDecimals: Number(readEventField(data, 'quoteMintDecimals', 'quote_mint_decimals')),
          initialBaseReserveRaw: toBigInt(readEventField(data, 'poolBaseAmount', 'pool_base_amount')),
          initialQuoteReserveRaw: toBigInt(readEventField(data, 'poolQuoteAmount', 'pool_quote_amount')),
          initialLiquidityRaw: toBigInt(readEventField(data, 'initialLiquidity', 'initial_liquidity')),
          lpTokenAmountOutRaw: toBigInt(readEventField(data, 'lpTokenAmountOut', 'lp_token_amount_out')),
          eventTimestampMs: toMillisecondsFromSeconds(readEventField(data, 'timestamp')),
        },
      })
      continue
    }

    results.push({
      name,
      data: {
        kind: normalizeInstructionKind(name) as Exclude<NormalizedEventKind, 'create_pool'>,
        pool: toBase58(readEventField(data, 'pool')),
        user: toBase58(readEventField(data, 'user')),
        eventTimestampMs: toMillisecondsFromSeconds(readEventField(data, 'timestamp')),
        poolBaseReserveRaw: toBigInt(readEventField(data, 'poolBaseTokenReserves', 'pool_base_token_reserves')),
        poolQuoteReserveRaw: toBigInt(readEventField(data, 'poolQuoteTokenReserves', 'pool_quote_token_reserves')),
      },
    })
  }

  return results
}

export function createPoolObservation(params: {
  event: NormalizedCreatePoolEvent
  signature: string
  slot: number
  createBlockTimeMs: number | null
  anchorTime: ResolvedEventTime
  signerAddresses: string[]
}): PoolObservationState {
  return {
    pool: params.event.pool,
    createSignature: params.signature,
    createSlot: params.slot,
    createBlockTimeMs: params.createBlockTimeMs,
    anchorTimeMs: params.anchorTime.timeMs,
    anchorTimeSource:
      params.anchorTime.source === 'blockTime' || params.anchorTime.source === 'slotBlockTime'
        ? params.anchorTime.source
        : 'unavailable',
    timeAnchorUnavailable: params.anchorTime.timeMs === null,
    baseMint: params.event.baseMint,
    quoteMint: params.event.quoteMint,
    baseMintDecimals: params.event.baseMintDecimals,
    quoteMintDecimals: params.event.quoteMintDecimals,
    creatorSigner: params.event.creator,
    poolCreator: params.event.creator,
    coinCreator: params.event.coinCreator,
    signerAddresses: params.signerAddresses,
    initialBaseReserveRaw: params.event.initialBaseReserveRaw,
    initialQuoteReserveRaw: params.event.initialQuoteReserveRaw,
    initialLiquidityRaw: params.event.initialLiquidityRaw,
    lpTokenAmountOutRaw: params.event.lpTokenAmountOutRaw,
    buyCompetitorWallets5s: new Set<string>(),
    interactingWallets5s: new Set<string>(),
    firstSeenWallets5s: new Map<string, WalletFirstSeen>(),
    competitionInstructionCounts5s: ZERO_COUNTS(),
    competitionInstructionCountsNonCreator5s: ZERO_COUNTS(),
    buyCompetitorWallets10s: new Set<string>(),
    interactingWallets10s: new Set<string>(),
    firstSeenWallets10s: new Map<string, WalletFirstSeen>(),
    competitionInstructionCounts10s: ZERO_COUNTS(),
    competitionInstructionCountsNonCreator10s: ZERO_COUNTS(),
    cyborgAlertTriggered: false,
    cyborgAlertTriggeredAtMs: null,
    creatorDrainedWithin60m: false,
    creatorDrainSignature: null,
    creatorDrainDetectedAtMs: null,
    creatorDrainRemainingBaseRaw: null,
    creatorDrainRemainingQuoteRaw: null,
    finalized: false,
  }
}

export function applyInteractionEvent(
  pool: PoolObservationState,
  event: NormalizedInteractionEvent,
  resolvedTime: ResolvedEventTime,
  signature: string,
  config: Pick<PumpSwapMetaObserverConfig, 'competitionWindowMs' | 'cyborgAlertWindowMs' | 'rugWindowMs' | 'drainThresholdPct' | 'minRemainingSolRawString'>
): { withinCompetitionWindow: boolean; withinRugWindow: boolean } {
  const withinCyborgWindow = isEventInWindow(
    pool.anchorTimeMs,
    resolvedTime.timeMs,
    config.cyborgAlertWindowMs
  )
  const withinCompetitionWindow = isEventInWindow(
    pool.anchorTimeMs,
    resolvedTime.timeMs,
    config.competitionWindowMs
  )
  const withinRugWindow = isEventInWindow(
    pool.anchorTimeMs,
    resolvedTime.timeMs,
    config.rugWindowMs
  )

  if (withinCompetitionWindow || withinCyborgWindow) {
    if (withinCompetitionWindow) {
      incrementInstructionCount(pool.competitionInstructionCounts10s, event.kind)
    }
    if (withinCyborgWindow) {
      incrementInstructionCount(pool.competitionInstructionCounts5s, event.kind)
    }

    if (event.user !== pool.creatorSigner) {
      if (withinCompetitionWindow) {
        incrementInstructionCount(pool.competitionInstructionCountsNonCreator10s, event.kind)
        pool.interactingWallets10s.add(event.user)
      }
      if (withinCyborgWindow) {
        incrementInstructionCount(pool.competitionInstructionCountsNonCreator5s, event.kind)
        pool.interactingWallets5s.add(event.user)
      }

      const existing = pool.firstSeenWallets10s.get(event.user)
      if (!existing || ((resolvedTime.timeMs ?? Number.MAX_SAFE_INTEGER) < (existing.firstSeenAtMs ?? Number.MAX_SAFE_INTEGER))) {
        if (withinCompetitionWindow) {
          pool.firstSeenWallets10s.set(event.user, {
            wallet: event.user,
            firstSeenAtMs: resolvedTime.timeMs,
            firstInstruction: event.kind,
          })
        }
      }
      const existing5s = pool.firstSeenWallets5s.get(event.user)
      if (
        withinCyborgWindow &&
        (!existing5s || ((resolvedTime.timeMs ?? Number.MAX_SAFE_INTEGER) < (existing5s.firstSeenAtMs ?? Number.MAX_SAFE_INTEGER)))
      ) {
        pool.firstSeenWallets5s.set(event.user, {
          wallet: event.user,
          firstSeenAtMs: resolvedTime.timeMs,
          firstInstruction: event.kind,
        })
      }
      if (withinCompetitionWindow && event.kind === 'buy') {
        pool.buyCompetitorWallets10s.add(event.user)
      }
      if (withinCyborgWindow && event.kind === 'buy') {
        pool.buyCompetitorWallets5s.add(event.user)
      }
    }
  }

  if (
    event.kind === 'withdraw' &&
    withinRugWindow &&
    event.user === pool.creatorSigner &&
    !pool.creatorDrainedWithin60m &&
    isNearTotalDrain({
      initialBaseReserveRaw: pool.initialBaseReserveRaw,
      initialQuoteReserveRaw: pool.initialQuoteReserveRaw,
      remainingBaseReserveRaw: event.poolBaseReserveRaw,
      remainingQuoteReserveRaw: event.poolQuoteReserveRaw,
      drainThresholdPct: config.drainThresholdPct,
      quoteMint: pool.quoteMint,
      minRemainingSolRawString: config.minRemainingSolRawString,
      quoteMintDecimals: pool.quoteMintDecimals,
    })
  ) {
    pool.creatorDrainedWithin60m = true
    pool.creatorDrainSignature = signature
    pool.creatorDrainDetectedAtMs = resolvedTime.timeMs
    pool.creatorDrainRemainingBaseRaw = event.poolBaseReserveRaw
    pool.creatorDrainRemainingQuoteRaw = event.poolQuoteReserveRaw
  }

  return { withinCompetitionWindow, withinRugWindow }
}

export function summarizePoolObservation(
  pool: PoolObservationState,
  nowMs: number,
  config: Pick<PumpSwapMetaObserverConfig, 'competitionWindowMs' | 'cyborgAlertWindowMs' | 'rugWindowMs'>
): PoolSummary {
  const cyborgEligibleAt5s = pool.anchorTimeMs !== null
    ? nowMs >= pool.anchorTimeMs + config.cyborgAlertWindowMs
    : false
  const completedCompetitionWindow = pool.anchorTimeMs !== null
    ? nowMs >= pool.anchorTimeMs + config.competitionWindowMs
    : false
  const completedRugWindow = pool.anchorTimeMs !== null
    ? nowMs >= pool.anchorTimeMs + config.rugWindowMs
    : false
  const eligibleForPrimaryMetrics = pool.anchorTimeMs !== null
  const legitimatePool = completedRugWindow
    ? !pool.creatorDrainedWithin60m
    : null

  return {
    pool: pool.pool,
    createSignature: pool.createSignature,
    createSlot: pool.createSlot,
    createBlockTimeMs: pool.createBlockTimeMs,
    anchorTimeMs: pool.anchorTimeMs,
    anchorTimeSource: pool.anchorTimeSource,
    timeAnchorUnavailable: pool.timeAnchorUnavailable,
    baseMint: pool.baseMint,
    quoteMint: pool.quoteMint,
    baseMintDecimals: pool.baseMintDecimals,
    quoteMintDecimals: pool.quoteMintDecimals,
    creatorSigner: pool.creatorSigner,
    poolCreator: pool.poolCreator,
    coinCreator: pool.coinCreator,
    signerAddresses: [...pool.signerAddresses],
    initialBaseReserveRaw: pool.initialBaseReserveRaw.toString(),
    initialQuoteReserveRaw: pool.initialQuoteReserveRaw.toString(),
    initialLiquidityRaw: pool.initialLiquidityRaw.toString(),
    lpTokenAmountOutRaw: pool.lpTokenAmountOutRaw.toString(),
    buyCompetitorWalletCount5s: pool.buyCompetitorWallets5s.size,
    buyCompetitorWallets5s: [...pool.buyCompetitorWallets5s].sort(),
    interactingWalletCount5s: pool.interactingWallets5s.size,
    interactingWallets5s: [...pool.interactingWallets5s].sort(),
    firstSeenWallets5s: [...pool.firstSeenWallets5s.values()].sort((a, b) => {
      const left = a.firstSeenAtMs ?? Number.MAX_SAFE_INTEGER
      const right = b.firstSeenAtMs ?? Number.MAX_SAFE_INTEGER
      return left - right || a.wallet.localeCompare(b.wallet)
    }),
    competitionInstructionCounts5s: { ...pool.competitionInstructionCounts5s },
    competitionInstructionCountsNonCreator5s: { ...pool.competitionInstructionCountsNonCreator5s },
    cyborgAlertWindowMs: config.cyborgAlertWindowMs,
    cyborgEligibleAt5s,
    cyborgAlertTriggered: pool.cyborgAlertTriggered,
    cyborgAlertTriggeredAtMs: pool.cyborgAlertTriggeredAtMs,
    buyCompetitorWalletCount10s: pool.buyCompetitorWallets10s.size,
    buyCompetitorWallets10s: [...pool.buyCompetitorWallets10s].sort(),
    interactingWalletCount10s: pool.interactingWallets10s.size,
    interactingWallets10s: [...pool.interactingWallets10s].sort(),
    firstSeenWallets10s: [...pool.firstSeenWallets10s.values()].sort((a, b) => {
      const left = a.firstSeenAtMs ?? Number.MAX_SAFE_INTEGER
      const right = b.firstSeenAtMs ?? Number.MAX_SAFE_INTEGER
      return left - right || a.wallet.localeCompare(b.wallet)
    }),
    competitionInstructionCounts10s: { ...pool.competitionInstructionCounts10s },
    competitionInstructionCountsNonCreator10s: { ...pool.competitionInstructionCountsNonCreator10s },
    creatorDrainedWithin60m: pool.creatorDrainedWithin60m,
    creatorDrainSignature: pool.creatorDrainSignature,
    creatorDrainDetectedAtMs: pool.creatorDrainDetectedAtMs,
    creatorDrainRemainingBaseRaw: bigintToJson(pool.creatorDrainRemainingBaseRaw),
    creatorDrainRemainingQuoteRaw: bigintToJson(pool.creatorDrainRemainingQuoteRaw),
    completedCompetitionWindow,
    completedRugWindow,
    eligibleForPrimaryMetrics,
    legitimatePool,
  }
}

export function buildSummaryMetrics(pools: PoolSummary[]): SummaryMetrics {
  const eligiblePools = pools.filter((pool) => pool.eligibleForPrimaryMetrics)
  const cyborgEligiblePools = eligiblePools.filter((pool) => pool.cyborgEligibleAt5s)
  const cyborgTriggeredPools = cyborgEligiblePools.filter((pool) => pool.cyborgAlertTriggered)
  const completedRugWindowPools = eligiblePools.filter((pool) => pool.completedRugWindow)
  const creatorDrainedWithin60mPools = completedRugWindowPools.filter((pool) => pool.creatorDrainedWithin60m)
  const legitimatePools = completedRugWindowPools.filter((pool) => pool.legitimatePool === true)
  const competitionCounts = eligiblePools.map((pool) => pool.buyCompetitorWalletCount10s).sort((a, b) => a - b)

  const medianBuyCompetitorWallets10s = competitionCounts.length === 0
    ? null
    : competitionCounts[Math.floor(competitionCounts.length / 2)]

  const avgBuyCompetitorWallets10s = competitionCounts.length === 0
    ? null
    : competitionCounts.reduce((sum, value) => sum + value, 0) / competitionCounts.length

  return {
    totalPoolsObserved: pools.length,
    poolsWithStrictAnchor: eligiblePools.length,
    poolsExcludedForMissingAnchor: pools.filter((pool) => pool.timeAnchorUnavailable).length,
    poolsEligibleForPrimaryMetrics: eligiblePools.length,
    completedRugWindowPools: completedRugWindowPools.length,
    pendingRugWindowPools: eligiblePools.filter((pool) => !pool.completedRugWindow).length,
    creatorDrainedWithin60mPools: creatorDrainedWithin60mPools.length,
    legitimatePools: legitimatePools.length,
    creatorDrainRatio: completedRugWindowPools.length === 0
      ? null
      : creatorDrainedWithin60mPools.length / completedRugWindowPools.length,
    cyborgEligiblePools5s: cyborgEligiblePools.length,
    cyborgTriggeredPools5s: cyborgTriggeredPools.length,
    avgBuyCompetitorWallets10s,
    medianBuyCompetitorWallets10s,
    maxBuyCompetitorWallets10s: competitionCounts.length === 0 ? null : competitionCounts[competitionCounts.length - 1],
  }
}

export function shouldTriggerCyborgAlert(
  pool: PoolObservationState,
  nowMs: number,
  config: Pick<PumpSwapMetaObserverConfig, 'cyborgAlertWindowMs' | 'cyborgMaxBuyCompetitors'>
): boolean {
  if (pool.cyborgAlertTriggered) return false
  if (pool.anchorTimeMs === null) return false
  if (nowMs < pool.anchorTimeMs + config.cyborgAlertWindowMs) return false
  return pool.buyCompetitorWallets5s.size <= config.cyborgMaxBuyCompetitors
}

export function buildCyborgAlert(
  pool: PoolObservationState,
  observedAtMs: number,
  config: Pick<PumpSwapMetaObserverConfig, 'cyborgAlertWindowMs'>
): CyborgAlert {
  return {
    kind: 'cyborg_candidate',
    observedAtMs,
    pool: pool.pool,
    createSignature: pool.createSignature,
    createSlot: pool.createSlot,
    anchorTimeMs: pool.anchorTimeMs as number,
    cyborgAlertWindowMs: config.cyborgAlertWindowMs,
    creatorSigner: pool.creatorSigner,
    poolCreator: pool.poolCreator,
    coinCreator: pool.coinCreator,
    baseMint: pool.baseMint,
    quoteMint: pool.quoteMint,
    buyCompetitorWalletCount5s: pool.buyCompetitorWallets5s.size,
    buyCompetitorWallets5s: [...pool.buyCompetitorWallets5s].sort(),
    interactingWalletCount5s: pool.interactingWallets5s.size,
    interactingWallets5s: [...pool.interactingWallets5s].sort(),
    firstSeenWallets5s: [...pool.firstSeenWallets5s.values()].sort((a, b) => {
      const left = a.firstSeenAtMs ?? Number.MAX_SAFE_INTEGER
      const right = b.firstSeenAtMs ?? Number.MAX_SAFE_INTEGER
      return left - right || a.wallet.localeCompare(b.wallet)
    }),
    competitionInstructionCounts5s: { ...pool.competitionInstructionCounts5s },
    competitionInstructionCountsNonCreator5s: { ...pool.competitionInstructionCountsNonCreator5s },
  }
}

function buildSummaryMarkdown(config: PumpSwapMetaObserverConfig, metrics: SummaryMetrics, pools: PoolSummary[]): string {
  const topCompetitionPools = [...pools]
    .sort((left, right) => right.buyCompetitorWalletCount10s - left.buyCompetitorWalletCount10s)
    .slice(0, 10)

  const lines = [
    '# PumpSwap Meta Observer Summary',
    '',
    `- Run hours configured: ${config.runHours}`,
    `- Competition window: ${config.competitionWindowMs} ms`,
    `- Cyborg alert window: ${config.cyborgAlertWindowMs} ms`,
    `- Rug window: ${config.rugWindowMs} ms`,
    `- Pools observed: ${metrics.totalPoolsObserved}`,
    `- Pools eligible for primary metrics: ${metrics.poolsEligibleForPrimaryMetrics}`,
    `- Pools excluded for missing anchor: ${metrics.poolsExcludedForMissingAnchor}`,
    `- Completed rug windows: ${metrics.completedRugWindowPools}`,
    `- Pending rug windows: ${metrics.pendingRugWindowPools}`,
    `- Creator drained within 60m: ${metrics.creatorDrainedWithin60mPools}`,
    `- Legitimate pools: ${metrics.legitimatePools}`,
    `- Creator drain ratio: ${metrics.creatorDrainRatio === null ? 'n/a' : metrics.creatorDrainRatio.toFixed(4)}`,
    `- Cyborg-eligible pools at 5s: ${metrics.cyborgEligiblePools5s}`,
    `- Cyborg-triggered pools at 5s: ${metrics.cyborgTriggeredPools5s}`,
    `- Avg buy competitors in first 10s: ${metrics.avgBuyCompetitorWallets10s === null ? 'n/a' : metrics.avgBuyCompetitorWallets10s.toFixed(2)}`,
    `- Median buy competitors in first 10s: ${metrics.medianBuyCompetitorWallets10s === null ? 'n/a' : String(metrics.medianBuyCompetitorWallets10s)}`,
    `- Max buy competitors in first 10s: ${metrics.maxBuyCompetitorWallets10s === null ? 'n/a' : String(metrics.maxBuyCompetitorWallets10s)}`,
    '',
    '## Top Competition Pools',
    '',
  ]

  if (topCompetitionPools.length === 0) {
    lines.push('- none')
  } else {
    for (const pool of topCompetitionPools) {
      lines.push(
        `- ${pool.pool}: ${pool.buyCompetitorWalletCount10s} buy competitors, creator_drained=${pool.creatorDrainedWithin60m}`
      )
    }
  }

  return lines.join('\n')
}

function writeJsonLine(stream: fs.WriteStream, value: JsonValue): void {
  stream.write(JSON.stringify(value) + '\n')
}

type LogsNotification = {
  signature: string
  logs: string[]
  err: unknown
}

export class PumpSwapMetaObserver {
  private readonly config: PumpSwapMetaObserverConfig
  private readonly connection
  private readonly startedAtMs = Date.now()
  private readonly cutoffAtMs: number
  private readonly outputTimestamp: string
  private readonly eventsStream: fs.WriteStream
  private readonly poolsStream: fs.WriteStream
  private readonly cyborgAlertsStream: fs.WriteStream
  private readonly cyborgAlertsLiveStream: fs.WriteStream
  private readonly eventsPath: string
  private readonly poolsPath: string
  private readonly cyborgAlertsPath: string
  private readonly cyborgAlertsLivePath: string
  private readonly summaryJsonPath: string
  private readonly summaryMarkdownPath: string
  private readonly latestJsonPath: string
  private readonly latestMarkdownPath: string
  private readonly pools = new Map<string, PoolObservationState>()
  private readonly finalizedPools: PoolSummary[] = []
  private readonly slotBlockTimeCache = new Map<number, number | null>()
  private queue: Promise<void> = Promise.resolve()
  private pendingLogBatches = 0
  private peakQueueDepth = 0
  private queueOverflowed = false
  private shutdownScheduled = false
  private logsSubscriptionId: number | null = null
  private heartbeatHandle: NodeJS.Timeout | null = null
  private cleanupHandle: NodeJS.Timeout | null = null
  private shuttingDown = false
  private ingestClosed = false
  private resolveDone: (() => void) | null = null
  private rejectDone: ((error: unknown) => void) | null = null

  constructor(config: PumpSwapMetaObserverConfig) {
    this.config = config
    this.cutoffAtMs = this.startedAtMs + Math.round(config.runHours * 60 * 60 * 1000)

    fs.mkdirSync(config.outputDir, { recursive: true })
    fs.mkdirSync(config.logDir, { recursive: true })

    this.outputTimestamp = new Date(this.startedAtMs).toISOString().replace(/[:.]/g, '-')
    this.eventsPath = path.join(config.outputDir, `events-${this.outputTimestamp}.jsonl`)
    this.poolsPath = path.join(config.outputDir, `pools-${this.outputTimestamp}.jsonl`)
    this.cyborgAlertsPath = path.join(config.outputDir, `cyborg-alerts-${this.outputTimestamp}.jsonl`)
    this.cyborgAlertsLivePath = path.join(config.outputDir, 'cyborg-alerts.live.jsonl')
    this.summaryJsonPath = path.join(config.outputDir, `summary-${this.outputTimestamp}.json`)
    this.summaryMarkdownPath = path.join(config.outputDir, `summary-${this.outputTimestamp}.md`)
    this.latestJsonPath = path.join(config.outputDir, 'latest.json')
    this.latestMarkdownPath = path.join(config.outputDir, 'latest.md')
    this.eventsStream = fs.createWriteStream(this.eventsPath, { flags: 'a' })
    this.poolsStream = fs.createWriteStream(this.poolsPath, { flags: 'a' })
    fs.writeFileSync(this.cyborgAlertsLivePath, '')
    this.cyborgAlertsStream = fs.createWriteStream(this.cyborgAlertsPath, { flags: 'a' })
    this.cyborgAlertsLiveStream = fs.createWriteStream(this.cyborgAlertsLivePath, { flags: 'a' })

    this.connection = config.wsUrl
      ? createSolanaConnection(config.rpcUrl, 'confirmed', { wsEndpoint: config.wsUrl })
      : createSolanaConnection(config.rpcUrl, 'confirmed')
  }

  public async run(): Promise<void> {
    console.log('[MetaObserver] Starting PumpSwap meta observer')
    console.log('[MetaObserver] RPC:', redactUrlForLog(this.config.rpcUrl))
    if (this.config.wsUrl) {
      console.log('[MetaObserver] WSS:', redactUrlForLog(this.config.wsUrl))
    }
    console.log('[MetaObserver] Output dir:', this.config.outputDir)
    console.log('[MetaObserver] Collection cutoff:', new Date(this.cutoffAtMs).toISOString())
    console.log('[MetaObserver] Cyborg alert window:', this.config.cyborgAlertWindowMs, 'ms')

    this.heartbeatHandle = setInterval(() => {
      this.printHeartbeat()
    }, this.config.heartbeatMs)

    this.cleanupHandle = setInterval(() => {
      void this.flushMaturePools()
    }, this.config.cleanupIntervalMs)

    this.logsSubscriptionId = this.connection.onLogs(
      PUMP_AMM_PROGRAM_ID,
      (logs: LogsNotification, ctx: { slot: number }) => {
        if (this.shuttingDown || logs.err) return

        let decodedEvents: PumpAmmDecodedEvent[]
        try {
          decodedEvents = extractTrackedPumpAmmEvents(logs.logs || [])
        } catch (error) {
          console.error('[MetaObserver] log decode error:', error)
          return
        }
        if (decodedEvents.length === 0) return

        if (this.pendingLogBatches >= this.config.maxQueueDepth) {
          if (!this.queueOverflowed) {
            this.queueOverflowed = true
            console.error(
              '[MetaObserver] queue overflow at depth=' +
              this.pendingLogBatches +
              '; stopping this evidence window before data loss or OOM.'
            )
            this.scheduleShutdown('queue_overflow')
          }
          return
        }

        this.pendingLogBatches += 1
        this.peakQueueDepth = Math.max(this.peakQueueDepth, this.pendingLogBatches)
        this.queue = this.queue
          .then(() => this.handleDecodedEvents(decodedEvents, logs.signature, ctx.slot))
          .catch((error) => {
            console.error('[MetaObserver] log handler error:', error)
          })
          .finally(() => {
            this.pendingLogBatches = Math.max(0, this.pendingLogBatches - 1)
          })
      },
      'confirmed'
    )

    process.on('SIGINT', () => {
      void this.shutdown('SIGINT')
    })
    process.on('SIGTERM', () => {
      void this.shutdown('SIGTERM')
    })

    await new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve
      this.rejectDone = reject
    })
  }

  private async handleDecodedEvents(
    decodedEvents: PumpAmmDecodedEvent[],
    signature: string,
    slot: number
  ): Promise<void> {
    if (this.shuttingDown) return

    if (Date.now() >= this.cutoffAtMs) {
      this.ingestClosed = true
    }

    for (const event of decodedEvents) {
      if (event.name === 'CreatePoolEvent') {
        if (this.ingestClosed) {
          continue
        }
        await this.handleCreatePoolEvent(event.data, signature, slot)
        continue
      }

      await this.handleInteractionEvent(event.data, signature, slot)
    }

    this.flushCyborgAlerts(Date.now())
    await this.flushMaturePools()
  }

  private async handleCreatePoolEvent(
    event: NormalizedCreatePoolEvent,
    signature: string,
    slot: number
  ): Promise<void> {
    const tx = await this.fetchParsedTransaction(signature)
    const signerAddresses = extractSignerAddresses(tx)
    const slotBlockTimeSeconds = await this.getSlotBlockTimeSeconds(slot)
    const anchorTime = resolveStrictAnchorTimeMs(tx?.blockTime ?? null, slotBlockTimeSeconds)
    const pool = createPoolObservation({
      event,
      signature,
      slot,
      createBlockTimeMs: toMillisecondsFromSeconds(tx?.blockTime ?? null),
      anchorTime,
      signerAddresses,
    })
    this.pools.set(pool.pool, pool)

    writeJsonLine(this.eventsStream, {
      kind: event.kind,
      signature,
      slot,
      pool: event.pool,
      creator: event.creator,
      coinCreator: event.coinCreator,
      baseMint: event.baseMint,
      quoteMint: event.quoteMint,
      eventTimestampMs: event.eventTimestampMs,
      createBlockTimeMs: pool.createBlockTimeMs,
      anchorTimeMs: pool.anchorTimeMs,
      anchorTimeSource: pool.anchorTimeSource,
      timeAnchorUnavailable: pool.timeAnchorUnavailable,
      signerAddresses,
      initialBaseReserveRaw: event.initialBaseReserveRaw.toString(),
      initialQuoteReserveRaw: event.initialQuoteReserveRaw.toString(),
      initialLiquidityRaw: event.initialLiquidityRaw.toString(),
      lpTokenAmountOutRaw: event.lpTokenAmountOutRaw.toString(),
    })

    if (pool.timeAnchorUnavailable) {
      this.finalizePool(pool, Date.now())
      return
    }

    this.flushCyborgAlerts(Date.now())
  }

  private async handleInteractionEvent(
    event: NormalizedInteractionEvent,
    signature: string,
    slot: number
  ): Promise<void> {
    const pool = this.pools.get(event.pool)
    if (!pool || pool.finalized) {
      return
    }

    let resolvedTime = resolveInteractionTimeMs(null, null, event.eventTimestampMs)
    if (resolvedTime.timeMs === null) {
      const slotBlockTimeSeconds = await this.getSlotBlockTimeSeconds(slot)
      resolvedTime = resolveInteractionTimeMs(null, slotBlockTimeSeconds, null)
    }
    const windowState = applyInteractionEvent(pool, event, resolvedTime, signature, this.config)

    writeJsonLine(this.eventsStream, {
      kind: event.kind,
      signature,
      slot,
      pool: event.pool,
      user: event.user,
      eventTimestampMs: event.eventTimestampMs,
      resolvedTimeMs: resolvedTime.timeMs,
      resolvedTimeSource: resolvedTime.source,
      withinCompetitionWindow: windowState.withinCompetitionWindow,
      withinRugWindow: windowState.withinRugWindow,
      poolBaseReserveRaw: event.poolBaseReserveRaw.toString(),
      poolQuoteReserveRaw: event.poolQuoteReserveRaw.toString(),
      creatorSigner: pool.creatorSigner,
    })
  }

  private async fetchParsedTransaction(signature: string): Promise<ParsedTransactionWithMeta | null> {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
      }

      try {
        const tx = await this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        })
        if (tx) {
          return tx
        }
      } catch (_) {}
    }

    return null
  }

  private async getSlotBlockTimeSeconds(slot: number): Promise<number | null> {
    if (this.slotBlockTimeCache.has(slot)) {
      return this.slotBlockTimeCache.get(slot) ?? null
    }

    try {
      const blockTime = await this.connection.getBlockTime(slot)
      this.slotBlockTimeCache.set(slot, blockTime)
      this.pruneSlotBlockTimeCache()
      return blockTime
    } catch (_) {
      this.slotBlockTimeCache.set(slot, null)
      this.pruneSlotBlockTimeCache()
      return null
    }
  }

  private pruneSlotBlockTimeCache(): void {
    while (this.slotBlockTimeCache.size > MAX_SLOT_BLOCK_TIME_CACHE_ENTRIES) {
      const oldest = this.slotBlockTimeCache.keys().next().value as number | undefined
      if (oldest === undefined) return
      this.slotBlockTimeCache.delete(oldest)
    }
  }

  private async flushMaturePools(): Promise<void> {
    const nowMs = Date.now()
    this.flushCyborgAlerts(nowMs)
    const finalized: PoolObservationState[] = []

    for (const pool of this.pools.values()) {
      if (pool.finalized) continue
      if (pool.anchorTimeMs === null || nowMs >= pool.anchorTimeMs + this.config.rugWindowMs) {
        finalized.push(pool)
      }
    }

    for (const pool of finalized) {
      this.finalizePool(pool, nowMs)
    }

    if (Date.now() >= this.cutoffAtMs) {
      this.ingestClosed = true
    }

    if (this.ingestClosed && this.pools.size === 0) {
      this.scheduleShutdown('completed')
    }
  }

  private scheduleShutdown(reason: string): void {
    if (this.shuttingDown || this.shutdownScheduled) return
    this.shutdownScheduled = true
    setImmediate(() => {
      this.shutdownScheduled = false
      void this.shutdown(reason).catch((error) => {
        console.error('[MetaObserver] shutdown error:', error)
        this.rejectDone?.(error)
      })
    })
  }

  private finalizePool(pool: PoolObservationState, nowMs: number): void {
    if (pool.finalized) return
    pool.finalized = true

    const summary = summarizePoolObservation(pool, nowMs, this.config)
    this.finalizedPools.push(summary)
    writeJsonLine(this.poolsStream, summary as unknown as JsonValue)
    this.pools.delete(pool.pool)
  }

  private flushCyborgAlerts(nowMs: number): void {
    for (const pool of this.pools.values()) {
      if (!shouldTriggerCyborgAlert(pool, nowMs, this.config)) {
        continue
      }
      this.emitCyborgAlert(pool, nowMs)
    }
  }

  private emitCyborgAlert(pool: PoolObservationState, nowMs: number): void {
    pool.cyborgAlertTriggered = true
    pool.cyborgAlertTriggeredAtMs = nowMs

    const alert = buildCyborgAlert(pool, nowMs, this.config)
    writeJsonLine(this.cyborgAlertsStream, alert as unknown as JsonValue)
    writeJsonLine(this.cyborgAlertsLiveStream, alert as unknown as JsonValue)

    console.log(
      '[Cyborg] zero-buy-competitor pool=' +
      alert.pool +
      ' creator=' +
      alert.creatorSigner +
      ' interactions5s=' +
      alert.interactingWalletCount5s +
      ' windowMs=' +
      alert.cyborgAlertWindowMs
    )
  }

  private printHeartbeat(): void {
    console.log(
      '[MetaObserver] heartbeat pools=' +
      (this.pools.size + this.finalizedPools.length) +
      ' active=' +
      this.pools.size +
      ' finalized=' +
      this.finalizedPools.length +
      ' queue=' +
      this.pendingLogBatches +
      ' queuePeak=' +
      this.peakQueueDepth +
      ' ingestClosed=' +
      this.ingestClosed
    )
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true

    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle)
      this.heartbeatHandle = null
    }
    if (this.cleanupHandle) {
      clearInterval(this.cleanupHandle)
      this.cleanupHandle = null
    }
    if (this.logsSubscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.logsSubscriptionId)
      } catch (_) {}
      this.logsSubscriptionId = null
    }

    await this.queue

    const nowMs = Date.now()
    for (const pool of this.pools.values()) {
      if (!pool.finalized) {
        this.finalizePool(pool, nowMs)
      }
    }

    await new Promise<void>((resolve) => {
      this.eventsStream.end(() => resolve())
    })
    await new Promise<void>((resolve) => {
      this.poolsStream.end(() => resolve())
    })
    await new Promise<void>((resolve) => {
      this.cyborgAlertsStream.end(() => resolve())
    })
    await new Promise<void>((resolve) => {
      this.cyborgAlertsLiveStream.end(() => resolve())
    })

    const metrics = buildSummaryMetrics(this.finalizedPools)
    const summary = {
      reason,
      startedAtMs: this.startedAtMs,
      finishedAtMs: nowMs,
      config: this.config,
      metrics,
      pools: this.finalizedPools,
      ingest: {
        pendingLogBatches: this.pendingLogBatches,
        peakQueueDepth: this.peakQueueDepth,
        queueOverflowed: this.queueOverflowed,
      },
      artifacts: {
        eventsPath: this.eventsPath,
        poolsPath: this.poolsPath,
        cyborgAlertsPath: this.cyborgAlertsPath,
        cyborgAlertsLivePath: this.cyborgAlertsLivePath,
        summaryJsonPath: this.summaryJsonPath,
        summaryMarkdownPath: this.summaryMarkdownPath,
      },
    }

    fs.writeFileSync(this.summaryJsonPath, JSON.stringify(summary, null, 2) + '\n')
    fs.writeFileSync(this.summaryMarkdownPath, buildSummaryMarkdown(this.config, metrics, this.finalizedPools) + '\n')
    fs.copyFileSync(this.summaryJsonPath, this.latestJsonPath)
    fs.copyFileSync(this.summaryMarkdownPath, this.latestMarkdownPath)

    console.log('[MetaObserver] Summary JSON:', this.summaryJsonPath)
    console.log('[MetaObserver] Summary Markdown:', this.summaryMarkdownPath)
    console.log('[MetaObserver] Events JSONL:', this.eventsPath)
    console.log('[MetaObserver] Pools JSONL:', this.poolsPath)
    console.log('[MetaObserver] Cyborg alerts JSONL:', this.cyborgAlertsPath)

    this.resolveDone?.()
  }
}

async function main(): Promise<void> {
  dotenv.config()
  try {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: false })
  } catch (_) {}

  const observer = new PumpSwapMetaObserver(resolvePumpSwapMetaObserverConfig(process.env))
  await observer.run()
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[MetaObserver] Fatal error:', error)
    process.exit(1)
  })
}
