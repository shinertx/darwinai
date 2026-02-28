// ============================================================================
// SignalCompiler — compiles genome DAG to executable signal function
// ============================================================================

import { EntryGenome, MarketSignal, PricePoint, SignalNode } from '../types'

export type SignalFn = (signal: MarketSignal, priceHistory: PricePoint[]) => boolean

// Topological sort of nodes
function topoSort(nodes: SignalNode[]): SignalNode[] {
  const nodeMap = new Map<string, SignalNode>()
  for (const n of nodes) nodeMap.set(n.id, n)

  const visited = new Set<string>()
  const result: SignalNode[] = []

  function visit(id: string) {
    if (visited.has(id)) return
    visited.add(id)
    const node = nodeMap.get(id)
    if (!node) return
    for (const inp of node.inputs) visit(inp)
    result.push(node)
  }

  for (const n of nodes) visit(n.id)
  return result
}

function evaluateNode(
  node: SignalNode,
  signal: MarketSignal,
  priceHistory: PricePoint[],
  values: Map<string, boolean | number>
): boolean | number {
  const p = node.params
  const getInputBool = (idx: number): boolean => {
    if (idx >= node.inputs.length) return false
    const v = values.get(node.inputs[idx])
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v > 0
    return false
  }
  const getInputNum = (idx: number): number => {
    if (idx >= node.inputs.length) return 0
    const v = values.get(node.inputs[idx])
    if (typeof v === 'number') return v
    if (typeof v === 'boolean') return v ? 1 : 0
    return 0
  }

  switch (node.type) {
    case 'migration_signal':
      return signal.type === 'migration'

    case 'new_pool_age':
      return signal.poolAgeMs < (p.maxAgeMs || 300000)

    case 'liquidity_depth': {
      const minSol = p.minSol || 10
      const maxSol = p.maxSol || 1000
      return signal.liquiditySol >= minSol && signal.liquiditySol <= maxSol
    }

    case 'volume_spike': {
      if (priceHistory.length < 3) return false
      const window = Math.min(Math.floor(p.window || 5), priceHistory.length)
      const recent = priceHistory.slice(-window)
      const recentVol = recent.reduce((s: number, pt: PricePoint) => s + (pt.volume || 0), 0)
      const avgVol = priceHistory.length > window
        ? priceHistory.slice(-window * 2, -window).reduce((s: number, pt: PricePoint) => s + (pt.volume || 0), 0) / window
        : (recentVol / window)
      if (avgVol === 0) return false
      return (recentVol / window) > (p.multiplier || 2.0) * avgVol
    }

    case 'buy_pressure': {
      const eventVol = signal.eventData.tradeSizeSol || 0
      const liq = signal.liquiditySol || 1
      return (eventVol / liq) > (p.threshold || 0.05)
    }

    case 'large_tx_count': {
      const txSize = signal.eventData.tradeSizeSol || 0
      return txSize > (p.minSizeSol || 3) ? 1 : 0
    }

    case 'price_momentum': {
      if (priceHistory.length < 2) return false
      const window = Math.min(Math.floor(p.window || 3), priceHistory.length)
      const oldest = priceHistory[priceHistory.length - window]
      const newest = priceHistory[priceHistory.length - 1]
      if (!oldest || oldest.price === 0) return false
      const change = (newest.price - oldest.price) / oldest.price
      return change > (p.threshold || 0.05)
    }

    case 'price_breakout': {
      if (priceHistory.length < 3) return false
      const lookback = Math.min(Math.floor(p.lookback || 10), priceHistory.length - 1)
      const currentPrice = priceHistory[priceHistory.length - 1].price
      const historicalHigh = Math.max(...priceHistory.slice(-lookback - 1, -1).map((pt: PricePoint) => pt.price))
      return currentPrice > historicalHigh
    }

    case 'acceleration': {
      if (priceHistory.length < 3) return false
      const window = Math.min(Math.floor(p.window || 3), priceHistory.length)
      const prices = priceHistory.slice(-window).map((pt: PricePoint) => pt.price)
      if (prices.length < 3) return false
      const v1 = prices[1] - prices[0]
      const v2 = prices[prices.length - 1] - prices[prices.length - 2]
      const accel = v2 - v1
      return accel > (p.threshold || 0.005) * prices[0]
    }

    case 'whale_entry': {
      const tradeSol = signal.eventData.tradeSizeSol || 0
      return tradeSol > (p.threshold || 5)
    }

    case 'holder_concentration':
      // No holder data in signal — pass through
      return true

    case 'deployer_history':
      // No deployer data in signal — pass through
      return true

    case 'AND':
      return getInputBool(0) && getInputBool(1)

    case 'OR':
      return getInputBool(0) || getInputBool(1)

    case 'NOT':
      return !getInputBool(0)

    case 'THRESHOLD':
      return getInputNum(0) > (p.value || 0.5)

    case 'SEQUENCE':
      // Simplified: just AND (can't track timing in single eval)
      return getInputBool(0) && getInputBool(1)

    case 'WEIGHTED_SUM': {
      const w0 = p.w0 !== undefined ? p.w0 : 0.5
      const w1 = p.w1 !== undefined ? p.w1 : 0.5
      const sum = getInputNum(0) * w0 + getInputNum(1) * w1
      return sum > (p.threshold || 0.5)
    }

    default:
      return false
  }
}

export function compile(genome: EntryGenome): SignalFn {
  const sorted = topoSort(genome.nodes)

  return function evaluateEntry(signal: MarketSignal, priceHistory: PricePoint[]): boolean {
    const values = new Map<string, boolean | number>()

    for (const node of sorted) {
      const result = evaluateNode(node, signal, priceHistory, values)
      values.set(node.id, result)
    }

    const output = values.get(genome.outputNodeId)
    if (output === undefined) return false
    if (typeof output === 'boolean') return output
    if (typeof output === 'number') return output > 0
    return false
  }
}
