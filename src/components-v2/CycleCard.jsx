import React, { useState } from 'react'

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

function ToolCallCard({ call, index }) {
  const isErr = call.error || call.exitCode > 0
  return (
    <div className={`tool-call-card${isErr ? ' tool-call-card--error' : ''}`}>
      <div className="tool-call-card-header">
        <span className="tool-call-card-index">T{index + 1}</span>
        <span className="tool-call-card-name">{call.toolName || call.name || 'tool'}</span>
        {call.durationMs != null && (
          <span className="tool-call-card-duration">{formatMs(call.durationMs)}</span>
        )}
      </div>
      {call.input?.path && (
        <div className="tool-call-card-path">{call.input.path}</div>
      )}
      {call.error && (
        <div className="tool-call-card-error">{String(call.error)}</div>
      )}
    </div>
  )
}

export default function CycleCard({ cycle, index, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const status = cycleStatus(cycle)
  const toolCalls = cycle.toolCalls || cycle.turns || []
  const durationMs = cycle.durationMs ?? (
    cycle.endedAt && cycle.startedAt
      ? new Date(cycle.endedAt) - new Date(cycle.startedAt)
      : null
  )

  return (
    <div className={`cycle-card cycle-card--${status}`}>
      <button
        className="cycle-card-header"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        type="button"
      >
        <span className="cycle-card-index">Cycle {index + 1}</span>
        <span className={`status-badge status-badge--${status}`}>{status}</span>
        {durationMs != null && (
          <span className="cycle-card-duration">{formatMs(durationMs)}</span>
        )}
        <span className="cycle-card-tool-count">{toolCalls.length} tool{toolCalls.length !== 1 ? 's' : ''}</span>
        <span className="cycle-card-chevron" aria-hidden="true">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="cycle-card-body">
          {cycle.haltReason && (
            <div className="cycle-card-halt-reason">Halted: {cycle.haltReason}</div>
          )}
          {toolCalls.length === 0 ? (
            <div className="cycle-card-empty">No tool calls recorded.</div>
          ) : (
            toolCalls.map((call, i) => (
              <ToolCallCard key={call.id || i} call={call} index={i} />
            ))
          )}
        </div>
      )}
    </div>
  )
}
