import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Logic extracted from CycleCard
function cycleStatus(cycle) {
  if (cycle.halted) return 'halted'
  if (cycle.failed) return 'failed'
  if (cycle.completed) return 'completed'
  return 'active'
}

function formatMs(ms) {
  if (!ms || ms < 1000) return `${ms || 0}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

describe('cycleStatus()', () => {
  it('returns active for an in-progress cycle', () => {
    assert.equal(cycleStatus({}), 'active')
  })

  it('returns completed', () => {
    assert.equal(cycleStatus({ completed: true }), 'completed')
  })

  it('returns failed', () => {
    assert.equal(cycleStatus({ failed: true }), 'failed')
  })

  it('returns halted — highest priority', () => {
    assert.equal(cycleStatus({ halted: true, failed: true, completed: true }), 'halted')
  })

  it('failed takes priority over completed', () => {
    assert.equal(cycleStatus({ failed: true, completed: true }), 'failed')
  })
})

describe('formatMs()', () => {
  it('formats sub-second durations with ms suffix', () => {
    assert.equal(formatMs(500), '500ms')
    assert.equal(formatMs(0), '0ms')
  })

  it('formats seconds', () => {
    assert.equal(formatMs(2500), '2.5s')
  })

  it('formats minutes', () => {
    assert.equal(formatMs(90000), '1m 30s')
  })

  it('handles null/undefined gracefully', () => {
    assert.equal(formatMs(null), '0ms')
    assert.equal(formatMs(undefined), '0ms')
  })
})
