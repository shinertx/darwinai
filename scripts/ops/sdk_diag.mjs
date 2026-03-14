import BN from 'bn.js'
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk'
import { PublicKey } from '@solana/web3.js'
import { createConnection, getWebSocketCtor, getWssUrl, loadWallet } from './_shared.mjs'

const connection = createConnection('confirmed')
const wallet = loadWallet()
const pumpAmm = new OnlinePumpAmmSdk(connection)
const WebSocket = await getWebSocketCtor()
const socket = new WebSocket(getWssUrl())

console.log('Waiting for a live PumpSwap pool...')

socket.on('open', () => {
  socket.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'logsSubscribe',
    params: [
      { mentions: ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'] },
      { commitment: 'confirmed' },
    ],
  }))
})

let done = false
socket.on('message', async (data) => {
  if (done) {
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

    done = true
    socket.close()

    const state = await pumpAmm.swapSolanaState(new PublicKey(pool), wallet.publicKey)
    console.log('Pool:', pool)
    console.log('baseMint:', state.baseMint?.toBase58())
    console.log('quoteMint:', state.pool?.quoteMint?.toBase58())
    console.log('userQuoteAccountInfo:', state.userQuoteAccountInfo ? 'present' : 'missing')

    const instructions = await PUMP_AMM_SDK.buyQuoteInput(state, new BN(100_000), 15)
    console.log('SDK buy instructions:', instructions.length)
    instructions.forEach((instruction, index) => {
      console.log(`  [${index}] ${instruction.programId.toBase58()}`)
    })
  } catch (error) {
    console.log('SDK diagnostic error:', error.message)
  }
})

setTimeout(() => {
  console.log('Timed out waiting for a live pool.')
  socket.close()
  process.exit(0)
}, 25_000)
