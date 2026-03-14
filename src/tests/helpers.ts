import { ClosedTrade } from '../types'

export function makeTrade(
  index: number,
  overrides: Partial<ClosedTrade> = {}
): ClosedTrade {
  const openedAt = 1_000_000 + index * 1_000
  const closedAt = openedAt + 5_000
  return {
    id: `trade_${index}`,
    strategyId: overrides.strategyId || 'strategy_a',
    genomeId: overrides.genomeId || 'genome_a',
    mint: overrides.mint || `mint_${index}`,
    pool: overrides.pool || 'pool_1',
    entryPriceSol: overrides.entryPriceSol ?? 1,
    exitPriceSol: overrides.exitPriceSol ?? 1.2,
    sizeSol: overrides.sizeSol ?? 0.05,
    pnlSol: overrides.pnlSol ?? 0.01,
    pnlPct: overrides.pnlPct ?? 0.2,
    mfePct: overrides.mfePct ?? 0.25,
    maePct: overrides.maePct ?? -0.05,
    exitReason: overrides.exitReason || 'take_profit',
    openedAt: overrides.openedAt ?? openedAt,
    closedAt: overrides.closedAt ?? closedAt,
    holdMs: overrides.holdMs ?? 5_000,
    isPaper: overrides.isPaper ?? true,
    signalType: overrides.signalType || 'migration',
    poolLiqSol: overrides.poolLiqSol ?? 100,
    desiredSizeSol: overrides.desiredSizeSol ?? 0.09,
    cappedSizeSol: overrides.cappedSizeSol ?? 0.09,
    poolCapSol: overrides.poolCapSol ?? 0.08,
    fillRatio: overrides.fillRatio ?? 0.88,
  }
}

export function buildTierATrades(): ClosedTrade[] {
  const trades: ClosedTrade[] = []
  for (let index = 0; index < 11; index++) {
    const winner = index < 7
    trades.push(makeTrade(index, {
      signalType: 'migration',
      pnlSol: winner ? (index === 0 ? 0.03 : 0.012) : -0.004,
      pnlPct: winner ? (index === 0 ? 0.55 : 0.22) : -0.08,
      exitReason: winner ? 'take_profit' : 'no_pump_bail',
      fillRatio: 0.86,
    }))
  }
  trades.push(makeTrade(99, {
    signalType: 'whale_buy',
    pnlSol: 0.003,
    pnlPct: 0.08,
    exitReason: 'take_profit',
    fillRatio: 0.82,
  }))
  return trades
}

export function buildTierBTrades(): ClosedTrade[] {
  const trades: ClosedTrade[] = []
  for (let index = 0; index < 9; index++) {
    const winner = index < 5
    trades.push(makeTrade(index, {
      signalType: 'migration',
      pnlSol: winner ? (index === 0 ? 0.018 : 0.01) : -0.0045,
      pnlPct: winner ? (index === 0 ? 0.3 : 0.16) : -0.08,
      exitReason: index === 8 ? 'no_pump_bail' : (winner ? 'take_profit' : 'time_stop'),
      fillRatio: 0.62,
    }))
  }
  for (let index = 9; index < 12; index++) {
    trades.push(makeTrade(index, {
      signalType: 'whale_buy',
      pnlSol: index === 10 ? -0.003 : 0.002,
      pnlPct: index === 10 ? -0.06 : 0.05,
      exitReason: index === 10 ? 'time_stop' : 'take_profit',
      fillRatio: 0.58,
    }))
  }
  return trades
}

export function buildTierCTrades(): ClosedTrade[] {
  const trades: ClosedTrade[] = []
  for (let index = 0; index < 8; index++) {
    const winner = index < 4
    trades.push(makeTrade(index, {
      signalType: 'migration',
      pnlSol: winner ? 0.008 : -0.003,
      pnlPct: winner ? 0.18 : -0.06,
      exitReason: index === 7 ? 'no_pump_bail' : (winner ? 'take_profit' : 'time_stop'),
      fillRatio: 0.75,
    }))
  }
  for (let index = 8; index < 12; index++) {
    trades.push(makeTrade(index, {
      signalType: 'whale_buy',
      pnlSol: index % 2 === 0 ? 0.002 : -0.002,
      pnlPct: index % 2 === 0 ? 0.05 : -0.04,
      exitReason: 'time_stop',
      fillRatio: 0.72,
    }))
  }
  return trades
}
