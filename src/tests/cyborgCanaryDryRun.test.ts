import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateDryRunModeledReturn } from '../cli/cyborgCanary'

test('dry-run modeled return subtracts fixed execution cost from gross price return', () => {
  const modeled = calculateDryRunModeledReturn(
    1,
    1.25,
    0.0001,
    0.000015966
  )

  assert.equal(modeled.modeledGrossReturnPct, 25)
  assert.equal(modeled.modeledCostSol, 0.000015966)
  assert.equal(Number(modeled.modeledCostPctOnSize.toFixed(3)), 15.966)
  assert.equal(Number(modeled.modeledNetReturnPct?.toFixed(3)), 9.034)
  assert.equal(Number(modeled.modeledNetReturnSol?.toFixed(9)), 0.000009034)
})

test('dry-run modeled return is incomplete without usable entry and exit prices', () => {
  const modeled = calculateDryRunModeledReturn(
    1,
    null,
    0.0001,
    0.000015966
  )

  assert.equal(modeled.modeledGrossReturnPct, null)
  assert.equal(modeled.modeledNetReturnPct, null)
  assert.equal(modeled.modeledNetReturnSol, null)
  assert.equal(Number(modeled.modeledCostPctOnSize.toFixed(3)), 15.966)
})
