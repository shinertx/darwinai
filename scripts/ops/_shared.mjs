import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import bs58 from 'bs58'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')

let envLoaded = false

export function loadEnv() {
  if (envLoaded) {
    return
  }

  dotenv.config({ path: path.join(PROJECT_ROOT, '.env') })
  dotenv.config({ path: path.join(PROJECT_ROOT, '.env.local'), override: true })
  envLoaded = true
}

export function requireEnv(name) {
  loadEnv()
  const value = process.env[name]
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value.trim()
}

export function getRpcUrl() {
  loadEnv()
  const value = (process.env.RPC_URLS || process.env.RPC_URL || '')
    .split(',')
    .map((entry) => entry.trim())
    .find(Boolean)

  if (!value) {
    throw new Error('Set RPC_URL or RPC_URLS before running this script.')
  }

  return value
}

export function getWssUrl() {
  return requireEnv('WSS_URL')
}

export function createConnection(commitment = 'confirmed') {
  return new Connection(getRpcUrl(), commitment)
}

export function loadWallet() {
  const raw = requireEnv('PRIVATE_KEY')
  return raw.startsWith('[')
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
    : Keypair.fromSecretKey(bs58.decode(raw))
}

export function formatSol(lamports) {
  return (lamports / 1_000_000_000).toFixed(9)
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function getWebSocketCtor() {
  const module = await import('ws')
  return module.WebSocket || module.default || module
}
