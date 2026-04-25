import { useState } from 'react'
import { saveModels, testModelConnection } from '../../services/aiService.js'
import { getAuthenticatedUser, listUserRepos } from '../../services/githubService.js'
import { KEYS } from '../../shared/storageKeys.js'

// ─── BluswanOnboarding ────────────────────────────────────────────────────────
// First-run wizard. Three steps:
//   1. Add a model (required — nothing works without it)
//   2. Connect GitHub (optional but recommended)
//   3. Pick a repo (if GitHub connected; skipped otherwise)
// On completion calls onDone({ models, githubToken, repoOwner, repoName }).
// Persists dismissal so it never shows again once exited.

const PRESET_BASES = [
  { label: 'Anthropic',  baseUrl: '' },
  { label: 'OpenAI',     baseUrl: 'https://api.openai.com/v1' },
  { label: 'Groq',       baseUrl: 'https://api.groq.com/openai/v1' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { label: 'Ollama',     baseUrl: 'http://localhost:11434/v1' },
  { label: 'Custom',     baseUrl: '' },
]

export default function BluswanOnboarding({ onDone, existingModels = [] }) {
  const [step, setStep] = useState(0)  // 0 = model, 1 = github, 2 = repo

  // ── Step 0: Model ──────────────────────────────────────────────────────────
  const [modelName,    setModelName]    = useState('Claude Sonnet')
  const [modelId,      setModelId]      = useState('claude-sonnet-4-6')
  const [apiKey,       setApiKey]       = useState('')
  const [baseUrl,      setBaseUrl]      = useState('')
  const [presetIdx,    setPresetIdx]    = useState(0)
  const [testing,      setTesting]      = useState(false)
  const [testResult,   setTestResult]   = useState(null) // { ok, error, ms }

  // ── Step 1: GitHub ─────────────────────────────────────────────────────────
  const [ghToken,      setGhToken]      = useState('')
  const [ghUser,       setGhUser]       = useState(null)  // { login }
  const [ghVerifying,  setGhVerifying]  = useState(false)
  const [ghError,      setGhError]      = useState(null)

  // ── Step 2: Repo ───────────────────────────────────────────────────────────
  const [repos,        setRepos]        = useState([])
  const [repoSearch,   setRepoSearch]   = useState('')
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [pickedOwner,  setPickedOwner]  = useState('')
  const [pickedName,   setPickedName]   = useState('')

  function handlePreset(idx) {
    setPresetIdx(idx)
    if (PRESET_BASES[idx].label !== 'Custom') setBaseUrl(PRESET_BASES[idx].baseUrl)
  }

  async function handleTestModel() {
    if (!apiKey.trim() || !modelId.trim()) return
    setTesting(true); setTestResult(null)
    const cfg = { id: 'onboard', name: modelName, apiKey: apiKey.trim(), baseUrl: baseUrl.trim(), modelId: modelId.trim() }
    const result = await testModelConnection(cfg)
    setTesting(false)
    setTestResult(result)
  }

  function handleSaveModel() {
    if (!apiKey.trim() || !modelId.trim()) return
    const id = `custom-${Date.now()}`
    const newModel = { id, name: modelName.trim() || modelId.trim(), apiKey: apiKey.trim(), baseUrl: baseUrl.trim(), modelId: modelId.trim() }
    const updated = [...existingModels.filter(m => m.id !== id), newModel]
    saveModels(updated)
    return { updated, newModel }
  }

  async function handleGhVerify() {
    if (!ghToken.trim()) return
    setGhVerifying(true); setGhError(null); setGhUser(null)
    try {
      const user = await getAuthenticatedUser(ghToken.trim())
      setGhUser(user)
    } catch {
      setGhError('Token invalid or missing repo scope.')
    } finally { setGhVerifying(false) }
  }

  async function handleLoadRepos() {
    if (!ghToken.trim()) return
    setLoadingRepos(true)
    try {
      const list = await listUserRepos(ghToken.trim(), 2)
      setRepos(list || [])
    } catch { setRepos([]) }
    finally { setLoadingRepos(false) }
  }

  function dismiss() {
    try { localStorage.setItem(KEYS.LS.ONBOARDING, JSON.stringify({ dismissed: true, ts: Date.now() })) } catch {}
    onDone({})
  }

  function completeStep0() {
    const result = handleSaveModel()
    if (!result) return
    setStep(1)
    return result
  }

  async function completeStep1(skip = false) {
    if (skip) { setStep(ghUser ? 2 : -1); return }
    if (!ghUser) return
    try { sessionStorage.setItem(KEYS.SS.GH_TOKEN, ghToken.trim()) } catch {}
    await handleLoadRepos()
    setStep(2)
  }

  function completeStep2(skip = false) {
    const modelResult = handleSaveModel()
    const token = ghToken.trim()
    const [owner, name] = skip
      ? ['', '']
      : [pickedOwner, pickedName]
    try { localStorage.setItem(KEYS.LS.ONBOARDING, JSON.stringify({ completed: true, ts: Date.now() })) } catch {}
    onDone({ models: modelResult?.updated, githubToken: token || undefined, repoOwner: owner, repoName: name })
  }

  const filteredRepos = repos.filter(r =>
    !repoSearch || r.full_name.toLowerCase().includes(repoSearch.toLowerCase())
  )

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="lk-onboarding-overlay">
      <div className="lk-onboarding-card">

        {/* Header */}
        <div className="lk-onboarding-hd">
          <img src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN" className="lk-onboarding-logo" />
          <div className="lk-onboarding-steps">
            {['Model', 'GitHub', 'Repo'].map((label, i) => (
              <div key={i} className={`lk-onboarding-step-dot${step === i ? ' lk-onboarding-step-dot--active' : step > i ? ' lk-onboarding-step-dot--done' : ''}`}>
                <span>{step > i ? '✓' : i + 1}</span>
                <span className="lk-onboarding-step-label">{label}</span>
              </div>
            ))}
          </div>
          <button className="lk-onboarding-skip-all" onClick={dismiss} title="Skip setup">✕</button>
        </div>

        {/* ── Step 0: Add a model ── */}
        {step === 0 && (
          <div className="lk-onboarding-body">
            <h2 className="lk-onboarding-title">Add your first model</h2>
            <p className="lk-onboarding-hint">BLUSWAN works with any OpenAI-compatible provider or Anthropic.</p>

            <div className="lk-onboarding-preset-row">
              {PRESET_BASES.map((p, i) => (
                <button key={i} className={`lk-onboarding-preset${presetIdx === i ? ' lk-onboarding-preset--active' : ''}`}
                  onClick={() => handlePreset(i)}>{p.label}</button>
              ))}
            </div>

            <div className="lk-onboarding-fields">
              <label className="lk-label">Display name</label>
              <input className="lk-input" value={modelName} onChange={e => setModelName(e.target.value)}
                placeholder="e.g. Claude Sonnet" />

              <label className="lk-label" style={{ marginTop: '0.75rem' }}>Model ID</label>
              <input className="lk-input" value={modelId} onChange={e => setModelId(e.target.value)}
                placeholder="e.g. claude-sonnet-4-6 or gpt-4o" />

              <label className="lk-label" style={{ marginTop: '0.75rem' }}>API Key</label>
              <input className="lk-input" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
                placeholder="sk-ant-… or sk-…" autoComplete="off" />

              {(presetIdx === PRESET_BASES.length - 1 || baseUrl) && (
                <>
                  <label className="lk-label" style={{ marginTop: '0.75rem' }}>Base URL <span className="lk-hint-inline">(optional for Anthropic)</span></label>
                  <input className="lk-input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
                    placeholder="https://api.openai.com/v1" />
                </>
              )}
            </div>

            {testResult && (
              <div className={`lk-onboarding-test-result${testResult.ok ? ' lk-onboarding-test-result--ok' : ' lk-onboarding-test-result--err'}`}>
                {testResult.ok ? `✓ Connected (${testResult.ms}ms)` : `✗ ${testResult.error || 'Connection failed'}`}
              </div>
            )}

            <div className="lk-onboarding-actions">
              <button className="lk-btn lk-btn--small" onClick={handleTestModel} disabled={testing || !apiKey.trim()}>
                {testing ? '…' : 'Test connection'}
              </button>
              <button className="lk-btn lk-btn--primary" onClick={completeStep0} disabled={!apiKey.trim() || !modelId.trim()}>
                Next →
              </button>
            </div>
          </div>
        )}

        {/* ── Step 1: GitHub ── */}
        {step === 1 && (
          <div className="lk-onboarding-body">
            <h2 className="lk-onboarding-title">Connect GitHub</h2>
            <p className="lk-onboarding-hint">
              Required for writing files and creating pull requests.{' '}
              <a href="https://github.com/settings/tokens/new?scopes=repo&description=BLUSWAN"
                target="_blank" rel="noreferrer" className="lk-onboarding-link">
                Create a token with <strong>repo</strong> scope →
              </a>
            </p>

            <div className="lk-onboarding-fields">
              <label className="lk-label">Personal Access Token</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input className="lk-input" type="password" value={ghToken} onChange={e => { setGhToken(e.target.value); setGhUser(null); setGhError(null) }}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" autoComplete="off" style={{ flex: 1 }} />
                <button className="lk-btn lk-btn--small" onClick={handleGhVerify} disabled={ghVerifying || !ghToken.trim()}>
                  {ghVerifying ? '…' : 'Verify'}
                </button>
              </div>
              {ghUser && <div className="lk-onboarding-test-result lk-onboarding-test-result--ok">✓ Connected as @{ghUser.login}</div>}
              {ghError && <div className="lk-onboarding-test-result lk-onboarding-test-result--err">✗ {ghError}</div>}
            </div>

            <div className="lk-onboarding-actions">
              <button className="lk-btn lk-btn--small" onClick={() => completeStep1(true)}>Skip for now</button>
              <button className="lk-btn lk-btn--primary" onClick={() => completeStep1(false)} disabled={!ghUser}>
                Next →
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Repo ── */}
        {step === 2 && (
          <div className="lk-onboarding-body">
            <h2 className="lk-onboarding-title">Pick a repository</h2>
            <p className="lk-onboarding-hint">BLUSWAN will index this repo and target all code changes here.</p>

            <input className="lk-input" placeholder="Search repos…" value={repoSearch}
              onChange={e => setRepoSearch(e.target.value)} style={{ marginBottom: '0.5rem' }} />

            <div className="lk-onboarding-repo-list">
              {loadingRepos
                ? <div className="lk-onboarding-repo-loading">Loading…</div>
                : filteredRepos.slice(0, 30).map(r => (
                  <button key={r.id}
                    className={`lk-onboarding-repo-item${pickedOwner === r.owner?.login && pickedName === r.name ? ' lk-onboarding-repo-item--selected' : ''}`}
                    onClick={() => { setPickedOwner(r.owner?.login || ''); setPickedName(r.name) }}>
                    <span className="lk-onboarding-repo-name">{r.full_name}</span>
                    {r.private && <span className="lk-onboarding-repo-badge">private</span>}
                  </button>
                ))
              }
            </div>

            <div className="lk-onboarding-actions">
              <button className="lk-btn lk-btn--small" onClick={() => completeStep2(true)}>Skip for now</button>
              <button className="lk-btn lk-btn--primary" onClick={() => completeStep2(false)} disabled={!pickedName}>
                ✓ Done
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
