// ============================================================================
// PopulationManager — maintains the pool of 16-32 strategy candidates
// ============================================================================

import { Genome, StrategyRecord } from '../types'
import { Strategy } from './Strategy'
import { EvolutionEngine } from '../evolution/EvolutionEngine'
import { Logger } from '../observatory/Logger'

export class PopulationManager {
  private strategies: Map<string, Strategy> = new Map()
  private engine = new EvolutionEngine()
  private logger: Logger
  private maxPop: number

  constructor(logger: Logger) {
    this.logger = logger
    this.maxPop = parseInt(process.env.DARWIN_POP_SIZE || '16', 10)
  }

  public spawn(genome: Genome, isPaper = true, seededFromMemory = false): Strategy {
    const strat = new Strategy(genome, isPaper, seededFromMemory)
    this.strategies.set(strat.id, strat)
    console.log(
      '[Population] Spawned strategy ' +
      strat.id +
      ' (genome: ' +
      genome.id +
      (seededFromMemory ? ', source: persisted' : ', source: fresh') +
      ')'
    )
    return strat
  }

  public kill(strategyId: string, reason = 'generation_cull'): void {
    const strat = this.strategies.get(strategyId)
    if (!strat) return
    const fitness = strat.getFitness()
    this.logger.logGraveyard(strat.genome, fitness, reason)
    this.strategies.delete(strategyId)
    console.log(
      '[Population] Killed strategy ' + strategyId +
      ' (reason: ' + reason +
      ', tier: ' + fitness.tier +
      ', trades: ' + strat.trades.length +
      ', growth: ' + fitness.metrics.bankrollGrowthPct.toFixed(2) + '%)'
    )
  }

  public promote(strategyId: string): void {
    const strat = this.strategies.get(strategyId)
    if (!strat) return
    const fitness = strat.getFitness()
    console.log(
      '[Population] Promoting strategy ' + strategyId +
      ' from paper to live (tier: ' + fitness.tier +
      ', growth: ' + fitness.metrics.bankrollGrowthPct.toFixed(2) + '%)'
    )
    // In this version all strategies run paper mode; promotion is logged
  }

  public getAll(): Strategy[] {
    return Array.from(this.strategies.values())
  }

  public getPaperStrategies(): Strategy[] {
    return this.getAll().filter((s) => s.isPaper)
  }

  public getLiveStrategies(): Strategy[] {
    return this.getAll().filter((s) => !s.isPaper)
  }

  public getStrategy(id: string): Strategy | undefined {
    return this.strategies.get(id)
  }

  public size(): number {
    return this.strategies.size
  }

  public getMaxPop(): number {
    return this.maxPop
  }

  public runGenerationCycle(): void {
    if (this.strategies.size === 0) return

    const records: StrategyRecord[] = this.getAll().map((s) => ({
      id: s.id,
      genomeId: s.genome.id,
      genome: s.genome,
      trades: s.trades,
      startedAt: s.startedAt,
      isPaper: s.isPaper,
    }))

    const result = this.engine.runGeneration(records)

    // Kill bottom performers
    for (const id of result.kill) {
      this.kill(id, 'generation_cull')
    }

    // Log generation result
    this.logger.logGeneration(result)

    const scoreByStrategy = new Map(result.scores.map((score) => [score.strategyId, score]))

    // Save the qualified survivors so restarts remember what actually aligns.
    for (const strat of this.getAll()) {
      const fitness = scoreByStrategy.get(strat.id)
      if (!fitness) continue
      if (strat.trades.length < 3) continue
      if (fitness.tier === 'hard_fail' || fitness.tier === 'tier_c') continue
      this.logger.saveGenome(strat.genome, fitness)
    }

    for (const id of result.preserve) {
      const strat = this.strategies.get(id)
      if (!strat) continue
    }

    // Spawn new genomes from breeding/mutation/random
    for (const genome of result.newGenomes) {
      if (this.strategies.size < this.maxPop) {
        this.spawn(genome, true)
      }
    }

    console.log('[Population] Generation complete. Pop: ' + this.strategies.size + '/' + this.maxPop)
  }
}
