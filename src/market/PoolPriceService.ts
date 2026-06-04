// ============================================================================
// PoolPriceService — fetches real token price from PumpSwap pool reserves
// Uses exact same byte offsets as final-radiation PumpSwapEngine
// ============================================================================

import { AccountInfo, Connection, Keypair, PublicKey } from '@solana/web3.js'
import { OnlinePumpAmmSdk } from '@pump-fun/pump-swap-sdk'
import { createSolanaConnection } from '../rpc/solanaConnection'

const WSOL_MINT = 'So11111111111111111111111111111111111111112'

// PumpSwap pool account layout (Anchor IDL offsets)
const OFFSET_BASE_MINT = 8 + 1 + 2 + 32
const OFFSET_QUOTE_MINT = OFFSET_BASE_MINT + 32
const OFFSET_BASE_VAULT = OFFSET_QUOTE_MINT + 64
const OFFSET_QUOTE_VAULT = OFFSET_BASE_VAULT + 32
const MIN_POOL_SIZE = OFFSET_QUOTE_VAULT + 32

// SPL Token layouts
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
const TOKEN_ACCOUNT_MIN_SIZE = TOKEN_ACCOUNT_AMOUNT_OFFSET + 8
const MINT_DECIMALS_OFFSET = 44
const MINT_ACCOUNT_MIN_SIZE = MINT_DECIMALS_OFFSET + 1

// PumpFun standard: 793.1M tokens go to PumpSwap at graduation
const PUMPFUN_POOL_TOKENS = 793_100_000

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function readTokenAmount(account: AccountInfo<Buffer> | null): number | null {
  if (!account || account.data.length < TOKEN_ACCOUNT_MIN_SIZE) return null
  return Number(account.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET))
}

function readMintDecimals(account: AccountInfo<Buffer> | null): number | null {
  if (!account || account.data.length < MINT_ACCOUNT_MIN_SIZE) return null
  return account.data.readUInt8(MINT_DECIMALS_OFFSET)
}

function rawAmountToNumber(value: unknown): number | null {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value && typeof (value as any).toString === 'function') {
    const parsed = Number((value as any).toString())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toBase58(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof (value as any).toBase58 === 'function') return (value as any).toBase58()
  return null
}

type PoolMetadata = {
  baseVault: PublicKey
  quoteVault: PublicKey
  solSide: 'base' | 'quote'
  tokenDecimals: number
}

const CACHE_TTL_MS = parsePositiveInt(process.env.DARWIN_POOL_PRICE_CACHE_TTL_MS, 5000)
const RPC_BATCH_SIZE = parsePositiveInt(process.env.DARWIN_RPC_BATCH_SIZE, 50)
const poolPriceCache = new Map<string, { price: number; ts: number }>()
const poolMetadataCache = new Map<string, PoolMetadata>()
const poolPriceInFlight = new Map<string, Promise<number | null>>()

export class PoolPriceService {
  private connection: Connection
  private pumpAmm: OnlinePumpAmmSdk

  constructor(rpcUrl: string) {
    this.connection = createSolanaConnection(rpcUrl, 'confirmed')
    this.pumpAmm = new OnlinePumpAmmSdk(this.connection)
  }

  public async getPriceFromPool(poolAddress: string): Promise<number | null> {
    const cached = poolPriceCache.get(poolAddress)
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.price

    const inflight = poolPriceInFlight.get(poolAddress)
    if (inflight) return inflight

    const promise = this.getPricesFromPools([poolAddress])
      .then(async (prices) => prices.get(poolAddress) ?? await this.getPriceFromSdkState(poolAddress))
      .finally(() => {
        poolPriceInFlight.delete(poolAddress)
      })

    poolPriceInFlight.set(poolAddress, promise)
    return promise
  }

  public async getPricesFromPools(poolAddresses: string[]): Promise<Map<string, number>> {
    const results = new Map<string, number>()
    const uniquePools = Array.from(new Set(poolAddresses.filter((pool) => pool && pool.length > 10)))

    if (uniquePools.length === 0) {
      return results
    }

    const now = Date.now()
    const stalePools: string[] = []
    for (const poolAddress of uniquePools) {
      const cached = poolPriceCache.get(poolAddress)
      if (cached && now - cached.ts < CACHE_TTL_MS) {
        results.set(poolAddress, cached.price)
      } else {
        stalePools.push(poolAddress)
      }
    }

    if (stalePools.length === 0) {
      return results
    }

    const metadataByPool = await this.ensurePoolMetadata(stalePools)
    const vaultPubkeys = new Map<string, PublicKey>()
    for (const metadata of metadataByPool.values()) {
      vaultPubkeys.set(metadata.baseVault.toBase58(), metadata.baseVault)
      vaultPubkeys.set(metadata.quoteVault.toBase58(), metadata.quoteVault)
    }

    const vaultAccounts = await this.fetchAccounts(Array.from(vaultPubkeys.values()))

    for (const poolAddress of stalePools) {
      const metadata = metadataByPool.get(poolAddress)
      if (!metadata) continue

      const baseAmountRaw = readTokenAmount(vaultAccounts.get(metadata.baseVault.toBase58()) ?? null)
      const quoteAmountRaw = readTokenAmount(vaultAccounts.get(metadata.quoteVault.toBase58()) ?? null)
      if (baseAmountRaw == null || quoteAmountRaw == null) continue

      const solReserveRaw = metadata.solSide === 'base' ? baseAmountRaw : quoteAmountRaw
      const tokenReserveRaw = metadata.solSide === 'base' ? quoteAmountRaw : baseAmountRaw
      if (solReserveRaw <= 0 || tokenReserveRaw <= 0) continue

      const solReserve = solReserveRaw / 1e9
      const tokenReserve = tokenReserveRaw / Math.pow(10, metadata.tokenDecimals)
      if (tokenReserve <= 0) continue

      const price = solReserve / tokenReserve
      poolPriceCache.set(poolAddress, { price, ts: Date.now() })
      results.set(poolAddress, price)
    }

    for (const poolAddress of stalePools) {
      if (results.has(poolAddress)) continue
      const sdkPrice = await this.getPriceFromSdkState(poolAddress)
      if (sdkPrice !== null && sdkPrice > 0) {
        results.set(poolAddress, sdkPrice)
      }
    }

    return results
  }

  // Estimate price for new migration where pool address may not be known
  // PumpFun graduates with ~793.1M tokens at liquiditySol SOL
  public estimateMigrationPrice(liquiditySol: number): number {
    return liquiditySol / PUMPFUN_POOL_TOKENS
  }

  private async ensurePoolMetadata(poolAddresses: string[]): Promise<Map<string, PoolMetadata>> {
    const resolved = new Map<string, PoolMetadata>()
    const uncachedPools: string[] = []

    for (const poolAddress of poolAddresses) {
      const cached = poolMetadataCache.get(poolAddress)
      if (cached) {
        resolved.set(poolAddress, cached)
      } else {
        uncachedPools.push(poolAddress)
      }
    }

    if (uncachedPools.length === 0) {
      return resolved
    }

    const poolPubkeys: PublicKey[] = []
    const poolAddressByPubkey = new Map<string, string>()
    for (const poolAddress of uncachedPools) {
      try {
        const pubkey = new PublicKey(poolAddress)
        poolPubkeys.push(pubkey)
        poolAddressByPubkey.set(pubkey.toBase58(), poolAddress)
      } catch (_) {}
    }

    const poolAccounts = await this.fetchAccounts(poolPubkeys)
    const pending = new Map<string, { baseVault: PublicKey; quoteVault: PublicKey; solSide: 'base' | 'quote'; tokenMint: PublicKey }>()
    const mintPubkeys = new Map<string, PublicKey>()

    for (const poolPubkey of poolPubkeys) {
      const poolAddress = poolAddressByPubkey.get(poolPubkey.toBase58())
      if (!poolAddress) continue

      const account = poolAccounts.get(poolPubkey.toBase58()) ?? null
      if (!account || account.data.length < MIN_POOL_SIZE) continue

      const data = account.data
      const baseMint = new PublicKey(data.slice(OFFSET_BASE_MINT, OFFSET_BASE_MINT + 32))
      const quoteMint = new PublicKey(data.slice(OFFSET_QUOTE_MINT, OFFSET_QUOTE_MINT + 32))
      const baseVault = new PublicKey(data.slice(OFFSET_BASE_VAULT, OFFSET_BASE_VAULT + 32))
      const quoteVault = new PublicKey(data.slice(OFFSET_QUOTE_VAULT, OFFSET_QUOTE_VAULT + 32))

      if (baseMint.toBase58() === WSOL_MINT) {
        pending.set(poolAddress, {
          baseVault,
          quoteVault,
          solSide: 'base',
          tokenMint: quoteMint,
        })
        mintPubkeys.set(quoteMint.toBase58(), quoteMint)
      } else if (quoteMint.toBase58() === WSOL_MINT) {
        pending.set(poolAddress, {
          baseVault,
          quoteVault,
          solSide: 'quote',
          tokenMint: baseMint,
        })
        mintPubkeys.set(baseMint.toBase58(), baseMint)
      }
    }

    const mintAccounts = await this.fetchAccounts(Array.from(mintPubkeys.values()))
    for (const [poolAddress, metadata] of pending) {
      const mintAccount = mintAccounts.get(metadata.tokenMint.toBase58()) ?? null
      const tokenDecimals = readMintDecimals(mintAccount)
      if (tokenDecimals == null) continue

      const resolvedMetadata: PoolMetadata = {
        baseVault: metadata.baseVault,
        quoteVault: metadata.quoteVault,
        solSide: metadata.solSide,
        tokenDecimals,
      }

      poolMetadataCache.set(poolAddress, resolvedMetadata)
      resolved.set(poolAddress, resolvedMetadata)
    }

    return resolved
  }

  private async getPriceFromSdkState(poolAddress: string): Promise<number | null> {
    try {
      const poolKey = new PublicKey(poolAddress)
      const state = await this.pumpAmm.swapSolanaState(poolKey, Keypair.generate().publicKey)
      const pool = (state as any)?.pool
      const baseMint = toBase58(pool?.baseMint ?? (state as any)?.baseMint)
      const quoteMint = toBase58(pool?.quoteMint ?? (state as any)?.quoteMint)
      const baseRaw = rawAmountToNumber((state as any)?.poolBaseAmount)
      const quoteRaw = rawAmountToNumber((state as any)?.poolQuoteAmount)
      if (!baseMint || !quoteMint || baseRaw == null || quoteRaw == null) return null

      const solSide = baseMint === WSOL_MINT ? 'base' : quoteMint === WSOL_MINT ? 'quote' : null
      if (!solSide) return null

      const tokenMint = solSide === 'base' ? quoteMint : baseMint
      const tokenRaw = solSide === 'base' ? quoteRaw : baseRaw
      const solRaw = solSide === 'base' ? baseRaw : quoteRaw
      if (solRaw <= 0 || tokenRaw <= 0) return null

      const tokenMintAccount = await this.connection.getAccountInfo(new PublicKey(tokenMint), 'confirmed')
      const tokenDecimals = readMintDecimals(tokenMintAccount)
      if (tokenDecimals == null) return null

      const solReserve = solRaw / 1e9
      const tokenReserve = tokenRaw / Math.pow(10, tokenDecimals)
      if (solReserve <= 0 || tokenReserve <= 0) return null

      const price = solReserve / tokenReserve
      poolPriceCache.set(poolAddress, { price, ts: Date.now() })
      return price
    } catch (_) {
      return null
    }
  }

  private async fetchAccounts(pubkeys: PublicKey[]): Promise<Map<string, AccountInfo<Buffer> | null>> {
    const accounts = new Map<string, AccountInfo<Buffer> | null>()
    if (pubkeys.length === 0) return accounts

    for (const batch of chunk(pubkeys, RPC_BATCH_SIZE)) {
      const infos = await this.connection.getMultipleAccountsInfo(batch)
      batch.forEach((pubkey, index) => {
        accounts.set(pubkey.toBase58(), infos[index] ?? null)
      })
    }

    return accounts
  }
}
