import React from 'react'
import CycleCard from './CycleCard.jsx'
import QualitySignals from './QualitySignals.jsx'

export default function CycleReview({ cycles = [], gates = [], securityScan = null, onClose }) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Cycle Review">
      <div className="modal-content modal-content--wide">
        <div className="modal-header">
          <h2>Cycle Review</h2>
          {onClose && (
            <button className="btn-ghost modal-close" onClick={onClose} type="button" aria-label="Close">
              ✕
            </button>
          )}
        </div>

        <div className="cycle-review-summary">
          <span>{cycles.length} cycle{cycles.length !== 1 ? 's' : ''} completed</span>
        </div>

        {gates.length > 0 && (
          <section className="cycle-review-section">
            <h3>Quality Gates</h3>
            <QualitySignals gates={gates} securityScan={securityScan} />
          </section>
        )}

        {cycles.length > 0 && (
          <section className="cycle-review-section">
            <h3>Cycle Timeline</h3>
            <div className="cycle-timeline">
              {cycles.map((cycle, idx) => (
                <CycleCard
                  key={cycle.id || idx}
                  cycle={cycle}
                  index={idx}
                  defaultExpanded={idx === cycles.length - 1}
                />
              ))}
            </div>
          </section>
        )}

        <div className="modal-actions">
          {onClose && (
            <button className="btn-secondary" onClick={onClose} type="button">
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
