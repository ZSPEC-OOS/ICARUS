import { memo } from 'react'

// ─── BluswanTerminal ────────────────────────────────────────────────────────────
// Interactive terminal: JS/Python sandbox execution + real shell via exec bridge.
const BluswanTerminal = memo(function BluswanTerminal({
  terminalLog,
  terminalInput,
  onInputChange,
  isTerminalRunning,
  onRunCommand,
  onClearLog,
}) {
  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey && !isTerminalRunning) {
      e.preventDefault()
      onRunCommand(terminalInput)
      onInputChange('')
    }
  }

  return (
    <div className="lk-output" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="lk-terminal-controls">
        <div className="lk-terminal-warn">
          💻 JS/Python runs in real sandbox · Shell cmds require a backend bridge · type <code>help</code>
        </div>
        <div className="lk-terminal-input-row">
          <input
            className="lk-input lk-terminal-input"
            placeholder="JS expression, python: print('hi'), or shell command…"
            value={terminalInput}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isTerminalRunning}
          />
          <button
            className="lk-btn lk-btn--run"
            onClick={() => { onRunCommand(terminalInput); onInputChange('') }}
            disabled={!terminalInput.trim() || isTerminalRunning}
          >
            {isTerminalRunning ? <><span className="lk-spinner" /> Running…</> : '▶ Run'}
          </button>
          {terminalLog.length > 0 && (
            <button className="lk-btn lk-btn--small" onClick={onClearLog}>Clear</button>
          )}
        </div>
      </div>

      <div className="lk-terminal-output">
        {terminalLog.length === 0 ? (
          <div className="lk-terminal-empty">
            Type a command above. JS expressions run in real sandbox, Python via Pyodide.<br />
            Examples: <code>2 + 2</code> · <code>python: sum([1,2,3])</code> · <code>help</code>
          </div>
        ) : (
          terminalLog.map((entry, i) => (
            <div key={i} className={`lk-terminal-entry lk-terminal-entry--${entry.type}`}>
              <span className="lk-terminal-prompt">❯ {entry.cmd}</span>
              <pre className="lk-terminal-result">{entry.output}</pre>
              <span className="lk-terminal-ts">{entry.ts}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
})

export default BluswanTerminal
