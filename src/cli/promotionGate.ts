import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { Connection, PublicKey } from '@solana/web3.js'
import {
  DEFAULT_PROMOTION_GATE_CONFIG,
  evaluatePromotionGate,
  type PromotionGateEvidence,
  type PromotionLoopEvidence,
} from '../promotion/PromotionGate'

function parseBooleanFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function getSignatureFinalized(connection: Connection, signature: string): Promise<boolean> {
  const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
  return status?.err === null && status.confirmationStatus === 'finalized'
}

async function getWalletLamportDeltaSol(
  connection: Connection,
  wallet: PublicKey,
  signature: string
): Promise<number | null> {
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

async function enrichOnChainEvidence(evidence: PromotionGateEvidence): Promise<PromotionGateEvidence> {
  const rpcUrl = ((process.env.RPC_URLS || process.env.RPC_URL || '').split(',')[0] || '').trim()
  if (!rpcUrl) throw new Error('RPC_URL or RPC_URLS required for on-chain promotion verification')

  const connection = new Connection(rpcUrl, 'confirmed')
  const wallet = new PublicKey(evidence.wallet)
  const loops: PromotionLoopEvidence[] = []

  for (const loop of evidence.loops) {
    const buyFinalized = await getSignatureFinalized(connection, loop.buySignature)
    const sellFinalized = await getSignatureFinalized(connection, loop.sellSignature)
    const buyWalletDeltaSol = await getWalletLamportDeltaSol(connection, wallet, loop.buySignature)
    const sellWalletDeltaSol = await getWalletLamportDeltaSol(connection, wallet, loop.sellSignature)

    loops.push({
      ...loop,
      buyFinalized,
      sellFinalized,
      buyWalletDeltaSol: buyWalletDeltaSol ?? loop.buyWalletDeltaSol,
      sellWalletDeltaSol: sellWalletDeltaSol ?? loop.sellWalletDeltaSol,
    })
  }

  return {
    ...evidence,
    loops,
  }
}

async function main(): Promise<void> {
  dotenv.config()
  try {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
  } catch (_) {}

  const inputPath = path.resolve(process.cwd(), process.env.PROMOTION_GATE_INPUT || '')
  if (!process.env.PROMOTION_GATE_INPUT) {
    throw new Error('PROMOTION_GATE_INPUT is required')
  }

  const outputDir = path.resolve(process.cwd(), process.env.PROMOTION_GATE_OUTPUT_DIR || 'data/promotion-gate')
  const verifyOnChain = parseBooleanFlag(process.env.PROMOTION_GATE_VERIFY_ONCHAIN || 'true')
  const minLoops = parsePositiveInt(process.env.PROMOTION_GATE_MIN_LOOPS, DEFAULT_PROMOTION_GATE_CONFIG.minLoops)
  fs.mkdirSync(outputDir, { recursive: true })

  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as PromotionGateEvidence
  const evidence = verifyOnChain ? await enrichOnChainEvidence(raw) : raw
  const record = evaluatePromotionGate(evidence, { minLoops })
  const outPath = path.join(
    outputDir,
    `promotion-gate-${record.status.toLowerCase()}-${new Date(record.evaluatedAtMs).toISOString().replace(/[:.]/g, '-')}.json`
  )
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n')

  console.log('[PromotionGate] Status:', record.status)
  console.log('[PromotionGate] Loops:', record.loopCount)
  console.log('[PromotionGate] Net wallet delta SOL:', record.netWalletDeltaSol.toFixed(9))
  console.log('[PromotionGate] Record:', outPath)
  if (record.failures.length > 0) {
    console.log('[PromotionGate] Failures:', record.failures.join(', '))
  }

  if (record.status !== 'PASS') {
    process.exit(2)
  }
}

main().catch((error) => {
  console.error('[PromotionGate] Failed:', error?.message || error)
  process.exit(1)
})
