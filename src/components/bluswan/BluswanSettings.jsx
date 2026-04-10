import { memo, useState } from 'react'
import { clearApiKeys, saveModels, testModelConnection, testSearchConnection, loadSearchKey, saveSearchKey } from '../../services/aiService.js'
import { getRepo } from '../../services/githubService.js'
import { parseGitHubUrl } from '../../utils/codeUtils.js'
import {
  loadFirebaseConfig,
  saveFirebaseConfig,
  initFirebase,
  clearFirebaseConfig,
  getFirebaseStatus,
  getCurrentUser,
  saveModelDoc,
  saveWebSearchKeyDoc,
} from '../../services/firebaseService.js'
import { loadEnhancerConfig, saveEnhancerConfig } from '../../services/enhancers/config.js'

// ─── BluswanSettings ────────────────────────────────────────────────────────────
// Settings drawer: GitHub credentials, theme picker, fine-tune sliders,
// permission mode, and BLUSWAN.md editor.
const BluswanSettings = memo(function BluswanSettings({
  // GitHub config — primary (target) repo
  githubToken, setGithubToken,
  repoOwner,   setRepoOwner,
  repoName,    setRepoName,
  baseBranch,  setBaseBranch,
  hasGithub,
  onReindex,

  onReindex2,

  // Generation options
  generateTests, setGenerateTests,
  creativity, setCreativity,
  enableThinking, setEnableThinking,

  // Push options
  doCreateBranch, setDoCreateBranch,
  doCreatePR,     setDoCreatePR,
  dryRun,         setDryRun,

  // Theme
  theme, setTheme,

  // Fine-tune
  fineTune, setFineTune, DEFAULT_FT,
  // Header layout controls
  headerLayout, setHeaderLayout, DEFAULT_HEADER_LAYOUT,

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
  const GHTOKEN_SS_KEY = 'bluswan:ghtoken'

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

  // ── Model API key helper ────────────────────────────────────────────────────
  const [addModelOpen,          setAddModelOpen]          = useState(false)
  const [newModelName,          setNewModelName]          = useState('')
  const [newModelUseCompTokens, setNewModelUseCompTokens] = useState(false)
  const [searchTestResult, setSearchTestResult] = useState(null)  // { testing, ok, error, ms }

  // ── Web Search collapse / save state ───────────────────────────────────────
  // Start collapsed when a key is already loaded (restored from Firebase/local).
  const [wsCollapsed, setWsCollapsed] = useState(() => !!webSearchApiKey)
  const [wsSaving,    setWsSaving]    = useState(false)

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

  // ── Test connection ─────────────────────────────────────────────────────────
  const [testResults, setTestResults] = useState({})  // { [modelId]: { testing, ok, error, ms } }

  async function handleTestConnection(m) {
    setTestResults(r => ({ ...r, [m.id]: { testing: true } }))
    const result = await testModelConnection(m)
    setTestResults(r => ({ ...r, [m.id]: { testing: false, ...result } }))
  }

  // ── Save model to Firebase ─────────────────────────────────────────────────
  async function handleSaveModel(m) {
    // Validate all three required fields before writing to Firestore
    if (!m.apiKey?.trim()) {
      setSaveErrors(e => ({ ...e, [m.id]: 'API Key is required' }))
      return
    }
    if (!m.baseUrl?.trim()) {
      setSaveErrors(e => ({ ...e, [m.id]: 'Base URL is required' }))
      return
    }
    if (!m.modelId?.trim()) {
      setSaveErrors(e => ({ ...e, [m.id]: 'Model ID is required' }))
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

          {(models || []).map(m => {
            const isCollapsed = collapsedModels.has(m.id)

            // ── Collapsed / saved view ──────────────────────────────────────
            if (isCollapsed) {
              return (
                <div
                  key={m.id}
                  className="lk-settings-model-row--saved"
                  onClick={() => setCollapsedModels(c => { const n = new Set(c); n.delete(m.id); return n })}
                  title="Click to edit"
                >
                  <span className="lk-settings-model-name">{m.name}</span>
                  <span className="lk-settings-badge lk-settings-badge--ok">● saved</span>
                  <span className="lk-settings-collapse-arrow" style={{ marginLeft: 'auto' }}>▸</span>
                </div>
              )
            }

            // ── Expanded / editing view ─────────────────────────────────────
            return (
              <div key={m.id} className="lk-settings-model-row">
                {/* Header row — Save (top-right) is diagonally opposite Test Connection (bottom-left) */}
                <div className="lk-settings-model-row-hd">
                  {m.id.startsWith('custom-') ? (
                    <input
                      className="lk-input lk-settings-model-name-input"
                      placeholder="Model name"
                      value={m.name || ''}
                      onChange={e => updateModelField(m.id, 'name', e.target.value)}
                    />
                  ) : (
                    <span className="lk-settings-model-name">{m.name}</span>
                  )}
                  <div className="lk-settings-model-row-actions">
                    <button
                      className="lk-btn lk-btn--small lk-btn--primary"
                      disabled={savingModels[m.id]}
                      onClick={() => handleSaveModel(m)}
                    >
                      {savingModels[m.id] ? 'Saving…' : 'Save'}
                    </button>
                    <button className="lk-settings-model-remove" onClick={() => removeModel(m.id)} title="Remove model">×</button>
                  </div>
                </div>
                <input
                  className="lk-input"
                  type="password"
                  placeholder={`API key for ${m.name || 'this model'}`}
                  value={m.apiKey || ''}
                  onChange={e => updateModelKey(m.id, e.target.value)}
                  autoComplete="off"
                />
                {m.id.startsWith('custom-') && (
                  <>
                    <input className="lk-input" placeholder="Model ID (e.g. gpt-4o)" value={m.modelId || ''}
                      onChange={e => updateModelField(m.id, 'modelId', e.target.value)} />
                    <input className="lk-input" placeholder="Base URL" value={m.baseUrl || ''}
                      onChange={e => updateModelField(m.id, 'baseUrl', e.target.value)} />
                  </>
                )}
                {!m.id.startsWith('custom-') && <span className="lk-hint">{m.baseUrl}</span>}
                {saveErrors[m.id] && (
                  <div className="lk-settings-model-save-error">{saveErrors[m.id]}</div>
                )}
                {/* Test connection — bottom-left (diagonally opposite Save at top-right) */}
                <div className="lk-settings-model-test">
                  <button
                    className="lk-btn lk-btn--small"
                    disabled={!m.apiKey || testResults[m.id]?.testing}
                    onClick={() => handleTestConnection(m)}
                  >
                    {testResults[m.id]?.testing ? '…Testing' : 'Test Connection'}
                  </button>
                  {testResults[m.id] && !testResults[m.id].testing && (
                    <>
                      <span className={`lk-settings-test-result lk-settings-test-result--${testResults[m.id].ok ? 'ok' : 'fail'}`}>
                        {testResults[m.id].ok
                          ? `● Connected (${testResults[m.id].ms}ms)`
                          : `✗ ${testResults[m.id].error}`}
                      </span>
                      {testResults[m.id].ok && testResults[m.id].warning && (
                        <span className="lk-settings-test-result lk-settings-test-result--warn">
                          ⚠ {testResults[m.id].warning}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}

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

      {/* Quick setup — paste a GitHub URL to fill owner + repo */}
      <div className="lk-field lk-field--url">
        <label className="lk-label">Quick Setup</label>
        <input
          className="lk-input"
          placeholder="Paste GitHub URL — github.com/owner/repo"
          onChange={e => {
            const parsed = parseGitHubUrl(e.target.value)
            if (parsed) { setRepoOwner(parsed.owner); setRepoName(parsed.repo) }
          }}
        />
        <span className="lk-hint">Auto-fills Owner and Repository below</span>
      </div>

      <div className="lk-drawer-grid">
        <div className="lk-field">
          <label className="lk-label">GitHub Token (PAT)</label>
          <input className="lk-input" type="password" placeholder="ghp_xxxxxxxxxxxx"
            value={githubToken} onChange={e => setGithubToken(e.target.value)} autoComplete="off" />
          <span className="lk-hint">Needs <code>repo</code> scope</span>
          <button className="lk-btn lk-btn--small lk-btn--warn" onClick={() => { clearApiKeys(); setGithubToken('') }}>
            Clear stored keys
          </button>
        </div>
        <div className="lk-field">
          <label className="lk-label">Owner</label>
          <input className="lk-input" placeholder="username or org"
            value={repoOwner} onChange={e => setRepoOwner(e.target.value.trim())} />
        </div>
        <div className="lk-field">
          <label className="lk-label">Repository</label>
          <input className="lk-input" placeholder="my-repo"
            value={repoName} onChange={e => setRepoName(e.target.value.trim())} />
        </div>
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


      <div className="lk-drawer-toggles">
        <label className="lk-toggle"><input type="checkbox" checked={generateTests} onChange={e => setGenerateTests(e.target.checked)} /><span>Generate test file alongside code</span></label>
        <label className="lk-toggle"><input type="checkbox" checked={doCreateBranch} onChange={e => setDoCreateBranch(e.target.checked)} /><span>Auto-create branch (<code>bluswan/…</code>)</span></label>
        <label className="lk-toggle"><input type="checkbox" checked={doCreatePR} onChange={e => setDoCreatePR(e.target.checked)} /><span>Auto-create pull request</span></label>
        <label className="lk-toggle lk-toggle--warn"><input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} /><span>Dry run — preview only, no commits</span></label>
        <label className="lk-toggle"><input type="checkbox" checked={enableThinking} onChange={e => setEnableThinking(e.target.checked)} /><span>Extended thinking <span className="lk-hint-inline">(Claude only — deeper reasoning, slower)</span></span></label>
        <label className="lk-toggle"><input type="checkbox" checked={deepReasoningEnabled} onChange={handleDeepReasoningToggle} /><span>Deep reasoning pipeline <span className="lk-hint-inline">(structured plan → RAG retrieval → critique loop)</span></span></label>
      </div>

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

      {/* Theme picker */}
      <div className="lk-theme-section">
        <div className="lk-theme-label">Theme</div>
        <div className="lk-theme-swatches">
          {[
            { id: 'bluswan',  name: 'BLUSWAN', bg: '#030b18', accent: '#3b8ef0' },
            { id: 'graphite', name: 'Graphite', bg: '#1a1b1e', accent: '#74c0fc' },
            { id: 'claude',   name: 'Claude',   bg: '#1a1a1a', accent: '#da7756' },
            { id: 'midnight', name: 'Midnight', bg: '#0b0f1a', accent: '#38bdf8' },
            { id: 'obsidian', name: 'Obsidian', bg: '#07091A', accent: '#7B82D8' },
            { id: 'forest',   name: 'Forest',   bg: '#0d1f17', accent: '#34d399' },
            { id: 'spectrum', name: 'Spectrum', bg: '#09081a', accent: '#ff4da3' },
            { id: 'phoenix',  name: 'Phoenix',  bg: '#0e0804', accent: '#ff6a00' },
          ].map(t => (
            <button
              key={t.id}
              className={`lk-theme-swatch${theme === t.id ? ' lk-theme-swatch--active' : ''}`}
              onClick={() => setTheme(t.id)}
              title={t.name}
            >
              <div className="lk-theme-dot" style={{ background: t.bg }}>
                <div className="lk-theme-dot-inner" style={{ background: t.accent }} />
              </div>
              <span className="lk-theme-name">{t.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Fine-tune sliders */}
      <div className="lk-finetune-section">
        <div className="lk-finetune-label">Fine-Tune</div>
        <div className="lk-finetune-grid">
          {[
            { key: 'brightness', label: 'Bright',    min: 50,  max: 150, def: 100 },
            { key: 'contrast',   label: 'Contrast',  min: 60,  max: 140, def: 100 },
            { key: 'saturation', label: 'Saturate',  min: 20,  max: 180, def: 100 },
            { key: 'highlight',  label: 'Highlight', min: 0,   max: 100, def: 50  },
            { key: 'shadow',     label: 'Shadow',    min: 0,   max: 100, def: 50  },
          ].map(({ key, label, min, max }) => (
            <div key={key} className="lk-finetune-row">
              <div className="lk-finetune-row-label">
                <span className="lk-finetune-name">{label}</span>
                <span className="lk-finetune-val">{fineTune[key]}</span>
              </div>
              <input
                type="range" className="lk-slider"
                min={min} max={max}
                value={fineTune[key]}
                onChange={e => setFineTune(prev => ({ ...prev, [key]: Number(e.target.value) }))}
              />
            </div>
          ))}
          <button className="lk-finetune-reset" onClick={() => setFineTune(DEFAULT_FT)}>
            ↺ Reset to defaults
          </button>
        </div>
      </div>

      {/* Header layout sliders */}
      <div className="lk-finetune-section">
        <div className="lk-finetune-label">Header Layout</div>
        <div className="lk-finetune-grid">
          {[
            { key: 'headerHeight', label: 'Header Height', min: 36, max: 96 },
            { key: 'titleSize', label: 'Title Size', min: 9, max: 28 },
            { key: 'titleOffsetX', label: 'Title X', min: -120, max: 120 },
            { key: 'titleOffsetY', label: 'Title Y', min: -40, max: 40 },
            { key: 'toggleOffsetX', label: 'Plan/Code X', min: -160, max: 160 },
            { key: 'toggleOffsetY', label: 'Plan/Code Y', min: -40, max: 40 },
          ].map(({ key, label, min, max }) => (
            <div key={key} className="lk-finetune-row">
              <div className="lk-finetune-row-label">
                <span className="lk-finetune-name">{label}</span>
                <span className="lk-finetune-val">{headerLayout[key]}</span>
              </div>
              <input
                type="range" className="lk-slider"
                min={min} max={max}
                value={headerLayout[key]}
                onChange={e => setHeaderLayout(prev => ({ ...prev, [key]: Number(e.target.value) }))}
              />
            </div>
          ))}
          <button className="lk-finetune-reset" onClick={() => setHeaderLayout(DEFAULT_HEADER_LAYOUT)}>
            ↺ Reset header layout
          </button>
        </div>
      </div>

      {/* Security */}
      <div className="lk-security-section">
        <div className="lk-security-label">Security</div>
        <div className="lk-security-body">
          <span className="lk-security-note">
            API keys and tokens are encrypted with your account ID and saved to your Firestore account —
            restored automatically when you sign in. Local session copies are cleared when the tab closes.
          </span>
          <div className="lk-permission-mode">
            <span className="lk-security-note">Push permission mode:</span>
            <div className="lk-permission-btns">
              {[
                { id: 'auto',   label: 'Auto',   title: 'Push immediately — no confirmation dialogs' },
                { id: 'ask',    label: 'Ask',    title: 'Confirm before every GitHub write (default)' },
                { id: 'manual', label: 'Manual', title: 'Confirm with extra context before each write' },
              ].map(m => (
                <button
                  key={m.id}
                  className={`lk-btn lk-btn--small${permissionMode === m.id ? ' lk-btn--active' : ''}`}
                  title={m.title}
                  onClick={() => {
                    setPermissionMode(m.id)
                    try { localStorage.setItem('bluswan:permMode', m.id) } catch {}
                  }}
                >{m.label}</button>
              ))}
            </div>
          </div>
          <button
            className="lk-btn lk-btn--clear-creds"
            onClick={() => {
              clearApiKeys()
              setGithubToken('')
              try { sessionStorage.removeItem(GHTOKEN_SS_KEY) } catch {}
            }}
            title="Remove all stored credentials from this session"
          >
            ⊘ Clear all credentials
          </button>
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
