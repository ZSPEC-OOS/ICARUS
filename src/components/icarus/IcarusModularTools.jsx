import { useState, useCallback, useEffect, useRef } from 'react'
import {
  getAllTools,
  installTool,
  uninstallTool,
  testTool,
  exportToolSource,
  validateToolModule,
} from '../../services/toolLoader'

// ─── IcarusModularTools ────────────────────────────────────────────────────────
// Drag-and-drop tool installer + tool list with Test / Download / Uninstall.
export default function IcarusModularTools() {
  const [tools,       setTools]       = useState([])
  const [isDragging,  setIsDragging]  = useState(false)
  const [installMsg,  setInstallMsg]  = useState(null)  // { type: 'success'|'error', text }
  const [testResults, setTestResults] = useState({})    // { [id]: { passed, message, running } }
  const [filter,      setFilter]      = useState('all') // 'all' | 'coding' | 'utility' | 'analysis'
  const dropRef  = useRef(null)
  const timerRef = useRef(null)

  const refresh = useCallback(() => setTools(getAllTools()), [])

  useEffect(() => { refresh() }, [refresh])

  // ── Drag-and-drop handlers ─────────────────────────────────────────────────
  const onDragOver = useCallback(e => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragging(true)
  }, [])

  const onDragLeave = useCallback(e => {
    if (!dropRef.current?.contains(e.relatedTarget)) setIsDragging(false)
  }, [])

  const processFile = useCallback(async file => {
    if (!file) return
    const ext = file.name.split('.').pop().toLowerCase()

    if (ext === 'json') {
      // JSON tool descriptor
      let descriptor
      try {
        descriptor = JSON.parse(await file.text())
      } catch {
        setInstallMsg({ type: 'error', text: `${file.name}: invalid JSON` })
        return
      }
      // Convert JSON descriptor to minimal JS source
      const source = `export const toolMeta = ${JSON.stringify(descriptor.toolMeta || descriptor, null, 2)};\nexport async function execute(input, config) {\n  return { message: 'JSON tool — no execute defined', input };\n}\nexport async function test() {\n  return { passed: true, message: 'JSON descriptor loaded.' };\n}`
      const { ok, errors, tool } = installTool(source)
      if (ok) {
        refresh()
        setInstallMsg({ type: 'success', text: `Installed: ${tool.name} v${tool.version}` })
      } else {
        setInstallMsg({ type: 'error', text: `${file.name}: ${errors.join(', ')}` })
      }
      return
    }

    if (ext === 'js') {
      let source
      try { source = await file.text() } catch {
        setInstallMsg({ type: 'error', text: `${file.name}: could not read file` })
        return
      }
      const { ok, errors, tool } = installTool(source)
      if (ok) {
        refresh()
        setInstallMsg({ type: 'success', text: `Installed: ${tool.name} v${tool.version}` })
      } else {
        setInstallMsg({ type: 'error', text: `${file.name}: ${errors.join(' · ')}` })
      }
      return
    }

    setInstallMsg({ type: 'error', text: `${file.name}: only .js and .json files accepted` })
  }, [refresh])

  const onDrop = useCallback(async e => {
    e.preventDefault()
    setIsDragging(false)
    setInstallMsg(null)
    const files = Array.from(e.dataTransfer.files)
    for (const file of files) await processFile(file)
  }, [processFile])

  // File input fallback
  const onFileInput = useCallback(async e => {
    const files = Array.from(e.target.files || [])
    setInstallMsg(null)
    for (const file of files) await processFile(file)
    e.target.value = ''
  }, [processFile])

  // Auto-clear install message after 5s
  useEffect(() => {
    if (!installMsg) return
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setInstallMsg(null), 5000)
    return () => clearTimeout(timerRef.current)
  }, [installMsg])

  // ── Test a tool ────────────────────────────────────────────────────────────
  const runTest = useCallback(async id => {
    setTestResults(prev => ({ ...prev, [id]: { running: true } }))
    const result = await testTool(id)
    setTestResults(prev => ({ ...prev, [id]: { ...result, running: false } }))
  }, [])

  // ── Download / export a tool ───────────────────────────────────────────────
  const downloadTool = useCallback(id => {
    const source = exportToolSource(id)
    if (!source) return
    const blob = new Blob([source], { type: 'text/javascript' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `${id}.js`
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  // ── Uninstall a user tool ──────────────────────────────────────────────────
  const handleUninstall = useCallback(id => {
    if (!window.confirm(`Uninstall tool "${id}"? This cannot be undone.`)) return
    uninstallTool(id)
    setTestResults(prev => { const n = { ...prev }; delete n[id]; return n })
    refresh()
  }, [refresh])

  // ── Filtered tool list ─────────────────────────────────────────────────────
  const visible = filter === 'all' ? tools : tools.filter(t => t.category === filter)
  const counts  = { all: tools.length }
  for (const t of tools) counts[t.category] = (counts[t.category] || 0) + 1

  const CATEGORY_LABELS = { coding: 'Coding', utility: 'Utility', analysis: 'Analysis' }

  return (
    <div className="lk-output lk-modular-tools">

      {/* ── Drop Zone ───────────────────────────────────────────────────────── */}
      <div
        ref={dropRef}
        className={`lk-drop-zone${isDragging ? ' lk-drop-zone--active' : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        aria-label="Drop zone for tool files"
      >
        <div className="lk-drop-icon">⊕</div>
        <div className="lk-drop-primary">Drop tool files here to install</div>
        <div className="lk-drop-secondary">Accepts <code>.js</code> and <code>.json</code> tool files</div>
        <label className="lk-btn lk-btn--tool lk-drop-browse">
          Browse files
          <input
            type="file"
            accept=".js,.json"
            multiple
            style={{ display: 'none' }}
            onChange={onFileInput}
          />
        </label>
      </div>

      {/* ── Install feedback ─────────────────────────────────────────────────── */}
      {installMsg && (
        <div className={`lk-install-msg lk-install-msg--${installMsg.type}`} role="status">
          {installMsg.type === 'success' ? '✓' : '✗'} {installMsg.text}
        </div>
      )}

      {/* ── Filter tabs ──────────────────────────────────────────────────────── */}
      <div className="lk-tool-filters">
        {['all', 'coding', 'utility', 'analysis'].map(cat => (
          <button
            key={cat}
            className={`lk-tool-filter-btn${filter === cat ? ' lk-tool-filter-btn--active' : ''}`}
            onClick={() => setFilter(cat)}
          >
            {cat === 'all' ? 'All' : CATEGORY_LABELS[cat]}
            <span className="lk-tool-filter-count">{counts[cat] || 0}</span>
          </button>
        ))}
      </div>

      {/* ── Tool list ────────────────────────────────────────────────────────── */}
      <div className="lk-tool-list">
        {visible.length === 0 ? (
          <div className="lk-tools-empty">No tools in this category.</div>
        ) : (
          visible.map(tool => {
            const tr = testResults[tool.id]
            return (
              <div key={tool.id} className={`lk-tool-entry${tool._builtin ? '' : ' lk-tool-entry--user'}`}>
                <div className="lk-tool-meta">
                  <div className="lk-tool-header-row">
                    <span className="lk-tool-name">{tool.name}</span>
                    <span className="lk-tool-version">v{tool.version}</span>
                    <span className={`lk-tool-category lk-tool-category--${tool.category}`}>
                      {CATEGORY_LABELS[tool.category]}
                    </span>
                    {!tool._builtin && (
                      <span className="lk-tool-badge lk-tool-badge--user">user</span>
                    )}
                  </div>
                  <div className="lk-tool-desc">{tool.description}</div>
                  {tool.author && (
                    <div className="lk-tool-author">by {tool.author}</div>
                  )}
                </div>

                <div className="lk-tool-actions">
                  {/* Test button */}
                  <button
                    className={`lk-btn lk-btn--small lk-btn--test${
                      tr ? (tr.running ? ' lk-btn--running' : tr.passed ? ' lk-btn--pass' : ' lk-btn--fail') : ''
                    }`}
                    onClick={() => runTest(tool.id)}
                    disabled={tr?.running}
                    title={tr ? tr.message : 'Run self-test'}
                  >
                    {tr?.running ? '…' : tr ? (tr.passed ? '✓ Pass' : '✗ Fail') : 'Test'}
                  </button>

                  {/* Download button */}
                  <button
                    className="lk-btn lk-btn--small"
                    onClick={() => downloadTool(tool.id)}
                    title="Download tool file"
                  >
                    ↓
                  </button>

                  {/* Uninstall (user tools only) */}
                  {!tool._builtin && (
                    <button
                      className="lk-btn lk-btn--small lk-btn--danger"
                      onClick={() => handleUninstall(tool.id)}
                      title="Uninstall this tool"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* Test result message */}
                {tr && !tr.running && (
                  <div className={`lk-test-result lk-test-result--${tr.passed ? 'pass' : 'fail'}`}>
                    {tr.message}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <div className="lk-tool-list-footer">
        {tools.length} tool{tools.length !== 1 ? 's' : ''} registered
        {tools.filter(t => !t._builtin).length > 0 && (
          <> · {tools.filter(t => !t._builtin).length} user-installed</>
        )}
        {' · '}
        <a
          className="lk-tool-template-link"
          href="#"
          onClick={e => {
            e.preventDefault()
            const templateUrl = '/src/tools/tool-template.js'
            const a = document.createElement('a')
            a.href     = templateUrl
            a.download = 'tool-template.js'
            a.click()
          }}
        >
          Download template
        </a>
      </div>
    </div>
  )
}
