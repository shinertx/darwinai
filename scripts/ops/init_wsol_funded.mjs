import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { ComputeBudgetProgram, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createConnection, formatSol, loadWallet, WSOL_MINT } from './_shared.mjs'

const connection = createConnection('confirmed')
const wallet = loadWallet()
const wsolAta = getAssociatedTokenAddressSync(WSOL_MINT, wallet.publicKey)
const lamports = Number(process.argv[2] || 100_000_000)

console.log('Wallet:', wallet.publicKey.toBase58())
console.log('SOL balance:', formatSol(await connection.getBalance(wallet.publicKey)))
console.log('WSOL ATA:', wsolAta.toBase58())
console.log('Funding amount:', formatSol(lamports), 'SOL')

const instructions = [
  createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, wsolAta, wallet.publicKey, WSOL_MINT),
  SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsolAta, lamports }),
  createSyncNativeInstruction(wsolAta),
]

const { blockhash } = await connection.getLatestBlockhash('confirmed')
const message = new TransactionMessage({
  payerKey: wallet.publicKey,
  recentBlockhash: blockhash,
  instructions: [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
    ...instructions,
  ],
}).compileToV0Message()

const tx = new VersionedTransaction(message)
tx.sign([wallet])

const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
console.log('Signature:', signature)

const confirmation = await connection.confirmTransaction(signature, 'confirmed')
console.log('Confirmed:', confirmation.value.err === null)
