import { memo, useRef, useEffect } from 'react'

// ─── Inline markdown (for chat bubbles and stream text) ───────────────────────
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
    if (listItems.length > 0) {
      blocks.push(
        <ul key={`list-${blocks.length}`} className="lk-md-list">
          {listItems.map((item, i) => <li key={i}>{renderInlineMarkdown(item)}</li>)}
        </ul>,
      )
      listItems = []
    }
  }

  lines.forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed) { flushList(); blocks.push(<div key={`sp-${blocks.length}`} className="lk-md-spacer" />); return }
    if (/^[-*]\s+/.test(trimmed)) { listItems.push(trimmed.replace(/^[-*]\s+/, '')); return }
    flushList()
    if      (trimmed.startsWith('### ')) blocks.push(<h4 key={`h3-${blocks.length}`}>{renderInlineMarkdown(trimmed.slice(4))}</h4>)
    else if (trimmed.startsWith('## '))  blocks.push(<h3 key={`h2-${blocks.length}`}>{renderInlineMarkdown(trimmed.slice(3))}</h3>)
    else if (trimmed.startsWith('# '))   blocks.push(<h2 key={`h1-${blocks.length}`}>{renderInlineMarkdown(trimmed.slice(2))}</h2>)
    else blocks.push(<p key={`p-${blocks.length}`}>{renderInlineMarkdown(trimmed)}</p>)
  })
  flushList()
  return blocks
}

// ─── Main component ───────────────────────────────────────────────────────────
const BluswanActivityFeed = memo(function BluswanActivityFeed({
  activityLog,
  isAgentRunning,
  agentStreamText,
  isGenerating,
  isPushing,
  feedRef,
  conversation,
  agentIntent: _agentIntent,
  agentTask,
  agentPhase: _agentPhase,
  filePlan = [],
  isAmplifying = false,
  amplifierDecisions = [],
  isPlanning = false,
  remediationStatus = null,
  planApproval = null,
  onApprovePlan,
  onCancelPlan,
}) {
  const streamBoxRef = useRef(null)

  // Auto-scroll to bottom on every render so new lines stay visible
  useEffect(() => {
    const el = streamBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  // ── Derive box state from agent lifecycle ─────────────────────────────────
  const wasTerminated = !isAgentRunning && agentTask?.status === 'interrupted'
  const hasError = !isAgentRunning && !wasTerminated &&
    activityLog.some(e => e.type === 'error' || e.status === 'error')
  const isDone = !isAgentRunning && !wasTerminated && !hasError &&
    activityLog.some(e => e.type === 'done')
  const boxState = isAgentRunning
    ? 'processing'
    : wasTerminated ? 'terminated'
    : hasError      ? 'error'
    : isDone        ? 'done'
    : null

  const isDeveloping =
    activityLog.length > 0 ||
    amplifierDecisions.length > 0 ||
    filePlan.length > 0 ||
    isAmplifying || isPlanning || isGenerating || isPushing ||
    remediationStatus || (isAgentRunning && agentStreamText)

  const errorReason = hasError
    ? (() => {
        const errEntries = activityLog.filter(e => e.type === 'error' || e.status === 'error')
        const last = errEntries[errEntries.length - 1]
        return last ? String(last.msg || '').replace(/^[✗⚠●]\s*/u, '').trim() : null
      })()
    : null

  // Summary = last assistant message, shown inside the box when done
  const summaryMsg = isDone && conversation?.length > 0
    ? [...conversation].reverse().find(m => m.role === 'assistant')
    : null

  return (
    <div className="lk-output lk-activity-output" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="lk-activity-feed" ref={feedRef}>

        {/* ── Chat history ──────────────────────────────────────────────── */}
        {conversation?.length > 0 && (
          <div className="lk-chat-history">
            {conversation.map((msg, i) => {
              // Skip last assistant msg if it will appear as summary inside the box
              if (summaryMsg && msg.role === 'assistant' && i === conversation.length - 1) return null
              return (
                <div key={i} className={`lk-chat-msg lk-chat-msg--${msg.role}`}>
                  <span className="lk-chat-label">{msg.role === 'user' ? 'You' : 'BLUSWAN'}</span>
                  <div className="lk-chat-bubble lk-chat-bubble--markdown">
                    {typeof msg.content === 'string'
                      ? renderMarkdown(msg.content.slice(0, 4000) + (msg.content.length > 4000 ? '…' : ''))
                      : '[content]'}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* ── Single developing stream box ───────────────────────────────── */}
        {isDeveloping && (
          <div className="lk-developing-box-center">
            <div className={['lk-developing-box-wrap', boxState && `lk-developing-box-wrap--${boxState}`].filter(Boolean).join(' ')}>
              {/* Spinning arc: CSS transform:rotate() — hardware-accelerated on iOS */}
              {boxState === 'processing' && (
                <div className="lk-spin-clip" aria-hidden="true">
                  <div className="lk-spin-gradient" />
                </div>
              )}
              <div className="lk-developing-box" ref={streamBoxRef}>

                {/* Activity log — all entries as plain text lines */}
                {activityLog.map(entry => {
                  const text = [entry.msg, entry.detail].filter(Boolean).join(' — ')
                  const done = entry.status === 'done' || entry.status === 'skip'
                  const active = entry.status === 'active'
                  return (
                    <div
                      key={entry.id}
                      className={[
                        'lk-stream-line',
                        done   ? 'lk-stream-line--dim'  : '',
                        active ? 'lk-stream-line--live' : '',
                      ].filter(Boolean).join(' ')}
                    >
                      {text}
                    </div>
                  )
                })}

                {/* Amplifier decisions */}
                {amplifierDecisions.map((d, i) => (
                  <div key={`amp-${i}`} className="lk-stream-line">{d}</div>
                ))}

                {/* Status lines */}
                {isAmplifying    && <div className="lk-stream-line lk-stream-line--live">Amplifying intent</div>}
                {isPlanning      && <div className="lk-stream-line lk-stream-line--live">Planning across repo</div>}
                {remediationStatus && <div className="lk-stream-line lk-stream-line--live">{remediationStatus}</div>}
                {isGenerating    && <div className="lk-stream-line lk-stream-line--live">Generating</div>}
                {isPushing       && <div className="lk-stream-line lk-stream-line--live">Pushing</div>}

                {/* File plan */}
                {filePlan.map(entry => {
                  const action = entry.action === 'modify' ? 'editing' : 'writing'
                  const done   = entry.status === 'done'
                  const err    = entry.status === 'error'
                  const live   = !done && !err
                  return (
                    <div
                      key={`fp-${entry.path}`}
                      className={[
                        'lk-stream-line',
                        done ? 'lk-stream-line--dim'   : '',
                        err  ? 'lk-stream-line--error' : '',
                        live ? 'lk-stream-line--live'  : '',
                      ].filter(Boolean).join(' ')}
                    >
                      {action} {entry.path}{entry.error ? ` — ${entry.error}` : ''}
                    </div>
                  )
                })}

                {/* Live stream text */}
                {isAgentRunning && agentStreamText && (
                  <div className="lk-stream-line lk-stream-line--current">
                    {renderInlineMarkdown(agentStreamText)}
                    <span className="lk-stream-cursor">▋</span>
                  </div>
                )}

                {/* Failure reason */}
                {boxState === 'error' && errorReason && (
                  <div className="lk-stream-error-reason">
                    <span className="lk-stream-error-icon">✗</span>
                    {errorReason}
                  </div>
                )}

                {/* Summary — last assistant message, shown inside box when done */}
                {summaryMsg && (
                  <div className="lk-stream-summary">
                    {typeof summaryMsg.content === 'string'
                      ? renderMarkdown(summaryMsg.content)
                      : null}
                  </div>
                )}

              </div>
            </div>
          </div>
        )}

        {/* ── Plan approval — outside stream box, needs button interaction ── */}
        {planApproval && (
          <div className="lk-stream-plan-approval">
            <div className="lk-stream-plan-text">
              Plan ready{planApproval.summary ? ` — ${planApproval.summary.slice(0, 160)}` : ''}
            </div>
            <div className="lk-stream-plan-actions">
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
