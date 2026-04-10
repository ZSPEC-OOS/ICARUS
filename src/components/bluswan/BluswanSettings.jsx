import { memo, useState, useEffect, useRef } from 'react'
import { clearApiKeys, saveModels, testModelConnection, testSearchConnection, loadSearchKey, saveSearchKey } from '../../services/aiService.js'
import { getRepo, getAuthenticatedUser } from '../../services/githubService.js'
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
  githubToken,    setGithubToken,
  githubClientId, setGithubClientId,
  repoOwner,      setRepoOwner,
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

  // ── GitHub connection state ────────────────────────────────────────────────
  const [ghConnected, setGhConnected] = useState(null)  // { login } from /user

  // Load connected username when token is present
  useEffect(() => {
    if (!githubToken) { setGhConnected(null); return }
    getAuthenticatedUser(githubToken).then(u => setGhConnected(u)).catch(() => setGhConnected(null))
  }, [githubToken])

  function handleGhDisconnect() {
    setGithubToken('')
    try { sessionStorage.removeItem('bluswan:ghtoken') } catch {}
    setGhConnected(null)
  }

  // ── Model API key helper ────────────────────────────────────────────────────
  const [addModelOpen,          setAddModelOpen]          = useState(false)
  const [newModelName,          setNewModelName]          = useState('')
  const [newModelUseCompTokens, setNewModelUseCompTokens] = useState(false)
  const [searchTestResult, setSearchTestResult] = useState(null)  // { testing, ok, error, ms }

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
