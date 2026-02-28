// ============================================================================
// PaperExecutor — simulated trade execution with realistic slippage model
// ============================================================================

import { v4 as uuidv4 } from 'uuid'
import { Genome, MarketSignal, Position, ClosedTrade } from '../types'

function calcSlippage(positionSol: number, poolLiqSol: number): number {
  if (poolLiqSol === 0) return 0.5
  const impactPct = positionSol / poolLiqSol
  if (impactPct > 0.08) return 0.20 + Math.random() * 0.30
  if (impactPct > 0.05) return 0.10 + Math.random() * 0.10
  if (impactPct > 0.02) return 0.05 + Math.random() * 0.05
  return 0.01 + Math.random() * 0.02
}

// How long after position open before price-dependent exits can fire.
// The entry price is injected into the feed immediately, so we need to
// wait at least one full poll cycle (3s) before treating price data as
// "fresh" market information. 5s gives comfortable margin.
const PRICE_UPDATE_GUARD_MS = 5000

export class PaperExecutor {
  private openPositions: Map<string, Position> = new Map()
  // Tracks the last time the tick loop saw a fresh price for this position
  private lastRealPriceAt: Map<string, number> = new Map()

  public open(
    signal: MarketSignal,
    genome: Genome,
    strategyId: string,
    sizeSol: number,
    entryPrice: number
  ): Position {
    const position: Position = {
      id: uuidv4(),
      strategyId,
      genomeId: genome.id,
      mint: signal.mint,
      pool: signal.pool,
      entryPriceSol: entryPrice,
      sizeSol,
      openedAt: Date.now(),
      peakPriceSol: entryPrice,
      lowestPriceSol: entryPrice,
      isPaper: true,
      poolLiqSol: signal.liquiditySol,
    }
    this.openPositions.set(position.id, position)
    // Do NOT pre-set lastRealPriceAt here — we want the first genuine
    // price observation from the poll loop (not the entry injection) to
    // be the trigger for price-dependent exits.
    return position
  }

  public tick(currentPrices: Map<string, number>, genomes: Map<string, Genome>): ClosedTrade[] {
    const closed: ClosedTrade[] = []
    const now = Date.now()

    for (const [posId, pos] of this.openPositions) {
      const genome = genomes.get(pos.genomeId)
      if (!genome) continue

      const rawPrice = currentPrices.get(pos.mint)

      // Update price tracking whenever we have a live price
      if (rawPrice !== undefined && rawPrice > 0) {
        if (rawPrice > pos.peakPriceSol) pos.peakPriceSol = rawPrice
        if (rawPrice < pos.lowestPriceSol) pos.lowestPriceSol = rawPrice
        this.lastRealPriceAt.set(posId, now)
      }

      // Use current price, or entry price if no update yet
      const currentPrice = rawPrice !== undefined && rawPrice > 0 ? rawPrice : pos.entryPriceSol

      // hadPriceUpdate: require that BOTH:
      //   1. We have recorded at least one price update (lastRealPriceAt is set)
      //   2. That update happened at least PRICE_UPDATE_GUARD_MS after position open
      // This prevents the entry-price injection (which lands in the feed at t=0)
      // from immediately enabling price-sensitive exit logic. We wait for the
      // first genuine poll cycle to complete (~3s) before exits can fire.
      const lastUpdate = this.lastRealPriceAt.get(posId) || 0
      const hadPriceUpdate = lastUpdate > 0 && lastUpdate > pos.openedAt + PRICE_UPDATE_GUARD_MS

      const holdMs = now - pos.openedAt
      const pricePct = (currentPrice - pos.entryPriceSol) / pos.entryPriceSol
      const peakPct = (pos.peakPriceSol - pos.entryPriceSol) / pos.entryPriceSol

      const ex = genome.exit
      let exitReason = ''

      // Take profit — only with verified price update
      if (hadPriceUpdate && pricePct >= ex.takeProfitPct) {
        exitReason = 'take_profit'
      }
      // Trailing stop — only with verified price update
      else if (hadPriceUpdate && peakPct >= ex.trailingActivatePct) {
        const trailLevel = pos.peakPriceSol * (1 - ex.trailingDistancePct)
        if (currentPrice <= trailLevel) {
          exitReason = 'trailing_stop'
        }
      }
      // Time stop — always fires (position held too long regardless of price)
      else if (holdMs >= ex.timeStopMs) {
        exitReason = 'time_stop'
      }
      // No pump bail — verified price update AND held long enough AND price flat
      else if (hadPriceUpdate && holdMs >= ex.noPumpBailMs && pricePct < 0.02) {
        exitReason = 'no_pump_bail'
      }
      // Fade exit — verified price update AND had meaningful run AND gave it back
      else if (hadPriceUpdate && peakPct >= 0.05) {
        const giveback = (pos.peakPriceSol - currentPrice) / pos.peakPriceSol
        if (giveback >= ex.fadeGivebackPct) {
          exitReason = 'fade_exit'
        }
      }

      if (exitReason) {
        const slippage = calcSlippage(pos.sizeSol, pos.poolLiqSol)
        const exitPrice = currentPrice * (1 - slippage)
        const pnlSol = pos.sizeSol * (exitPrice - pos.entryPriceSol) / pos.entryPriceSol
        const pnlPct = (exitPrice - pos.entryPriceSol) / pos.entryPriceSol
        const mfePct = (pos.peakPriceSol - pos.entryPriceSol) / pos.entryPriceSol
        const maePct = (pos.lowestPriceSol - pos.entryPriceSol) / pos.entryPriceSol

        const trade: ClosedTrade = {
          id: uuidv4(),
          strategyId: pos.strategyId,
          genomeId: pos.genomeId,
          mint: pos.mint,
          pool: pos.pool,
          entryPriceSol: pos.entryPriceSol,
          exitPriceSol: exitPrice,
          sizeSol: pos.sizeSol,
          pnlSol,
          pnlPct,
          mfePct,
          maePct,
          exitReason,
          openedAt: pos.openedAt,
          closedAt: now,
          holdMs,
          isPaper: pos.isPaper,
        }

        this.openPositions.delete(posId)
        this.lastRealPriceAt.delete(posId)
        closed.push(trade)
      }
    }

    return closed
  }

  public getOpenPositions(): Position[] {
    return Array.from(this.openPositions.values())
  }

  public getOpenPositionCount(strategyId?: string): number {
    if (!strategyId) return this.openPositions.size
    return Array.from(this.openPositions.values()).filter((p) => p.strategyId === strategyId).length
  }

  public removePosition(positionId: string): void {
    this.openPositions.delete(positionId)
    this.lastRealPriceAt.delete(positionId)
  }
}
