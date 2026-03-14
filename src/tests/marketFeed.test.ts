import test from 'node:test'
import assert from 'node:assert/strict'
import { getSignalCooldownKey } from '../market/MarketFeed'

test('market feed cooldown buckets are separated by signal type', () => {
  const migrationKey = getSignalCooldownKey({ mint: 'mint_1', type: 'migration' })
  const ammKey = getSignalCooldownKey({ mint: 'mint_1', type: 'amm_activity' })
  const whaleKey = getSignalCooldownKey({ mint: 'mint_1', type: 'whale_buy' })

  assert.notEqual(migrationKey, ammKey)
  assert.notEqual(migrationKey, whaleKey)
  assert.notEqual(ammKey, whaleKey)
})
