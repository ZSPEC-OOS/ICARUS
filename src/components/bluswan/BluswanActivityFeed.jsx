import { memo, useRef, useEffect, useState, useCallback } from 'react'

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

// ─── Toolbox slider row ───────────────────────────────────────────────────────
function TRow({ label, value, min, max, step = 1, unit = '', onChange }) {
  return (
    <tr>
      <td style={{ color: 'rgba(147,197,253,0.6)', fontSize: '0.68rem', paddingRight: 8, paddingBottom: 5, whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
        {label}
      </td>
      <td style={{ paddingBottom: 5, verticalAlign: 'middle' }}>
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))}
          style={{ width: 90, accentColor: '#4d9cff', verticalAlign: 'middle', cursor: 'pointer' }}
        />
      </td>
      <td style={{ paddingLeft: 6, paddingBottom: 5, verticalAlign: 'middle' }}>
        <input
          type="number" min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))}
          style={{
            width: 50, background: 'rgba(5,12,28,0.8)', border: '1px solid rgba(77,156,255,0.2)',
            borderRadius: 5, color: '#e8f4ff', fontSize: '0.7rem', padding: '1px 4px',
            fontFamily: 'monospace', textAlign: 'right',
          }}
        />
        <span style={{ color: 'rgba(147,197,253,0.45)', marginLeft: 3, fontSize: '0.67rem' }}>{unit}</span>
      </td>
    </tr>
  )
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

  // ── Toolbox state ─────────────────────────────────────────────────────────
  const [posX,          setPosX]          = useState(null)   // null = not yet positioned
  const [posY,          setPosY]          = useState(null)
  const [boxWidth,      setBoxWidth]      = useState(480)
  const [boxHeight,     setBoxHeight]     = useState(320)
  const [bgOpacity,     setBgOpacity]     = useState(8)      // %  (maps to 0.08 default)
  const [blur,          setBlur]          = useState(6)      // px
  const [borderRadius,  setBorderRadius]  = useState(10)     // px
  const [borderOpacity, setBorderOpacity] = useState(10)     // %
  const [padding,       setPadding]       = useState(14)     // px
  const [showHud,       setShowHud]       = useState(true)
  const hasDragged = useRef(false)

  // Auto-scroll developing box to bottom on every render
  useEffect(() => {
    const el = streamBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  // Centre on screen when the developing box first appears
  useEffect(() => {
    if (isDeveloping && posX === null) {
      setPosX(Math.round((window.innerWidth  - boxWidth)  / 2))
      setPosY(Math.round((window.innerHeight - boxHeight) / 2))
    }
  }) // runs every render but only sets once due to posX === null guard

  // ── Drag ──────────────────────────────────────────────────────────────────
  const onDragDown = useCallback((e) => {
    if (posX === null || e.target.closest('[data-no-drag]')) return
    e.preventDefault()
    hasDragged.current = true
    const startX = e.clientX - posX
    const startY = e.clientY - posY
    function onMove(e) {
      setPosX(e.clientX - startX)
      setPosY(e.clientY - startY)
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [posX, posY])

  // ── Resize right edge ─────────────────────────────────────────────────────
  const onResizeRight = useCallback((e) => {
    e.stopPropagation(); e.preventDefault()
    const startX = e.clientX, startW = boxWidth
    function onMove(e) { setBoxWidth(Math.max(240, Math.min(1200, startW + e.clientX - startX))) }
    function onUp() { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [boxWidth])

  // ── Resize bottom edge ────────────────────────────────────────────────────
  const onResizeBottom = useCallback((e) => {
    e.stopPropagation(); e.preventDefault()
    const startY = e.clientY, startH = boxHeight
    function onMove(e) { setBoxHeight(Math.max(100, Math.min(900, startH + e.clientY - startY))) }
    function onUp() { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [boxHeight])

  // ── Resize corner (both) ──────────────────────────────────────────────────
  const onResizeCorner = useCallback((e) => {
    e.stopPropagation(); e.preventDefault()
    const startX = e.clientX, startY = e.clientY, startW = boxWidth, startH = boxHeight
    function onMove(e) {
      setBoxWidth( Math.max(240, Math.min(1200, startW + e.clientX - startX)))
      setBoxHeight(Math.max(100, Math.min(900,  startH + e.clientY - startY)))
    }
    function onUp() { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [boxWidth, boxHeight])

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

  const bgAlpha     = (bgOpacity     / 100).toFixed(2)
  const borderAlpha = (borderOpacity / 100).toFixed(2)

  return (
    <div className="lk-output lk-activity-output" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="lk-activity-feed" ref={feedRef}>

        {/* ── Chat history ──────────────────────────────────────────────── */}
        {conversation?.length > 0 && (
          <div className="lk-chat-history">
            {conversation.map((msg, i) => (
              <div key={i} className={`lk-chat-msg lk-chat-msg--${msg.role}`}>
                <span className="lk-chat-label">{msg.role === 'user' ? 'You' : 'BLUSWAN'}</span>
                <div className="lk-chat-bubble lk-chat-bubble--markdown">
                  {typeof msg.content === 'string'
                    ? renderMarkdown(msg.content.slice(0, 4000) + (msg.content.length > 4000 ? '…' : ''))
                    : '[content]'}
                </div>
              </div>
            ))}
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

      {/* ── Developing box — floating, freely positionable ────────────────── */}
      {isDeveloping && posX !== null && (
        <div
          className={['lk-developing-box-wrap', boxState && `lk-developing-box-wrap--${boxState}`].filter(Boolean).join(' ')}
          onMouseDown={onDragDown}
          style={{
            position: 'fixed',
            left: posX,
            top:  posY,
            width: boxWidth,
            zIndex: 900,
            cursor: 'grab',
            userSelect: 'none',
          }}
        >
          {boxState === 'processing' && (
            <div className="lk-spin-clip" aria-hidden="true">
              <div className="lk-spin-gradient" />
            </div>
          )}

          <div
            className="lk-developing-box"
            ref={streamBoxRef}
            data-no-drag
            style={{
              height: boxHeight,
              padding,
              borderRadius,
              background: `rgba(0, 0, 0, ${bgAlpha})`,
              backdropFilter: `blur(${blur}px)`,
              WebkitBackdropFilter: `blur(${blur}px)`,
              border: `1px solid rgba(116, 192, 252, ${borderAlpha})`,
              overflowY: 'auto',
              overflowX: 'hidden',
              scrollBehavior: 'smooth',
              scrollbarWidth: 'none',
              cursor: 'default',
            }}
          >
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

            {amplifierDecisions.map((d, i) => (
              <div key={`amp-${i}`} className="lk-stream-line">{d}</div>
            ))}

            {isAmplifying    && <div className="lk-stream-line lk-stream-line--live">Amplifying intent</div>}
            {isPlanning      && <div className="lk-stream-line lk-stream-line--live">Planning across repo</div>}
            {remediationStatus && <div className="lk-stream-line lk-stream-line--live">{remediationStatus}</div>}
            {isGenerating    && <div className="lk-stream-line lk-stream-line--live">Generating</div>}
            {isPushing       && <div className="lk-stream-line lk-stream-line--live">Pushing</div>}

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

            {isAgentRunning && agentStreamText && (
              <div className="lk-stream-line lk-stream-line--current">
                {renderInlineMarkdown(agentStreamText)}
                <span className="lk-stream-cursor">▋</span>
              </div>
            )}

            {boxState === 'error' && errorReason && (
              <div className="lk-stream-error-reason">
                <span className="lk-stream-error-icon">✗</span>
                {errorReason}
              </div>
            )}
          </div>

          {/* Right-edge resize */}
          <div data-no-drag onMouseDown={onResizeRight} style={{ position: 'absolute', top: 0, right: -5, width: 10, height: '100%', cursor: 'ew-resize', zIndex: 10 }} />
          {/* Bottom-edge resize */}
          <div data-no-drag onMouseDown={onResizeBottom} style={{ position: 'absolute', bottom: -5, left: 0, width: '100%', height: 10, cursor: 'ns-resize', zIndex: 10 }} />
          {/* Corner resize */}
          <div data-no-drag onMouseDown={onResizeCorner} style={{ position: 'absolute', bottom: -5, right: -5, width: 14, height: 14, cursor: 'nwse-resize', zIndex: 11, background: 'rgba(77,156,255,0.25)', borderRadius: 3 }} />
        </div>
      )}

      {/* ── Toolbox HUD ───────────────────────────────────────────────────── */}
      {isDeveloping && (
        <div
          data-no-drag
          style={{
            position: 'fixed', bottom: 18, right: 18,
            background: 'rgba(3,8,20,0.96)',
            border: '1px solid rgba(77,156,255,0.28)',
            borderRadius: 14,
            padding: '10px 14px',
            backdropFilter: 'blur(16px)',
            zIndex: 9999,
            userSelect: 'none',
            minWidth: 270,
            fontFamily: 'monospace',
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showHud ? 8 : 0, borderBottom: showHud ? '1px solid rgba(77,156,255,0.12)' : 'none', paddingBottom: showHud ? 7 : 0 }}>
            <span style={{ color: '#4d9cff', fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.1em' }}>TOOLBOX</span>
            <button onClick={() => setShowHud(v => !v)} style={{ background: 'none', border: 'none', color: '#4d9cff', cursor: 'pointer', fontSize: '0.7rem', padding: 0 }}>
              {showHud ? 'hide ▲' : 'show ▼'}
            </button>
          </div>

          {showHud && (
            <>
              <div style={{ color: 'rgba(77,156,255,0.4)', fontSize: '0.63rem', letterSpacing: '0.08em', marginBottom: 4 }}>POSITION &amp; SIZE</div>
              <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 8 }}>
                <tbody>
                  <TRow label="Left"   value={posX ?? 0} min={-400} max={3000} onChange={setPosX}      unit="px" />
                  <TRow label="Top"    value={posY ?? 0} min={-400} max={2000} onChange={setPosY}      unit="px" />
                  <TRow label="Width"  value={boxWidth}  min={240}  max={1200} onChange={setBoxWidth}  unit="px" />
                  <TRow label="Height" value={boxHeight} min={100}  max={900}  onChange={setBoxHeight} unit="px" />
                </tbody>
              </table>

              <div style={{ color: 'rgba(77,156,255,0.4)', fontSize: '0.63rem', letterSpacing: '0.08em', marginBottom: 4 }}>APPEARANCE</div>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <tbody>
                  <TRow label="BG Opacity"     value={bgOpacity}     min={0} max={100} onChange={setBgOpacity}     unit="%" />
                  <TRow label="Blur"           value={blur}          min={0} max={60}  onChange={setBlur}          unit="px" />
                  <TRow label="Corner Radius"  value={borderRadius}  min={0} max={50}  onChange={setBorderRadius}  unit="px" />
                  <TRow label="Border Opacity" value={borderOpacity} min={0} max={100} onChange={setBorderOpacity} unit="%" />
                  <TRow label="Padding"        value={padding}       min={4} max={60}  onChange={setPadding}       unit="px" />
                </tbody>
              </table>

              <button
                onClick={() => {
                  const w = 480, h = 320
                  setPosX(Math.round((window.innerWidth  - w) / 2))
                  setPosY(Math.round((window.innerHeight - h) / 2))
                  setBoxWidth(w); setBoxHeight(h)
                  setBgOpacity(8); setBlur(6); setBorderRadius(10); setBorderOpacity(10); setPadding(14)
                }}
                style={{
                  marginTop: 10, width: '100%', padding: '4px 0',
                  background: 'rgba(26,78,168,0.2)', border: '1px solid rgba(77,156,255,0.18)',
                  borderRadius: 7, color: '#93c5fd', cursor: 'pointer', fontSize: '0.68rem',
                }}
              >
                Reset to defaults
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
})

export default BluswanActivityFeed
