import React from 'react'

export default function BudgetBar({ used = 0, total = 1, label = 'Budget', type = 'tokens' }) {
  const safeTotal = total > 0 ? total : 1
  const ratio = Math.min(1, Math.max(0, used / safeTotal))
  const pct = (ratio * 100).toFixed(1)

  const colorClass = ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warn' : 'ok'

  return (
    <div className="budget-bar-wrap">
      <div className="budget-bar-header">
        <span className="budget-bar-label">{label}</span>
        <span className="budget-bar-value">
          {used.toLocaleString()} / {total.toLocaleString()} {type}
        </span>
      </div>
      <div className="budget-bar" aria-label={`${label}: ${pct}% used`}>
        <div
          className={`budget-bar-fill budget-bar-fill--${colorClass}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={total}
        />
      </div>
      <div className="budget-bar-pct">{pct}%</div>
    </div>
  )
}
