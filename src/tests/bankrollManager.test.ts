import test from 'node:test'
import assert from 'node:assert/strict'
import { BankrollManager } from '../execution/BankrollManager'

test('bankroll sizing exposes desired, capped, and fill-ratio math', () => {
  const previousMode = process.env.DARWIN_MODE
  const previousBalance = process.env.STARTING_BALANCE_SOL
  const previousPaperMaxPct = process.env.DARWIN_PAPER_MAX_POSITION_PCT
  process.env.DARWIN_MODE = 'paper'
  process.env.STARTING_BALANCE_SOL = '1'
  process.env.DARWIN_PAPER_MAX_POSITION_PCT = '0.12'

  const manager = new BankrollManager()
  const sizing = manager.getSizingPlan(0.05, 40, 0.03, 'migration')
  const fillRatio = sizing.desiredSizeSol > 0 ? sizing.sizeSol / sizing.desiredSizeSol : 0

  assert.equal(Number(sizing.desiredSizeSol.toFixed(3)), 0.125)
  assert.equal(Number(sizing.cappedSizeSol.toFixed(3)), 0.12)
  assert.equal(Number(sizing.poolCapSol.toFixed(3)), 1.2)
  assert.equal(Number(sizing.sizeSol.toFixed(3)), 0.12)
  assert.equal(Number(fillRatio.toFixed(2)), 0.96)

  if (previousMode == null) delete process.env.DARWIN_MODE
  else process.env.DARWIN_MODE = previousMode
  if (previousBalance == null) delete process.env.STARTING_BALANCE_SOL
  else process.env.STARTING_BALANCE_SOL = previousBalance
  if (previousPaperMaxPct == null) delete process.env.DARWIN_PAPER_MAX_POSITION_PCT
  else process.env.DARWIN_PAPER_MAX_POSITION_PCT = previousPaperMaxPct
})

test('bankroll sizing respects the fixed live trade size in live mode', () => {
  const previousMode = process.env.DARWIN_MODE
  const previousBalance = process.env.STARTING_BALANCE_SOL
  const previousLiveSize = process.env.LIVE_TRADE_SIZE_SOL
  process.env.DARWIN_MODE = 'live'
  process.env.STARTING_BALANCE_SOL = '5'
  process.env.LIVE_TRADE_SIZE_SOL = '0.001'

  const manager = new BankrollManager()
  const sizing = manager.getSizingPlan(0.05, 100, 0.03, 'migration')

  assert.equal(Number(sizing.desiredSizeSol.toFixed(3)), 0.001)
  assert.equal(Number(sizing.cappedSizeSol.toFixed(3)), 0.001)
  assert.equal(Number(sizing.sizeSol.toFixed(3)), 0.001)
  assert.equal(sizing.signalMultiplier, 1)

  if (previousMode == null) delete process.env.DARWIN_MODE
  else process.env.DARWIN_MODE = previousMode
  if (previousBalance == null) delete process.env.STARTING_BALANCE_SOL
  else process.env.STARTING_BALANCE_SOL = previousBalance
  if (previousLiveSize == null) delete process.env.LIVE_TRADE_SIZE_SOL
  else process.env.LIVE_TRADE_SIZE_SOL = previousLiveSize
})
