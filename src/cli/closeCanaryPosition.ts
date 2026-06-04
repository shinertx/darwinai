import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import bs58 from 'bs58'
import { LiveExecutor } from '../execution/LiveExecutor'
import type { Position } from '../types'

type TokenBalanceSnapshot = {
  account: string
  amountRaw: bigint
  uiAmountString: string
}

function parseBooleanFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
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

async function getMintTokenProgramId(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const accountInfo = await connection.getAccountInfo(mint, 'confirmed')
  return accountInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
}

async function getTokenBalanceSnapshot(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey
): Promise<TokenBalanceSnapshot> {
  const tokenProgramId = await getMintTokenProgramId(connection, mint)
  const ata = getAssociatedTokenAddressSync(mint, wallet, false, tokenProgramId)

  try {
    const balance = await connection.getTokenAccountBalance(ata, 'confirmed')
    return {
      account: ata.toBase58(),
      amountRaw: BigInt(balance.value.amount),
      uiAmountString: balance.value.uiAmountString || '0',
    }
  } catch {
    return {
      account: ata.toBase58(),
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

async function main(): Promise<void> {
  dotenv.config()
  try {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
  } catch (_) {}

  const mint = (process.env.CLOSE_CANARY_MINT || '').trim()
  const pool = (process.env.CLOSE_CANARY_POOL || '').trim()
  const reason = (process.env.CLOSE_CANARY_REASON || 'manual_canary_exit_proof').trim()
  const outputDir = path.resolve(process.cwd(), process.env.CLOSE_CANARY_OUTPUT_DIR || 'data/live-canary')
  const requireSignature = parseBooleanFlag(process.env.CLOSE_CANARY_REQUIRE_SIGNATURE || 'true')

  if (!mint || !pool) {
    throw new Error('CLOSE_CANARY_MINT and CLOSE_CANARY_POOL are required')
  }

  const rpcUrl = ((process.env.RPC_URLS || process.env.RPC_URL || '').split(',')[0] || '').trim()
  if (!rpcUrl) {
    throw new Error('RPC_URL or RPC_URLS not set')
  }

  fs.mkdirSync(outputDir, { recursive: true })
  const wallet = resolveWallet()
  const connection = new Connection(rpcUrl, 'confirmed')
  const mintPk = new PublicKey(mint)
  const poolPk = new PublicKey(pool)

  const beforeBalanceSol = (await connection.getBalance(wallet.publicKey, 'confirmed')) / 1e9
  const beforeToken = await getTokenBalanceSnapshot(connection, wallet.publicKey, mintPk)
  if (beforeToken.amountRaw <= 0n) {
    throw new Error(`No token balance to close for ${mint}`)
  }

  const executor = new LiveExecutor()
  const position: Position = {
    id: `external-${mint.slice(0, 8)}-${Date.now()}`,
    strategyId: 'manual-canary-close',
    genomeId: 'manual-canary-close',
    mint: mintPk.toBase58(),
    pool: poolPk.toBase58(),
    entryPriceSol: 0,
    sizeSol: 0,
    openedAt: Date.now(),
    peakPriceSol: 0,
    lowestPriceSol: 0,
    isPaper: false,
    poolLiqSol: 0,
    signalType: 'amm_activity',
  }

  console.log('[CloseCanary] Wallet:', wallet.publicKey.toBase58())
  console.log('[CloseCanary] Mint:', mintPk.toBase58())
  console.log('[CloseCanary] Pool:', poolPk.toBase58())
  console.log('[CloseCanary] Token account:', beforeToken.account)
  console.log('[CloseCanary] Before SOL:', beforeBalanceSol.toFixed(9))
  console.log('[CloseCanary] Before token raw:', beforeToken.amountRaw.toString())

  const signature = await executor.closeExternalPositionNow(position, reason, beforeToken.amountRaw)
  if (requireSignature && !signature) {
    throw new Error('Close did not produce a signature')
  }

  const afterBalanceSol = (await connection.getBalance(wallet.publicKey, 'confirmed')) / 1e9
  const afterToken = await getTokenBalanceSnapshot(connection, wallet.publicKey, mintPk)
  const walletDeltaSol = await getWalletLamportDeltaSol(connection, wallet.publicKey, signature)
  const result = {
    executedAtMs: Date.now(),
    wallet: wallet.publicKey.toBase58(),
    mint: mintPk.toBase58(),
    pool: poolPk.toBase58(),
    tokenAccount: beforeToken.account,
    reason,
    beforeBalanceSol,
    afterBalanceSol,
    balanceDeltaSol: afterBalanceSol - beforeBalanceSol,
    beforeTokenAmountRaw: beforeToken.amountRaw.toString(),
    beforeTokenUiAmountString: beforeToken.uiAmountString,
    afterTokenAmountRaw: afterToken.amountRaw.toString(),
    afterTokenUiAmountString: afterToken.uiAmountString,
    tokenDeltaRaw: (afterToken.amountRaw - beforeToken.amountRaw).toString(),
    flattened: afterToken.amountRaw === 0n,
    signature,
    walletDeltaSol,
    settlementShadowMode: parseBooleanFlag(process.env.DARWIN_SETTLEMENT_SHADOW_MODE),
  }

  const outPath = path.join(
    outputDir,
    `close-canary-${new Date(result.executedAtMs).toISOString().replace(/[:.]/g, '-')}.json`
  )
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n')
  console.log('[CloseCanary] Result written:', outPath)
  console.log('[CloseCanary] Signature:', signature || 'none')
  console.log('[CloseCanary] After SOL:', afterBalanceSol.toFixed(9))
  console.log('[CloseCanary] After token raw:', afterToken.amountRaw.toString())
}

main().catch((error) => {
  console.error('[CloseCanary] Failed:', error?.message || error)
  process.exit(1)
})
