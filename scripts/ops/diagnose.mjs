import BN from 'bn.js'
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, CANONICAL_POOL_INDEX, pumpPoolAuthorityPda, poolPda } from '@pump-fun/pump-swap-sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { createConnection, formatSol, loadWallet, WSOL_MINT } from './_shared.mjs'

const connection = createConnection('confirmed')
const wallet = loadWallet()
const pumpAmm = new OnlinePumpAmmSdk(connection)

console.log('Wallet:', wallet.publicKey.toBase58())
console.log('SOL balance:', formatSol(await connection.getBalance(wallet.publicKey)))

const wsolAta = getAssociatedTokenAddressSync(WSOL_MINT, wallet.publicKey)
console.log('WSOL ATA:', wsolAta.toBase58())
console.log('WSOL ATA exists:', (await connection.getAccountInfo(wsolAta)) !== null)

const mintArg = process.argv[2]
if (!mintArg) {
  console.log('\nPass a mint address to inspect the canonical PumpSwap pool.')
  process.exit(0)
}

const mint = new PublicKey(mintArg)
const pool = poolPda(CANONICAL_POOL_INDEX, pumpPoolAuthorityPda(mint), mint, WSOL_MINT)
console.log('Canonical pool:', pool.toBase58())

try {
  const state = await pumpAmm.swapSolanaState(pool, wallet.publicKey)
  console.log('baseMint:', state.baseMint?.toBase58())
  console.log('quoteMint:', state.pool?.quoteMint?.toBase58())
  console.log('userQuoteAccountInfo:', state.userQuoteAccountInfo ? 'present' : 'missing')
  const instructions = await PUMP_AMM_SDK.buyQuoteInput(state, new BN(100_000), 15)
  console.log('SDK buy instructions:', instructions.length)
} catch (error) {
  console.log('Pool inspection failed:', error.message)
}
