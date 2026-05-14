import React from 'react'

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

export default function QualitySignals({ gates = [], securityScan = null }) {
  if (gates.length === 0 && !securityScan) {
    return (
      <div className="quality-signals quality-signals--empty">
        <span>No quality signals available.</span>
      </div>
    )
  }

  return (
    <div className="quality-signals">
      <table className="signals-table">
        <thead>
          <tr>
            <th>Gate</th>
            <th>Metric</th>
            <th>Threshold</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {gates.map((gate) => {
            const st = signalStatus(gate)
            return (
              <tr key={gate.id} className={`signals-table-row signals-table-row--${st}`}>
                <td className="signals-table-id">{gate.id}</td>
                <td className="signals-table-metric">{formatMetric(gate)}</td>
                <td className="signals-table-threshold">{formatThreshold(gate)}</td>
                <td className="signals-table-status">
                  <span className={`status-badge status-badge--${st === 'pass' ? 'completed' : st === 'fail' ? 'failed' : 'pending'}`}>
                    {st}
                  </span>
                </td>
                <td className="signals-table-detail">{gate.detail || '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {securityScan && (
        <div className={`quality-signals-sec quality-signals-sec--${securityScan.passed ? 'ok' : 'warn'}`}>
          <strong>Security:</strong> {securityScan.summary || (securityScan.passed ? 'No issues' : 'Issues found')}
          {securityScan.issues && securityScan.issues.length > 0 && (
            <ul className="quality-signals-sec-issues">
              {securityScan.issues.slice(0, 5).map((iss, i) => (
                <li key={i}>{iss.severity?.toUpperCase()} — {iss.message || iss.type}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
