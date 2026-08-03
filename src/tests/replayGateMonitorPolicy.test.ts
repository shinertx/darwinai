import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyReplayEventWindow,
  decideReplayGateRefresh,
  isReplayGateRefreshArtifactName,
} from '../analysis/ReplayGateMonitorPolicy'

test('replay gate monitor classifies only clean completed summaries as ready', () => {
  assert.deepEqual(classifyReplayEventWindow(null), {
    status: 'active',
    terminalReason: null,
  })
  assert.deepEqual(classifyReplayEventWindow({
    reason: 'completed',
    ingest: { queueOverflowed: false },
  }), {
    status: 'completed',
    terminalReason: 'completed',
  })
  assert.deepEqual(classifyReplayEventWindow({
    reason: 'completed',
    ingest: { queueOverflowed: true },
  }), {
    status: 'invalid',
    terminalReason: 'queue_overflow',
  })
  assert.deepEqual(classifyReplayEventWindow({ reason: 'SIGTERM' }), {
    status: 'invalid',
    terminalReason: 'SIGTERM',
  })
})

test('replay gate monitor refuses an incomplete event window', () => {
  const decision = decideReplayGateRefresh({
    eventFile: '/tmp/events-a.jsonl',
    eventSizeBytes: 100,
    state: null,
    minGrowthBytes: 50,
    runOnStart: false,
    eventWindowStatus: 'active',
  })

  assert.equal(decision.shouldRun, false)
  assert.equal(decision.reason, 'event_window_incomplete')
  assert.equal(decision.growthBytes, 0)
})

test('replay gate monitor refuses an invalid event window even with run-on-start enabled', () => {
  const decision = decideReplayGateRefresh({
    eventFile: '/tmp/events-a.jsonl',
    eventSizeBytes: 100,
    state: null,
    minGrowthBytes: 50,
    runOnStart: true,
    eventWindowStatus: 'invalid',
    eventTerminalReason: 'queue_overflow',
  })

  assert.equal(decision.shouldRun, false)
  assert.equal(decision.reason, 'event_window_invalid:queue_overflow')
  assert.equal(decision.growthBytes, 0)
})

test('replay gate monitor runs when a window first reaches completed', () => {
  const decision = decideReplayGateRefresh({
    eventFile: '/tmp/events-a.jsonl',
    eventSizeBytes: 150,
    state: {
      eventFile: '/tmp/events-a.jsonl',
      eventSizeBytes: 150,
      eventWindowStatus: 'active',
    },
    minGrowthBytes: 50,
    runOnStart: false,
    eventWindowStatus: 'completed',
    eventTerminalReason: 'completed',
  })

  assert.equal(decision.shouldRun, true)
  assert.equal(decision.reason, 'event_window_completed')
  assert.equal(decision.growthBytes, 150)
})

test('replay gate monitor waits when event growth is below threshold', () => {
  const decision = decideReplayGateRefresh({
    eventFile: '/tmp/events-a.jsonl',
    eventSizeBytes: 140,
    state: {
      eventFile: '/tmp/events-a.jsonl',
      eventSizeBytes: 100,
      eventWindowStatus: 'completed',
    },
    minGrowthBytes: 50,
    runOnStart: false,
    eventWindowStatus: 'completed',
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
      eventWindowStatus: 'completed',
    },
    minGrowthBytes: 50,
    runOnStart: false,
    eventWindowStatus: 'completed',
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
      eventWindowStatus: 'completed',
    },
    minGrowthBytes: 50,
    runOnStart: false,
    eventWindowStatus: 'completed',
  })

  assert.equal(decision.shouldRun, true)
  assert.equal(decision.reason, 'event_window_completed')
  assert.equal(decision.growthBytes, 25)
})

test('replay gate monitor runs when the same event file shrinks', () => {
  const decision = decideReplayGateRefresh({
    eventFile: '/tmp/events-a.jsonl',
    eventSizeBytes: 75,
    state: {
      eventFile: '/tmp/events-a.jsonl',
      eventSizeBytes: 100,
      eventWindowStatus: 'completed',
    },
    minGrowthBytes: 50,
    runOnStart: false,
    eventWindowStatus: 'completed',
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
