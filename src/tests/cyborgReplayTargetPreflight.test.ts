import fs from 'fs'
import os from 'os'
import path from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateCyborgReplayTargetPreflight } from '../promotion/CyborgReplayTargetPreflight'

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-replay-target-preflight-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeTarget(dir: string, name: string, body: unknown): string {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, JSON.stringify(body, null, 2) + '\n')
  return filePath
}

test('replay target preflight blocks promotion when no target-watch artifact exists', () => {
  withTempDir((dir) => {
    const result = evaluateCyborgReplayTargetPreflight({ inputDir: dir })

    assert.equal(result.allowed, false)
    assert.equal(result.reason, 'missing_target_watch')
    assert.deepEqual(result.blockers, ['missing_replay_target_watch'])
  })
})

test('replay target preflight blocks promotion while latest target is waiting', () => {
  withTempDir((dir) => {
    const artifact = writeTarget(dir, 'replay-target-watch-2026-06-08T00-00-00-000Z.json', {
      status: 'WAIT',
      candidates: [],
      bestMatch: {
        blockers: ['sample_pools<20', 'completed_paths<20'],
      },
    })

    const result = evaluateCyborgReplayTargetPreflight({ inputDir: dir })

    assert.equal(result.allowed, false)
    assert.equal(result.reason, 'target_not_ready')
    assert.equal(result.targetWatchPath, artifact)
    assert.equal(result.status, 'WAIT')
    assert.deepEqual(result.blockers, ['sample_pools<20', 'completed_paths<20'])
  })
})

test('replay target preflight allows promotion only on a clean paper candidate', () => {
  withTempDir((dir) => {
    const artifact = writeTarget(dir, 'replay-target-watch-2026-06-08T00-00-00-000Z.json', {
      status: 'PAPER_CANDIDATE',
      candidates: [{ segment: 'profile=low_buy_competition|rent=yes' }],
      bestMatch: {
        blockers: [],
      },
    })

    const result = evaluateCyborgReplayTargetPreflight({ inputDir: dir })

    assert.equal(result.allowed, true)
    assert.equal(result.reason, 'paper_candidate')
    assert.equal(result.targetWatchPath, artifact)
    assert.equal(result.candidateCount, 1)
  })
})

test('replay target preflight can be bypassed only as an explicit diagnostic override', () => {
  withTempDir((dir) => {
    writeTarget(dir, 'replay-target-watch-2026-06-08T00-00-00-000Z.json', {
      status: 'TARGET_NOT_FOUND',
      candidates: [],
      bestMatch: null,
    })

    const result = evaluateCyborgReplayTargetPreflight({
      inputDir: dir,
      allowReplayTargetBypass: true,
    })

    assert.equal(result.allowed, true)
    assert.equal(result.reason, 'override_target_not_ready')
    assert.equal(result.status, 'TARGET_NOT_FOUND')
  })
})
