// ============================================================================
// PoolPriceService — fetches real token price from PumpSwap pool reserves
// Uses exact same byte offsets as final-radiation PumpSwapEngine
// ============================================================================

import { Connection, PublicKey } from '@solana/web3.js'

const WSOL_MINT = 'So11111111111111111111111111111111111111112'

// PumpSwap pool account layout (Anchor IDL offsets)
const OFFSET_BASE_MINT  = 8 + 1 + 2 + 32        // 43
const OFFSET_QUOTE_MINT = OFFSET_BASE_MINT  + 32  // 75
const OFFSET_LP_MINT    = OFFSET_QUOTE_MINT + 32  // 107
const OFFSET_BASE_VAULT = OFFSET_LP_MINT    + 32  // 139
const OFFSET_QUOTE_VAULT = OFFSET_BASE_VAULT + 32  // 171
const MIN_POOL_SIZE     = OFFSET_QUOTE_VAULT + 32  // 203

// PumpFun standard: 793.1M tokens go to PumpSwap at graduation
const PUMPFUN_POOL_TOKENS = 793_100_000

// Cache pool prices (3s TTL)
const poolPriceCache = new Map<string, { price: number; ts: number }>()
const CACHE_TTL_MS = 3000

export class PoolPriceService {
  private connection: Connection

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed')
  }

  // Get price from PumpSwap pool reserves (returns SOL per token)
  public async getPriceFromPool(poolAddress: string): Promise<number | null> {
    const cached = poolPriceCache.get(poolAddress)
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.price

    try {
      const poolPubkey = new PublicKey(poolAddress)
      const poolAccount = await this.connection.getAccountInfo(poolPubkey)
      if (!poolAccount || poolAccount.data.length < MIN_POOL_SIZE) return null

      const data = poolAccount.data
      const baseMint  = new PublicKey(data.slice(OFFSET_BASE_MINT,  OFFSET_BASE_MINT  + 32))
      const quoteMint = new PublicKey(data.slice(OFFSET_QUOTE_MINT, OFFSET_QUOTE_MINT + 32))
      const baseVault  = new PublicKey(data.slice(OFFSET_BASE_VAULT,  OFFSET_BASE_VAULT  + 32))
      const quoteVault = new PublicKey(data.slice(OFFSET_QUOTE_VAULT, OFFSET_QUOTE_VAULT + 32))

      const [baseInfo, quoteInfo] = await Promise.all([
        this.connection.getTokenAccountBalance(baseVault).catch(() => null),
        this.connection.getTokenAccountBalance(quoteVault).catch(() => null),
      ])

      if (!baseInfo || !quoteInfo) return null

      const baseAmt  = Number(baseInfo.value.amount)
      const quoteAmt = Number(quoteInfo.value.amount)
      if (baseAmt === 0 || quoteAmt === 0) return null

      // Determine which side is SOL
      const baseIsSOL  = baseMint.toBase58()  === WSOL_MINT
      const quoteIsSOL = quoteMint.toBase58() === WSOL_MINT

      let solReserveRaw: number
      let tokenReserveRaw: number
      let tokenDecimals: number

      if (baseIsSOL) {
        solReserveRaw   = baseAmt
        tokenReserveRaw = quoteAmt
        tokenDecimals   = quoteInfo.value.decimals
      } else if (quoteIsSOL) {
        solReserveRaw   = quoteAmt
        tokenReserveRaw = baseAmt
        tokenDecimals   = baseInfo.value.decimals
      } else {
        return null // neither side is SOL
      }

      const solReserve   = solReserveRaw / 1e9
      const tokenReserve = tokenReserveRaw / Math.pow(10, tokenDecimals)
      if (tokenReserve === 0) return null

      const price = solReserve / tokenReserve
      poolPriceCache.set(poolAddress, { price, ts: Date.now() })
      return price

    } catch (_) {
      return null
    }
  }

  // Estimate price for new migration where pool address may not be known
  // PumpFun graduates with ~793.1M tokens at liquiditySol SOL
  public estimateMigrationPrice(liquiditySol: number): number {
    return liquiditySol / PUMPFUN_POOL_TOKENS
  }
}
