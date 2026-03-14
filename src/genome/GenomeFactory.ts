// ============================================================================
// GenomeFactory — generates, crosses, and mutates genomes
// ============================================================================

import { v4 as uuidv4 } from 'uuid'
import {
  Genome, EntryGenome, ExitGenome, RiskGenome,
  SignalNode, SignalType
} from '../types'

const LEAF_SIGNAL_TYPES: SignalType[] = [
  'migration_signal', 'new_pool_age', 'liquidity_depth',
  'volume_spike', 'buy_pressure', 'whale_entry',
  'price_momentum', 'price_breakout', 'acceleration',
]

const LOGIC_TYPES: SignalType[] = ['AND', 'OR', 'NOT', 'THRESHOLD', 'WEIGHTED_SUM']
type StrategyBias = 'migration' | 'exploration'

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function randInt(min: number, max: number): number {
  return Math.floor(randBetween(min, max + 1))
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function defaultParams(type: SignalType): Record<string, number> {
  switch (type) {
    case 'migration_signal': return {}
    case 'new_pool_age': return { maxAgeMs: randBetween(30000, 300000) }
    case 'liquidity_depth': return { minSol: randBetween(10, 50), maxSol: randBetween(100, 500) }
    case 'volume_spike': return { multiplier: randBetween(1.5, 5.0), window: randInt(3, 10) }
    case 'buy_pressure': return { threshold: randBetween(0.5, 0.8), window: randInt(3, 10) }
    case 'large_tx_count': return { threshold: randBetween(1, 5), minSizeSol: randBetween(1, 5) }
    case 'price_momentum': return { threshold: randBetween(0.02, 0.15), window: randInt(2, 8) }
    case 'price_breakout': return { lookback: randInt(5, 20) }
    case 'acceleration': return { threshold: randBetween(0.01, 0.10), window: randInt(2, 5) }
    case 'whale_entry': return { threshold: randBetween(2, 15) }
    case 'holder_concentration': return { maxPct: randBetween(0.3, 0.8) }
    case 'deployer_history': return { minScore: randBetween(0.3, 0.8) }
    case 'AND': return {}
    case 'OR': return {}
    case 'NOT': return {}
    case 'THRESHOLD': return { value: randBetween(0.1, 0.9) }
    case 'SEQUENCE': return { delayMs: randBetween(1000, 10000) }
    case 'WEIGHTED_SUM': return { threshold: randBetween(0.3, 0.7), w0: Math.random(), w1: Math.random() }
    default: return {}
  }
}

function randomExitGenome(bias: StrategyBias = 'exploration'): ExitGenome {
  if (bias === 'migration') {
    return {
      takeProfitPct: randBetween(0.25, 1.20),
      trailingActivatePct: randBetween(0.10, 0.35),
      trailingDistancePct: randBetween(0.08, 0.22),
      timeStopMs: randBetween(60000, 300000),
      noPumpBailMs: randBetween(12000, 30000),
      fadeGivebackPct: randBetween(0.15, 0.35),
      moonbagPct: Math.random() < 0.45 ? randBetween(0.12, 0.45) : 0,
    }
  }

  return {
    takeProfitPct: randBetween(0.08, 0.80),
    trailingActivatePct: randBetween(0.04, 0.20),
    trailingDistancePct: randBetween(0.05, 0.25),
    timeStopMs: randBetween(30000, 180000),
    noPumpBailMs: randBetween(15000, 45000),
    fadeGivebackPct: randBetween(0.2, 0.5),
    moonbagPct: Math.random() < 0.3 ? randBetween(0.1, 0.5) : 0,
  }
}

function randomRiskGenome(): RiskGenome {
  return {
    capitalPct: randBetween(0.01, 0.05),
    maxConcurrent: randInt(1, 6),
    drawdownPausePct: randBetween(0.3, 0.6),
    cooldownMs: randBetween(1000, 10000),
    maxPoolPct: randBetween(0.03, 0.08),
  }
}

function buildRandomEntryGenome(): EntryGenome {
  const nodeCount = randInt(2, 4)
  const nodes: SignalNode[] = []

  for (let i = 0; i < nodeCount; i++) {
    const type = pick(LEAF_SIGNAL_TYPES)
    nodes.push({
      id: 'node_' + uuidv4().slice(0, 8),
      type,
      params: defaultParams(type),
      inputs: [],
    })
  }

  if (nodes.length >= 2) {
    const combType = pick(['AND', 'OR', 'WEIGHTED_SUM'] as SignalType[])
    const combNode: SignalNode = {
      id: 'node_' + uuidv4().slice(0, 8),
      type: combType,
      params: defaultParams(combType),
      inputs: nodes.slice(0, 2).map((n: SignalNode) => n.id),
    }
    nodes.push(combNode)
    return { nodes, outputNodeId: combNode.id }
  }

  return { nodes, outputNodeId: nodes[nodes.length - 1].id }
}

function buildMigrationBiasedEntryGenome(): EntryGenome {
  const migNode: SignalNode = {
    id: 'node_' + uuidv4().slice(0, 8),
    type: 'migration_signal',
    params: {},
    inputs: [],
  }
  const nodes: SignalNode[] = [migNode]
  let outputId = migNode.id

  // 60% chance to add a liquidity depth filter (AND with migration)
  if (Math.random() < 0.60) {
    const liqNode: SignalNode = {
      id: 'node_' + uuidv4().slice(0, 8),
      type: 'liquidity_depth',
      params: { minSol: randBetween(20, 100), maxSol: randBetween(200, 1000) },
      inputs: [],
    }
    const andNode: SignalNode = {
      id: 'node_' + uuidv4().slice(0, 8),
      type: 'AND',
      params: {},
      inputs: [migNode.id, liqNode.id],
    }
    nodes.push(liqNode, andNode)
    outputId = andNode.id
  }

  return { nodes, outputNodeId: outputId }
}

export function createRandom(generation = 0): Genome {
  const bias: StrategyBias = Math.random() < 0.80 ? 'migration' : 'exploration'
  const entry = bias === 'migration'
    ? buildMigrationBiasedEntryGenome()
    : buildRandomEntryGenome()

  return {
    id: 'genome_' + uuidv4().slice(0, 8),
    entry,
    exit: randomExitGenome(bias),
    risk: randomRiskGenome(),
    generation,
    parentIds: [],
    createdAt: Date.now(),
  }
}

export function crossover(a: Genome, b: Genome, generation: number): Genome {
  const aHasMigration = a.entry.nodes.some((n: SignalNode) => n.type === 'migration_signal')
  const bHasMigration = b.entry.nodes.some((n: SignalNode) => n.type === 'migration_signal')
  const eitherHasMigration = aHasMigration || bHasMigration

  let useAEntry: boolean
  if (eitherHasMigration && Math.random() < 0.70) {
    // Inherit migration-focused entry from whichever parent has it
    useAEntry = aHasMigration ? true : false
  } else {
    useAEntry = Math.random() < 0.5
  }
  const entry = deepClone(useAEntry ? a.entry : b.entry)
  const entryBias: StrategyBias = entry.nodes.some((n: SignalNode) => n.type === 'migration_signal')
    ? 'migration'
    : 'exploration'
  const exit = Math.random() < 0.7
    ? deepClone(entryBias === 'migration' ? (aHasMigration ? a.exit : b.exit) : (useAEntry ? b.exit : a.exit))
    : randomExitGenome(entryBias)

  const risk: RiskGenome = {
    capitalPct: Math.max(a.risk.capitalPct, b.risk.capitalPct) * 0.6 +
      Math.min(a.risk.capitalPct, b.risk.capitalPct) * 0.4,
    maxConcurrent: Math.random() < 0.5 ? a.risk.maxConcurrent : b.risk.maxConcurrent,
    drawdownPausePct: (a.risk.drawdownPausePct + b.risk.drawdownPausePct) / 2,
    cooldownMs: (a.risk.cooldownMs + b.risk.cooldownMs) / 2,
    maxPoolPct: (a.risk.maxPoolPct + b.risk.maxPoolPct) / 2,
  }

  return {
    id: 'genome_' + uuidv4().slice(0, 8),
    entry,
    exit,
    risk,
    generation,
    parentIds: [a.id, b.id],
    createdAt: Date.now(),
  }
}

export function mutate(g: Genome, generation: number): Genome {
  const clone = deepClone(g)
  clone.id = 'genome_' + uuidv4().slice(0, 8)
  clone.generation = generation
  clone.parentIds = [g.id]
  clone.createdAt = Date.now()

  const roll = Math.random()

  // Mutation resistance: migration-rooted genomes are 85% resistant to type changes
  const hasMigrationRoot = clone.entry.nodes.some((n: SignalNode) => n.type === 'migration_signal')
  if (hasMigrationRoot && Math.random() < 0.85) {
    // Only mutate params, not structure
    if (clone.entry.nodes.length > 0) {
      const node = pick(clone.entry.nodes)
      for (const key of Object.keys(node.params)) {
        node.params[key] = node.params[key] * (0.8 + Math.random() * 0.4)
      }
    }
    return clone
  }

  if (roll < 0.05) {
    clone.entry = buildRandomEntryGenome()
  } else if (roll < 0.10) {
    clone.exit = randomExitGenome(hasMigrationRoot ? 'migration' : 'exploration')
  } else if (roll < 0.35) {
    if (clone.entry.nodes.length > 0) {
      const node = pick(clone.entry.nodes)
      for (const key of Object.keys(node.params)) {
        node.params[key] = node.params[key] * (0.8 + Math.random() * 0.4)
      }
    }
  } else if (roll < 0.50) {
    const type = pick(LEAF_SIGNAL_TYPES)
    const newNode: SignalNode = {
      id: 'node_' + uuidv4().slice(0, 8),
      type,
      params: defaultParams(type),
      inputs: [],
    }
    const combinator = clone.entry.nodes.find((n: SignalNode) => LOGIC_TYPES.includes(n.type))
    if (combinator && combinator.inputs.length < 3) {
      combinator.inputs.push(newNode.id)
    }
    clone.entry.nodes.push(newNode)
  } else if (roll < 0.60) {
    const removable = clone.entry.nodes.filter(
      (n: SignalNode) => n.id !== clone.entry.outputNodeId && n.inputs.length === 0
    )
    if (removable.length > 0) {
      const toRemove = pick(removable)
      clone.entry.nodes = clone.entry.nodes.filter((n: SignalNode) => n.id !== toRemove.id)
      clone.entry.nodes.forEach((n: SignalNode) => {
        n.inputs = n.inputs.filter((id: string) => id !== toRemove.id)
      })
    }
  } else if (roll < 0.75) {
    const ex = clone.exit
    ex.takeProfitPct = clamp(ex.takeProfitPct * (0.8 + Math.random() * 0.4), 0.05, 1.0)
    ex.trailingActivatePct = clamp(ex.trailingActivatePct * (0.8 + Math.random() * 0.4), 0.02, 0.3)
    ex.trailingDistancePct = clamp(ex.trailingDistancePct * (0.8 + Math.random() * 0.4), 0.03, 0.4)
    ex.timeStopMs = clamp(ex.timeStopMs * (0.8 + Math.random() * 0.4), 20000, 240000)
    ex.noPumpBailMs = clamp(ex.noPumpBailMs * (0.8 + Math.random() * 0.4), 10000, 60000)
    ex.fadeGivebackPct = clamp(ex.fadeGivebackPct * (0.8 + Math.random() * 0.4), 0.1, 0.6)
  } else {
    const rk = clone.risk
    rk.capitalPct = clamp(rk.capitalPct * (0.9 + Math.random() * 0.2), 0.005, 0.05)
    rk.drawdownPausePct = clamp(rk.drawdownPausePct * (0.9 + Math.random() * 0.2), 0.1, 0.8)
    rk.cooldownMs = clamp(rk.cooldownMs * (0.8 + Math.random() * 0.4), 500, 30000)
    rk.maxPoolPct = clamp(rk.maxPoolPct * (0.8 + Math.random() * 0.4), 0.01, 0.1)
  }

  return clone
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}
