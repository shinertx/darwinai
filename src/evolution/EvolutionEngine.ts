// ============================================================================
// EvolutionEngine — scores, selects, breeds, and mutates the population
// ============================================================================

import { Genome, StrategyRecord, GenerationResult, FitnessScore } from '../types'
import { FitnessScorer } from './FitnessScorer'
import { createRandom, crossover, mutate } from '../genome/GenomeFactory'

const PRESERVE_TOP = 5
const DELETE_BOTTOM = 10
const BREED_COUNT = 10
const MUTATE_COUNT = 7
const SPAWN_RANDOM = 5

export class EvolutionEngine {
  private scorer = new FitnessScorer()
  private generation = 0

  public runGeneration(strategies: StrategyRecord[]): GenerationResult {
    this.generation++
    console.log('[Evolution] Starting generation ' + this.generation + ' with ' + strategies.length + ' strategies')

    // Score all strategies
    const scores: FitnessScore[] = strategies.map((s) =>
      this.scorer.score(s.id, s.genomeId, s.trades, s.startedAt)
    )

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score)

    const ranked = scores.map((sc, i) => ({
      score: sc,
      strategy: strategies.find((s) => s.id === sc.strategyId)!,
    }))

    // Bottom 10 are killed
    const bottom = ranked.slice(-DELETE_BOTTOM)
    const kill = bottom.map((r) => r.strategy.id)

    // Top 5 are preserved
    const top = ranked.slice(0, PRESERVE_TOP)
    const preserve = top.map((r) => r.strategy.id)

    // Get survivor genomes (not killed)
    const survivors = ranked.filter((r) => !kill.includes(r.strategy.id))
    const survivorGenomes = survivors.map((r) => r.strategy.genome)

    // Breed 10 from top performers (random pairs from top 5-10)
    const breedPool = ranked.slice(0, Math.min(10, ranked.length))
    const newGenomes: Genome[] = []

    for (let i = 0; i < BREED_COUNT; i++) {
      const aIdx = Math.floor(Math.random() * breedPool.length)
      let bIdx = Math.floor(Math.random() * breedPool.length)
      while (bIdx === aIdx && breedPool.length > 1) bIdx = Math.floor(Math.random() * breedPool.length)
      const child = crossover(
        breedPool[aIdx].strategy.genome,
        breedPool[bIdx].strategy.genome,
        this.generation
      )
      newGenomes.push(child)
    }

    // Mutate 7 from survivors
    for (let i = 0; i < MUTATE_COUNT && i < survivorGenomes.length; i++) {
      const idx = Math.floor(Math.random() * survivorGenomes.length)
      newGenomes.push(mutate(survivorGenomes[idx], this.generation))
    }

    // Spawn 5 completely random
    for (let i = 0; i < SPAWN_RANDOM; i++) {
      newGenomes.push(createRandom(this.generation))
    }

    console.log('[Evolution] Gen ' + this.generation + ' result: kill=' + kill.length + ' preserve=' + preserve.length + ' new=' + newGenomes.length)

    return {
      kill,
      preserve,
      newGenomes,
      generation: this.generation,
      scores,
    }
  }

  public getGeneration(): number {
    return this.generation
  }
}
