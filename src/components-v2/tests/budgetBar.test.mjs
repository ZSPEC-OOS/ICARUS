import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Pure logic extracted from BudgetBar — colour thresholds and ratio clamping
function colorClass(used, total) {
  const safeTotal = total > 0 ? total : 1
  const ratio = Math.min(1, Math.max(0, used / safeTotal))
  if (ratio >= 0.9) return 'danger'
  if (ratio >= 0.7) return 'warn'
  return 'ok'
}

function pct(used, total) {
  const safeTotal = total > 0 ? total : 1
  const ratio = Math.min(1, Math.max(0, used / safeTotal))
  return (ratio * 100).toFixed(1)
}

describe('BudgetBar logic', () => {
  it('classifies low usage as ok', () => {
    assert.equal(colorClass(50, 200), 'ok')
  })

  it('classifies 70% as warn', () => {
    assert.equal(colorClass(70, 100), 'warn')
  })

  it('classifies 90% as danger', () => {
    assert.equal(colorClass(90, 100), 'danger')
  })

  it('classifies 100% as danger', () => {
    assert.equal(colorClass(100, 100), 'danger')
  })

  it('clamps ratio above 1', () => {
    assert.equal(colorClass(150, 100), 'danger')
    assert.equal(pct(150, 100), '100.0')
  })

  it('clamps ratio below 0', () => {
    assert.equal(colorClass(-10, 100), 'ok')
    assert.equal(pct(-10, 100), '0.0')
  })

  it('handles zero total without division by zero', () => {
    assert.equal(colorClass(0, 0), 'ok')
    assert.equal(pct(0, 0), '0.0')
  })

  it('formats percentage correctly', () => {
    assert.equal(pct(33, 100), '33.0')
    assert.equal(pct(1, 3), '33.3')
  })
})
