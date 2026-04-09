import { memo } from 'react'

// ─── Role metadata ─────────────────────────────────────────────────────────────
const ROLE_META = {
  planner:       { label: 'Planner',     icon: '◈', colorClass: 'lane-role--planner'  },
  debugger:      { label: 'Debugger',    icon: '⚑', colorClass: 'lane-role--debugger' },
  refactorer:    { label: 'Refactorer',  icon: '⟳', colorClass: 'lane-role--refactor' },
  'test-writer': { label: 'Test Writer', icon: '⊛', colorClass: 'lane-role--tests'    },
  reviewer:      { label: 'Reviewer',    icon: '⊙', colorClass: 'lane-role--reviewer' },
}

const STRATEGY_LABELS = {
  single:     'single',
  fallback:   'fallback',
  ensemble:   'ensemble',
  cost_aware: 'cost-aware',
  disabled:   null,
  no_config:  null,
}

function ConfidencePill({ confidence }) {
  const pct = Math.round((confidence ?? 0) * 100)
  const cls = pct >= 75 ? 'conf-high' : pct >= 50 ? 'conf-med' : 'conf-low'
  return (
    <span className={`lk-lane-conf lk-${cls}`}>{pct}%</span>
  )
}

/**
 * BluswanTaskLanes — horizontal strip of live/completed orchestration task cards.
 *
 * Props:
 *   lanes  — array of lane objects accumulated from orchestration events:
 *     {
 *       id:           string,
 *       role:         string,
 *       modelId:      string,
 *       modelName?:   string,
 *       confidence:   number,
 *       strategy:     string,
 *       reasoning:    string,
 *       status:       'active' | 'done' | 'error' | 'fallback',
 *       usedFallback?: boolean,
 *       ensembleModels?: string[],
 *     }
 */
const BluswanTaskLanes = memo(function BluswanTaskLanes({ lanes = [] }) {
  if (!lanes.length) return null

  return (
    <div className="lk-task-lanes" role="region" aria-label="Parallel task lanes">
      <div className="lk-task-lanes-hd">◆ Orchestration</div>
      <div className="lk-task-lanes-row">
        {lanes.map(lane => {
          const meta = ROLE_META[lane.role] || { label: lane.role, icon: '·', colorClass: '' }
          const strategyLabel = STRATEGY_LABELS[lane.strategy] ?? lane.strategy
          const modelLabel = (lane.modelName || lane.modelId || '').replace(/^(claude|gpt|gemini)-?/i, '').slice(0, 22) || 'default'

          return (
            <div
              key={lane.id}
              className={`lk-lane-card lk-lane-card--${lane.status}`}
              title={lane.reasoning}
            >
              {/* Role badge */}
              <div className={`lk-lane-role ${meta.colorClass}`}>
                <span className="lk-lane-role-icon">{meta.icon}</span>
                <span className="lk-lane-role-label">{meta.label}</span>
              </div>

              {/* Model + strategy */}
              <div className="lk-lane-model">{modelLabel}</div>
              {strategyLabel && (
                <div className={`lk-lane-strategy lk-lane-strategy--${lane.strategy}`}>{strategyLabel}</div>
              )}

              {/* Confidence */}
              <ConfidencePill confidence={lane.confidence} />

              {/* Status indicator */}
              <div className="lk-lane-status">
                {lane.status === 'active'    && <span className="lk-spinner lk-spinner--sm" />}
                {lane.status === 'done'      && <span className="lk-lane-status-icon lk-lane-status-icon--done">✓</span>}
                {lane.status === 'error'     && <span className="lk-lane-status-icon lk-lane-status-icon--error">✗</span>}
                {lane.status === 'fallback'  && <span className="lk-lane-status-icon lk-lane-status-icon--warn">⚠</span>}
              </div>

              {/* Ensemble badge */}
              {lane.ensembleModels?.length > 1 && (
                <div className="lk-lane-ensemble" title={`Ensemble: ${lane.ensembleModels.join(', ')}`}>
                  ×{lane.ensembleModels.length}
                </div>
              )}

              {/* Fallback indicator */}
              {lane.usedFallback && (
                <div className="lk-lane-fallback-badge" title="Fallback model used">↩</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})

export default BluswanTaskLanes

// ── Lane accumulation helper (used in useAgentSession / Bluswan) ─────────────────

let _laneSeq = 0
/**
 * Process an orchestration event and return an updated lanes array.
 * Handles: 'orchestration', 'orchestration_fallback_used', 'orchestration_ensemble', 'done', 'error'
 */
export function applyLaneEvent(lanes, event) {
  switch (event.type) {
    case 'orchestration': {
      _laneSeq++
      const newLane = {
        id:         `lane-${_laneSeq}`,
        role:       event.role,
        modelId:    event.modelId || '',
        modelName:  event.modelName || '',
        confidence: event.confidence ?? 0.5,
        strategy:   event.strategy || 'single',
        reasoning:  event.reasoning || '',
        status:     'active',
        usedFallback: false,
        ensembleModels: [],
      }
      // Keep at most 6 lanes; slide oldest off
      return [...lanes, newLane].slice(-6)
    }

    case 'orchestration_fallback_used': {
      // Mark the most recent active lane as fallback
      const updated = [...lanes]
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i].status === 'active') {
          updated[i] = { ...updated[i], status: 'fallback', usedFallback: true, modelId: event.modelId || updated[i].modelId }
          break
        }
      }
      return updated
    }

    case 'orchestration_ensemble': {
      const updated = [...lanes]
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i].status === 'active') {
          updated[i] = { ...updated[i], ensembleModels: event.modelsUsed || [] }
          break
        }
      }
      return updated
    }

    case 'done': {
      // Mark all active lanes done
      return lanes.map(l => l.status === 'active' ? { ...l, status: 'done' } : l)
    }

    case 'error': {
      return lanes.map(l => l.status === 'active' ? { ...l, status: 'error' } : l)
    }

    default:
      return lanes
  }
}
