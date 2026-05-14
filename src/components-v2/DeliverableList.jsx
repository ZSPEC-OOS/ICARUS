import React from 'react'

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

export default function DeliverableList({ deliverables = [], onSelect }) {
  if (deliverables.length === 0) {
    return (
      <div className="deliverable-list deliverable-list--empty">
        <span>No deliverables defined.</span>
      </div>
    )
  }

  return (
    <ol className="deliverable-list">
      {deliverables.map((d, idx) => {
        const status = statusBadge(d)
        return (
          <li
            key={d.id || idx}
            className={`deliverable-card deliverable-card--${status}`}
            onClick={() => onSelect?.(d)}
            role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined}
            onKeyDown={onSelect ? (e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(d) } : undefined}
          >
            <div className="deliverable-card-header">
              <span className="deliverable-card-index">#{idx + 1}</span>
              <span className="deliverable-card-type">{d.type || 'file'}</span>
              <span className={`status-badge status-badge--${status}`}>{statusLabel(d)}</span>
            </div>
            <div className="deliverable-card-path">{d.path || d.description || '—'}</div>
            {d.acceptanceCriteria && (
              <div className="deliverable-card-criteria">
                <span className="deliverable-card-criteria-label">Criteria:</span>{' '}
                {d.acceptanceCriteria}
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
