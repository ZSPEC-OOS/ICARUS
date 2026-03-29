import { memo } from 'react'
import { INTENT_LABELS } from '../../services/interactivePipeline.js'

function renderInlineMarkdown(text) {
  const parts = String(text || '').split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={idx}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={idx}>{part.slice(1, -1)}</code>
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
    if (!trimmed) {
      flushList()
      blocks.push(<div key={`sp-${blocks.length}`} className="lk-md-spacer" />)
      return
    }
    if (/^[-*]\s+/.test(trimmed)) {
      listItems.push(trimmed.replace(/^[-*]\s+/, ''))
      return
    }

    flushList()
    if (trimmed.startsWith('### ')) blocks.push(<h4 key={`h3-${blocks.length}`}>{renderInlineMarkdown(trimmed.slice(4))}</h4>)
    else if (trimmed.startsWith('## ')) blocks.push(<h3 key={`h2-${blocks.length}`}>{renderInlineMarkdown(trimmed.slice(3))}</h3>)
    else if (trimmed.startsWith('# ')) blocks.push(<h2 key={`h1-${blocks.length}`}>{renderInlineMarkdown(trimmed.slice(2))}</h2>)
    else blocks.push(<p key={`p-${blocks.length}`}>{renderInlineMarkdown(trimmed)}</p>)
  })

  flushList()
  return blocks
}

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
}) {
  return (
    <div className="lk-output lk-activity-output" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="lk-activity-feed" ref={feedRef}>
        {conversation?.length > 0 && (
          <div className="lk-chat-history">
            {conversation.map((msg, i) => (
              <div key={i} className={`lk-chat-msg lk-chat-msg--${msg.role}`}>
                <span className="lk-chat-label">{msg.role === 'user' ? 'You' : 'Assistant'}</span>
                <div className="lk-chat-bubble lk-chat-bubble--markdown">
                  {typeof msg.content === 'string'
                    ? renderMarkdown(msg.content.slice(0, 4000) + (msg.content.length > 4000 ? '...' : ''))
                    : '[content]'}
                </div>
              </div>
            ))}
          </div>
        )}

        {isAgentRunning && agentIntent && (
          <div className="lk-intent-badge" data-intent={agentIntent}>
            <span className="lk-intent-icon">*</span>
            <span className="lk-intent-label">{INTENT_LABELS[agentIntent] || agentIntent}</span>
            {agentTask?.goal && (
              <span className="lk-intent-goal">{agentTask.goal.slice(0, 80)}</span>
            )}
          </div>
        )}

        {activityLog.length === 0 && !conversation?.length ? (
          <div className="lk-activity-empty">No activity yet - generate code to see live operations.</div>
        ) : (
          activityLog.map(entry => {
            const isCompleteMessage = /agent complete/i.test(entry.msg || '')
            return (
              <div
                key={entry.id}
                className={`lk-activity-line lk-activity-line--${entry.status} lk-activity-line--${entry.type}${isCompleteMessage ? ' lk-activity-line--agent-complete' : ''}`}
              >
                <span className="lk-activity-icon">
                  {entry.status === 'active' && !isCompleteMessage
                    ? <span className="lk-spinner" />
                    : entry.status === 'done' || isCompleteMessage ? '✓'
                    : entry.status === 'error' ? 'X'
                    : '-'}
                </span>
                <span className="lk-activity-body">
                  <span className="lk-activity-msg">{entry.msg}</span>
                  {entry.detail && <span className="lk-activity-detail">{entry.detail}</span>}
                </span>
              </div>
            )
          })
        )}

        {isAgentRunning && agentStreamText && (
          <div className="lk-activity-line lk-activity-line--active lk-activity-line--agent lk-activity-stream">
            <span className="lk-activity-icon"><span className="lk-spinner" /></span>
            <span className="lk-activity-body">
              <span className="lk-activity-msg">{renderInlineMarkdown(agentStreamText)}<span className="lk-stream-cursor">|</span></span>
            </span>
          </div>
        )}

        {(isGenerating || isPushing) && (
          <div className="lk-activity-line lk-activity-line--active">
            <span className="lk-activity-icon"><span className="lk-spinner" /></span>
            <span className="lk-activity-body">
              <span className="lk-activity-msg">{isGenerating ? 'Generating...' : 'Pushing...'}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  )
})

export default LogikActivityFeed
