// ============================================================================
// Strategy — a single candidate organism with its genome and trade history
// ============================================================================

import { v4 as uuidv4 } from 'uuid'
import { Genome, MarketSignal, PricePoint, ClosedTrade, FitnessScore } from '../types'
import { compile, SignalFn } from '../genome/SignalCompiler'
import { FitnessScorer } from '../evolution/FitnessScorer'

const scorer = new FitnessScorer()

export class Strategy {
  public readonly id: string
  public readonly genome: Genome
  public readonly isPaper: boolean
  public trades: ClosedTrade[] = []
  public readonly startedAt: number
  private readonly seededFromMemory: boolean
  private signalFn: SignalFn
  private lastEntryAt = 0

  constructor(genome: Genome, isPaper: boolean, seededFromMemory = false) {
    this.id = 'strategy_' + uuidv4().slice(0, 8)
    this.genome = genome
    this.isPaper = isPaper
    this.startedAt = Date.now()
    this.seededFromMemory = seededFromMemory
    this.signalFn = compile(genome.entry)
  }

  public evaluateSignal(signal: MarketSignal, priceHistory: PricePoint[]): boolean {
    try {
      // Enforce cooldown
      const now = Date.now()
      if (now - this.lastEntryAt < this.genome.risk.cooldownMs) return false
      return this.signalFn(signal, priceHistory)
    } catch (e) {
      console.error('[Strategy] Signal evaluation error:', e)
      return false
    }
  }

  public recordEntry(): void {
    this.lastEntryAt = Date.now()
  }

  public recordTrade(trade: ClosedTrade): void {
    this.trades.push(trade)
  }

  public getFitness(): FitnessScore {
    return scorer.score(this.id, this.genome.id, this.trades, this.startedAt)
  }

  public getAssessment(): FitnessScore {
    return this.getFitness()
  }

  public wasSeededFromMemory(): boolean {
    return this.seededFromMemory
  }

  public getHoursActive(): number {
    return (Date.now() - this.startedAt) / (1000 * 60 * 60)
  }
}
