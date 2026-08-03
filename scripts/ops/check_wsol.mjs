import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { createConnection, loadWallet, WSOL_MINT } from './_shared.mjs'

const connection = createConnection('confirmed')
const wallet = loadWallet()
const ata = getAssociatedTokenAddressSync(WSOL_MINT, wallet.publicKey)

console.log('Wallet:', wallet.publicKey.toBase58())
console.log('WSOL ATA:', ata.toBase58())

const info = await connection.getAccountInfo(ata)
console.log('Exists:', info !== null)
if (info) {
  console.log('Owner:', info.owner.toBase58())
  console.log('Lamports:', info.lamports)
}

try {
  const balance = await connection.getTokenAccountBalance(ata)
  console.log('Token balance:', balance.value.uiAmount, 'WSOL')
} catch (error) {
  console.log('Token balance unavailable:', error.message)
}
