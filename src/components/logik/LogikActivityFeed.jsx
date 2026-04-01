import { memo, useRef } from 'react'
import { INTENT_LABELS } from '../../services/interactivePipeline.js'

// ─── Inline markdown (unchanged from original) ────────────────────────────────
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

// ─── Entry icon system ────────────────────────────────────────────────────────
// Each type gets a distinct glyph with its own colour class so entries are
// scannable without reading the text.
function EntryIcon({ entry }) {
  if (entry.status === 'active' && !isCompleteMsg(entry.msg)) {
    return <span className="lk-spinner" />
  }
  const t = entry.type
  const s = entry.status
  if (t === 'write')  return <span className="lk-ei lk-ei--write">✏</span>
  if (t === 'done')   return <span className="lk-ei lk-ei--done">✓</span>
  if (t === 'error' || s === 'error') return <span className="lk-ei lk-ei--error">✗</span>
  if (t === 'warn'  || s === 'warning') return <span className="lk-ei lk-ei--warn">⚠</span>
  if (t === 'plan')   return <span className="lk-ei lk-ei--plan">◈</span>
  if (t === 'agent')  return <span className="lk-ei lk-ei--agent">⚡</span>
  if (t === 'ci')     return <span className="lk-ei lk-ei--ci">⌥</span>
  if (t === 'fetch')  return <span className="lk-ei lk-ei--fetch">↓</span>
  if (t === 'tool')   return <span className="lk-ei lk-ei--tool">●</span>
  if (s === 'done')   return <span className="lk-ei lk-ei--done">✓</span>
  if (s === 'skip')   return <span className="lk-ei lk-ei--skip">–</span>
  return <span className="lk-ei lk-ei--default">·</span>
}

function isCompleteMsg(msg = '') { return /agent complete/i.test(msg) }

// ─── Tool entry body ──────────────────────────────────────────────────────────
// Parses `● verb: args — detail` from tool messages into structured markup.
function ToolEntryBody({ msg, detail }) {
  // Strip leading bullet
  const clean = String(msg || '').replace(/^[●•·]\s*/, '')

  // Split on first colon to separate verb from args (only if verb is short)
  const colonIdx = clean.indexOf(':')
  if (colonIdx > 0 && colonIdx <= 18) {
    const verb = clean.slice(0, colonIdx).trim()
    const rest = clean.slice(colonIdx + 1).trim()

    // Further split rest on ' — ' to separate path from description
    const dashIdx = rest.indexOf(' — ')
    const path    = dashIdx > 0 ? rest.slice(0, dashIdx).trim() : rest
    const desc    = dashIdx > 0 ? rest.slice(dashIdx + 3).trim() : ''

    return (
      <span className="lk-activity-body">
        <span className="lk-tool-verb">{verb}</span>
        {path && <span className="lk-tool-path">{path}</span>}
        {desc && <span className="lk-tool-desc">{desc}</span>}
        {detail && <span className="lk-activity-detail">{detail.slice(0, 100)}</span>}
      </span>
    )
  }

  // Fallback: render as plain message
  return (
    <span className="lk-activity-body">
      <span className="lk-activity-msg">{renderInlineMarkdown(clean)}</span>
      {detail && <span className="lk-activity-detail">{detail.slice(0, 100)}</span>}
    </span>
  )
}

// ─── Phase section divider ────────────────────────────────────────────────────
function PhaseDivider({ phase }) {
  const LABELS = {
    scoping:    'Reading codebase',
    planning:   'Planning',
    coding:     'Writing code',
    reviewing:  'Reviewing',
    validating: 'Running tests',
    finalizing: 'Finalising',
  }
  return (
    <div className="lk-phase-divider" aria-hidden>
      <span className="lk-phase-divider-label">{LABELS[phase] || phase}</span>
    </div>
  )
}

// ─── Phase inference from entry (presentation-only heuristic) ─────────────────
// We classify each entry so we can insert dividers when the phase changes.
// This is purely visual — it never alters the entry data.
function inferEntryPhase(entry) {
  const msg = (entry.msg || '').toLowerCase()
  if (entry.type === 'plan')   return 'planning'
  if (entry.type === 'write')  return 'coding'
  if (entry.type === 'fetch')  return 'scoping'
  if (entry.type === 'ci')     return 'validating'
  if (entry.type === 'tool') {
    if (/\b(read|list|grep|search|analyz|scan|fetch|index)\b/.test(msg)) return 'scoping'
    if (/\b(write|edit|creat|delet|revert)\b/.test(msg))                 return 'coding'
    if (/\b(lint|test|run|npm|build|check)\b/.test(msg))                 return 'validating'
    if (/\b(pull.request|pr|push|commit|branch)\b/.test(msg))            return 'finalizing'
    if (/\b(todo|plan|task)\b/.test(msg))                                 return 'planning'
  }
  return null
}

// ─── Single activity entry ────────────────────────────────────────────────────
const ActivityEntry = memo(function ActivityEntry({ entry }) {
  const complete  = isCompleteMsg(entry.msg)
  const isToolRow = entry.type === 'tool' || entry.type === 'write' || entry.type === 'fetch'
  const isNarrate = entry.type === 'agent' && !complete

  const cls = [
    'lk-activity-line',
    `lk-activity-line--${entry.status}`,
    `lk-activity-line--${entry.type}`,
    complete  ? 'lk-activity-line--agent-complete' : '',
    isNarrate ? 'lk-activity-line--narration' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cls}>
      <span className="lk-activity-icon">
        <EntryIcon entry={entry} />
      </span>

      {isToolRow ? (
        <ToolEntryBody msg={entry.msg} detail={entry.detail} />
      ) : (
        <span className="lk-activity-body">
          <span className="lk-activity-msg">{renderInlineMarkdown(entry.msg)}</span>
          {entry.detail && <span className="lk-activity-detail">{entry.detail}</span>}
        </span>
      )}
    </div>
  )
})

// ─── Main component ───────────────────────────────────────────────────────────
const LogikActivityFeed = memo(function LogikActivityFeed({
  activityLog,
  isAgentRunning,
  agentStreamText,
  isGenerating,
  isPushing,
  feedRef,
  conversation,
  agentIntent,
  agentTask,
  // New props (4.2 wiring — gracefully ignored if not passed)
  agentPhase: _agentPhase,
}) {
  // Build the render list: entries interleaved with phase dividers
  const renderedItems = []
  let lastPhase = null

  for (const entry of activityLog) {
    const phase = inferEntryPhase(entry)
    if (phase && phase !== lastPhase && !isCompleteMsg(entry.msg)) {
      renderedItems.push({ _divider: true, phase, id: `div-${entry.id}` })
      lastPhase = phase
    }
    renderedItems.push(entry)
  }

  return (
    <div className="lk-output lk-activity-output" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="lk-activity-feed" ref={feedRef}>

        {/* ── Chat history ──────────────────────────────────────────────── */}
        {conversation?.length > 0 && (
          <div className="lk-chat-history">
            {conversation.map((msg, i) => (
              <div key={i} className={`lk-chat-msg lk-chat-msg--${msg.role}`}>
                <span className="lk-chat-label">{msg.role === 'user' ? 'You' : 'Assistant'}</span>
                <div className="lk-chat-bubble lk-chat-bubble--markdown">
                  {typeof msg.content === 'string'
                    ? renderMarkdown(msg.content.slice(0, 4000) + (msg.content.length > 4000 ? '…' : ''))
                    : '[content]'}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Intent badge (legacy — kept for non-agent sessions) ───────── */}
        {isAgentRunning && agentIntent && !agentTask?.goal && (
          <div className="lk-intent-badge" data-intent={agentIntent}>
            <span className="lk-intent-icon">*</span>
            <span className="lk-intent-label">{INTENT_LABELS[agentIntent] || agentIntent}</span>
          </div>
        )}

        {/* ── Empty state ───────────────────────────────────────────────── */}
        {activityLog.length === 0 && !conversation?.length ? (
          <div className="lk-activity-empty">No activity yet — run the agent to see live operations.</div>
        ) : (
          renderedItems.map(item =>
            item._divider
              ? <PhaseDivider key={item.id} phase={item.phase} />
              : <ActivityEntry key={item.id} entry={item} />
          )
        )}

        {/* ── Live stream text panel ────────────────────────────────────── */}
        {isAgentRunning && agentStreamText && (
          <div className="lk-stream-panel">
            <span className="lk-stream-panel-icon">⚡</span>
            <span className="lk-stream-panel-text">
              {renderInlineMarkdown(agentStreamText)}
              <span className="lk-stream-cursor">|</span>
            </span>
          </div>
        )}

        {/* ── Generating / pushing spinners ─────────────────────────────── */}
        {(isGenerating || isPushing) && (
          <div className="lk-activity-line lk-activity-line--active">
            <span className="lk-activity-icon"><span className="lk-spinner" /></span>
            <span className="lk-activity-body">
              <span className="lk-activity-msg">{isGenerating ? 'Generating…' : 'Pushing…'}</span>
            </span>
          </div>
        )}

      </div>
    </div>
  )
})

export default LogikActivityFeed
