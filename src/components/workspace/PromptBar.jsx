// ─── PromptBar ────────────────────────────────────────────────────────────────
// Bottom input card extracted from Bluswan.jsx.
// Receives a focused slice of workspace state as props.

import { useRef } from 'react'

export default function PromptBar({
  // input state
  prompt, setPrompt,
  attachedFiles, setAttachedFiles,
  fileInputRef,
  refinementPrompt,
  generatedCode,
  // busy flags
  isGenerating,
  isPushing,
  agentSession,
  // handlers
  handleRefine,
  handleSubmitPrompt,
  handleKeyDown,
  handleAbort,
  // run tests button
  bridgeAvailable,
  prResult,
  handleRunProjectTests,
  isRunningPostPushTests,
  // LRM
  longRequestMode, setLongRequestMode,
  executionMode, setExecutionMode,
  lrmPlan, setLrmPlan,
  // model selector
  models,
  activeModelId, setActiveModelId,
  onModelChange,
  // branch row
  baseBranch,
  lastBranchName,
  // error / pr badge
  error,
}) {
  const busy = isGenerating || isPushing

  return (
    <div className="lk-input-bar">
      <div className="lk-input-inner">

        {error && <div className="lk-error" role="alert">{error}</div>}

        {prResult && (
          <a className="lk-pr-badge" href={prResult.url} target="_blank" rel="noopener noreferrer">
            <span className="lk-pr-icon">↗</span>
            Pull Request {prResult.number ? `#${prResult.number}` : 'created'}
          </a>
        )}

        <div className="lk-input-card">

          {/* Branch row */}
          <div className="lk-input-branch-row">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style={{flexShrink:0,opacity:0.6}}>
              <path d="M5.559 8.855c.166 1.183 1.19 2.145 2.456 2.145a2.58 2.58 0 0 0 2.516-2H12a1 1 0 1 0 0-2h-1.47A2.58 2.58 0 0 0 8.015 5C6.749 5 5.725 5.962 5.559 7.145H4a1 1 0 1 0 0 2h1.559zM8.015 7a.58.58 0 1 1 0 1.16.58.58 0 0 1 0-1.16z"/>
              <path fillRule="evenodd" d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8zm7-6a6 6 0 1 0 0 12A6 6 0 0 0 8 2z"/>
            </svg>
            <span className="lk-branch-base">{baseBranch || 'main'}</span>
            {lastBranchName && (
              <>
                <span className="lk-branch-arrow">←</span>
                <span className="lk-branch-feature">{lastBranchName}</span>
              </>
            )}
          </div>

          {/* Hidden file input */}
          <input
            type="file"
            ref={fileInputRef}
            multiple
            accept="image/*,text/*,application/json,application/pdf,.md,.txt,.js,.ts,.jsx,.tsx,.py,.go,.rs,.java,.css,.html"
            style={{ display: 'none' }}
            onChange={e => {
              const files = Array.from(e.target.files || [])
              if (files.length) setAttachedFiles(prev => [...prev, ...files])
              e.target.value = ''
            }}
          />

          {/* Textarea */}
          <textarea
            className="lk-textarea"
            placeholder="Reply..."
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isGenerating || agentSession.isAgentRunning}
          />

          {/* Attached file chips */}
          {attachedFiles.length > 0 && (
            <div className="lk-attached-files-row">
              {attachedFiles.map((f, i) => (
                <div key={i} className="lk-attached-chip">
                  <span className="lk-attached-chip-name" title={f.name}>{f.name}</span>
                  <button
                    className="lk-attached-chip-remove"
                    onClick={() => setAttachedFiles(prev => prev.filter((_, j) => j !== i))}
                    title="Remove attachment"
                  >✕</button>
                </div>
              ))}
            </div>
          )}

          {/* Toolbar */}
          <div className="lk-input-toolbar">

            <div className="lk-input-toolbar-left">
              <button
                className="lk-toolbar-btn lk-toolbar-btn--plus"
                title="Attach files or photos"
                onClick={() => fileInputRef.current?.click()}
              >+</button>
              <button
                className={`lk-toolbar-btn--lrm${longRequestMode ? ' lk-toolbar-btn--lrm-on' : ''}`}
                title={longRequestMode ? 'Long Request Mode ON — click to disable' : 'Enable Long Request Mode'}
                onClick={() => { setLongRequestMode(v => !v); if (!longRequestMode) setLrmPlan(null) }}
              >⇥ LRM</button>
              <button
                className={`lk-toolbar-btn--drct${executionMode === 'drct' ? ' lk-toolbar-btn--drct-on' : ''}`}
                title={executionMode === 'drct' ? 'DRCT Creative Mode ON — click to disable' : 'Enable DRCT Creative Mode'}
                onClick={() => setExecutionMode(prev => prev === 'drct' ? 'default' : 'drct')}
              >🎨 DRCT</button>
            </div>

            <div className="lk-input-toolbar-right">

              {bridgeAvailable && prResult && (
                <button className="lk-btn lk-btn--run" onClick={handleRunProjectTests} disabled={isRunningPostPushTests}>
                  <span className="lk-btn-icon">⊛</span>
                  {isRunningPostPushTests ? 'Running…' : 'Run Tests'}
                </button>
              )}

              <select
                className="lk-toolbar-model-select"
                value={activeModelId}
                onChange={e => { setActiveModelId(e.target.value); onModelChange?.(e.target.value) }}
                disabled={busy}
              >
                <option value="">Model…</option>
                {(models || []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>

              <button
                className="lk-toolbar-btn lk-toolbar-btn--stop"
                onClick={handleAbort}
                disabled={!busy && !agentSession.isAgentRunning}
                title={busy || agentSession.isAgentRunning ? 'Stop generation' : 'Nothing running'}
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
                  <rect x="1.5" y="1.5" width="9" height="9" rx="2"/>
                </svg>
              </button>

              <button
                className="lk-toolbar-btn lk-toolbar-btn--send"
                onClick={handleSubmitPrompt}
                disabled={busy || agentSession.isAgentRunning || (!prompt.trim() && attachedFiles.length === 0)}
                title="Send message"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M15.854.146a.5.5 0 0 1 .11.54l-5.819 14.547a.75.75 0 0 1-1.329.124l-3.178-4.995L.643 7.184a.75.75 0 0 1 .124-1.33L15.314.037a.5.5 0 0 1 .54.109z"/>
                </svg>
              </button>

            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
