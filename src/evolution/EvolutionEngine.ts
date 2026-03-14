// ============================================================================
// EvolutionEngine — scores, selects, breeds, and mutates the population
// ============================================================================

import { Genome, StrategyRecord, GenerationResult, FitnessScore } from '../types'
import { FitnessScorer } from './FitnessScorer'
import { createRandom, crossover, mutate } from '../genome/GenomeFactory'
import { compareAssessments } from './MissionAssessment'

const PRESERVE_TOP = 5
const DELETE_BOTTOM = 10

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

    // Sort by tier priority first, then by the ordered mission rank tuple.
    scores.sort(compareAssessments)

    const ranked = scores.map((sc, i) => ({
      score: sc,
      strategy: strategies.find((s) => s.id === sc.strategyId)!,
    }))

    const qualified = ranked.filter((entry) => entry.score.tier === 'tier_a' || entry.score.tier === 'tier_b')
    const top = qualified.slice(0, PRESERVE_TOP)
    const preserve = top.map((r) => r.strategy.id)
    const preserveSet = new Set(preserve)

    const prioritizedCull = ranked
      .filter((entry) => !preserveSet.has(entry.strategy.id))
      .filter((entry) => entry.score.tier === 'hard_fail' || entry.score.tier === 'tier_c')
      .map((entry) => entry.strategy.id)

    const kill = [...prioritizedCull]
    if (kill.length < DELETE_BOTTOM) {
      for (let index = ranked.length - 1; index >= 0 && kill.length < DELETE_BOTTOM; index--) {
        const entry = ranked[index]
        if (preserveSet.has(entry.strategy.id) || kill.includes(entry.strategy.id)) continue
        kill.push(entry.strategy.id)
      }
    }
    const killSet = new Set(kill)

    // Get survivor genomes (not killed)
    const survivors = ranked.filter((r) => !killSet.has(r.strategy.id))
    const survivorGenomes = survivors.map((r) => r.strategy.genome)
    const breedPool = qualified.filter((entry) => !killSet.has(entry.strategy.id)).slice(0, Math.min(10, qualified.length))
    const newGenomes: Genome[] = []
    const targetNewGenomes = kill.length
    const breedCount = breedPool.length >= 2 ? Math.floor(targetNewGenomes * 0.45) : 0
    const mutateCount = survivorGenomes.length > 0 ? Math.floor(targetNewGenomes * 0.35) : 0

    for (let i = 0; i < breedCount; i++) {
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

    for (let i = 0; i < mutateCount && i < survivorGenomes.length; i++) {
      const idx = Math.floor(Math.random() * survivorGenomes.length)
      newGenomes.push(mutate(survivorGenomes[idx], this.generation))
    }

    while (newGenomes.length < targetNewGenomes) {
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
