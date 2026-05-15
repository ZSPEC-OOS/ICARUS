import React, { useState, useEffect, useRef, useCallback } from 'react'
import Bluswan from './components/Bluswan'
import { loadModels, saveModels, saveSearchKey, runPrompt } from './services/aiService'
import {
  onAuthStateChange,
  signOutUser,
  signInWithEmail,
  signUpWithEmail,
  loadUserSettings,
  saveUserSettings,
  loadModelDocs,
  loadUserToolsDoc,
} from './services/firebaseService'
import { KEYS } from './shared/storageKeys.js'
import {
  getFeatureFlags,
  getMigrationStatus,
  setFeatureFlag,
  subscribeToFlags,
} from './config/featureFlags.js'
import TaskDashboard from './components-v2/TaskDashboard.jsx'
import PlanReview from './components-v2/PlanReview.jsx'
import CycleReview from './components-v2/CycleReview.jsx'
import QualitySignals from './components-v2/QualitySignals.jsx'
import FeatureFlagPanel from './components-v2/FeatureFlagPanel.jsx'
import EngineToggle from './components-v2/EngineToggle.jsx'

// Populate localStorage + sessionStorage from cloud settings
// Called after login so that Bluswan's loadSettings() reads the cloud values on
// first render. Each value uses the same storage path that Bluswan writes to,
// so the component initialises transparently with persisted data.
async function injectCloudSettings(settings) {
  if (!settings) return
  try {
    const { githubToken, repo2Token, webSearchApiKey, models,
            permissionMode, _v, _ts, ...rest } = settings

    // Non-secret settings -> localStorage (same key Bluswan uses)
    localStorage.setItem(KEYS.LS.SETTINGS, JSON.stringify(rest))

    // permissionMode has its own key in localStorage
    if (permissionMode) localStorage.setItem(KEYS.LS.PERM_MODE, permissionMode)

    // GitHub tokens -> sessionStorage as plaintext (matching Bluswan's read path)
    if (githubToken !== undefined) sessionStorage.setItem(KEYS.SS.GH_TOKEN, githubToken || '')
    if (repo2Token !== undefined) sessionStorage.setItem(KEYS.SS.GH_TOKEN_2, repo2Token || '')

    // Search key must be stored via saveSearchKey() because loadSearchKey() decrypts it
    if (webSearchApiKey !== undefined) await saveSearchKey(webSearchApiKey || '')

    // Models (with API keys) -> aiService storage (handles its own encryption)
    if (Array.isArray(models) && models.length > 0) await saveModels(models)
  } catch (err) {
    console.warn('[Bluswan] injectCloudSettings failed:', err.message)
  }
}

function Splash({ msg = 'Loading...' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh',
      background: 'url(/bluswan-bg.jpg) center/cover no-repeat, #030b18',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
      fontSize: '0.9rem',
      flexDirection: 'column',
      gap: '1.25rem',
    }}>
      <img src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN" style={{ height: '44px', width: 'auto' }} />
      <span style={{ color: '#3d5a7a', fontSize: '0.82rem', letterSpacing: '0.04em' }}>{msg}</span>
    </div>
  )
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || 'Unknown error' }
  }

  componentDidCatch(error) {
    console.error('[Bluswan] Unhandled render error:', error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(180deg, #020817 0%, #071630 100%)',
          color: '#bfdbfe',
          padding: '1.5rem',
          textAlign: 'center',
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
        }}>
          <div style={{ maxWidth: '38rem' }}>
            <img src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN" style={{ height: '44px', width: 'auto', marginBottom: '1rem' }} />
            <h2 style={{ margin: 0, fontSize: '1.1rem', color: '#dbeafe' }}>BLUSWAN hit a runtime error</h2>
            <p style={{ margin: '0.75rem 0 0', lineHeight: 1.5, color: '#93c5fd' }}>
              This usually means a JavaScript exception occurred right after loading.
              Open browser DevTools and check the console for the first red error.
            </p>
            <p style={{ margin: '0.75rem 0 0', fontSize: '0.85rem', color: '#60a5fa' }}>
              Error: {this.state.message}
            </p>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  const [flags, setFlags] = useState(getFeatureFlags())

  // Three-phase state:
  //   authChecked=false  -> Firebase resolving initial auth state (show splash)
  //   authUser=null      -> Not logged in
  //   settingsReady=false -> Logged in but loading Firestore (show splash)
  //   settingsReady=true  -> Ready (show Bluswan)
  const [authChecked, setAuthChecked] = useState(false)
  const [authUser, setAuthUser] = useState(null)
  const [settingsReady, setSettingsReady] = useState(false)
  const [cloudError, setCloudError] = useState('')

  const [models, setModels] = useState([])
  const [selectedModelId, setSelectedModelId] = useState('')
  const [fbModelIds, setFbModelIds] = useState([])

  // Async key decryption means we can't use loadModels as a synchronous
  // useState initialiser — load once on mount instead.
  useEffect(() => {
    loadModels().then(m => {
      setModels(m)
      setSelectedModelId(prev => prev || m[0]?.id || '')
    }).catch(() => {})
  }, [])

  // Re-render when the engine toggle fires (or any other setFeatureFlag call)
  useEffect(() => {
    return subscribeToFlags(() => setFlags(getFeatureFlags()))
  }, [])

  // Debounce ref - avoids a Firestore write on every keystroke
  const saveTimerRef = useRef(null)
  const pendingSettingsRef = useRef({})
  const authUserRef = useRef(null)

  // Firebase auth listener - single source of truth
  // This listener fires when Firebase confirms login, giving us time to load
  // Firestore settings BEFORE rendering Bluswan (so it initialises with correct values).
  useEffect(() => {
    const unsub = onAuthStateChange(async (user) => {
      if (user) {
        authUserRef.current = user
        setCloudError('')

        // Load cloud settings and hydrate localStorage before mounting Bluswan
        let cloud = null
        try {
          cloud = await loadUserSettings(user.uid)
        } catch (err) {
          // Real error (permissions, network) - log it and proceed with local defaults
          console.warn('[Bluswan] Could not load cloud settings:', err.message)
          setCloudError('Could not load cloud settings - using local data. Check Firestore rules.')
        }

        if (cloud) {
          await injectCloudSettings(cloud)
          const freshModels = await loadModels()
          setModels(freshModels)
          setSelectedModelId(freshModels[0]?.id || '')
          // Seed pending ref so the first handleSetModels call has full context
          pendingSettingsRef.current = cloud
        }

        // Load per-model documents — the authoritative cross-device store.
        // If the models/ collection has documents they override what came from
        // the settings blob, and their IDs are passed down so the settings UI
        // can render them in collapsed (already-saved) state.
        try {
          const fbModels = await loadModelDocs(user.uid)
          if (fbModels.length > 0) {
            await saveModels(fbModels)
            setModels(fbModels)
            setSelectedModelId(fbModels[0]?.id || '')
            setFbModelIds(fbModels.map(m => m.id))
          }
        } catch (err) {
          console.warn('[Bluswan] Could not load model docs:', err.message)
        }

        try {
          const toolEntries = await loadUserToolsDoc(user.uid)
          localStorage.setItem(KEYS.LS.USER_TOOLS, JSON.stringify(toolEntries))
        } catch (err) {
          console.warn('[Bluswan] Could not load modular tools:', err.message)
        }

        setAuthUser(user)
        setSettingsReady(true)
      } else {
        authUserRef.current = null
        setAuthUser(null)
        setSettingsReady(true)
      }
      setAuthChecked(true)
    })
    return unsub
  }, [])

  const scheduleCloudSave = useCallback((uid, settings) => {
    pendingSettingsRef.current = settings
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveUserSettings(uid, pendingSettingsRef.current).catch(err =>
        console.warn('[Bluswan] Cloud save failed:', err.message)
      )
    }, 1500)
  }, [])

  // Settings changes from Bluswan (github tokens, theme, repo config, etc.)
  // Bluswan calls this whenever any persisted setting changes.
  // We merge with the latest models so the cloud doc is always complete.
  const handleSettingsChanged = useCallback((settings) => {
    const uid = authUserRef.current?.uid
    if (!uid) return
    loadModels().then(m => scheduleCloudSave(uid, { ...settings, models: m })).catch(() => {})
  }, [scheduleCloudSave])

  // Model changes from BluswanSettings (API key entered/changed)
  const handleSetModels = useCallback((updated) => {
    setModels(updated)
    const uid = authUserRef.current?.uid
    if (!uid) return
    scheduleCloudSave(uid, { ...pendingSettingsRef.current, models: updated })
  }, [scheduleCloudSave])

  // Called by BluswanSettings after a model is successfully saved to Firebase.
  // Keeps fbModelIds in sync so the settings drawer remount shows the right
  // collapsed-state set even after models saved in the current session.
  const handleModelSaved = useCallback((modelId) => {
    setFbModelIds(prev => prev.includes(modelId) ? prev : [...prev, modelId])
  }, [])

  // ─── V2 Task State ───────────────────────────────────────────────────────────

  const modelsRef = useRef(models)
  const selectedModelIdRef = useRef(selectedModelId)

  useEffect(() => { modelsRef.current = models }, [models])
  useEffect(() => { selectedModelIdRef.current = selectedModelId }, [selectedModelId])

  const [taskState, setTaskState] = useState({
    phase: 'idle',
    plan: null,
    cycles: [],
    budget: null,
    gates: [],
    securityScan: null,
    taskSpec: null,
    error: null,
    events: [],
  })
  const [v2Result, setV2Result] = useState(null)
  const [showPlanReview, setShowPlanReview] = useState(false)
  const [planReviewPlan, setPlanReviewPlan] = useState(null)
  const [showCycleReview, setShowCycleReview] = useState(false)
  const [cycleReviewCycle, setCycleReviewCycle] = useState(null)
  const [isFallbackToV1, setIsFallbackToV1] = useState(false)
  const [v2Notice, setV2Notice] = useState(null) // { type: 'error'|'info'|'warn', msg }

  // Resolve refs allow onPlanReview / onCompletionCheck promises to be settled
  // from outside the async runTask call.
  const planReviewResolveRef = useRef(null)
  const completionResolveRef = useRef(null)

  // ─── V1 Task Execution ───────────────────────────────────────────────────────

  async function runV1Task(_goal) {
    // V1 execution is handled entirely inside the Bluswan component.
    // This function is called only when falling back from V2.
    // Switching to V1 UI is handled by setting isFallbackToV1, which re-renders
    // to show <Bluswan> — the user can then enter the task again.
    setV2Notice({ type: 'info', msg: 'Switched to V1 engine. Use the chat interface below.' })
  }

  // ─── V2 Task Execution ───────────────────────────────────────────────────────

  async function executeV2(taskSpec) {
    setIsFallbackToV1(false)
    setV2Result(null)
    setV2Notice(null)
    setTaskState({ phase: 'planning', plan: null, cycles: [], budget: null, gates: [], securityScan: null, taskSpec, error: null, events: [] })

    // Thin executor — delegates to services-v2/agentExecutor.js with stub IO
    const { makeExecutor: makeV2Executor } = await import('./services-v2/agentExecutor.js')
    const v2ExecuteTool = makeV2Executor({
      // IO stubs — real implementations provided by the bridge layer in production.
      // Phase 9 wires the routing; IO bridge is connected in Phase 10.
      fsRead: async (path) => `ERROR: fsRead not connected (${path})`,
      fsWrite: async (_path, _content) => { throw new Error('fsWrite not connected') },
      fsEdit: async (_path, _old, _new) => { throw new Error('fsEdit not connected') },
      fsDelete: async (_path) => { throw new Error('fsDelete not connected') },
      fsList: async (_dir) => [],
      fsSearch: async (_dir, _pattern) => [],
      fsGrep: async (_pattern, _path) => [],
      runCommand: async (cmd) => `ERROR: runCommand not connected (${cmd})`,
      webFetch: async (url) => `ERROR: webFetch not connected (${url})`,
      webSearch: async (_query) => [],
    })

    try {
      const { runTask } = await import('./core-v2/index.js')
      const result = await runTask(taskSpec, {
        onPhaseChange: (phase) => setTaskState(prev => ({ ...prev, phase })),
        onCycleStart: (cycle) => setTaskState(prev => ({ ...prev, currentCycle: cycle })),
        onCycleEnd: (cycle, cycleResult) => {
          setTaskState(prev => ({
            ...prev,
            cycles: [...(prev.cycles ?? []), { ...cycle, ...cycleResult }],
          }))
          if (flags.enableCycleReview && cycleResult?.status !== 'completed') {
            setCycleReviewCycle(cycle)
            setShowCycleReview(true)
          }
        },
        onPlanReview: async (plan) => {
          if (!flags.enablePlanReview) return 'approve'
          setPlanReviewPlan(plan)
          setTaskState(prev => ({ ...prev, plan }))
          setShowPlanReview(true)
          return new Promise((resolve) => { planReviewResolveRef.current = resolve })
        },
        onCompletionCheck: async (state, gateResult) => {
          setTaskState(prev => ({
            ...prev,
            gates: gateResult?.details ?? prev.gates,
            securityScan: gateResult?.securityScan ?? prev.securityScan,
          }))
          return new Promise((resolve) => { completionResolveRef.current = resolve })
        },
        onEvent: (event) => {
          setTaskState(prev => ({ ...prev, events: [...(prev.events || []), event] }))
          if (flags.enableTelemetry) {
            console.debug('[telemetry]', event.type, event.data)
          }
        },
        onError: (error) => {
          setV2Notice({ type: 'error', msg: `${error.code}: ${error.explanation}` })
        },
        callLLM: async (prompt) => {
          const model = modelsRef.current.find(m => m.id === selectedModelIdRef.current) || modelsRef.current[0]
          if (!model?.apiKey) throw new Error('No model with API key configured')
          const result = await runPrompt(model, prompt, '', null, null)
          return typeof result === 'string' ? result : (result?.text || '')
        },
        executeTool: v2ExecuteTool,
      })

      setV2Result(result)
      setTaskState(prev => ({ ...prev, phase: result.phase }))

      // Offer V1 fallback if V2 failed
      if (result.phase === 'failed' && !isFallbackToV1) {
        setV2Notice({ type: 'warn', msg: `V2 task failed: ${result.failureReason ?? 'unknown'}. You can retry with V1.` })
      }
    } catch (error) {
      console.error('[V2] Engine crashed:', error)
      setTaskState(prev => ({ ...prev, phase: 'error', error: error.message }))
      setV2Notice({ type: 'error', msg: 'V2 engine crashed. Falling back to V1.' })
      await fallbackToV1(taskSpec)
    }
  }

  // ─── Fallback ────────────────────────────────────────────────────────────────

  async function fallbackToV1(taskSpec) {
    setIsFallbackToV1(true)
    await runV1Task(taskSpec?.goal ?? '')
  }

  // ─── Plan Review Handlers ─────────────────────────────────────────────────────

  function handlePlanApprove() {
    planReviewResolveRef.current?.('approve')
    planReviewResolveRef.current = null
    setShowPlanReview(false)
  }

  function handlePlanReject() {
    planReviewResolveRef.current?.('reject')
    planReviewResolveRef.current = null
    setShowPlanReview(false)
    setTaskState(prev => ({ ...prev, phase: 'idle' }))
  }

  // ─── Cycle Review Handlers ────────────────────────────────────────────────────

  function handleCycleContinue() {
    setShowCycleReview(false)
    // Task runner continues automatically
  }

  function handleCycleAcceptPartial() {
    setShowCycleReview(false)
    completionResolveRef.current?.('accept')
    completionResolveRef.current = null
  }

  function handleCycleHalt() {
    setShowCycleReview(false)
    completionResolveRef.current?.('halt')
    completionResolveRef.current = null
    setTaskState(prev => ({ ...prev, phase: 'halted' }))
  }

  // ─── Auth ────────────────────────────────────────────────────────────────────

  const handleLogout = useCallback(async () => {
    // Flush any pending save before signing out
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      const uid = authUserRef.current?.uid
      if (uid && pendingSettingsRef.current) {
        const m = await loadModels().catch(() => [])
        await saveUserSettings(uid, { ...pendingSettingsRef.current, models: m })
          .catch(() => {})
      }
    }
    await signOutUser().catch(() => {})
    // Clear sensitive local session data
    try {
      sessionStorage.removeItem(KEYS.SS.GH_TOKEN)
      sessionStorage.removeItem(KEYS.SS.GH_TOKEN_2)
      sessionStorage.removeItem(KEYS.SS.SEARCH_KEY)
      sessionStorage.removeItem(KEYS.SS.AI_KEYS)
      sessionStorage.removeItem(KEYS.SS.AI_SESSION_KEY)
    } catch {}
    pendingSettingsRef.current = {}
    setModels([])
  }, [])

  const handleTask = useCallback(async (taskSpec) => {
    if (flags.useV2Engine) return executeV2(taskSpec)
    return null
  }, [flags.useV2Engine]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Render ───────────────────────────────────────────────────────────────────

  if (!authChecked) return <Splash />
  if (authUser && !settingsReady) return <Splash msg="Loading your settings..." />

  const showV2UI = flags.useV2UI && !isFallbackToV1

  return (
    <>
      {cloudError && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
          background: '#7f1d1d', color: '#fca5a5', padding: '0.5rem 1rem',
          fontSize: '0.8rem', textAlign: 'center',
        }}>
          Warning: {cloudError}
        </div>
      )}

      {/* Dev-only feature flag bar */}
      {import.meta.env.DEV && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9998,
          background: '#0f172a', color: '#64748b', padding: '0.25rem 0.75rem',
          fontSize: '0.7rem', display: 'flex', gap: '1rem', alignItems: 'center',
          borderTop: '1px solid #1e293b',
        }}>
          <span>Engine: <strong style={{ color: flags.useV2Engine ? '#34d399' : '#f87171' }}>{flags.useV2Engine ? 'V2' : 'V1'}</strong></span>
          <span>UI: <strong style={{ color: flags.useV2UI ? '#34d399' : '#f87171' }}>{flags.useV2UI ? 'V2' : 'V1'}</strong></span>
          <span>Status: <strong style={{ color: '#94a3b8' }}>{getMigrationStatus()}</strong></span>
        </div>
      )}

      {/* V2 crash/failure notice */}
      {v2Notice && (
        <div style={{
          position: 'fixed', top: cloudError ? '2.5rem' : 0, left: 0, right: 0, zIndex: 9997,
          background: v2Notice.type === 'error' ? '#7f1d1d' : v2Notice.type === 'warn' ? '#78350f' : '#1e3a5f',
          color: v2Notice.type === 'error' ? '#fca5a5' : v2Notice.type === 'warn' ? '#fcd34d' : '#bfdbfe',
          padding: '0.5rem 1rem', fontSize: '0.8rem', textAlign: 'center',
          display: 'flex', gap: '1rem', justifyContent: 'center', alignItems: 'center',
        }}>
          <span>{v2Notice.msg}</span>
          {v2Notice.type !== 'info' && (
            <button
              onClick={() => fallbackToV1(taskState.taskSpec)}
              style={{ background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '3px', color: 'inherit', cursor: 'pointer', fontSize: '0.75rem', padding: '0.2rem 0.6rem' }}
            >
              Use V1
            </button>
          )}
          <button
            onClick={() => setV2Notice(null)}
            style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '0.8rem', marginLeft: '0.5rem' }}
          >
            ✕
          </button>
        </div>
      )}

      <AppErrorBoundary>
        <>
          {/* Floating engine toggle only shown in V1 mode; V2 has its own in the sidebar */}
          {!showV2UI && (
            <EngineToggle
              position="floating"
              onSwitch={({ engine }) => {
                if (engine === 'v2') setIsFallbackToV1(false)
              }}
            />
          )}

          {showV2UI ? (
            <>
              <TaskDashboard
                v2State={taskState}
                onStartTask={(spec) => {
                  if (spec === null) {
                    setTaskState(prev => ({ ...prev, phase: 'idle', events: [] }))
                    return
                  }
                  executeV2(spec)
                }}
                models={models}
                selectedModelId={selectedModelId}
                onModelChange={(id) => setSelectedModelId(id)}
                onModelsUpdate={handleSetModels}
              />

              {showPlanReview && planReviewPlan && (
                <PlanReview
                  plan={planReviewPlan}
                  onApprove={handlePlanApprove}
                  onReject={handlePlanReject}
                />
              )}

              {showCycleReview && cycleReviewCycle && (
                <CycleReview
                  cycles={taskState.cycles}
                  onContinue={handleCycleContinue}
                  onAccept={handleCycleAcceptPartial}
                  onHalt={handleCycleHalt}
                />
              )}

              {import.meta.env.DEV && (
                <FeatureFlagPanel
                  flags={flags}
                  onChange={(key, val) => {
                    setFeatureFlag(key, val)
                    window.location.reload()
                  }}
                />
              )}
            </>
          ) : (
            /* V1 Chat Interface — completely unchanged */
            <Bluswan
              models={models}
              setModels={handleSetModels}
              selectedModelId={selectedModelId}
              onModelChange={(id) => setSelectedModelId(id)}
              onClose={() => {}}
              onSettingsChanged={handleSettingsChanged}
              onLogout={handleLogout}
              userEmail={authUser?.email || 'local-user@bluswan.local'}
              savedModelIds={fbModelIds}
              onModelSaved={handleModelSaved}
            />
          )}
        </>
      </AppErrorBoundary>
    </>
  )
}
