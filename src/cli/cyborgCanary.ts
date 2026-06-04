import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { spawn } from 'child_process'
import dotenv from 'dotenv'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import bs58 from 'bs58'
import { LiveExecutor } from '../execution/LiveExecutor'
import {
  resolveCyborgShapeScoringConfig,
  scoreCyborgShape,
  type CyborgShapeScore,
} from '../observatory/cyborgShapeScoring'
import type { Genome, MarketSignal } from '../types'

type CreatePoolEventLine = {
  kind: 'create_pool'
  pool: string
  creator: string
  baseMint: string
  quoteMint: string
  baseMintDecimals?: number
  quoteMintDecimals?: number
  initialBaseReserveRaw?: string
  initialQuoteReserveRaw?: string
  signature: string
  anchorTimeMs: number | null
  timeAnchorUnavailable?: boolean
}

type InteractionEventLine = {
  kind: 'buy' | 'sell' | 'deposit' | 'withdraw'
  pool: string
  user: string
  resolvedTimeMs: number | null
}

type PoolWatchState = {
  pool: string
  creator: string
  createSignature: string
  anchorTimeMs: number
  baseMint: string
  quoteMint: string
  baseMintDecimals: number
  quoteMintDecimals: number
  initialBaseReserveRaw: bigint
  initialQuoteReserveRaw: bigint
  buyCompetitorWallets5s: Set<string>
  interactingWallets5s: Set<string>
  timer: NodeJS.Timeout | null
}

type CanaryResult = {
  observedAtMs: number
  executedAtMs: number
  pool: string
  creator: string
  createSignature: string
  mint: string
  signalType: MarketSignal['type']
  sizeSol: number
  entryPriceSol: number
  liquiditySol: number
  wallet: string
  beforeBalanceSol: number
  afterBuyBalanceSol: number
  afterSellBalanceSol: number
  beforeTokenAmountRaw: string
  afterBuyTokenAmountRaw: string
  afterSellTokenAmountRaw: string
  residualTokenAmountRaw: string
  residualTokenUiAmountString: string
  flattened: boolean
  netReturnSol: number
  netReturnPctOnSize: number
  buyWalletDeltaSol: number | null
  sellWalletDeltaSol: number | null
  netReturnSource: 'tx_deltas' | 'balance_snapshot'
  buySignature: string | null
  sellSignature: string | null
  strictZeroInteraction5s: boolean
  uniqueCreatorInRun: boolean
  shapeProfile: string
  shapeScore: number
  shapeQualified: boolean
  shapeReasons: string[]
  shapeBlockers: string[]
  estimatedLaterBuyFlowRate: number | null
  estimatedThreePlusLaterBuyWalletRate: number | null
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const DEFAULT_ALERT_WINDOW_MS = 5_000
const DEFAULT_CANARY_SIZE_SOL = 0.0001
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const TOKEN_FLAT_DUST_RAW = 1_000n

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value || '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function resolveWallet(): Keypair {
  const privateKey = (process.env.PRIVATE_KEY || '').trim()
  if (!privateKey) {
    throw new Error('PRIVATE_KEY not set')
  }
  return privateKey.startsWith('[')
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(privateKey)))
    : Keypair.fromSecretKey(bs58.decode(privateKey))
}

function buildDummyGenome(): Genome {
  return {
    id: 'cyborg-canary-genome',
    generation: 0,
    parentIds: [],
    createdAt: Date.now(),
    entry: {
      nodes: [],
      outputNodeId: 'root',
    },
    exit: {
      takeProfitPct: 100,
      trailingActivatePct: 100,
      trailingDistancePct: 1,
      timeStopMs: 60_000,
      noPumpBailMs: 60_000,
      fadeGivebackPct: 1,
      moonbagPct: 0,
    },
    risk: {
      capitalPct: 0,
      maxConcurrent: 1,
      drawdownPausePct: 1,
      cooldownMs: 0,
      maxPoolPct: 1,
    },
  }
}

function isWithinWindow(anchorTimeMs: number, resolvedTimeMs: number | null, windowMs: number): boolean {
  if (resolvedTimeMs === null) return false
  return resolvedTimeMs >= anchorTimeMs && resolvedTimeMs < anchorTimeMs + windowMs
}

function deriveSignalFromPool(state: PoolWatchState, nowMs: number): MarketSignal | null {
  const baseIsWsol = state.baseMint === WSOL_MINT
  const quoteIsWsol = state.quoteMint === WSOL_MINT
  if (!baseIsWsol && !quoteIsWsol) {
    return null
  }

  const mint = baseIsWsol ? state.quoteMint : state.baseMint
  const solReserveRaw = baseIsWsol ? state.initialBaseReserveRaw : state.initialQuoteReserveRaw
  const tokenReserveRaw = baseIsWsol ? state.initialQuoteReserveRaw : state.initialBaseReserveRaw
  const solDecimals = baseIsWsol ? state.baseMintDecimals : state.quoteMintDecimals
  const tokenDecimals = baseIsWsol ? state.quoteMintDecimals : state.baseMintDecimals
  const solReserve = Number(solReserveRaw) / (10 ** solDecimals)
  const tokenReserve = Number(tokenReserveRaw) / (10 ** tokenDecimals)
  if (!Number.isFinite(solReserve) || !Number.isFinite(tokenReserve) || solReserve <= 0 || tokenReserve <= 0) {
    return null
  }

  return {
    type: 'new_pool',
    mint,
    pool: state.pool,
    liquiditySol: solReserve,
    poolAgeMs: Math.max(0, nowMs - state.anchorTimeMs),
    priceSol: solReserve / tokenReserve,
    eventData: {
      creator: state.creator,
      createSignature: state.createSignature,
      cyborgStrictZeroInteractions5s: true,
    },
    timestamp: state.anchorTimeMs,
  }
}

type TokenBalanceSnapshot = {
  amountRaw: bigint
  uiAmountString: string
}

async function getTokenBalanceSnapshot(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey
): Promise<TokenBalanceSnapshot> {
  const mintAccount = await connection.getAccountInfo(mint, 'confirmed')
  const tokenProgramId = mintAccount?.owner?.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID
  const ata = getAssociatedTokenAddressSync(mint, wallet, false, tokenProgramId)

  try {
    const balance = await connection.getTokenAccountBalance(ata, 'confirmed')
    return {
      amountRaw: BigInt(balance.value.amount),
      uiAmountString: balance.value.uiAmountString || '0',
    }
  } catch {
    return {
      amountRaw: 0n,
      uiAmountString: '0',
    }
  }
}

async function getWalletLamportDeltaSol(
  connection: Connection,
  wallet: PublicKey,
  signature: string | null
): Promise<number | null> {
  if (!signature) return null

  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  })
  if (!tx?.meta) return null

  const keyIndex = tx.transaction.message.accountKeys.findIndex((entry) => entry.pubkey.equals(wallet))
  if (keyIndex < 0) return null

  const pre = tx.meta.preBalances[keyIndex]
  const post = tx.meta.postBalances[keyIndex]
  if (typeof pre !== 'number' || typeof post !== 'number') return null
  return (post - pre) / 1e9
}

async function executeCanary(
  executor: LiveExecutor,
  connection: Connection,
  wallet: Keypair,
  state: PoolWatchState,
  canarySizeSol: number,
  outputDir: string,
  shapeScore: CyborgShapeScore
): Promise<CanaryResult | null> {
  const nowMs = Date.now()
  const signal = deriveSignalFromPool(state, nowMs)
  if (!signal) {
    console.log('[CyborgCanary] Skipping non-WSOL or invalid pool:', state.pool)
    return null
  }

  const mintPk = new PublicKey(signal.mint)
  const beforeBalanceSol = (await connection.getBalance(wallet.publicKey, 'confirmed')) / 1e9
  const beforeToken = await getTokenBalanceSnapshot(connection, wallet.publicKey, mintPk)
  const position = await executor.open(
    signal,
    buildDummyGenome(),
    'cyborg-canary',
    canarySizeSol,
    signal.priceSol
  )

  if (!position) {
    const failure = executor.consumeLastOpenFailureReason()
    console.log('[CyborgCanary] Buy failed:', failure || 'unknown')
    return null
  }

  const afterBuyBalanceSol = (await connection.getBalance(wallet.publicKey, 'confirmed')) / 1e9
  const afterBuyToken = await getTokenBalanceSnapshot(connection, wallet.publicKey, mintPk)
  const sellSignature = await executor.closePositionNow(position.id, 'cyborg_canary_immediate_sell')
  const afterSellBalanceSol = (await connection.getBalance(wallet.publicKey, 'confirmed')) / 1e9
  const afterSellToken = await getTokenBalanceSnapshot(connection, wallet.publicKey, mintPk)
  const residualTokenAmountRaw = afterSellToken.amountRaw - beforeToken.amountRaw
  const flattened = residualTokenAmountRaw <= TOKEN_FLAT_DUST_RAW
  const buyWalletDeltaSol = await getWalletLamportDeltaSol(connection, wallet.publicKey, position.entrySignature || null)
  const sellWalletDeltaSol = await getWalletLamportDeltaSol(connection, wallet.publicKey, sellSignature)
  const txDeltaNetReturnSol = buyWalletDeltaSol !== null && sellWalletDeltaSol !== null
    ? buyWalletDeltaSol + sellWalletDeltaSol
    : null
  const netReturnSol = txDeltaNetReturnSol ?? (afterSellBalanceSol - beforeBalanceSol)

  const result: CanaryResult = {
    observedAtMs: state.anchorTimeMs + DEFAULT_ALERT_WINDOW_MS,
    executedAtMs: Date.now(),
    pool: state.pool,
    creator: state.creator,
    createSignature: state.createSignature,
    mint: signal.mint,
    signalType: signal.type,
    sizeSol: canarySizeSol,
    entryPriceSol: signal.priceSol,
    liquiditySol: signal.liquiditySol,
    wallet: wallet.publicKey.toBase58(),
    beforeBalanceSol,
    afterBuyBalanceSol,
    afterSellBalanceSol,
    beforeTokenAmountRaw: beforeToken.amountRaw.toString(),
    afterBuyTokenAmountRaw: afterBuyToken.amountRaw.toString(),
    afterSellTokenAmountRaw: afterSellToken.amountRaw.toString(),
    residualTokenAmountRaw: residualTokenAmountRaw.toString(),
    residualTokenUiAmountString: afterSellToken.uiAmountString,
    flattened,
    netReturnSol,
    netReturnPctOnSize: (netReturnSol / canarySizeSol) * 100,
    buyWalletDeltaSol,
    sellWalletDeltaSol,
    netReturnSource: txDeltaNetReturnSol !== null ? 'tx_deltas' : 'balance_snapshot',
    buySignature: position.entrySignature || null,
    sellSignature,
    strictZeroInteraction5s: state.buyCompetitorWallets5s.size === 0 && state.interactingWallets5s.size === 0,
    uniqueCreatorInRun: !shapeScore.blockers.includes('repeat_creator'),
    shapeProfile: shapeScore.profile,
    shapeScore: shapeScore.score,
    shapeQualified: shapeScore.qualified,
    shapeReasons: [...shapeScore.reasons],
    shapeBlockers: [...shapeScore.blockers],
    estimatedLaterBuyFlowRate: shapeScore.estimatedLaterBuyFlowRate,
    estimatedThreePlusLaterBuyWalletRate: shapeScore.estimatedThreePlusLaterBuyWalletRate,
  }

  const outPath = path.join(
    outputDir,
    `cyborg-canary-${new Date(result.executedAtMs).toISOString().replace(/[:.]/g, '-')}.json`
  )
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n')
  console.log('[CyborgCanary] Result written:', outPath)
  console.log('[CyborgCanary] Net return SOL:', result.netReturnSol.toFixed(9))
  console.log('[CyborgCanary] Net return % on size:', result.netReturnPctOnSize.toFixed(4))
  console.log('[CyborgCanary] Flattened:', result.flattened, '| residual raw:', result.residualTokenAmountRaw)
  return result
}

async function main(): Promise<void> {
  dotenv.config()
  try {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
  } catch (_) {}

  process.env.DARWIN_SETTLEMENT_SHADOW_MODE = 'false'
  process.env.SETTLEMENT_API_URL = ''
  process.env.SETTLEMENT_LAND_API_KEY = ''
  process.env.SETTLEMENT_TXREADY_API_KEY = ''

  const alertWindowMs = parsePositiveInt(process.env.PUMPSWAP_CYBORG_ALERT_WINDOW_MS, DEFAULT_ALERT_WINDOW_MS)
  const canarySizeSol = parsePositiveFloat(process.env.PUMPSWAP_CYBORG_CANARY_SIZE_SOL, DEFAULT_CANARY_SIZE_SOL)
  const timeoutMs = parsePositiveInt(process.env.PUMPSWAP_CYBORG_CANARY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const outputDir = path.resolve(process.cwd(), process.env.PUMPSWAP_META_OUTPUT_DIR || 'data/meta-observer')
  const eventsDir = outputDir
  const shapeConfig = resolveCyborgShapeScoringConfig(process.env)
  fs.mkdirSync(outputDir, { recursive: true })

  const rpcUrl = ((process.env.RPC_URLS || process.env.RPC_URL || '').split(',')[0] || '').trim()
  if (!rpcUrl) throw new Error('RPC_URL or RPC_URLS not set')

  const wallet = resolveWallet()
  const connection = new Connection(rpcUrl, 'confirmed')
  const startingBalanceSol = (await connection.getBalance(wallet.publicKey, 'confirmed')) / 1e9
  console.log('[CyborgCanary] Wallet:', wallet.publicKey.toBase58())
  console.log('[CyborgCanary] Starting balance:', startingBalanceSol.toFixed(9), 'SOL')
  console.log('[CyborgCanary] Canary size:', canarySizeSol.toFixed(6), 'SOL')
  console.log(
    '[CyborgCanary] Shape scorer:',
    `minScore=${shapeConfig.minScore}`,
    `maxBuy5s=${shapeConfig.maxBuyCompetitors5s}`,
    `maxInteractions5s=${shapeConfig.maxInteractingWallets5s}`,
    `minLiquiditySol=${shapeConfig.minLiquiditySol.toFixed(2)}`,
    `requireUniqueCreator=${shapeConfig.requireUniqueCreator}`
  )
  console.log('[CyborgCanary] Settlement shadow mode overridden to false for this process')
  console.log('[CyborgCanary] Settlement routing disabled for this process; using direct RPC submit path')

  const latestEventsPath = path.join(
    eventsDir,
    fs.readdirSync(eventsDir).filter((name) => name.startsWith('events-') && name.endsWith('.jsonl')).sort().at(-1) || ''
  )
  if (!latestEventsPath || !fs.existsSync(latestEventsPath)) {
    throw new Error('No events JSONL found to tail')
  }

  const creatorCreateCount = new Map<string, number>()
  const activePools = new Map<string, PoolWatchState>()
  const handledPools = new Set<string>()
  let executing = false
  let streamPosition = 0
  let pendingLiveFragment = ''

  const processRow = (row: CreatePoolEventLine | InteractionEventLine, mode: 'history' | 'live'): void => {
    if (row.kind === 'create_pool') {
      if (handledPools.has(row.pool)) {
        return
      }
      creatorCreateCount.set(row.creator, (creatorCreateCount.get(row.creator) || 0) + 1)
      if (mode === 'history') {
        return
      }
      if (row.anchorTimeMs === null || row.timeAnchorUnavailable) {
        return
      }
      const state: PoolWatchState = {
        pool: row.pool,
        creator: row.creator,
        createSignature: row.signature,
        anchorTimeMs: row.anchorTimeMs,
        baseMint: row.baseMint,
        quoteMint: row.quoteMint,
        baseMintDecimals: row.baseMintDecimals ?? 9,
        quoteMintDecimals: row.quoteMintDecimals ?? 9,
        initialBaseReserveRaw: BigInt(row.initialBaseReserveRaw || '0'),
        initialQuoteReserveRaw: BigInt(row.initialQuoteReserveRaw || '0'),
        buyCompetitorWallets5s: new Set<string>(),
        interactingWallets5s: new Set<string>(),
        timer: null,
      }
      activePools.set(state.pool, state)
      const delayMs = Math.max(0, state.anchorTimeMs + alertWindowMs - Date.now())
      state.timer = setTimeout(async () => {
        if (executing) return
        if (handledPools.has(state.pool)) return
        executing = true
        const executor = new LiveExecutor()
        try {
          const signal = deriveSignalFromPool(state, Date.now())
          if (!signal) {
            handledPools.add(state.pool)
            executing = false
            return
          }

          const uniqueCreatorInRun = (creatorCreateCount.get(state.creator) || 0) === 1
          const shapeScore = scoreCyborgShape({
            buyCompetitorWalletCount5s: state.buyCompetitorWallets5s.size,
            interactingWalletCount5s: state.interactingWallets5s.size,
            liquiditySol: signal.liquiditySol,
            uniqueCreatorInRun,
          }, shapeConfig)

          signal.eventData = {
            ...signal.eventData,
            cyborgShapeProfile: shapeScore.profile,
            cyborgShapeScore: shapeScore.score,
            cyborgShapeQualified: shapeScore.qualified,
            cyborgShapeReasons: [...shapeScore.reasons],
            cyborgShapeBlockers: [...shapeScore.blockers],
            estimatedLaterBuyFlowRate: shapeScore.estimatedLaterBuyFlowRate,
            estimatedThreePlusLaterBuyWalletRate: shapeScore.estimatedThreePlusLaterBuyWalletRate,
          }

          if (!shapeScore.qualified) {
            handledPools.add(state.pool)
            console.log(
              '[CyborgCanary] Skipping low-exitability shape:',
              state.pool,
              '| profile:',
              shapeScore.profile,
              '| score:',
              `${shapeScore.score}/${shapeScore.maxScore}`,
              '| blockers:',
              shapeScore.blockers.join(',') || 'none',
              '| reasons:',
              shapeScore.reasons.join(',') || 'none'
            )
            executing = false
            return
          }

          const assessment = await executor.assessEntryTradability(signal, canarySizeSol)
          if (!assessment.tradable) {
            handledPools.add(state.pool)
            console.log(
              '[CyborgCanary] Skipping upstream-blocked pool:',
              state.pool,
              '| profile:',
              shapeScore.profile,
              '| score:',
              `${shapeScore.score}/${shapeScore.maxScore}`,
              '| reason:',
              assessment.reason || 'unknown'
            )
            executing = false
            return
          }

          handledPools.add(state.pool)
          console.log(
            '[CyborgCanary] Executing on scored pool:',
            state.pool,
            '| profile:',
            shapeScore.profile,
            '| score:',
            `${shapeScore.score}/${shapeScore.maxScore}`,
            '| estimatedLaterFlow:',
            shapeScore.estimatedLaterBuyFlowRate?.toFixed(3) ?? 'n/a',
            '| estimated3Plus:',
            shapeScore.estimatedThreePlusLaterBuyWalletRate?.toFixed(3) ?? 'n/a'
          )
          const result = await executeCanary(
            executor,
            connection,
            wallet,
            state,
            canarySizeSol,
            outputDir,
            shapeScore
          )
          if (result) {
            process.exit(result.flattened ? 0 : 3)
          }
          executing = false
        } catch (error: any) {
          console.log('[CyborgCanary] Execution error:', error?.message || error)
          process.exit(1)
        }
      }, delayMs)
      return
    }

    const state = activePools.get(row.pool)
    if (!state) return
    if (!isWithinWindow(state.anchorTimeMs, row.resolvedTimeMs, alertWindowMs)) return
    if (row.user === state.creator) return
    state.interactingWallets5s.add(row.user)
    if (row.kind === 'buy') {
      state.buyCompetitorWallets5s.add(row.user)
    }
  }

  const historyScanner = spawn(
    'sh',
    [
      '-lc',
      `if command -v rg >/dev/null 2>&1; then exec rg '"kind":"create_pool"' "${latestEventsPath}"; else exec grep -F '"kind":"create_pool"' "${latestEventsPath}"; fi`,
    ],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
    }
  )
  const bootstrap = readline.createInterface({
    input: historyScanner.stdout!,
    crlfDelay: Infinity,
  })
  for await (const line of bootstrap) {
    if (!line) continue
    processRow(JSON.parse(line) as CreatePoolEventLine | InteractionEventLine, 'history')
  }
  const historyExitCode = await new Promise<number>((resolve) => {
    historyScanner.on('close', (code) => resolve(code ?? 0))
  })
  if (historyExitCode !== 0 && historyExitCode !== 1) {
    throw new Error(`Historical create_pool scan failed with exit code ${historyExitCode}`)
  }
  streamPosition = fs.statSync(latestEventsPath).size

  console.log('[CyborgCanary] Watching:', latestEventsPath)
  console.log('[CyborgCanary] Waiting for next rent-safe, high-exitability 5s pool...')

  const interval = setInterval(() => {
    const stat = fs.statSync(latestEventsPath)
    if (stat.size <= streamPosition) return

    const stream = fs.createReadStream(latestEventsPath, { start: streamPosition, end: stat.size - 1, encoding: 'utf8' })
    let chunkBuffer = pendingLiveFragment

    stream.on('data', (chunk: string | Buffer) => {
      chunkBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })

    stream.on('end', () => {
      const rows = chunkBuffer.split('\n')
      pendingLiveFragment = rows.pop() || ''

      for (const line of rows) {
        if (!line) continue
        try {
          processRow(JSON.parse(line) as CreatePoolEventLine | InteractionEventLine, 'live')
        } catch (error: any) {
          console.log('[CyborgCanary] Skipping malformed live row:', error?.message || error)
        }
      }
    })

    stream.on('close', () => {
      streamPosition = stat.size
    })
  }, 1000)

  setTimeout(() => {
    clearInterval(interval)
    console.log('[CyborgCanary] Timed out waiting for a strict unique-creator pool')
    process.exit(2)
  }, timeoutMs)
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[CyborgCanary] Fatal error:', error)
    process.exit(1)
  })
}
