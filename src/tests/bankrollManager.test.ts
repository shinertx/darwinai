import test from 'node:test'
import assert from 'node:assert/strict'
import { BankrollManager } from '../execution/BankrollManager'

test('bankroll sizing exposes desired, capped, and fill-ratio math', () => {
  const previousMode = process.env.DARWIN_MODE
  const previousBalance = process.env.STARTING_BALANCE_SOL
  process.env.DARWIN_MODE = 'paper'
  process.env.STARTING_BALANCE_SOL = '1'

  const manager = new BankrollManager()
  const sizing = manager.getSizingPlan(0.05, 2, 0.03, 'migration')
  const fillRatio = sizing.desiredSizeSol > 0 ? sizing.sizeSol / sizing.desiredSizeSol : 0

  assert.equal(Number(sizing.desiredSizeSol.toFixed(3)), 0.15)
  assert.equal(Number(sizing.cappedSizeSol.toFixed(3)), 0.1)
  assert.equal(Number(sizing.poolCapSol.toFixed(3)), 0.06)
  assert.equal(Number(sizing.sizeSol.toFixed(3)), 0.06)
  assert.equal(Number(fillRatio.toFixed(2)), 0.4)

  if (previousMode == null) delete process.env.DARWIN_MODE
  else process.env.DARWIN_MODE = previousMode
  if (previousBalance == null) delete process.env.STARTING_BALANCE_SOL
  else process.env.STARTING_BALANCE_SOL = previousBalance
})
