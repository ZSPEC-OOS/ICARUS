import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Logic extracted from QualitySignals
function signalStatus(gate) {
  if (gate.passed === false) return 'fail'
  if (gate.passed === true) return 'pass'
  return 'unknown'
}

function formatMetric(gate) {
  if (gate.metric == null) return '—'
  if (typeof gate.metric === 'number') {
    if (gate.id === 'test_pass_rate' || gate.id === 'semantic_edit_distance') {
      return `${(gate.metric * 100).toFixed(1)}%`
    }
    return String(gate.metric)
  }
  return String(gate.metric)
}

function formatThreshold(gate) {
  if (gate.threshold == null && gate.min == null && gate.max == null) return '—'
  if (gate.min != null && gate.max != null) {
    return `${(gate.min * 100).toFixed(0)}%–${(gate.max * 100).toFixed(0)}%`
  }
  if (gate.threshold != null) {
    if (gate.id === 'test_pass_rate') return `≥${(gate.threshold * 100).toFixed(0)}%`
    return `≤${gate.threshold}`
  }
  return '—'
}

describe('signalStatus()', () => {
  it('returns pass for passed gates', () => {
    assert.equal(signalStatus({ passed: true }), 'pass')
  })

  it('returns fail for failed gates', () => {
    assert.equal(signalStatus({ passed: false }), 'fail')
  })

  it('returns unknown when passed is undefined', () => {
    assert.equal(signalStatus({}), 'unknown')
  })
})

describe('formatMetric()', () => {
  it('returns em dash for null metric', () => {
    assert.equal(formatMetric({ metric: null }), '—')
  })

  it('formats test_pass_rate as percentage', () => {
    assert.equal(formatMetric({ id: 'test_pass_rate', metric: 0.875 }), '87.5%')
  })

  it('formats semantic_edit_distance as percentage', () => {
    assert.equal(formatMetric({ id: 'semantic_edit_distance', metric: 0.5 }), '50.0%')
  })

  it('formats api_stability metric as plain number', () => {
    assert.equal(formatMetric({ id: 'api_stability', metric: 3 }), '3')
  })

  it('formats string metric as-is', () => {
    assert.equal(formatMetric({ id: 'x', metric: 'ok' }), 'ok')
  })
})

describe('formatThreshold()', () => {
  it('returns em dash when no threshold fields', () => {
    assert.equal(formatThreshold({ id: 'x' }), '—')
  })

  it('formats range threshold', () => {
    assert.equal(formatThreshold({ min: 0.15, max: 0.98 }), '15%–98%')
  })

  it('formats test_pass_rate threshold with >= prefix', () => {
    assert.equal(formatThreshold({ id: 'test_pass_rate', threshold: 0.8 }), '≥80%')
  })

  it('formats api_stability with <= prefix', () => {
    assert.equal(formatThreshold({ id: 'api_stability', threshold: 0 }), '≤0')
  })
})
