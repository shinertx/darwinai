// ============================================================================
// BankrollManager — tracks SOL bankroll, sizes positions
// ============================================================================

import { ClosedTrade } from '../types'
import { resolveRuntimeConfig } from '../config/runtime'

function parsePositiveNumber(value: string | undefined): number | null {
  const parsed = parseFloat(value || '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export class BankrollManager {
  private balance: number
  private peakBalance: number
  private startedAt: number
  private trades: ClosedTrade[] = []
  private drawdownPausePct: number
  private mode: 'paper' | 'live'
  private liveTradeSizeSol: number
  private paperMaxPositionPct: number
  private paperMaxPositionSol: number | null

  constructor() {
    const startBalance = parseFloat(process.env.STARTING_BALANCE_SOL || '1.0')
    const runtime = resolveRuntimeConfig(process.env)
    const parsedPaperMaxPositionPct = parsePositiveNumber(process.env.DARWIN_PAPER_MAX_POSITION_PCT)
    this.balance = startBalance
    this.peakBalance = startBalance
    this.startedAt = Date.now()
    this.mode = runtime.mode
    this.liveTradeSizeSol = parsePositiveNumber(process.env.LIVE_TRADE_SIZE_SOL) || 0.001
    this.paperMaxPositionPct = clamp(parsedPaperMaxPositionPct || 0.12, 0.01, 0.95)
    this.paperMaxPositionSol = parsePositiveNumber(process.env.DARWIN_PAPER_MAX_POSITION_SOL)
    // Paper trading is virtual — allow deeper drawdown so evolution has runway.
    // Live mode uses a strict halt to protect capital.
    const isPaper = this.mode === 'paper'
    this.drawdownPausePct = isPaper ? 0.90 : 0.40
    console.log('[BankrollManager] Starting balance: ' + startBalance.toFixed(4) + ' SOL | mode=' + runtime.mode)
  }

  public getPositionSize(
    capitalPct: number,
    poolLiqSol: number,
    maxPoolPct: number,
    signalType: 'migration' | 'whale_buy' | 'new_pool' | 'amm_activity' = 'amm_activity'
  ): number {
    return this.getSizingPlan(capitalPct, poolLiqSol, maxPoolPct, signalType).sizeSol
  }

  public getSizingPlan(
    capitalPct: number,
    poolLiqSol: number,
    maxPoolPct: number,
    signalType: 'migration' | 'whale_buy' | 'new_pool' | 'amm_activity' = 'amm_activity'
  ): {
    desiredSizeSol: number
    cappedSizeSol: number
    poolCapSol: number
    sizeSol: number
    signalMultiplier: number
  } {
    if (this.mode === 'live') {
      const desiredSizeSol = this.liveTradeSizeSol
      const cappedSizeSol = Math.min(desiredSizeSol, this.balance * 0.95)
      const poolCapSol = poolLiqSol * maxPoolPct
      const sizeSol = Math.min(cappedSizeSol, poolCapSol)

      return {
        desiredSizeSol,
        cappedSizeSol,
        poolCapSol,
        sizeSol,
        signalMultiplier: 1,
      }
    }

    // Migration sizing is liquidity-aware:
    // scale down in thin pools (reduce churn/no-pump damage), scale up in deeper pools (capture upside).
    const migrationMultiplier =
      poolLiqSol >= 120 ? 3.4 :
      poolLiqSol >= 70 ? 3.0 :
      poolLiqSol >= 35 ? 2.5 :
      1.3

    // Signal-type multiplier: bet bigger on migrations, smaller on noisy amm swaps
    const signalMultiplier =
      signalType === 'migration' ? migrationMultiplier :
      signalType === 'whale_buy' ? 0.75 :
      signalType === 'new_pool'  ? 1.0 :
      0.2  // amm_activity

    const desiredSizeSol = this.balance * capitalPct * signalMultiplier
    const paperCapSol = this.balance * this.paperMaxPositionPct
    const absoluteCapSol = this.paperMaxPositionSol ?? Number.POSITIVE_INFINITY
    const cappedSizeSol = Math.min(desiredSizeSol, this.balance * 0.95, paperCapSol, absoluteCapSol)
    const poolCapSol = poolLiqSol * maxPoolPct
    const sizeSol = Math.min(cappedSizeSol, poolCapSol)

    return {
      desiredSizeSol,
      cappedSizeSol,
      poolCapSol,
      sizeSol,
      signalMultiplier,
    }
  }

  public recordTrade(trade: ClosedTrade): void {
    this.balance += trade.pnlSol
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance
    }
    this.trades.push(trade)
  }

  public getCurrentBalance(): number {
    return this.balance
  }

  public getPeakBalance(): number {
    return this.peakBalance
  }

  public isDrawdownBreached(): boolean {
    if (this.peakBalance === 0) return false
    const drawdown = (this.peakBalance - this.balance) / this.peakBalance
    return drawdown > this.drawdownPausePct
  }

  public getDrawdownPct(): number {
    if (this.peakBalance === 0) return 0
    return (this.peakBalance - this.balance) / this.peakBalance
  }

  public getDailyPnl(): number {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
    const dayTrades = this.trades.filter((t) => t.closedAt > oneDayAgo)
    return dayTrades.reduce((sum, t) => sum + t.pnlSol, 0)
  }

  public getTotalPnl(): number {
    return this.trades.reduce((sum, t) => sum + t.pnlSol, 0)
  }
}
