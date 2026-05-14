import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Logic extracted from DeliverableList
function statusBadge(deliverable) {
  if (deliverable.completed) return 'completed'
  if (deliverable.failed) return 'failed'
  return 'pending'
}

function statusLabel(deliverable) {
  if (deliverable.completed) return 'Done'
  if (deliverable.failed) return 'Failed'
  return 'Pending'
}

describe('DeliverableList logic', () => {
  it('pending deliverable has status "pending"', () => {
    assert.equal(statusBadge({ id: 'a' }), 'pending')
    assert.equal(statusLabel({ id: 'a' }), 'Pending')
  })

  it('completed deliverable has status "completed"', () => {
    assert.equal(statusBadge({ id: 'a', completed: true }), 'completed')
    assert.equal(statusLabel({ id: 'a', completed: true }), 'Done')
  })

  it('failed deliverable has status "failed"', () => {
    assert.equal(statusBadge({ id: 'a', failed: true }), 'failed')
    assert.equal(statusLabel({ id: 'a', failed: true }), 'Failed')
  })

  it('completed takes priority over failed', () => {
    assert.equal(statusBadge({ id: 'a', completed: true, failed: true }), 'completed')
  })

  it('correctly categorises mixed deliverables', () => {
    const list = [
      { id: '1', completed: true },
      { id: '2', failed: true },
      { id: '3' },
    ]
    const statuses = list.map(statusBadge)
    assert.deepEqual(statuses, ['completed', 'failed', 'pending'])
  })
})
