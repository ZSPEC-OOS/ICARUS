import { memo, useState, useEffect, useRef } from 'react'
import { clearApiKeys, saveModels, testModelConnection, testSearchConnection, loadSearchKey, saveSearchKey } from '../../services/aiService.js'
import { detectProvider, discoverLocalModels } from '../../services/providerRegistry.js'
import { getRepo, getAuthenticatedUser } from '../../services/githubService.js'
import { parseGitHubUrl } from '../../utils/codeUtils.js'
import { KEYS } from '../../shared/storageKeys.js'
import {
  loadFirebaseConfig,
  saveFirebaseConfig,
  initFirebase,
  clearFirebaseConfig,
  getFirebaseStatus,
  getCurrentUser,
  saveModelDoc,
  saveWebSearchKeyDoc,
  saveUserToolsDoc,
} from '../../services/firebaseService.js'
import { loadEnhancerConfig, saveEnhancerConfig } from '../../services/enhancers/config.js'
import {
  getAllTools,
  getUserToolEntries,
  installToolAtSlot,
  uninstallTool,
} from '../../services/toolLoader.js'

// ─── ModelCard ────────────────────────────────────────────────────────────────
function ModelCard({ m, isCollapsed, onExpand, onRemove, saveError, isSaving, testResult, onTest, onSave, onUpdateKey, onUpdateField }) {
  const [discoveredModels, setDiscoveredModels] = useState([])
  const [discovering, setDiscovering] = useState(false)

  const isLocal = m.baseUrl && detectProvider(m.baseUrl).id !== 'unknown' &&
    ['ollama', 'lmstudio', 'openai-compatible'].includes(detectProvider(m.baseUrl).id) &&
    (m.baseUrl.includes('localhost') || m.baseUrl.includes('127.0.0.1'))

  async function handleDiscover() {
    setDiscovering(true)
    const models = await discoverLocalModels(m.baseUrl)
    setDiscoveredModels(models)
    setDiscovering(false)
    if (models.length === 1) onUpdateField('modelId', models[0])
  }

  const listId = `discover-${m.id}`

  if (isCollapsed) {
    return (
      <div className="lk-settings-model-row--saved" onClick={onExpand} title="Click to edit">
        <span className="lk-settings-model-name">{m.name}</span>
        <span className="lk-settings-badge lk-settings-badge--ok">● saved</span>
        <span className="lk-settings-collapse-arrow" style={{ marginLeft: 'auto' }}>▸</span>
      </div>
    )
  }
  return (
    <div className="lk-settings-model-row">
      <div className="lk-settings-model-row-hd">
        {m.id.startsWith('custom-') ? (
          <input
            className="lk-input lk-settings-model-name-input"
            placeholder="Model name"
            value={m.name || ''}
            onChange={e => onUpdateField('name', e.target.value)}
          />
        ) : (
          <span className="lk-settings-model-name">{m.name}</span>
        )}
        <div className="lk-settings-model-row-actions">
          <button className="lk-btn lk-btn--small lk-btn--primary" disabled={isSaving} onClick={onSave}>
            {isSaving ? 'Saving…' : 'Save'}
          </button>
          <button className="lk-settings-model-remove" onClick={onRemove} title="Remove model">×</button>
        </div>
      </div>
      <input
        className="lk-input"
        type="password"
        placeholder={`API key for ${m.name || 'this model'} (leave blank for local)`}
        value={m.apiKey || ''}
        onChange={e => onUpdateKey(e.target.value)}
        autoComplete="off"
      />
      {m.id.startsWith('custom-') && (
        <>
          <input className="lk-input" placeholder="Base URL" value={m.baseUrl || ''}
            onChange={e => onUpdateField('baseUrl', e.target.value)} />
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input className="lk-input" placeholder="Model ID (e.g. gpt-4o)" value={m.modelId || ''}
              onChange={e => onUpdateField('modelId', e.target.value)}
              list={discoveredModels.length ? listId : undefined}
              style={{ flex: 1 }} />
            {discoveredModels.length > 0 && (
              <datalist id={listId}>
                {discoveredModels.map(id => <option key={id} value={id} />)}
              </datalist>
            )}
            {isLocal && (
              <button className="lk-btn lk-btn--small" onClick={handleDiscover} disabled={discovering} title="Discover running models">
                {discovering ? '…' : 'Discover'}
              </button>
            )}
          </div>
        </>
      )}
      {!m.id.startsWith('custom-') && <span className="lk-hint">{m.baseUrl}</span>}
      {saveError && <div className="lk-settings-model-save-error">{saveError}</div>}
      <div className="lk-settings-model-test">
        <button
          className="lk-btn lk-btn--small"
          disabled={testResult?.testing}
          onClick={onTest}
        >
          {testResult?.testing ? '…Testing' : 'Test Connection'}
        </button>
        {testResult && !testResult.testing && (
          <>
            <span className={`lk-settings-test-result lk-settings-test-result--${testResult.ok ? 'ok' : 'fail'}`}>
              {testResult.ok ? `● Connected (${testResult.ms}ms)` : `✗ ${testResult.error}`}
            </span>
            {testResult.ok && testResult.warning && (
              <span className="lk-settings-test-result lk-settings-test-result--warn">
                ⚠ {testResult.warning}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── BluswanSettings ────────────────────────────────────────────────────────────
// Settings drawer: GitHub credentials, theme picker, fine-tune sliders,
// permission mode, and BLUSWAN.md editor.
const BluswanSettings = memo(function BluswanSettings({
  // GitHub config — primary (target) repo
  githubToken,    setGithubToken,
  githubClientId, setGithubClientId,
  repoOwner,      setRepoOwner,
  repoName,    setRepoName,
  baseBranch,  setBaseBranch,
  hasGithub,
  onReindex,

  // Generation options
  generateTests, setGenerateTests,
  creativity, setCreativity,
  enableThinking, setEnableThinking,
  thinkingBudget, setThinkingBudget,

  // Per-tool hooks
  hooksConfig, setHooksConfig,

  // Push options
  dryRun,         setDryRun,

  // Permission mode
  permissionMode, setPermissionMode,

  // BLUSWAN.md
  bluswanMdDraft, setBluswanMdDraft, onSaveBluswanMd, isSavingBluswanMd,

  // AI models (API keys)
  models, setModels,

  // Model Firebase persistence
  savedModelIds,  // array of model IDs already saved to Firestore (start collapsed)
  onModelSaved,   // callback(modelId) — notify parent when a model is saved

  // Web search
  webSearchApiKey, setWebSearchApiKey,

  // Auth
  onLogout, userEmail,
}) {
  const GHTOKEN_SS_KEY = KEYS.SS.GH_TOKEN

  // ── Simple / Advanced mode ────────────────────────────────────────────────
  const [simpleMode, setSimpleMode] = useState(() => {
    try { return localStorage.getItem(KEYS.LS.SIMPLE_MODE) !== 'false' } catch { return true }
  })
  function toggleSimpleMode(next) {
    setSimpleMode(next)
    try { localStorage.setItem(KEYS.LS.SIMPLE_MODE, String(next)) } catch {}
  }

  // ── Firebase state ──────────────────────────────────────────────────────────
  const [fbDraft, setFbDraft]   = useState(() => {
    const cfg = loadFirebaseConfig()
    return cfg ? JSON.stringify(cfg, null, 2) : ''
  })
  const [fbStatus,    setFbStatus]    = useState(() => getFirebaseStatus())
  const [fbSaving,    setFbSaving]    = useState(false)
  const [fbError,     setFbError]     = useState(null)
  const [fbCollapsed, setFbCollapsed] = useState(() => getFirebaseStatus().configured)

  async function handleSaveFirebase() {
    setFbError(null)
    setFbSaving(true)
    try {
      const parsed = JSON.parse(fbDraft)
      await initFirebase(parsed)
      setFbStatus(getFirebaseStatus())
    } catch (e) {
      setFbError(e.message)
    } finally {
      setFbSaving(false)
    }
  }

  function handleClearFirebase() {
    clearFirebaseConfig()
    setFbDraft('')
    setFbStatus(getFirebaseStatus())
    setFbError(null)
  }

  // ── GitHub connection state ────────────────────────────────────────────────
  const [ghConnected, setGhConnected] = useState(null)  // { login } from /user

  // Load connected username when token is present
  useEffect(() => {
    if (!githubToken) { setGhConnected(null); return }
    getAuthenticatedUser(githubToken).then(u => setGhConnected(u)).catch(() => setGhConnected(null))
  }, [githubToken])

  function handleGhDisconnect() {
    setGithubToken('')
    try { sessionStorage.removeItem(KEYS.SS.GH_TOKEN) } catch {}
    setGhConnected(null)
  }

  // ── Model API key helper ────────────────────────────────────────────────────
  const [addModelOpen,          setAddModelOpen]          = useState(false)
  const [newModelName,          setNewModelName]          = useState('')
  const [newModelUseCompTokens, setNewModelUseCompTokens] = useState(false)
  const [searchTestResult, setSearchTestResult] = useState(null)  // { testing, ok, error, ms }
  const [modularInstallMsg, setModularInstallMsg] = useState(null)
  const [isModularDragging, setIsModularDragging] = useState([false, false, false])
  const [modularTools, setModularTools] = useState(() => getAllTools().filter(t => !t._builtin).slice(0, 3))
  const [slotPasteOpen,  setSlotPasteOpen]  = useState([false, false, false])
  const [slotPasteText,  setSlotPasteText]  = useState(['', '', ''])
  const [slotPasteTitle, setSlotPasteTitle] = useState(['', '', ''])

  // ── Web Search collapse / save state ───────────────────────────────────────
  // webSearchApiKey loads asynchronously in the parent (AES-GCM decrypt), so we
  // can't rely on its initial value alone.  Start from whatever is available now,
  // then collapse once the first time a key arrives — without re-collapsing if the
  // user later expands the panel to edit.
  const [wsCollapsed, setWsCollapsed] = useState(() => !!webSearchApiKey)
  const [wsSaving,    setWsSaving]    = useState(false)
  const wsAutoCollapsedRef = useRef(!!webSearchApiKey)
  useEffect(() => {
    if (webSearchApiKey && !wsAutoCollapsedRef.current) {
      wsAutoCollapsedRef.current = true
      setWsCollapsed(true)
    }
  }, [webSearchApiKey])

  // ── Per-model collapse / save state ────────────────────────────────────────
  // Models whose IDs are in this set show only their name (collapsed). They
  // expand on click and can be saved again to commit edits back to Firebase.
  const [collapsedModels, setCollapsedModels] = useState(
    () => new Set(savedModelIds || [])
  )
  const [savingModels, setSavingModels] = useState({})  // { [id]: boolean }
  const [saveErrors,   setSaveErrors]   = useState({})  // { [id]: string | null }

  // ── Agent capability toggles ─────────────────────────────────────────────
  const [deepReasoningEnabled, setDeepReasoningEnabled] = useState(
    () => loadEnhancerConfig().deepReasoning?.enabled ?? false
  )
  function handleDeepReasoningToggle(e) {
    const enabled = e.target.checked
    setDeepReasoningEnabled(enabled)
    saveEnhancerConfig({ deepReasoning: { enabled } })
  }

  // ── Model 2 Attachment ───────────────────────────────────────────────────
  const [m2Config, setM2Config] = useState(() => {
    const cfg = loadEnhancerConfig()
    return { enabled: false, escalateOnError: true, escalateOnQualityFail: false, modelId: null, ...cfg.model2Attachment }
  })

  function handleM2Toggle(enabled) {
    const next = { ...m2Config, enabled }
    setM2Config(next)
    saveEnhancerConfig({ model2Attachment: next })
  }
  function handleM2ModelSelect(modelId) {
    const next = { ...m2Config, modelId: modelId || null }
    setM2Config(next)
    saveEnhancerConfig({ model2Attachment: next })
  }
  function handleM2QualityToggle(escalateOnQualityFail) {
    const next = { ...m2Config, escalateOnQualityFail }
    setM2Config(next)
    saveEnhancerConfig({ model2Attachment: next })
  }

  function updateModelKey(id, key) {
    const updated = (models || []).map(m => m.id === id ? { ...m, apiKey: key } : m)
    setModels(updated)
    saveModels(updated)
  }

  function updateModelField(id, field, val) {
    const updated = (models || []).map(m => m.id === id ? { ...m, [field]: val } : m)
    setModels(updated)
    saveModels(updated)
  }

  function addCustomModel() {
    const name = newModelName.trim()
    if (!name) return
    const id = `custom-${Date.now()}`
    const model = { id, name, apiKey: '', baseUrl: '', modelId: '' }
    if (newModelUseCompTokens) model.useMaxCompletionTokens = true
    const updated = [...(models || []), model]
    setModels(updated)
    saveModels(updated)
    setNewModelName('')
    setNewModelUseCompTokens(false)
    setAddModelOpen(false)
  }

  async function handleTestSearch() {
    setSearchTestResult({ testing: true })
    const result = await testSearchConnection(webSearchApiKey)
    setSearchTestResult({ testing: false, ...result })
  }

  function handleSaveWebSearch() {
    if (!webSearchApiKey?.trim()) return
    setWsSaving(true)
    const uid = getCurrentUser()?.uid
    saveWebSearchKeyDoc(uid, webSearchApiKey)  // fire-and-forget, swallows errors
    setWsCollapsed(true)
    setWsSaving(false)
  }

  function removeModel(id) {
    const updated = (models || []).filter(m => m.id !== id)
    setModels(updated)
    saveModels(updated)
  }

  const modularInstructionText = `Convert this tool into BLUSWAN Modular Tool format.
Output rules:
1) Return complete JavaScript source only (no markdown, no explanations).
2) Export exactly these symbols:
   - toolMeta
   - execute(input, config)
   - test()
3) Keep the tool self-contained (no imports, no external runtime dependencies).

toolMeta requirements:
- id: unique kebab-case string (example: "summarize-diff")
- name: human-readable name
- version: semver string (example: "1.0.0")
- description: one concise sentence
- category: one of "coding" | "utility" | "analysis"
- author: optional

execute(input, config) contract:
- Must be async and return JSON-serializable data.
- Accept object or primitive input safely (normalize if needed).
- Validate required fields and return clear error messages instead of throwing when recoverable.
- Keep behavior deterministic unless randomness is explicitly needed.

test() contract:
- Must be async.
- Run at least one representative execute() call.
- Return exactly: { passed: boolean, message: string }.

Use this skeleton:
export const toolMeta = { id: "my-tool-id", name: "My Tool", version: "1.0.0", description: "…", category: "utility" };
export async function execute(input, config) { /* ... */ return { ok: true }; }
export async function test() { return { passed: true, message: "Smoke test passed." }; }`

  function refreshModularTools() {
    setModularTools(getAllTools().filter(t => !t._builtin).slice(0, 3))
  }

  async function persistModularTools(entries = getUserToolEntries()) {
    const uid = getCurrentUser()?.uid
    if (!uid) return
    await saveUserToolsDoc(uid, entries.slice(0, 3))
  }

  async function handleInstallModularFile(file, slotIndex) {
    if (!file) return
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!['js', 'json'].includes(ext)) {
      setModularInstallMsg({ type: 'error', text: `${file.name}: only .js and .json files accepted` })
      return
    }
    let source = ''
    if (ext === 'json') {
      let descriptor
      try { descriptor = JSON.parse(await file.text()) } catch {
        setModularInstallMsg({ type: 'error', text: `${file.name}: invalid JSON` })
        return
      }
      source = `export const toolMeta = ${JSON.stringify(descriptor.toolMeta || descriptor, null, 2)};\nexport async function execute(input, config) {\n  return { message: 'JSON tool loaded', input };\n}\nexport async function test() {\n  return { passed: true, message: 'JSON descriptor loaded.' };\n}\n`
    } else {
      source = await file.text()
    }
    const result = installToolAtSlot(source, slotIndex, 3)
    if (!result.ok) {
      setModularInstallMsg({ type: 'error', text: `${file.name}: ${result.errors.join(' · ')}` })
      return
    }
    await persistModularTools()
    refreshModularTools()
    setModularInstallMsg({ type: 'success', text: `Installed: ${result.tool.name}` })
  }

  async function handleRemoveModularTool(toolId) {
    uninstallTool(toolId)
    await persistModularTools()
    refreshModularTools()
  }

  async function handleInstallModularPaste(text, title, slotIndex) {
    const trimmed = text.trim()
    if (!trimmed) {
      setModularInstallMsg({ type: 'error', text: 'Nothing to load — paste JSON first.' })
      return
    }
    let source
    try {
      const descriptor = JSON.parse(trimmed)
      const meta = { ...(descriptor.toolMeta || descriptor) }
      if (title.trim()) meta.name = title.trim()
      source = `export const toolMeta = ${JSON.stringify(meta, null, 2)};\nexport async function execute(input, config) {\n  return { message: 'JSON tool loaded', input };\n}\nexport async function test() {\n  return { passed: true, message: 'JSON descriptor loaded.' };\n}\n`
    } catch {
      if (!trimmed.includes('export')) {
        setModularInstallMsg({ type: 'error', text: 'Invalid input — paste a JS module (with export statements) or a JSON descriptor.' })
        return
      }
      source = trimmed
    }
    const result = installToolAtSlot(source, slotIndex, 3)
    if (!result.ok) {
      setModularInstallMsg({ type: 'error', text: `Install failed: ${result.errors.join(' · ')}` })
      return
    }
    await persistModularTools()
    refreshModularTools()
    setSlotPasteOpen(prev => prev.map((v, i) => i === slotIndex ? false : v))
    setSlotPasteText(prev => prev.map((v, i) => i === slotIndex ? '' : v))
    setSlotPasteTitle(prev => prev.map((v, i) => i === slotIndex ? '' : v))
    setModularInstallMsg({ type: 'success', text: `Installed: ${result.tool.name}` })
  }

  function handleExportTool(tool) {
    const data = JSON.stringify(tool.toolMeta || { name: tool.name, version: tool.version }, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(tool.name || 'tool').replace(/\s+/g, '-').toLowerCase()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Test connection ─────────────────────────────────────────────────────────
  const [testResults, setTestResults] = useState({})  // { [modelId]: { testing, ok, error, ms } }

  async function handleTestConnection(m) {
    setTestResults(r => ({ ...r, [m.id]: { testing: true } }))
    const result = await testModelConnection(m)
    setTestResults(r => ({ ...r, [m.id]: { testing: false, ...result } }))
  }

  // ── Save model to Firebase ─────────────────────────────────────────────────
  async function handleSaveModel(m) {
    // Allow API key persistence even when optional metadata fields are empty.
    if (!m.apiKey?.trim()) {
      setSaveErrors(e => ({ ...e, [m.id]: 'API Key is required' }))
      return
    }

    setSaveErrors(e => ({ ...e, [m.id]: null }))
    setSavingModels(s => ({ ...s, [m.id]: true }))
    // Fire-and-forget Firebase write — saveModelDoc swallows its own errors.
    // Collapse unconditionally so local state is always committed.
    const uid = getCurrentUser()?.uid
    saveModelDoc(uid, m)
    setCollapsedModels(c => new Set([...c, m.id]))
    onModelSaved?.(m.id)
    setSavingModels(s => ({ ...s, [m.id]: false }))
  }

  return (
    <div className="lk-drawer lk-drawer--settings">

      {/* ── Simple / Advanced toggle ──────────────────────────────────────── */}
      <div className="lk-settings-mode-toggle">
        <button
          className={`lk-settings-mode-btn${simpleMode ? ' lk-settings-mode-btn--active' : ''}`}
          onClick={() => toggleSimpleMode(true)}
        >Simple</button>
        <button
          className={`lk-settings-mode-btn${!simpleMode ? ' lk-settings-mode-btn--active' : ''}`}
          onClick={() => toggleSimpleMode(false)}
        >Advanced</button>
      </div>

      {/* ── Account ───────────────────────────────────────────────────────── */}
      {onLogout && (
        <div className="lk-settings-account">
          {userEmail && <span className="lk-settings-account-email">{userEmail}</span>}
          <button className="lk-btn lk-btn--small lk-btn--warn" onClick={onLogout}>
            ⏻ Log out
          </button>
        </div>
      )}

      {/* ── AI API & Services ─────────────────────────────────────────────── */}
      <div className="lk-settings-section">
        <div className="lk-settings-section-hd">
          <span className="lk-settings-section-icon">◈</span>
          AI Models
        </div>
        <div className="lk-settings-section-body">
          <span className="lk-security-note">
            Keys are encrypted and saved to your account — restored automatically when you sign in on any device.
          </span>

          {(models || []).map(m => (
            <ModelCard
              key={m.id}
              m={m}
              isCollapsed={collapsedModels.has(m.id)}
              onExpand={() => setCollapsedModels(c => { const n = new Set(c); n.delete(m.id); return n })}
              onRemove={() => removeModel(m.id)}
              saveError={saveErrors[m.id]}
              isSaving={savingModels[m.id]}
              testResult={testResults[m.id]}
              onTest={() => handleTestConnection(m)}
              onSave={() => handleSaveModel(m)}
              onUpdateKey={key => updateModelKey(m.id, key)}
              onUpdateField={(field, val) => updateModelField(m.id, field, val)}
            />
          ))}

          {/* Add Model */}
          {addModelOpen ? (
            <div className="lk-settings-add-model">
              <div className="lk-settings-add-model-hd">Add a custom model</div>
              <div className="lk-settings-add-custom">
                <input
                  className="lk-input"
                  placeholder="Name (e.g. My GPT-4o)"
                  value={newModelName}
                  onChange={e => setNewModelName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addCustomModel()}
                  autoFocus
                />
                <button className="lk-btn lk-btn--small lk-btn--primary" onClick={addCustomModel} disabled={!newModelName.trim()}>
                  Add
                </button>
              </div>
              <label className="lk-toggle" style={{ marginTop: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={newModelUseCompTokens}
                  onChange={e => setNewModelUseCompTokens(e.target.checked)}
                />
                <span>
                  Use <code>max_completion_tokens</code> instead of <code>max_tokens</code>
                  <span className="lk-hint-inline"> (required for OpenAI o-series: o1, o3, o4-mini)</span>
                </span>
              </label>
              <button className="lk-btn lk-btn--small" style={{ marginTop: '0.5rem' }} onClick={() => { setAddModelOpen(false); setNewModelName(''); setNewModelUseCompTokens(false) }}>Cancel</button>
            </div>
          ) : (
            <button className="lk-btn lk-btn--small lk-settings-add-btn" onClick={() => setAddModelOpen(true)}>
              + Add Model
            </button>
          )}
        </div>
      </div>

      {!simpleMode && <>

      {/* ── Model 2 Attachment ────────────────────────────────────────────── */}
      <div className="lk-settings-section">
        <div className="lk-settings-section-hd">
          <span className="lk-settings-section-icon">⬆</span>
          Model 2 Attachment
          {m2Config.enabled && m2Config.modelId && (
            <span className="lk-settings-badge lk-settings-badge--ok">● active</span>
          )}
        </div>
        <div className="lk-settings-section-body">
          <span className="lk-hint">
            When Model 1 fails or errors out, BLUSWAN automatically re-runs the full task
            using this backup model. Attach a more powerful model as your safety net.
          </span>
          <label className="lk-toggle">
            <input
              type="checkbox"
              checked={m2Config.enabled}
              onChange={e => handleM2Toggle(e.target.checked)}
            />
            <span>Enable Model 2 Attachment</span>
          </label>

          {m2Config.enabled && (
            <>
              <div style={{ marginTop: '0.75rem' }}>
                <div className="lk-hint" style={{ marginBottom: '0.35rem' }}>Escalation Model</div>
                <select
                  className="lk-input"
                  value={m2Config.modelId || ''}
                  onChange={e => handleM2ModelSelect(e.target.value)}
                >
                  <option value="">— Select a model —</option>
                  {(models || []).map(m => (
                    <option key={m.id} value={m.id}>
                      {m.name}{!m.apiKey ? ' (no key)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <label className="lk-toggle" style={{ marginTop: '0.75rem' }}>
                <input
                  type="checkbox"
                  checked={!!m2Config.escalateOnQualityFail}
                  onChange={e => handleM2QualityToggle(e.target.checked)}
                />
                <span>
                  Also escalate on quality gate failures
                  <span className="lk-hint-inline"> (reruns the full task when reliability checks fail — slower)</span>
                </span>
              </label>

              {m2Config.modelId && (() => {
                const m2 = (models || []).find(m => m.id === m2Config.modelId)
                if (!m2) return (
                  <div className="lk-settings-model-save-error" style={{ marginTop: '0.5rem' }}>
                    Model not found — select a configured model above.
                  </div>
                )
                if (!m2.apiKey) return (
                  <div className="lk-settings-model-save-error" style={{ marginTop: '0.5rem' }}>
                    ⚠ {m2.name} has no API key — add one in the AI Models section.
                  </div>
                )
                return (
                  <div className="lk-settings-m2-ready" style={{ marginTop: '0.5rem', fontSize: '0.82rem', color: 'var(--lk-color-ok, #3fb950)' }}>
                    ● Ready — {m2.name} will take over if Model 1 fails
                  </div>
                )
              })()}
            </>
          )}
        </div>
      </div>

      {/* ── Modular Tools ─────────────────────────────────────────────────── */}
      <div className="lk-settings-section">
        <div className="lk-settings-section-hd">
          <span className="lk-settings-section-icon">🧩</span>
          Modular Tools
          <span className="lk-settings-badge">{modularTools.length}/3 installed</span>
        </div>
        <div className="lk-settings-section-body">
          <span className="lk-hint">
            Drop or attach up to 3 modular tool files. Installed tools sync to Firestore and are restored across devices.
          </span>
          <div className="lk-modular-slots">
            {[0, 1, 2].map(slot => {
              const tool = modularTools[slot]
              const pasteOpen = slotPasteOpen[slot]
              return (
                <div
                  key={slot}
                  className={`lk-modular-slot${tool ? ' lk-modular-slot--filled' : ''}${isModularDragging[slot] ? ' lk-modular-slot--drag' : ''}`}
                  onDragOver={e => {
                    e.preventDefault()
                    setIsModularDragging(prev => prev.map((v, i) => i === slot ? true : v))
                  }}
                  onDragLeave={() => setIsModularDragging(prev => prev.map((v, i) => i === slot ? false : v))}
                  onDrop={async e => {
                    e.preventDefault()
                    setIsModularDragging(prev => prev.map((v, i) => i === slot ? false : v))
                    await handleInstallModularFile(e.dataTransfer.files?.[0], slot)
                  }}
                >
                  {tool ? (
                    <>
                      <div className="lk-modular-slot-header">
                        <span className="lk-modular-slot-indicator" />
                        <span className="lk-modular-slot-name">{tool.name}</span>
                        <span className="lk-hint-inline">v{tool.version}</span>
                      </div>
                      <div className="lk-modular-slot-actions">
                        <button className="lk-btn lk-btn--small lk-btn--warn" onClick={() => handleRemoveModularTool(tool.id)}>Remove</button>
                        <button className="lk-btn lk-btn--small" onClick={() => handleExportTool(tool)}>Export</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="lk-modular-slot-title">Slot {slot + 1}</div>
                      {pasteOpen ? (
                        <div className="lk-modular-slot-paste-area">
                          <input
                            className="lk-modular-slot-title-input"
                            placeholder="Label (optional)"
                            value={slotPasteTitle[slot]}
                            onChange={e => setSlotPasteTitle(prev => prev.map((v, i) => i === slot ? e.target.value : v))}
                          />
                          <textarea
                            className="lk-modular-slot-paste-text"
                            placeholder="Paste JSON here…"
                            value={slotPasteText[slot]}
                            onChange={e => setSlotPasteText(prev => prev.map((v, i) => i === slot ? e.target.value : v))}
                          />
                          <div className="lk-modular-slot-paste-btns">
                            <button
                              className="lk-btn lk-btn--small lk-btn--primary"
                              onClick={() => handleInstallModularPaste(slotPasteText[slot], slotPasteTitle[slot], slot)}
                            >Load</button>
                            <button
                              className="lk-btn lk-btn--small"
                              onClick={() => {
                                setSlotPasteOpen(prev => prev.map((v, i) => i === slot ? false : v))
                                setSlotPasteText(prev => prev.map((v, i) => i === slot ? '' : v))
                                setSlotPasteTitle(prev => prev.map((v, i) => i === slot ? '' : v))
                              }}
                            >Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="lk-modular-slot-empty">Drop .js/.json here</div>
                      )}
                      <div className="lk-modular-slot-actions">
                        <label className="lk-btn lk-btn--small">
                          Attach file
                          <input
                            type="file"
                            accept=".js,.json"
                            style={{ display: 'none' }}
                            onChange={async e => {
                              await handleInstallModularFile(e.target.files?.[0], slot)
                              e.target.value = ''
                            }}
                          />
                        </label>
                        {!pasteOpen && (
                          <button
                            className="lk-btn lk-btn--small"
                            onClick={() => setSlotPasteOpen(prev => prev.map((v, i) => i === slot ? true : v))}
                          >Paste</button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>

          <div className="lk-modular-instructions">
            <div className="lk-modular-instructions-hd">
              <strong>Tool Conversion Instructions</strong>
              <button
                className="lk-btn lk-btn--small"
                onClick={async () => {
                  try { await navigator.clipboard.writeText(modularInstructionText) } catch {}
                }}
              >
                Copy
              </button>
            </div>
            <textarea className="lk-bluswanmd-editor" value={modularInstructionText} readOnly rows={10} />
          </div>

          {modularInstallMsg && (
            <div className={`lk-install-msg lk-install-msg--${modularInstallMsg.type}`}>
              {modularInstallMsg.text}
            </div>
          )}
        </div>
      </div>

      {/* ── Web Search ────────────────────────────────────────────────────── */}
      <div className="lk-settings-section">
        {/* Header: collapse toggle (left) + Save button at top-right (opposite bottom-left Test Connection) */}
        <div className="lk-settings-ws-hd">
          <button
            className="lk-settings-section-hd--btn lk-settings-ws-toggle"
            onClick={() => setWsCollapsed(c => !c)}
          >
            <span className="lk-settings-section-icon">🔍</span>
            Web Search
            {wsCollapsed && webSearchApiKey && (
              <span className="lk-settings-badge lk-settings-badge--ok">● connected</span>
            )}
            <span className="lk-settings-collapse-arrow" style={{ marginLeft: 'auto' }}>
              {wsCollapsed ? '▸' : '▾'}
            </span>
          </button>
          {!wsCollapsed && (
            <button
              className="lk-btn lk-btn--small lk-btn--primary"
              style={{ flexShrink: 0 }}
              disabled={wsSaving || !webSearchApiKey?.trim()}
              onClick={handleSaveWebSearch}
            >
              {wsSaving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>

        {!wsCollapsed && (
          <div className="lk-settings-section-body">
            <span className="lk-hint">
              Enables the <code>web_search</code> agent tool. Get a free key at{' '}
              <a href="https://app.tavily.com" target="_blank" rel="noreferrer">app.tavily.com</a>
              {' '}(1,000 free searches/month). Saved to your account and restored on next sign-in.
            </span>
            <input
              className="lk-input"
              type="password"
              placeholder="Tavily API key (tvly-…)"
              value={webSearchApiKey || ''}
              onChange={e => {
                setWebSearchApiKey(e.target.value)
                saveSearchKey(e.target.value)
                setSearchTestResult(null)
              }}
              autoComplete="off"
            />
            {/* Test Connection — bottom-left (diagonally opposite Save at top-right) */}
            <div className="lk-settings-model-test">
              <button
                className="lk-btn lk-btn--small"
                disabled={!webSearchApiKey || searchTestResult?.testing}
                onClick={handleTestSearch}
              >
                {searchTestResult?.testing ? '…Testing' : 'Test Connection'}
              </button>
              {searchTestResult && !searchTestResult.testing && (
                <span className={`lk-settings-test-result lk-settings-test-result--${searchTestResult.ok ? 'ok' : 'fail'}`}>
                  {searchTestResult.ok
                    ? `● Connected (${searchTestResult.ms}ms)`
                    : `✗ ${searchTestResult.error}`}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Firebase ──────────────────────────────────────────────────────── */}
      <div className="lk-settings-section">
        <button
          className="lk-settings-section-hd lk-settings-section-hd--btn"
          onClick={() => setFbCollapsed(c => !c)}
        >
          <span className="lk-settings-section-icon">🔥</span>
          Firebase / Cloud Storage
          {fbStatus.configured && (
            <span className="lk-settings-badge lk-settings-badge--ok">
              {fbStatus.initialised ? '● connected' : '● config saved'}
            </span>
          )}
          <span className="lk-settings-collapse-arrow" style={{ marginLeft: 'auto' }}>
            {fbCollapsed ? '▸' : '▾'}
          </span>
        </button>
        {!fbCollapsed && (
          <div className="lk-settings-section-body">
            {fbStatus.configured && fbStatus.projectId && (
              <div className="lk-firebase-project">
                Project: <strong>{fbStatus.projectId}</strong>
                {fbStatus.initialised ? ' · connected' : ' · not yet initialised'}
              </div>
            )}

            <label className="lk-label">Firebase Config (JSON)</label>
            <textarea
              className="lk-bluswanmd-editor lk-firebase-textarea"
              placeholder={`Paste your Firebase config here, e.g.:\n{\n  "apiKey": "AIzaSy...",\n  "authDomain": "your-project.firebaseapp.com",\n  "projectId": "your-project",\n  "storageBucket": "your-project.appspot.com",\n  "messagingSenderId": "123456789",\n  "appId": "1:123456789:web:abcdef"\n}`}
              value={fbDraft}
              onChange={e => { setFbDraft(e.target.value); setFbError(null) }}
              rows={8}
              spellCheck={false}
            />

            {fbError && <div className="lk-firebase-error">{fbError}</div>}

            <div className="lk-settings-row-actions">
              <button
                className="lk-btn lk-btn--primary lk-btn--small"
                onClick={handleSaveFirebase}
                disabled={fbSaving || !fbDraft.trim()}
              >
                {fbSaving ? 'Connecting…' : '🔥 Save & Connect'}
              </button>
              {fbStatus.configured && (
                <button className="lk-btn lk-btn--small lk-btn--warn" onClick={handleClearFirebase}>
                  Disconnect
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      </>}{/* end !simpleMode block 1: Model2/Modular/WebSearch/Firebase */}

      {/* ── GitHub Connection ─────────────────────────────────────────────── */}
      <div className="lk-settings-section">
        <div className="lk-settings-section-hd">
          <span className="lk-settings-section-icon">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
          </span>
          GitHub
          {githubToken && <span className="lk-settings-badge lk-settings-badge--ok">● connected{ghConnected ? ` as @${ghConnected.login}` : ''}</span>}
        </div>
        <div className="lk-settings-section-body">

          {/* ── Connected ── */}
          {githubToken ? (
            <div className="lk-gh-connected">
              <span className="lk-hint">
                Connected. Use the repo picker in the top bar to switch between any of your repositories — the selection persists across sessions.
              </span>
              <button className="lk-btn lk-btn--small lk-btn--warn" style={{ marginTop: '0.5rem' }} onClick={handleGhDisconnect}>
                Disconnect GitHub
              </button>
            </div>
          ) : (
            /* ── Not connected ── */
            <>
              <span className="lk-hint">
                Create a Personal Access Token at{' '}
                <a href="https://github.com/settings/tokens/new?scopes=repo&description=BLUSWAN" target="_blank" rel="noreferrer">
                  github.com/settings/tokens
                </a>
                {' '}— select <strong>repo</strong> scope, set no expiry. Paste it below. The token is encrypted and saved to your account so you only need to do this once.
              </span>
              <input
                className="lk-input"
                type="password"
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                value={githubToken}
                onChange={e => setGithubToken(e.target.value.trim())}
                autoComplete="off"
              />
            </>
          )}
        </div>
      </div>

      <div className="lk-drawer-grid">
        <div className="lk-field">
          <label className="lk-label">Base Branch</label>
          <div className="lk-branch-row">
            <input className="lk-input" placeholder="main"
              value={baseBranch} onChange={e => setBaseBranch(e.target.value.trim())} />
            <button
              className="lk-icon-btn"
              title="Detect default branch from GitHub"
              disabled={!githubToken || !repoOwner || !repoName}
              onClick={async () => {
                try {
                  const repo = await getRepo(githubToken, repoOwner, repoName)
                  if (repo.default_branch) setBaseBranch(repo.default_branch)
                } catch {}
              }}
            >⟳</button>
          </div>
        </div>
        <div className="lk-field">
          <button className="lk-btn lk-btn--small" disabled={!hasGithub} onClick={onReindex}>
            ♻ Reindex repository
          </button>
          <span className="lk-hint">Refresh the repo index and conventions (clears cached snapshot).</span>
        </div>
      </div>


      {!simpleMode && <>

      <div className="lk-drawer-toggles">
        <label className="lk-toggle"><input type="checkbox" checked={generateTests} onChange={e => setGenerateTests(e.target.checked)} /><span>Generate test file alongside code</span></label>
        <label className="lk-toggle lk-toggle--warn"><input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} /><span>Dry run — preview only, no commits</span></label>
        <label className="lk-toggle"><input type="checkbox" checked={enableThinking} onChange={e => setEnableThinking(e.target.checked)} /><span>Extended thinking <span className="lk-hint-inline">(Claude only — deeper reasoning, slower)</span></span></label>
        <label className="lk-toggle"><input type="checkbox" checked={deepReasoningEnabled} onChange={handleDeepReasoningToggle} /><span>Deep reasoning pipeline <span className="lk-hint-inline">(structured plan → RAG retrieval → critique loop)</span></span></label>
        <label className="lk-toggle"><input type="checkbox" checked={hooksConfig?.autoLintAfterWrite ?? false} onChange={e => setHooksConfig(h => ({ ...h, autoLintAfterWrite: e.target.checked }))} /><span>Auto-lint after write <span className="lk-hint-inline">(run ESLint on every edited .js/.ts file)</span></span></label>
        <label className="lk-toggle"><input type="checkbox" checked={hooksConfig?.autoTypeCheckAfterEdit ?? false} onChange={e => setHooksConfig(h => ({ ...h, autoTypeCheckAfterEdit: e.target.checked }))} /><span>Auto type-check after edit <span className="lk-hint-inline">(run tsc on each changed file — requires bridge)</span></span></label>
        <label className="lk-toggle"><input type="checkbox" checked={hooksConfig?.autoTestAfterWrite ?? false} onChange={e => setHooksConfig(h => ({ ...h, autoTestAfterWrite: e.target.checked }))} /><span>Auto-debug loop <span className="lk-hint-inline">(run tests after every file write — model sees failures inline and self-corrects)</span></span></label>
        {hooksConfig?.autoTestAfterWrite && (
          <input
            className="lk-input"
            placeholder="Test command (default: npm test -- --passWithNoTests)"
            value={hooksConfig?.testCmd ?? ''}
            onChange={e => setHooksConfig(h => ({ ...h, testCmd: e.target.value }))}
            style={{ marginTop: '0.35rem' }}
          />
        )}
        <label className="lk-toggle" style={{ marginTop: '0.35rem' }}>
          <input
            type="checkbox"
            checked={(() => { try { return loadEnhancerConfig().crossSessionMemory?.enabled ?? false } catch { return false } })()}
            onChange={e => saveEnhancerConfig({ crossSessionMemory: { enabled: e.target.checked } })}
          />
          <span>Cross-session memory <span className="lk-hint-inline">(auto-log each task + changed files to BLUSWAN.md so future sessions remember what was done)</span></span>
        </label>
      </div>

      {/* Thinking budget slider — only shown when extended thinking is enabled */}
      {enableThinking && (
        <div className="lk-finetune-section">
          <div className="lk-finetune-label">Thinking Budget</div>
          <div className="lk-finetune-grid">
            <div className="lk-finetune-row">
              <div className="lk-finetune-row-label">
                <span className="lk-finetune-name">{thinkingBudget >= 12000 ? 'Deep' : thinkingBudget >= 6000 ? 'Standard' : 'Light'}</span>
                <span className="lk-finetune-val">{(thinkingBudget / 1000).toFixed(0)}k tokens</span>
              </div>
              <input
                type="range" className="lk-slider"
                min={1000} max={16000} step={1000}
                value={thinkingBudget}
                onChange={e => setThinkingBudget(Number(e.target.value))}
              />
            </div>
            <span className="lk-hint">1k = light · 8k = standard · 16k = deep (slower, uses more tokens)</span>
          </div>
        </div>
      )}

      </>}{/* end !simpleMode block 2: toggles + thinking budget */}

      {/* Creativity slider */}
      <div className="lk-finetune-section">
        <div className="lk-finetune-label">Creativity</div>
        <div className="lk-finetune-grid">
          <div className="lk-finetune-row">
            <div className="lk-finetune-row-label">
              <span className="lk-finetune-name">{creativity <= 20 ? 'Precise' : creativity >= 80 ? 'Creative' : 'Balanced'}</span>
              <span className="lk-finetune-val">{creativity}</span>
            </div>
            <input
              type="range" className="lk-slider"
              min={0} max={100}
              value={creativity}
              onChange={e => setCreativity(Number(e.target.value))}
            />
          </div>
          <span className="lk-hint">0 = precise &amp; deterministic · 50 = balanced · 100 = creative &amp; varied</span>
        </div>
      </div>

      {/* BLUSWAN.md editor */}
      <div className="lk-security-section">
        <div className="lk-security-label">Project Instructions (BLUSWAN.md)</div>
        <div className="lk-security-body">
          <span className="lk-security-note">
            Standing instructions injected into every generation prompt. Saved as BLUSWAN.md in your repo root.
          </span>
          <textarea
            className="lk-bluswanmd-editor"
            placeholder={'# BLUSWAN.md\nDescribe conventions, patterns, and rules for this project.\nExample: "Always use Tailwind for styling. Prefer hooks over class components."'}
            value={bluswanMdDraft}
            onChange={e => setBluswanMdDraft(e.target.value)}
            rows={8}
          />
          <button
            className="lk-btn lk-btn--primary"
            onClick={onSaveBluswanMd}
            disabled={isSavingBluswanMd || !hasGithub}
            title={hasGithub ? 'Save BLUSWAN.md to repository' : 'GitHub connection required'}
          >
            {isSavingBluswanMd ? 'Saving…' : '↑ Save to repo'}
          </button>
        </div>
      </div>
    </div>
  )
})

export default BluswanSettings
