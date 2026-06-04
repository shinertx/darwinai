import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createConnection, formatSol, loadEnv, loadWallet, requireEnv, sleep } from './_shared.mjs'

const LAMPORTS_PER_SOL = 1_000_000_000

function parsePositiveInt(name, fallback) {
  const raw = (process.env[name] || '').trim()
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`)
  }
  return value
}

function normalizeApiUrl(url) {
  return url.replace(/\/+$/, '')
}

function isTerminalStatus(status) {
  return ['confirmed', 'finalized', 'expired', 'failed', 'timed_out'].includes(status)
}

async function postJson(url, headers, body, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }

    return { ok: res.ok, status: res.status, data }
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(url, headers, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    })

    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }

    return { ok: res.ok, status: res.status, data }
  } finally {
    clearTimeout(timer)
  }
}

async function checkSettlementHealth(settlementApiUrl, timeoutMs) {
  const candidates = ['/healthz', '/health']
  let lastFailure = null

  for (const path of candidates) {
    const response = await getJson(`${settlementApiUrl}${path}`, {}, timeoutMs)
    if (response.ok) {
      return { path, data: response.data }
    }
    lastFailure = response
  }

  throw new Error(`Settlement health check failed: ${JSON.stringify(lastFailure?.data || lastFailure)}`)
}

async function requestDevnetAirdropIfNeeded(connection, wallet, minimumLamports) {
  const currentBalance = await connection.getBalance(wallet.publicKey, 'confirmed')
  if (currentBalance >= minimumLamports) {
    return currentBalance
  }

  console.log(`[smoke] Devnet balance ${formatSol(currentBalance)} SOL is low; requesting 1 SOL airdrop...`)
  const signature = await connection.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL)
  const latest = await connection.getLatestBlockhash('confirmed')
  await connection.confirmTransaction({
    signature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }, 'confirmed')

  const newBalance = await connection.getBalance(wallet.publicKey, 'confirmed')
  console.log(`[smoke] Airdrop confirmed. New balance: ${formatSol(newBalance)} SOL`)
  return newBalance
}

async function main() {
  loadEnv()

  const settlementApiUrl = normalizeApiUrl(requireEnv('SETTLEMENT_API_URL'))
  const settlementLandKey = requireEnv('SETTLEMENT_LAND_API_KEY')
  const settlementTxreadyKey = (process.env.SETTLEMENT_TXREADY_API_KEY || '').trim()
  const settlementNetwork = (process.env.SETTLEMENT_NETWORK || 'devnet').trim()
  const confirmationTarget = (process.env.SETTLEMENT_CONFIRMATION_TARGET || 'confirmed').trim() === 'finalized'
    ? 'finalized'
    : 'confirmed'
  const timeoutSeconds = parsePositiveInt('SETTLEMENT_TIMEOUT_SECONDS', 60)
  const pollIntervalMs = parsePositiveInt('SETTLEMENT_POLL_INTERVAL_MS', 1200)
  const httpTimeoutMs = parsePositiveInt('SETTLEMENT_HTTP_TIMEOUT_MS', 15000)
  const lamports = parsePositiveInt('SETTLEMENT_SMOKE_LAMPORTS', 5000)

  const connection = createConnection('confirmed')
  const wallet = loadWallet()
  const recipient = ((process.env.SETTLEMENT_SMOKE_RECIPIENT || '').trim())
    ? new PublicKey(process.env.SETTLEMENT_SMOKE_RECIPIENT.trim())
    : wallet.publicKey

  console.log(`[smoke] Wallet: ${wallet.publicKey.toBase58()}`)
  console.log(`[smoke] Recipient: ${recipient.toBase58()}${recipient.equals(wallet.publicKey) ? ' (self-transfer)' : ''}`)
  console.log(`[smoke] RPC: ${connection.rpcEndpoint}`)
  console.log(`[smoke] Settlement API: ${settlementApiUrl}`)
  console.log(`[smoke] Settlement network: ${settlementNetwork}`)
  console.log(`[smoke] Transfer amount: ${lamports} lamports`)

  if (settlementNetwork !== 'devnet') {
    throw new Error(`This smoke test is intentionally scoped to devnet. Refusing network=${settlementNetwork}`)
  }

  const health = await checkSettlementHealth(settlementApiUrl, httpTimeoutMs)
  console.log(`[smoke] Settlement health check passed via ${health.path}.`)

  await requestDevnetAirdropIfNeeded(connection, wallet, Math.max(lamports * 20, 20_000_000))

  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: recipient,
        lamports,
      }),
    ],
  }).compileToV0Message()

  let transaction = new VersionedTransaction(message)

  if (settlementTxreadyKey) {
    const optimize = await postJson(
      `${settlementApiUrl}/v1/txready/optimize`,
      { 'x-api-key': settlementTxreadyKey },
      {
        transaction: Buffer.from(transaction.serialize()).toString('base64'),
        network: settlementNetwork,
      },
      httpTimeoutMs,
    )

    if (!optimize.ok) {
      throw new Error(`txready optimize failed with status ${optimize.status}: ${JSON.stringify(optimize.data)}`)
    }

    const optimized = optimize.data?.optimizedTransaction
    if (!optimized) {
      throw new Error(`txready optimize response missing optimizedTransaction: ${JSON.stringify(optimize.data)}`)
    }

    transaction = VersionedTransaction.deserialize(Buffer.from(optimized, 'base64'))
    console.log('[smoke] txready optimization succeeded.')
  } else {
    console.log('[smoke] No SETTLEMENT_TXREADY_API_KEY set; skipping txready optimization.')
  }

  transaction.sign([wallet])

  const submit = await postJson(
    `${settlementApiUrl}/v1/land/submit`,
    { 'x-api-key': settlementLandKey },
    {
      transaction: Buffer.from(transaction.serialize()).toString('base64'),
      network: settlementNetwork,
      confirmationTarget,
      timeoutSeconds,
    },
    httpTimeoutMs,
  )

  if (!submit.ok) {
    throw new Error(`land/submit failed with status ${submit.status}: ${JSON.stringify(submit.data)}`)
  }

  const jobId = submit.data?.job?.id
  if (!jobId) {
    throw new Error(`land/submit response missing job id: ${JSON.stringify(submit.data)}`)
  }

  console.log(`[smoke] Settlement job accepted: ${jobId}`)

  const deadline = Date.now() + (timeoutSeconds * 1000) + 5000
  while (Date.now() < deadline) {
    const job = await getJson(
      `${settlementApiUrl}/v1/land/jobs/${jobId}`,
      { 'x-api-key': settlementLandKey },
      httpTimeoutMs,
    )

    if (job.ok) {
      const status = job.data?.job?.status
      const signature = job.data?.job?.signature || null
      if (status) {
        console.log(`[smoke] Job status: ${status}${signature ? ` | sig: ${signature}` : ''}`)
      }

      if (status && isTerminalStatus(status)) {
        if (status === 'confirmed' || status === 'finalized') {
          const tx = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          })
          console.log(`[smoke] Success. Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`)
          console.log(`[smoke] Fee: ${tx?.meta?.fee ?? 'unknown'} lamports`)
          return
        }

        throw new Error(`Settlement reached terminal failure status ${status}: ${job.data?.job?.failureReason || 'n/a'}`)
      }
    } else {
      console.log(`[smoke] Poll status ${job.status}: ${JSON.stringify(job.data)}`)
    }

    await sleep(pollIntervalMs)
  }

  throw new Error(`Settlement job polling timed out for job ${jobId}`)
}

main().catch((error) => {
  console.error('[smoke] FAILED:', error?.message || error)
  process.exit(1)
})
