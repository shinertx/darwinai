import { createConnection, loadWallet } from './_shared.mjs'

const connection = createConnection('confirmed')
const wallet = loadWallet()

console.log('Wallet:', wallet.publicKey.toBase58())

const signatures = await connection.getSignaturesForAddress(wallet.publicKey, { limit: 5 })
console.log('\nRecent transactions:')
for (const entry of signatures) {
  console.log(entry.signature, '| err:', JSON.stringify(entry.err), '| slot:', entry.slot)
}

const failed = signatures.find((entry) => entry.err !== null)
if (!failed) {
  process.exit(0)
}

console.log('\nFetching failed transaction:', failed.signature)
const tx = await connection.getTransaction(failed.signature, { maxSupportedTransactionVersion: 0 })
if (!tx) {
  console.log('Transaction not found.')
  process.exit(1)
}

console.log('Error:', JSON.stringify(tx.meta?.err))
console.log('Logs:')
for (const log of tx.meta?.logMessages || []) {
  console.log(' ', log)
}
