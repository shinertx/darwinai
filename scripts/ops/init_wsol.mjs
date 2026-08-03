import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createConnection, loadWallet, WSOL_MINT } from './_shared.mjs'

const connection = createConnection('confirmed')
const wallet = loadWallet()
const wsolAta = getAssociatedTokenAddressSync(WSOL_MINT, wallet.publicKey)

console.log('Wallet:', wallet.publicKey.toBase58())
console.log('Creating WSOL ATA:', wsolAta.toBase58())

const instruction = createAssociatedTokenAccountIdempotentInstruction(
  wallet.publicKey,
  wsolAta,
  wallet.publicKey,
  WSOL_MINT
)

const { blockhash } = await connection.getLatestBlockhash('confirmed')
const message = new TransactionMessage({
  payerKey: wallet.publicKey,
  recentBlockhash: blockhash,
  instructions: [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
    instruction,
  ],
}).compileToV0Message()

const tx = new VersionedTransaction(message)
tx.sign([wallet])

const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
console.log('Signature:', signature)

const confirmation = await connection.confirmTransaction(signature, 'confirmed')
console.log('Confirmed:', confirmation.value.err === null)
