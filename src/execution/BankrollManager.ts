// ============================================================================
// BankrollManager — tracks SOL bankroll, sizes positions
// ============================================================================

import { ClosedTrade } from '../types'

export class BankrollManager {
  private balance: number
  private peakBalance: number
  private startedAt: number
  private trades: ClosedTrade[] = []
  private drawdownPausePct: number

  constructor() {
    const startBalance = parseFloat(process.env.STARTING_BALANCE_SOL || '1.0')
    this.balance = startBalance
    this.peakBalance = startBalance
    this.startedAt = Date.now()
    // Paper trading is virtual — allow deeper drawdown so evolution has runway
    // Live mode uses strict 40% halt as per GENESIS spec
    const isPaper = process.env.PAPER_TRADE !== 'false'
    this.drawdownPausePct = isPaper ? 0.90 : 0.40
    console.log('[BankrollManager] Starting balance: ' + startBalance.toFixed(4) + ' SOL')
  }

  public getPositionSize(capitalPct: number, poolLiqSol: number, maxPoolPct: number): number {
    const desiredSize = this.balance * capitalPct
    const poolCap = poolLiqSol * maxPoolPct
    return Math.min(desiredSize, poolCap, this.balance * 0.95)
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
