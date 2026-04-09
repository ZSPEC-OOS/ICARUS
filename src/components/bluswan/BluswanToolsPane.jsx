import { useState, memo } from 'react'

// ─── BluswanToolsPane ───────────────────────────────────────────────────────────
// Quick-access tool buttons (npm test / lint / build / git) + custom command input.
const TOOL_BUTTONS = [
  { label: 'Run Tests',    cmd: 'npm test',              tool: 'test'       },
  { label: 'Run Linter',   cmd: 'npm run lint',          tool: 'lint'       },
  { label: 'Run Build',    cmd: 'npm run build',         tool: 'build'      },
  { label: 'Install Deps', cmd: 'npm install',           tool: 'install'    },
  { label: 'Git Status',   cmd: 'git status',            tool: 'git-status' },
  { label: 'Git Log',      cmd: 'git log --oneline -10', tool: 'git-log'    },
]

const BluswanToolsPane = memo(function BluswanToolsPane({
  bridgeAvailable,
  callExecBridge,
  onSetActiveTab,
}) {
  const [customCommand, setCustomCommand] = useState('')

  async function runTool(cmd) {
    if (bridgeAvailable) {
      await callExecBridge(cmd)
    } else {
      // No output panel is shown in Tools tab; keep this path as a no-op.
    }
    onSetActiveTab?.('tools')
  }

  return (
    <div className="lk-output" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="lk-tools-controls">
        <div className="lk-tools-warn">
          {bridgeAvailable === true
            ? '🟢 Exec bridge active — tools run real commands on your machine'
            : bridgeAvailable === false
              ? '🔴 Exec bridge offline — start via `npm run dev` for real execution'
              : '⏳ Checking exec bridge…'}
        </div>
        <div className="lk-tools-buttons">
          {TOOL_BUTTONS.map(({ label, cmd, tool }) => (
            <button key={tool} className="lk-btn lk-btn--tool" onClick={() => runTool(cmd)}>
              {label}
            </button>
          ))}
        </div>
        <div className="lk-tools-custom">
          <input
            className="lk-input"
            placeholder="Custom command (e.g., npx tsc --noEmit)"
            value={customCommand}
            onChange={e => setCustomCommand(e.target.value)}
            onKeyDown={async e => {
              if (e.key === 'Enter' && customCommand.trim()) {
                e.preventDefault()
                const cmd = customCommand.trim()
                setCustomCommand('')
                await runTool(cmd)
              }
            }}
          />
          <button
            className="lk-btn lk-btn--tool"
            disabled={!customCommand.trim()}
            onClick={async () => {
              const cmd = customCommand.trim()
              if (!cmd) return
              setCustomCommand('')
              await runTool(cmd)
            }}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  )
})

export default BluswanToolsPane
