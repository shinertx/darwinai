import BN from 'bn.js'
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk'
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createConnection, getWebSocketCtor, getWssUrl, loadWallet } from './_shared.mjs'

const connection = createConnection('confirmed')
const wallet = loadWallet()
const pumpAmm = new OnlinePumpAmmSdk(connection)
const WebSocket = await getWebSocketCtor()
const socket = new WebSocket(getWssUrl())

console.log('Listening for a live PumpSwap pool...')

socket.on('open', () => {
  socket.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'logsSubscribe',
    params: [
      { mentions: ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'] },
      { commitment: 'processed' },
    ],
  }))
})

let tested = false
socket.on('message', async (data) => {
  if (tested) {
    return
  }

  try {
    const message = JSON.parse(data.toString())
    const logs = message?.params?.result?.value?.logs
    const poolLine = logs?.find((line) => line.includes('pool:'))
    const pool = poolLine?.match(/pool:\s*([A-Za-z0-9]{32,})/)?.[1]
    if (!pool) {
      return
    }

    tested = true
    socket.close()

    const state = await pumpAmm.swapSolanaState(new PublicKey(pool), wallet.publicKey)
    const instructions = await PUMP_AMM_SDK.buyQuoteInput(state, new BN(100_000), 15)

    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
        ...instructions,
      ],
    }).compileToV0Message()

    const tx = new VersionedTransaction(messageV0)
    tx.sign([wallet])

    const simulation = await connection.simulateTransaction(tx, { commitment: 'processed' })
    console.log('Pool:', pool)
    console.log('Simulation error:', JSON.stringify(simulation.value.err))
    console.log('Simulation logs:')
    for (const log of simulation.value.logs || []) {
      console.log(' ', log)
    }
  } catch (error) {
    console.log('Buy simulation failed:', error.message)
  }
})

setTimeout(() => {
  console.log('Timed out waiting for a live pool.')
  socket.close()
  process.exit(0)
}, 30_000)
