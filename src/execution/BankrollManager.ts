// ============================================================================
// BankrollManager — tracks SOL bankroll, sizes positions
// ============================================================================

import { ClosedTrade } from '../types'
import { resolveRuntimeConfig } from '../config/runtime'

export class BankrollManager {
  private balance: number
  private peakBalance: number
  private startedAt: number
  private trades: ClosedTrade[] = []
  private drawdownPausePct: number

  constructor() {
    const startBalance = parseFloat(process.env.STARTING_BALANCE_SOL || '1.0')
    const runtime = resolveRuntimeConfig(process.env)
    this.balance = startBalance
    this.peakBalance = startBalance
    this.startedAt = Date.now()
    // Paper trading is virtual — allow deeper drawdown so evolution has runway.
    // Live mode uses a strict halt to protect capital.
    const isPaper = runtime.mode === 'paper'
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
    cappedDesiredSizeSol: number
    poolCapSol: number
    sizeSol: number
    signalMultiplier: number
  } {
    const MAX_POSITION_SOL = 0.10
    // Signal-type multiplier: bet bigger on migrations, smaller on noisy amm swaps
    const signalMultiplier =
      signalType === 'migration' ? 3.0 :
      signalType === 'whale_buy' ? 0.75 :
      signalType === 'new_pool'  ? 1.0 :
      0.2  // amm_activity

    const desiredSizeSol = this.balance * capitalPct * signalMultiplier
    const cappedDesiredSizeSol = Math.min(desiredSizeSol, this.balance * 0.95, MAX_POSITION_SOL)
    const poolCapSol = poolLiqSol * maxPoolPct
    const sizeSol = Math.min(cappedDesiredSizeSol, poolCapSol)

    return {
      desiredSizeSol,
      cappedDesiredSizeSol,
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
