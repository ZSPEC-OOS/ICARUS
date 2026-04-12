import { memo, useRef, useEffect, useState } from 'react'
import BluswanPhasePlan from './BluswanPhasePlan'

// ─── Inline markdown (for stream text and summaries) ─────────────────────────
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

// ─── Braille spinner (mirrors BLUSWAN TUI: ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏) ─────────────
const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
function BrailleSpinner() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % BRAILLE.length), 80)
    return () => clearInterval(id)
  }, [])
  return <span className="lk-braille-spinner">{BRAILLE[frame]}</span>
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
  agentIntent: _agentIntent,
  agentTask,
  agentPhase: _agentPhase,
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
  lrmPlan = null,
  onLrmStart,
  onLrmProceed,
  onLrmOverride,
  onLrmCancel,
}) {
  const streamBoxRef = useRef(null)

  // ── Output style: true = TUI (Braille spinner + ⎿), false = Classic (◌/✓ chips)
  const [tuiMode, setTuiMode] = useState(true)

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
  const boxState = (isAgentRunning || isGenerating || isPushing)
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
    remediationStatus || isAgentRunning ||
    !!planApproval || !!executedPlan || wasTerminated || hasError ||
    lrmGeneratingPlan || !!lrmPlan

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

  // ── Output line renderers — branch on tuiMode ────────────────────────────
  // Tool event (narration chip or ⎿ line)
  const renderToolLine = (key, status, logMsg) => {
    if (tuiMode) {
      const cls = status === 'done'  ? 'lk-tool-result'
                : status === 'error' ? 'lk-tool-error'
                :                      'lk-tool-active'
      return (
        <div key={key} className={cls}>
          {status === 'done' ? '⎿' : status === 'error' ? '✗' : <BrailleSpinner />}
          {' '}{logMsg}
        </div>
      )
    }
    return (
      <div key={key} className={[
        'lk-narration-chip',
        status === 'done'  ? 'lk-narration-chip--done'  : '',
        status === 'error' ? 'lk-narration-chip--error' : '',
        (!status || status === 'active') ? 'lk-narration-chip--active' : '',
      ].filter(Boolean).join(' ')}>
        {status === 'done' ? '✓' : status === 'error' ? '✗' : '◌'} {logMsg}
      </div>
    )
  }

  // Raw activity-log or file-plan stream line
  const renderStreamEntry = (key, { done, err, active, text }) => {
    if (tuiMode) {
      return (
        <div key={key} className={done ? 'lk-tool-result' : err ? 'lk-tool-error' : active ? 'lk-tool-active' : 'lk-stream-line'}>
          {done && '⎿ '}{err && '✗ '}{active && <><BrailleSpinner />{' '}</>}{text}
        </div>
      )
    }
    return (
      <div key={key} className={[
        'lk-stream-line',
        done   ? 'lk-stream-line--dim'   : '',
        err    ? 'lk-stream-line--error' : '',
        active ? 'lk-stream-line--live'  : '',
      ].filter(Boolean).join(' ')}>
        {text}
      </div>
    )
  }

  // Single-line status (Amplifying / Planning / Generating / Pushing / LRM)
  const renderStatusLine = (key, label) => tuiMode
    ? <div key={key} className="lk-tool-active"><BrailleSpinner /> {label}</div>
    : <div key={key} className="lk-stream-line lk-stream-line--live">{label}</div>

  return (
    <div className="lk-output lk-activity-output" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="lk-activity-feed" ref={feedRef}>

        {/* ── Single developing stream box ───────────────────────────────── */}
        {isDeveloping && (
          <div className="lk-developing-box-center">

            {/* ── Output style toggle ──────────────────────────────────── */}
            <div className="lk-ost-row">
              <button
                className={`lk-ost-btn${!tuiMode ? ' lk-ost-btn--active' : ''}`}
                onClick={() => setTuiMode(false)}
              >Classic</button>
              <button
                className={`lk-ost-btn${tuiMode ? ' lk-ost-btn--active' : ''}`}
                onClick={() => setTuiMode(true)}
              >TUI</button>
            </div>

            <div className={['lk-developing-box-wrap', boxState && `lk-developing-box-wrap--${boxState}`].filter(Boolean).join(' ')}>
              <div className="lk-developing-box" ref={streamBoxRef}>

                {/* Executed plan — shown at top of box once approved, persists during execution */}
                {executedPlan?.summary && (
                  <div className="lk-stream-executed-plan">
                    <div className="lk-stream-executed-plan-hd">▶ Plan</div>
                    <div className="lk-stream-executed-plan-body">
                      {renderMarkdown(executedPlan.summary)}
                    </div>
                  </div>
                )}

                {/* LRM: generating plan status */}
                {lrmGeneratingPlan && renderStatusLine('lrm-gen', 'Analysing request and building phase plan…')}

                {/* ── Narration thread (agent mode) ─────────────────────── */}
                {narrationThread.length > 0 ? (
                  <div className="lk-narration-thread">
                    {narrationThread.map((entry, i) => {
                      if (entry.kind === 'text') {
                        return (
                          <div key={`n-${i}`} className="lk-narration-text">
                            {renderInlineMarkdown(entry.text)}
                          </div>
                        )
                      }
                      if (entry.kind === 'tool') {
                        return renderToolLine(`t-${i}`, entry.status, entry.logMsg)
                      }
                      return null
                    })}
                    {/* Live typing narration */}
                    {isAgentRunning && agentStreamText && (
                      <div className="lk-narration-text lk-narration-text--live">
                        {renderInlineMarkdown(agentStreamText)}
                        <span className="lk-stream-cursor">▋</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {/* Fallback: raw activity log when no narration yet */}
                    {activityLog.map(entry => {
                      const text   = [entry.msg, entry.detail].filter(Boolean).join(' — ')
                      const done   = entry.status === 'done' || entry.status === 'skip'
                      const err    = entry.status === 'error'
                      const active = entry.status === 'active'
                      return renderStreamEntry(entry.id, { done, err, active, text })
                    })}

                    {/* Amplifier decisions */}
                    {amplifierDecisions.map((d, i) => tuiMode
                      ? <div key={`amp-${i}`} className="lk-tool-result">⎿ {d}</div>
                      : <div key={`amp-${i}`} className="lk-stream-line">{d}</div>
                    )}

                    {/* Status lines */}
                    {isAmplifying    && renderStatusLine('amp',  'Amplifying intent')}
                    {isPlanning      && renderStatusLine('plan', 'Planning across repo')}
                    {remediationStatus && renderStatusLine('rem', remediationStatus)}
                    {isGenerating    && renderStatusLine('gen',  'Generating')}
                    {isPushing       && renderStatusLine('push', pushStep || 'Pushing')}

                    {/* File plan */}
                    {filePlan.map(entry => {
                      const done = entry.status === 'done'
                      const err  = entry.status === 'error'
                      const live = !done && !err
                      if (tuiMode) {
                        const action = entry.action === 'modify' ? 'Edit' : 'Write'
                        return (
                          <div
                            key={`fp-${entry.path}`}
                            className={done ? 'lk-tool-result' : err ? 'lk-tool-error' : 'lk-tool-active'}
                          >
                            {done && '⎿'}{err && '✗'}{live && <BrailleSpinner />}
                            {' '}{action} {entry.path}{entry.error ? ` — ${entry.error}` : ''}
                          </div>
                        )
                      }
                      const action = entry.action === 'modify' ? 'editing' : 'writing'
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
                  </>
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

                {/* Plan approval — inside the box so all output stays together */}
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

            {/* LRM phase plan — rendered below the stream box, inside the center wrapper */}
            {lrmPlan && (
              <BluswanPhasePlan
                plan={lrmPlan}
                isGenerating={isGenerating}
                onStart={onLrmStart}
                onProceed={onLrmProceed}
                onOverride={onLrmOverride}
                onCancel={onLrmCancel}
              />
            )}
          </div>
        )}

      </div>
    </div>
  )
})

export default BluswanActivityFeed
