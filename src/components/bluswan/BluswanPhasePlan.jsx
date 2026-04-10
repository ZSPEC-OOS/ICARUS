import { useState } from 'react'

// ─── BluswanPhasePlan ─────────────────────────────────────────────────────────
// Long Request Mode phase plan UI.
// Renders a collapsible list of phases with per-phase status, verification
// prompts, and proceed/override controls.
// Intentionally self-contained — no shared state with the main code gen flow.

const STATUS_ICON = {
  pending:    '○',
  active:     '◉',
  verifying:  '◌',
  complete:   '✓',
  blocked:    '✗',
}

const STATUS_LABEL = {
  pending:    'Pending',
  active:     'Running…',
  verifying:  'Verifying…',
  complete:   'Complete',
  blocked:    'Needs retry',
}

function relPhaseDate(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60000) return 'just now'
  return `${Math.floor(diff / 60000)}m ago`
}

export default function BluswanPhasePlan({
  plan,          // { phases, currentIdx, statuses, verifyError, originalPrompt, phaseTimes }
  isGenerating,  // bool — a phase is executing right now
  onStart,       // () → begin Phase 0
  onProceed,     // (idx) → proceed to next phase after idx
  onOverride,    // (idx) → manually override verification
  onCancel,      // () → cancel/dismiss entire plan
}) {
  const [expanded, setExpanded] = useState({ 0: true })

  if (!plan) return null
  const { phases, currentIdx, statuses, verifyError } = plan

  const allDone = phases.every((_, i) => statuses[i] === 'complete')

  function toggle(idx) {
    setExpanded(e => ({ ...e, [idx]: !e[idx] }))
  }

  return (
    <div className="lk-phase-plan">
      {/* Header */}
      <div className="lk-phase-plan-hd">
        <div className="lk-phase-plan-hd-left">
          <span className="lk-phase-plan-icon">⇥</span>
          <span className="lk-phase-plan-title">Long Request Mode</span>
          <span className="lk-phase-plan-count">{phases.length} phases</span>
        </div>
        {!isGenerating && (
          <button className="lk-phase-plan-cancel" onClick={onCancel} title="Cancel plan">✕</button>
        )}
      </div>

      {/* Phase list */}
      <div className="lk-phase-plan-list">
        {phases.map((phase, idx) => {
          const status   = statuses[idx] || 'pending'
          const isOpen   = expanded[idx]
          const isActive = idx === currentIdx && status === 'active'
          const isBlocked = status === 'blocked'
          const isDone   = status === 'complete'
          const isVerifying = status === 'verifying'
          const isPending = status === 'pending'
          const isReadyToStart = idx === 0 && !Object.values(statuses).some(s => s !== 'pending')

          return (
            <div
              key={phase.id}
              className={[
                'lk-phase-card',
                `lk-phase-card--${status}`,
                isOpen ? 'lk-phase-card--open' : '',
              ].filter(Boolean).join(' ')}
            >
              {/* Card header (always visible) */}
              <button
                className="lk-phase-card-hd"
                onClick={() => toggle(idx)}
                disabled={isPending && idx !== 0 && !isReadyToStart}
              >
                <span className={`lk-phase-status-icon lk-phase-status-icon--${status}`}>
                  {STATUS_ICON[status]}
                </span>
                <span className="lk-phase-num">Phase {idx + 1}</span>
                <span className="lk-phase-title-text">{phase.title}</span>
                <span className="lk-phase-status-label">{STATUS_LABEL[status]}</span>
                <span className="lk-phase-chevron">{isOpen ? '▾' : '▸'}</span>
              </button>

              {/* Expanded body */}
              {isOpen && (
                <div className="lk-phase-card-body">
                  <p className="lk-phase-summary">{phase.summary}</p>

                  {phase.targets?.length > 0 && (
                    <div className="lk-phase-targets">
                      {phase.targets.map((t, ti) => (
                        <span key={ti} className="lk-phase-target-chip">{t}</span>
                      ))}
                    </div>
                  )}

                  {/* CTA: Start Phase 1 */}
                  {isReadyToStart && idx === 0 && (
                    <button className="lk-btn lk-btn--primary lk-phase-cta" onClick={onStart}>
                      ▶ Confirm &amp; Begin Phase 1
                    </button>
                  )}

                  {/* Active: generation in progress */}
                  {isActive && isGenerating && (
                    <div className="lk-phase-running">
                      <span className="lk-gh-flow-spinner">◌</span> Executing phase {idx + 1}…
                    </div>
                  )}

                  {/* Active: generation done, waiting for verification/proceed */}
                  {isActive && !isGenerating && (
                    <div className="lk-phase-verify-wrap">
                      <p className="lk-phase-verify-hint">
                        Phase {idx + 1} generation complete.
                        {idx < phases.length - 1 ? ' Verify the output above, then proceed.' : ' All phases ready — push to GitHub when satisfied.'}
                      </p>
                      {idx < phases.length - 1 && (
                        <button
                          className="lk-btn lk-btn--primary lk-phase-cta"
                          onClick={() => onProceed(idx)}
                        >
                          Proceed to Phase {idx + 2} →
                        </button>
                      )}
                      {idx === phases.length - 1 && (
                        <button className="lk-btn lk-phase-cta" onClick={onCancel}>
                          ✓ Done — close plan
                        </button>
                      )}
                    </div>
                  )}

                  {/* Verifying */}
                  {isVerifying && (
                    <div className="lk-phase-running">
                      <span className="lk-gh-flow-spinner">◌</span> Verifying changes…
                    </div>
                  )}

                  {/* Blocked */}
                  {isBlocked && (
                    <div className="lk-phase-blocked-wrap">
                      <p className="lk-phase-blocked-msg">
                        ✗ {verifyError || 'Phase changes not detected. Commit or apply changes, then retry.'}
                      </p>
                      <div className="lk-phase-blocked-actions">
                        <button
                          className="lk-btn lk-btn--primary lk-phase-cta"
                          onClick={() => onProceed(idx)}
                        >
                          ↻ Retry verification
                        </button>
                        <button
                          className="lk-btn lk-btn--small"
                          onClick={() => onOverride(idx)}
                        >
                          Override ✓
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* All done banner */}
      {allDone && (
        <div className="lk-phase-all-done">
          ✓ All phases complete
          <button className="lk-btn lk-btn--small" style={{ marginLeft: '0.75rem' }} onClick={onCancel}>
            Close
          </button>
        </div>
      )}
    </div>
  )
}
