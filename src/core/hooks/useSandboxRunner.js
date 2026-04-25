import { useState, useCallback, useRef } from 'react'
import { buildSandboxHtml, buildPyodideSandboxHtml } from '../../utils/codeUtils'

export function useSandboxRunner({ generatedCode, testCode, language, bridgeAvailable, callExecBridgeStream }) {
  const sandboxRef = useRef(null)

  const [sandboxOutput,     setSandboxOutput]     = useState([])
  const [sandboxSetup,      setSandboxSetup]      = useState('')
  const [isRunning,         setIsRunning]         = useState(false)
  const [isRunningTests,    setIsRunningTests]    = useState(false)
  const [terminalInput,     setTerminalInput]     = useState('')
  const [terminalLog,       setTerminalLog]       = useState([])
  const [isTerminalRunning, setIsTerminalRunning] = useState(false)

  const handleRunInSandbox = useCallback(() => {
    if (!generatedCode) return
    const isPython = language === 'python'
    setIsRunning(true)
    setSandboxOutput([{ level: 'info', text: isPython ? '▶ Loading Python runtime (Pyodide)…' : '▶ Running in isolated sandbox…' }])
    const iframe = sandboxRef.current
    if (!iframe) { setIsRunning(false); return }
    const guardMs = isPython ? 25000 : 9000
    let guardTimer = null
    const onMessage = (e) => {
      if (e.data?.done) {
        clearTimeout(guardTimer)
        setSandboxOutput(e.data.log?.length ? e.data.log : [{ level: 'info', text: '(no output)' }])
        setIsRunning(false); window.removeEventListener('message', onMessage)
      }
    }
    window.addEventListener('message', onMessage)
    guardTimer = setTimeout(() => { window.removeEventListener('message', onMessage); setIsRunning(false) }, guardMs)
    iframe.srcdoc = isPython ? buildPyodideSandboxHtml(generatedCode) : buildSandboxHtml(generatedCode, sandboxSetup)
  }, [generatedCode, sandboxSetup, language])

  const handleRunTests = useCallback(() => {
    if (!testCode) return
    const isPython = language === 'python'
    setIsRunningTests(true)
    setSandboxOutput([{ level: 'info', text: isPython ? '▶ Loading Python runtime (Pyodide)…' : '▶ Running tests in isolated sandbox…' }])
    const iframe = sandboxRef.current
    if (!iframe) { setIsRunningTests(false); return }
    const guardMs = isPython ? 25000 : 9000
    let guardTimer = null
    const onMessage = (e) => {
      if (e.data?.done) {
        clearTimeout(guardTimer)
        setSandboxOutput(e.data.log?.length ? e.data.log : [{ level: 'info', text: '(no output)' }])
        setIsRunningTests(false); window.removeEventListener('message', onMessage)
      }
    }
    window.addEventListener('message', onMessage)
    guardTimer = setTimeout(() => { window.removeEventListener('message', onMessage); setIsRunningTests(false) }, guardMs)
    iframe.srcdoc = isPython ? buildPyodideSandboxHtml(testCode) : buildSandboxHtml(testCode, sandboxSetup)
  }, [testCode, sandboxSetup, language])

  const runTerminalCommand = useCallback((cmd) => {
    const trimmed = cmd.trim()
    if (!trimmed) return
    const ts = new Date().toLocaleTimeString()
    const pushEntry = (output, type = 'output') =>
      setTerminalLog(prev => [...prev, { cmd: trimmed, output, type, ts }])
    if (trimmed === 'clear') { setTerminalLog([]); return }
    if (trimmed === 'help') {
      pushEntry('Available commands:\n  JS/TS expressions  → executed in browser sandbox\n  python: <code>     → executed via Pyodide\n  clear / help', 'info')
      return
    }
    if (/^python:/i.test(trimmed)) {
      const code = trimmed.slice(7).trim()
      setIsTerminalRunning(true)
      const iframe = sandboxRef.current
      if (!iframe) { pushEntry('Sandbox not available', 'error'); setIsTerminalRunning(false); return }
      const timer = setTimeout(() => { window.removeEventListener('message', onPyMsg); pushEntry('[timeout] 20 s limit reached', 'warn'); setIsTerminalRunning(false) }, 22000)
      const onPyMsg = (e) => {
        if (!e.data?.done) return
        clearTimeout(timer); window.removeEventListener('message', onPyMsg)
        const lines = e.data.log || []
        pushEntry(lines.length ? lines.map(l => l.text).join('\n') : '(no output)', lines.some(l => l.level === 'error') ? 'error' : 'output')
        setIsTerminalRunning(false)
      }
      window.addEventListener('message', onPyMsg)
      iframe.srcdoc = buildPyodideSandboxHtml(code)
      return
    }
    const isJsLike = /^(const |let |var |function |class |console\.|\/\/|import |export |async |await )/.test(trimmed) ||
      (/[+\-*/%=()[\]{}.`"']/.test(trimmed) && !/^[a-z]+ /.test(trimmed)) || /^\d/.test(trimmed)
    if (isJsLike) {
      setIsTerminalRunning(true)
      const iframe = sandboxRef.current
      if (!iframe) { pushEntry('Sandbox not available', 'error'); setIsTerminalRunning(false); return }
      const timer = setTimeout(() => { window.removeEventListener('message', onJsMsg); pushEntry('[timeout] 7 s limit reached', 'warn'); setIsTerminalRunning(false) }, 8000)
      const onJsMsg = (e) => {
        if (!e.data?.done) return
        clearTimeout(timer); window.removeEventListener('message', onJsMsg)
        const lines = e.data.log || []
        pushEntry(lines.length ? lines.map(l => l.text).join('\n') : '(no output)', lines.some(l => l.level === 'error') ? 'error' : 'output')
        setIsTerminalRunning(false)
      }
      window.addEventListener('message', onJsMsg)
      iframe.srcdoc = buildSandboxHtml(trimmed, '')
      return
    }
    if (/^node( -v|--version)?$/.test(trimmed)) { pushEntry('v20.x (browser JS engine)', 'info'); return }
    if (/^python3?( --version|-V)?$/.test(trimmed)) { pushEntry('Python 3.12 (Pyodide) — use: python: print("hello")', 'info'); return }
    if (bridgeAvailable) {
      setIsTerminalRunning(true)
      let streamOut = ''
      const streamId = `stream-${Date.now()}`
      setTerminalLog(prev => [...prev, { cmd: trimmed, output: '', type: 'output', ts, streamId }])
      callExecBridgeStream(trimmed, undefined, (chunk) => {
        streamOut += chunk
        setTerminalLog(prev => prev.map(e => e.streamId === streamId ? { ...e, output: streamOut } : e))
      }).then(({ exitCode }) => {
        setTerminalLog(prev => prev.map(e => e.streamId === streamId
          ? { ...e, output: streamOut || '(no output)', type: exitCode === 0 ? 'output' : 'error', streamId: undefined }
          : e))
        setIsTerminalRunning(false)
      })
      return
    }
    const shellCmds = ['npm', 'yarn', 'pnpm', 'git', 'npx', 'tsc', 'eslint', 'jest', 'vitest', 'cargo', 'go', 'pip']
    const base = trimmed.split(/\s+/)[0]
    if (shellCmds.includes(base)) {
      pushEntry(`ℹ "${trimmed}" requires the exec bridge (run via \`npm run dev\`).\nBridge not detected — start the Vite dev server to enable real shell execution.`, 'info')
      return
    }
    pushEntry(`command not found: ${base}\nType "help" for available commands.`, 'error')
  }, [bridgeAvailable, callExecBridgeStream]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    sandboxRef,
    sandboxOutput, setSandboxOutput, sandboxSetup, setSandboxSetup,
    isRunning, isRunningTests,
    terminalInput, setTerminalInput,
    terminalLog, setTerminalLog,
    isTerminalRunning,
    handleRunInSandbox, handleRunTests, runTerminalCommand,
  }
}
