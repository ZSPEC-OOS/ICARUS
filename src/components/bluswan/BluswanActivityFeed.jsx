import { memo, useRef, useEffect, useState } from 'react'

// ─── Inline markdown (bold + code only) ──────────────────────────────────────
function renderInlineMarkdown(text) {
  const parts = String(text || '').split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={idx}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`')  && part.endsWith('`'))  return <code   key={idx}>{part.slice(1, -1)}</code>
    return <span key={idx}>{part}</span>
  })
}

function renderMarkdown(text) {
  const lines = String(text || '').split('\n')
  const blocks = []
  let listItems = []
  const flushList = () => {
    if (!listItems.length) return
    blocks.push(<ul key={`ul-${blocks.length}`} className="lk-cc-md-list">{listItems.map((it, i) => <li key={i}>{renderInlineMarkdown(it)}</li>)}</ul>)
    listItems = []
  }
  lines.forEach(line => {
    const t = line.trim()
    if (!t) { flushList(); return }
    if (/^[-*]\s+/.test(t)) { listItems.push(t.replace(/^[-*]\s+/, '')); return }
    flushList()
    if      (t.startsWith('### ')) blocks.push(<h4 key={`h-${blocks.length}`}>{renderInlineMarkdown(t.slice(4))}</h4>)
    else if (t.startsWith('## '))  blocks.push(<h3 key={`h-${blocks.length}`}>{renderInlineMarkdown(t.slice(3))}</h3>)
    else if (t.startsWith('# '))   blocks.push(<h2 key={`h-${blocks.length}`}>{renderInlineMarkdown(t.slice(2))}</h2>)
    else blocks.push(<p key={`p-${blocks.length}`}>{renderInlineMarkdown(t)}</p>)
  })
  flushList()
  return blocks
}

// ─── Braille spinner ──────────────────────────────────────────────────────────
const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
function BrailleSpinner() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % BRAILLE.length), 80)
    return () => clearInterval(id)
  }, [])
  return <span className="lk-braille-spinner">{BRAILLE[frame]}</span>
}

// ─── ToolLine — a single Claude-Code-style tool call row ─────────────────────
function ToolLine({ status, children }) {
  const cls = status === 'done'  ? 'lk-cc-line lk-cc-line--done'
            : status === 'error' ? 'lk-cc-line lk-cc-line--err'
            :                      'lk-cc-line lk-cc-line--active'
  return (
    <div className={cls}>
      {status === 'done'  ? <span className="lk-cc-icon">✓</span>
     : status === 'error' ? <span className="lk-cc-icon lk-cc-icon--err">✗</span>
     :                      <span className="lk-cc-icon lk-cc-icon--spin"><BrailleSpinner /></span>}
      <span className="lk-cc-line-text">{children}</span>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
const BluswanActivityFeed = memo(function BluswanActivityFeed({
  activityLog,
  narrationThread = [],
  isAgentRunning,
  agentStreamText,
  isGenerating,
  isPushing,
  pushStep,
  feedRef,
  conversation,
  agentTask,
  activeModelName,
  escalatedModelId,
  filePlan = [],
  isAmplifying = false,
  amplifierDecisions = [],
  isPlanning = false,
  remediationStatus = null,
  executedPlan = null,
  planApproval = null,
  onApprovePlan,
  onCancelPlan,
  lrmGeneratingPlan = false,
  // lrmPlan and related LRM props intentionally unused — phases run silently
  failedAtPhase,
  onRetry,
}) {
  const streamRef = useRef(null)

  // Auto-scroll as new lines arrive
  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  const wasTerminated = !isAgentRunning && agentTask?.status === 'interrupted'
  const hasError = !isAgentRunning && !wasTerminated &&
    activityLog.some(e => e.type === 'error' || e.status === 'error')
  const isDone = !isAgentRunning && !wasTerminated && !hasError &&
    activityLog.some(e => e.type === 'done')

  const errorReason = hasError
    ? (() => {
        const errEntries = activityLog.filter(e => e.type === 'error' || e.status === 'error')
        const last = errEntries[errEntries.length - 1]
        return last ? String(last.msg || '').replace(/^[✗⚠●]\s*/u, '').trim() : null
      })()
    : null

  const summaryMsg = isDone && conversation?.length > 0
    ? [...conversation].reverse().find(m => m.role === 'assistant')
    : null

  const isActive = isAgentRunning || isGenerating || isPushing

  const hasContent =
    narrationThread.length > 0 || activityLog.length > 0 ||
    amplifierDecisions.length > 0 || filePlan.length > 0 ||
    !!executedPlan?.summary || !!summaryMsg || !!planApproval ||
    (isAgentRunning && !!agentStreamText)

  return (
    <div className="lk-cc-feed" ref={feedRef}>
      <div className="lk-cc-stream" ref={streamRef}>

        {/* Model indicator */}
        {activeModelName && (
          <div className="lk-cc-model-line">
            {escalatedModelId
              ? <><span className="lk-cc-escalate">⬆</span> {escalatedModelId}</>
              : activeModelName}
          </div>
        )}

        {/* Executed plan summary */}
        {executedPlan?.summary && (
          <div className="lk-cc-plan-summary">
            <div className="lk-cc-plan-summary-hd">▶ Plan</div>
            <div className="lk-cc-plan-summary-body">{renderMarkdown(executedPlan.summary)}</div>
          </div>
        )}

        {/* LRM: silent analysis indicator */}
        {lrmGeneratingPlan && <ToolLine status="active">Analyzing task scope…</ToolLine>}

        {/* Narration thread (agent mode) */}
        {narrationThread.length > 0 ? (
          <>
            {narrationThread.map((entry, i) => {
              if (entry.kind === 'text') {
                return (
                  <div key={`n-${i}`} className="lk-cc-prose">
                    {renderInlineMarkdown(entry.text)}
                  </div>
                )
              }
              if (entry.kind === 'tool') {
                return <ToolLine key={`t-${i}`} status={entry.status}>{entry.logMsg}</ToolLine>
              }
              return null
            })}
            {/* Live streaming narration */}
            {isAgentRunning && agentStreamText && (
              <div className="lk-cc-prose lk-cc-prose--live">
                {renderInlineMarkdown(agentStreamText)}
                <span className="lk-stream-cursor">▋</span>
              </div>
            )}
          </>
        ) : (
          <>
            {/* Raw activity log */}
            {activityLog.map(entry => {
              const text   = [entry.msg, entry.detail].filter(Boolean).join(' — ')
              const status = entry.status === 'done' || entry.status === 'skip' ? 'done'
                           : entry.status === 'error' ? 'error'
                           : entry.status === 'active' ? 'active' : null
              return <ToolLine key={entry.id} status={status}>{text}</ToolLine>
            })}

            {/* Amplifier decisions */}
            {amplifierDecisions.map((d, i) => (
              <ToolLine key={`amp-${i}`} status="done">{d}</ToolLine>
            ))}

            {/* Status lines */}
            {isAmplifying     && <ToolLine status="active">Amplifying intent…</ToolLine>}
            {isPlanning       && <ToolLine status="active">Planning…</ToolLine>}
            {remediationStatus && <ToolLine status="active">{remediationStatus}</ToolLine>}

            {/* File plan */}
            {filePlan.map(entry => {
              const action = entry.action === 'modify' ? 'Edit' : 'Write'
              const status = entry.status === 'done' ? 'done' : entry.status === 'error' ? 'error' : 'active'
              return (
                <ToolLine key={`fp-${entry.path}`} status={status}>
                  {action} {entry.path}{entry.error ? ` — ${entry.error}` : ''}
                </ToolLine>
              )
            })}

            {isGenerating && !filePlan.length && !activityLog.length && (
              <ToolLine status="active">Generating…</ToolLine>
            )}
            {isPushing && <ToolLine status="active">{pushStep || 'Pushing to GitHub…'}</ToolLine>}

            {/* Live stream text */}
            {isAgentRunning && agentStreamText && (
              <div className="lk-cc-prose lk-cc-prose--live">
                {renderInlineMarkdown(agentStreamText)}
                <span className="lk-stream-cursor">▋</span>
              </div>
            )}
          </>
        )}

        {/* Idle preparing indicator */}
        {!hasContent && isActive && (
          <ToolLine status="active">Preparing…</ToolLine>
        )}

        {/* Error block */}
        {hasError && (
          <div className="lk-cc-error-block">
            {errorReason && (
              <div className="lk-cc-error-msg">
                <span className="lk-cc-icon lk-cc-icon--err">✗</span>
                <span>{errorReason}</span>
              </div>
            )}
            {failedAtPhase && (
              <div className="lk-cc-error-detail">└─ failed during: {failedAtPhase}</div>
            )}
            {onRetry && (
              <button className="lk-btn lk-btn--small lk-cc-retry-btn" onClick={onRetry}>
                ↻ Retry
              </button>
            )}
          </div>
        )}

        {/* Done summary */}
        {summaryMsg && (
          <div className="lk-cc-summary">
            {typeof summaryMsg.content === 'string' ? renderMarkdown(summaryMsg.content) : null}
          </div>
        )}

        {/* Plan approval (amplifier pre-execution confirmation) */}
        {planApproval && (
          <div className="lk-cc-approval">
            <div className="lk-cc-approval-text">
              Plan ready{planApproval.summary ? ` — ${planApproval.summary.slice(0, 160)}` : ''}
            </div>
            <div className="lk-cc-approval-actions">
              <button className="lk-btn lk-btn--small lk-btn--success" onClick={onApprovePlan}>▶ Execute</button>
              <button className="lk-btn lk-btn--small" onClick={onCancelPlan}>✗ Cancel</button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
})

export default BluswanActivityFeed
