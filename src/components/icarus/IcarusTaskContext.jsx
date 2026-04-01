import { memo } from 'react'

// ─── Phase order (matches interactivePipeline.js PIPELINE_PHASES) ─────────────
const PHASE_ORDER = [
  'understanding',
  'planning',
  'scoping',
  'coding',
  'reviewing',
  'validating',
  'finalizing',
  'complete',
]

// Short labels for the strip (full labels too wide)
const PHASE_SHORT = {
  understanding: 'read',
  planning:      'plan',
  scoping:       'scope',
  coding:        'code',
  reviewing:     'review',
  validating:    'test',
  finalizing:    'push',
  complete:      'done',
}

// ─── Intent visual metadata ────────────────────────────────────────────────────
const INTENT_META = {
  new_feature:     { icon: '⊕', label: 'New Feature', mod: 'new'      },
  modify_existing: { icon: '⟳', label: 'Modify',      mod: 'modify'   },
  debug:           { icon: '⚑', label: 'Debug',       mod: 'debug'    },
  explain:         { icon: '◎', label: 'Explain',     mod: 'explain'  },
  refactor:        { icon: '⊛', label: 'Refactor',    mod: 'refactor' },
}

// ─── Orchestration role display ────────────────────────────────────────────────
const ROLE_SHORT = {
  planner:       'planner',
  debugger:      'debugger',
  refactorer:    'refactorer',
  'test-writer': 'test-writer',
  reviewer:      'reviewer',
}

/**
 * IcarusTaskContext — full-width header block rendered above the activity feed
 * while the agent is running. Shows intent, goal, routing role, and a phase
 * progress strip so the user always knows what ICARUS is doing and how far
 * along the pipeline it is.
 *
 * Props:
 *   intent       string|null   — detected intent (from interactivePipeline)
 *   task         object|null   — { goal, status, steps }
 *   agentPhase   string        — current pipeline phase
 *   orchDecision object|null   — { role, confidence, modelId } from orchestration
 */
const IcarusTaskContext = memo(function IcarusTaskContext({
  intent,
  task,
  agentPhase,
  orchDecision,
}) {
  if (!intent && !task?.goal) return null

  const meta     = INTENT_META[intent] || { icon: '⚡', label: intent || 'Task', mod: 'default' }
  const phaseIdx = PHASE_ORDER.indexOf(agentPhase || 'understanding')
  const isDone   = agentPhase === 'complete'

  return (
    <div className={`lk-task-ctx lk-task-ctx--${meta.mod}`}>

      {/* ── Top row: intent + routing badges ─────────────────────────────── */}
      <div className="lk-task-ctx-hd">
        <span className="lk-task-ctx-icon">{meta.icon}</span>
        <span className="lk-task-ctx-intent">{meta.label}</span>

        {orchDecision?.role && ROLE_SHORT[orchDecision.role] && (
          <span className="lk-task-ctx-role">{ROLE_SHORT[orchDecision.role]}</span>
        )}

        {orchDecision?.modelId && (
          <span className="lk-task-ctx-model">
            {orchDecision.modelId.replace(/^(claude|gpt|gemini)-?/i, '').slice(0, 20)}
          </span>
        )}

        {orchDecision?.confidence != null && (
          <span className={`lk-task-ctx-conf ${orchDecision.confidence >= 0.75 ? 'lk-conf-high' : orchDecision.confidence >= 0.5 ? 'lk-conf-med' : 'lk-conf-low'}`}>
            {Math.round(orchDecision.confidence * 100)}%
          </span>
        )}

        <span className={`lk-task-ctx-phase-label ${isDone ? 'lk-task-ctx-phase-label--done' : ''}`}>
          {isDone ? '✓ complete' : agentPhase || 'understanding'}
        </span>
      </div>

      {/* ── Goal text ─────────────────────────────────────────────────────── */}
      {task?.goal && (
        <div className="lk-task-ctx-goal">
          {task.goal.length > 110 ? `${task.goal.slice(0, 107)}…` : task.goal}
        </div>
      )}

      {/* ── Phase progress strip ──────────────────────────────────────────── */}
      <div className="lk-phase-strip" role="progressbar" aria-valuenow={phaseIdx} aria-valuemax={PHASE_ORDER.length - 1}>
        {PHASE_ORDER.slice(0, -1).map((phase, idx) => {
          const state = idx < phaseIdx ? 'done' : idx === phaseIdx ? 'active' : 'future'
          return (
            <div key={phase} className={`lk-phase-pip lk-phase-pip--${state}`}>
              <div className="lk-phase-pip-dot">
                {state === 'done' && <span className="lk-phase-pip-check">✓</span>}
                {state === 'active' && <span className="lk-phase-pip-pulse" />}
              </div>
              <span className="lk-phase-pip-label">{PHASE_SHORT[phase] || phase}</span>
            </div>
          )
        })}
        {/* Connector lines between pips */}
        <div className="lk-phase-track" style={{ '--track-pct': `${Math.max(0, (phaseIdx / (PHASE_ORDER.length - 2)) * 100)}%` }} />
      </div>

    </div>
  )
})

export default IcarusTaskContext
