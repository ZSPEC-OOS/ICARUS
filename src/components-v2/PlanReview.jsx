import React from 'react'
import DeliverableList from './DeliverableList.jsx'

export default function PlanReview({ plan, onApprove, onReject, onClose }) {
  if (!plan) return null

  const deliverables = plan.deliverables || []
  const goal = plan.goal || plan.taskSpec?.goal || ''
  const constraints = plan.constraints || []
  const cycleLimit = plan.cycleLimit ?? plan.taskSpec?.cycleLimit

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Plan Review">
      <div className="modal-content">
        <div className="modal-header">
          <h2>Plan Review</h2>
          {onClose && (
            <button className="btn-ghost modal-close" onClick={onClose} type="button" aria-label="Close">
              ✕
            </button>
          )}
        </div>

        {goal && (
          <div className="plan-review-goal">
            <strong>Goal:</strong> {goal}
          </div>
        )}

        {cycleLimit != null && (
          <div className="plan-review-meta">
            <span>Cycle limit: <strong>{cycleLimit}</strong></span>
          </div>
        )}

        {constraints.length > 0 && (
          <div className="plan-review-constraints">
            <strong>Constraints:</strong>
            <ul>
              {constraints.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </div>
        )}

        <div className="plan-review-deliverables">
          <strong>Deliverables ({deliverables.length})</strong>
          <DeliverableList deliverables={deliverables} />
        </div>

        <div className="modal-actions">
          {onApprove && (
            <button className="btn-primary" onClick={onApprove} type="button">
              Approve Plan
            </button>
          )}
          {onReject && (
            <button className="btn-danger" onClick={onReject} type="button">
              Reject Plan
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
