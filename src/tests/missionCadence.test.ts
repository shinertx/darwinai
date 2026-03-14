import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveGenerationCadence } from '../config/mission'

test('generation cadence keeps standard defaults when research mode is off', () => {
  const cadence = resolveGenerationCadence({})

  assert.equal(cadence.intervalMin, 60)
  assert.equal(cadence.tradeThreshold, 75)
  assert.equal(cadence.profile, 'standard')
  assert.equal(cadence.source, 'defaults')
})

test('generation cadence switches to research defaults when enabled', () => {
  const cadence = resolveGenerationCadence({
    DARWIN_RESEARCH_MODE: 'true',
  })

  assert.equal(cadence.intervalMin, 20)
  assert.equal(cadence.tradeThreshold, 25)
  assert.equal(cadence.profile, 'research')
  assert.equal(cadence.source, 'research_defaults')
})

test('explicit cadence overrides research defaults', () => {
  const cadence = resolveGenerationCadence({
    DARWIN_RESEARCH_MODE: 'true',
    DARWIN_GENERATION_INTERVAL_MIN: '12',
    DARWIN_GENERATION_TRADE_THRESHOLD: '18',
  })

  assert.equal(cadence.intervalMin, 12)
  assert.equal(cadence.tradeThreshold, 18)
  assert.equal(cadence.profile, 'research')
  assert.equal(cadence.source, 'explicit')
})
