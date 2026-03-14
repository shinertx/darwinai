import test from 'node:test'
import assert from 'node:assert/strict'
import { EvolutionEngine } from '../evolution/EvolutionEngine'
import { createRandom } from '../genome/GenomeFactory'
import { StrategyRecord } from '../types'
import { buildTierATrades, buildTierBTrades, buildTierCTrades, makeTrade } from './helpers'

function buildHardFailTrades() {
  return Array.from({ length: 10 }, (_, index) =>
    makeTrade(index, {
      signalType: 'whale_buy',
      pnlSol: -0.003,
      pnlPct: -0.06,
      exitReason: 'no_pump_bail',
      fillRatio: 0.7,
    })
  )
}

function record(id: string, trades: ReturnType<typeof buildTierATrades>, generation: number): StrategyRecord {
  const genome = createRandom(generation)
  genome.id = `${id}_genome`
  return {
    id,
    genomeId: genome.id,
    genome,
    trades,
    startedAt: Date.now() - 30 * 60 * 1000,
    isPaper: true,
  }
}

test('evolution preserves aligned tiers before culling weak ones', () => {
  const engine = new EvolutionEngine()
  const strategies: StrategyRecord[] = [
    record('tier_a_1', buildTierATrades(), 1),
    record('tier_a_2', buildTierATrades(), 1),
    record('tier_a_3', buildTierATrades(), 1),
    record('tier_b_1', buildTierBTrades(), 1),
    record('tier_b_2', buildTierBTrades(), 1),
    record('tier_b_3', buildTierBTrades(), 1),
    record('tier_c_1', buildTierCTrades(), 1),
    record('tier_c_2', buildTierCTrades(), 1),
    record('tier_c_3', buildTierCTrades(), 1),
    record('hard_fail_1', buildHardFailTrades(), 1),
    record('hard_fail_2', buildHardFailTrades(), 1),
    record('hard_fail_3', buildHardFailTrades(), 1),
  ]

  const result = engine.runGeneration(strategies)
  const preserveSet = new Set(result.preserve)
  const killSet = new Set(result.kill)

  assert.ok(result.preserve.length > 0)
  assert.ok([...preserveSet].every((id) => !id.startsWith('tier_c_') && !id.startsWith('hard_fail_')))
  assert.ok(['tier_c_1', 'tier_c_2', 'tier_c_3', 'hard_fail_1', 'hard_fail_2', 'hard_fail_3'].every((id) => killSet.has(id)))
  assert.equal(result.newGenomes.length, result.kill.length)
})
