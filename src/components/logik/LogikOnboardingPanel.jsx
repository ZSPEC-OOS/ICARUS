// ─── LogikOnboardingPanel ─────────────────────────────────────────────────────
//
// Step-by-step setup wizard shown to non-coders until all ONBOARDING_STEPS
// are complete. Renders as a dismissible panel in the LOGIK sidebar.
//
// Props
//   showOnboarding   boolean
//   currentStep      { id, title, detail, action, link, manual } | null
//   stepIndex        0-based index
//   totalSteps       total step count
//   progressPercent  0–100
//   isComplete       boolean
//   activeTips       array of tip objects
//   onMarkManual     (stepId) => void
//   onDismiss        () => void
//   onDismissTip     (tipId) => void
//
// ─────────────────────────────────────────────────────────────────────────────

import { memo } from 'react'

const LogikOnboardingPanel = memo(function LogikOnboardingPanel({
  showOnboarding,
  currentStep,
  stepIndex,
  totalSteps,
  progressPercent,
  isComplete,
  activeTips,
  onMarkManual,
  onDismiss,
  onDismissTip,
}) {
  if (!showOnboarding && activeTips.length === 0) return null

  return (
    <div className="lk-onboarding-wrap" role="complementary" aria-label="Setup guide">

      {/* ── Contextual tips (shown independently of main panel) ── */}
      {activeTips.map(tip => (
        <div key={tip.id} className="lk-tip" role="alert">
          <div className="lk-tip-header">
            <span className="lk-tip-icon">💡</span>
            <strong className="lk-tip-headline">{tip.headline}</strong>
            <button
              className="lk-tip-close"
              onClick={() => onDismissTip(tip.id)}
              aria-label="Dismiss tip"
            >×</button>
          </div>
          <p className="lk-tip-body">{tip.body}</p>
          {tip.link && (
            <a
              className="lk-tip-link"
              href={tip.link.url}
              target="_blank"
              rel="noopener noreferrer"
            >{tip.link.label} ↗</a>
          )}
        </div>
      ))}

      {/* ── Main onboarding panel ── */}
      {showOnboarding && (
        <div className="lk-onboarding-panel">

          {/* Header */}
          <div className="lk-onboarding-header">
            <span className="lk-onboarding-icon">🚀</span>
            <div className="lk-onboarding-title-group">
              <h3 className="lk-onboarding-title">Getting started</h3>
              <span className="lk-onboarding-progress-label">
                Step {Math.min(stepIndex + 1, totalSteps)} of {totalSteps}
              </span>
            </div>
            <button
              className="lk-onboarding-dismiss"
              onClick={onDismiss}
              title="Hide this guide (you can re-open it with the ? button)"
              aria-label="Dismiss setup guide"
            >×</button>
          </div>

          {/* Progress bar */}
          <div className="lk-onboarding-progress-bar" role="progressbar"
               aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100}>
            <div
              className="lk-onboarding-progress-fill"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          {/* Current step */}
          {isComplete ? (
            <div className="lk-onboarding-complete">
              <span className="lk-onboarding-check">✓</span>
              <div>
                <strong>You're all set!</strong>
                <p>Type what you want to build below and press <kbd>Enter</kbd> to send (<kbd>Shift+Enter</kbd> adds a new line).</p>
              </div>
            </div>
          ) : currentStep ? (
            <div className="lk-onboarding-step">
              <div className="lk-onboarding-step-title">
                <span className="lk-onboarding-step-num">{stepIndex + 1}</span>
                <strong>{currentStep.title}</strong>
              </div>

              <p className="lk-onboarding-step-detail">{currentStep.detail}</p>

              <div className="lk-onboarding-step-action">
                <span className="lk-onboarding-step-action-icon">→</span>
                <span>{currentStep.action}</span>
              </div>

              {currentStep.link && (
                <a
                  className="lk-onboarding-link"
                  href={currentStep.link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {currentStep.link.label} ↗
                </a>
              )}

              {currentStep.manual && (
                <button
                  className="lk-onboarding-manual-done"
                  onClick={() => onMarkManual(currentStep.id)}
                >
                  ✓ Done — I have a GitHub account
                </button>
              )}
            </div>
          ) : null}

        </div>
      )}
    </div>
  )
})

export default LogikOnboardingPanel
