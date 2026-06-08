import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideReplayGateRefresh,
  isReplayGateRefreshArtifactName,
} from '../analysis/ReplayGateMonitorPolicy'

test('replay gate monitor records a baseline when no state exists and run-on-start is off', () => {
  const decision = decideReplayGateRefresh({
    eventFile: '/tmp/events-a.jsonl',
    eventSizeBytes: 100,
    state: null,
    minGrowthBytes: 50,
    runOnStart: false,
  })

  assert.equal(decision.shouldRun, false)
  assert.equal(decision.reason, 'no_state_record_baseline')
  assert.equal(decision.growthBytes, 0)
})

test('replay gate monitor runs immediately when no state exists and run-on-start is on', () => {
  const decision = decideReplayGateRefresh({
    eventFile: '/tmp/events-a.jsonl',
    eventSizeBytes: 100,
    state: null,
    minGrowthBytes: 50,
    runOnStart: true,
  })

  assert.equal(decision.shouldRun, true)
  assert.equal(decision.reason, 'no_state_run_on_start')
  assert.equal(decision.growthBytes, 0)
})

test('replay gate monitor waits when event growth is below threshold', () => {
  const decision = decideReplayGateRefresh({
    eventFile: '/tmp/events-a.jsonl',
    eventSizeBytes: 140,
    state: {
      eventFile: '/tmp/events-a.jsonl',
      eventSizeBytes: 100,
    },
    minGrowthBytes: 50,
    runOnStart: false,
  })

  assert.equal(decision.shouldRun, false)
  assert.equal(decision.reason, 'event_growth<50')
  assert.equal(decision.growthBytes, 40)
})

test('replay gate monitor runs when event growth reaches threshold', () => {
  const decision = decideReplayGateRefresh({
    eventFile: '/tmp/events-a.jsonl',
    eventSizeBytes: 150,
    state: {
      eventFile: '/tmp/events-a.jsonl',
      eventSizeBytes: 100,
    },
    minGrowthBytes: 50,
    runOnStart: false,
  })

  assert.equal(decision.shouldRun, true)
  assert.equal(decision.reason, 'event_growth>=50')
  assert.equal(decision.growthBytes, 50)
})

test('replay gate monitor runs when the active event file changes', () => {
  const decision = decideReplayGateRefresh({
    eventFile: '/tmp/events-b.jsonl',
    eventSizeBytes: 25,
    state: {
      eventFile: '/tmp/events-a.jsonl',
      eventSizeBytes: 100,
    },
    minGrowthBytes: 50,
    runOnStart: false,
  })

  assert.equal(decision.shouldRun, true)
  assert.equal(decision.reason, 'event_file_changed')
  assert.equal(decision.growthBytes, 25)
})

test('replay gate monitor runs when the same event file shrinks', () => {
  const decision = decideReplayGateRefresh({
    eventFile: '/tmp/events-a.jsonl',
    eventSizeBytes: 75,
    state: {
      eventFile: '/tmp/events-a.jsonl',
      eventSizeBytes: 100,
    },
    minGrowthBytes: 50,
    runOnStart: false,
  })

  assert.equal(decision.shouldRun, true)
  assert.equal(decision.reason, 'event_file_shrank_or_rotated')
  assert.equal(decision.growthBytes, -25)
})

test('replay gate monitor recognizes refresh artifacts without matching its state file', () => {
  assert.equal(isReplayGateRefreshArtifactName('replay-gate-refresh-2026-06-08T07-00-07-916Z.json'), true)
  assert.equal(isReplayGateRefreshArtifactName('replay-gate-refresh-monitor-state.json'), false)
  assert.equal(isReplayGateRefreshArtifactName('replay-gate-refresh.lock'), false)
})
