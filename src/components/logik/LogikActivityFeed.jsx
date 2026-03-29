import { memo } from 'react'
import { INTENT_LABELS } from '../../services/interactivePipeline.js'

const LogikActivityFeed = memo(function LogikActivityFeed({
  activityLog,
  isAgentRunning,
  agentStreamText,
  isGenerating,
  isPushing,
  feedRef,
  onViewCode,
  conversation,
  agentIntent,
  agentTask,
  agentPhase,
}) {
  const phaseLabel = agentPhase && agentPhase !== 'complete' && agentPhase !== 'understanding'
    ? agentPhase.charAt(0).toUpperCase() + agentPhase.slice(1)
    : null

  const lastToolMsg = isAgentRunning
    ? [...activityLog].reverse().find(e => e.type === 'tool')?.msg?.replace(/^\* /, '') || null
    : null

  return (
    <div className="lk-output lk-activity-output" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="lk-activity-feed" ref={feedRef}>
        {conversation?.length > 0 && (
          <div className="lk-chat-history">
            {conversation.map((msg, i) => (
              <div key={i} className={`lk-chat-msg lk-chat-msg--${msg.role}`}>
                <span className="lk-chat-label">{msg.role === 'user' ? 'You' : 'Assistant'}</span>
                <div className="lk-chat-bubble">
                  {typeof msg.content === 'string'
                    ? msg.content.slice(0, 800) + (msg.content.length > 800 ? '...' : '')
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
          activityLog.map(entry => (
            <div key={entry.id} className={`lk-activity-line lk-activity-line--${entry.status} lk-activity-line--${entry.type}`}>
              <span className="lk-activity-icon">
                {entry.status === 'active'
                  ? <span className="lk-spinner" />
                  : entry.status === 'done' ? 'OK'
                  : entry.status === 'error' ? 'X'
                  : '-'}
              </span>
              <span className="lk-activity-body">
                <span className="lk-activity-msg">{entry.msg}</span>
                {entry.detail && <span className="lk-activity-detail">{entry.detail}</span>}
              </span>
            </div>
          ))
        )}

        {isAgentRunning && agentStreamText && (
          <div className="lk-activity-line lk-activity-line--active lk-activity-line--agent lk-activity-stream">
            <span className="lk-activity-icon"><span className="lk-spinner" /></span>
            <span className="lk-activity-body">
              <span className="lk-activity-msg">{agentStreamText}<span className="lk-stream-cursor">|</span></span>
            </span>
          </div>
        )}

        {isAgentRunning && phaseLabel && (
          <div className="lk-phase-bar">
            <span className="lk-phase-dot">*</span>
            <span className="lk-phase-name">{phaseLabel}</span>
            {lastToolMsg && (
              <>
                <span className="lk-phase-arrow">-&gt;</span>
                <span className="lk-phase-action">{lastToolMsg}</span>
              </>
            )}
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

      {activityLog.length > 0 && (
        <div className="lk-activity-footer">
          <button className="lk-activity-view-code" onClick={onViewCode}>
            View Generated Code -&gt;
          </button>
        </div>
      )}
    </div>
  )
})

export default LogikActivityFeed
