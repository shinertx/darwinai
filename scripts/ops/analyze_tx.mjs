import { createConnection, loadWallet } from './_shared.mjs'

const connection = createConnection('confirmed')
const wallet = loadWallet()

const signatures = await connection.getSignaturesForAddress(wallet.publicKey, { limit: 20 })
const failed = signatures.find((entry) => entry.err !== null)

if (!failed) {
  console.log('No failed transactions found for', wallet.publicKey.toBase58())
  process.exit(0)
}

console.log('Analyzing failed transaction:', failed.signature)

const tx = await connection.getTransaction(failed.signature, { maxSupportedTransactionVersion: 0 })
if (!tx) {
  console.log('Transaction not found.')
  process.exit(1)
}

console.log('Error:', JSON.stringify(tx.meta?.err))
console.log('\nProgram logs:')
for (const log of tx.meta?.logMessages || []) {
  console.log(' ', log)
}

const accountKeys = tx.transaction.message.getAccountKeys()
console.log('\nAccounts:')
for (let index = 0; index < accountKeys.length; index += 1) {
  console.log(`  [${index}] ${accountKeys.get(index).toBase58()}`)
}
