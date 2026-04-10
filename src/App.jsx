import { useState, useEffect, useRef, useCallback } from 'react'
import LoginScreen from './components/LoginScreen'
import Bluswan from './components/Bluswan'
import { loadModels, saveModels, saveSearchKey } from './services/aiService'
import {
  onAuthStateChange,
  signOutUser,
  signInWithEmail,
  signUpWithEmail,
  loadUserSettings,
  saveUserSettings,
  loadModelDocs,
} from './services/firebaseService'

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
    localStorage.setItem('bluswan:settings', JSON.stringify(rest))

    // permissionMode has its own key in localStorage
    if (permissionMode) localStorage.setItem('bluswan:permMode', permissionMode)

    // GitHub tokens -> sessionStorage as plaintext (matching Bluswan's read path)
    if (githubToken !== undefined) sessionStorage.setItem('bluswan:ghtoken', githubToken || '')
    if (repo2Token !== undefined) sessionStorage.setItem('bluswan:ghtoken2', repo2Token || '')

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
      <img src="/NEWLOGO-header.png" alt="BLUSWAN" style={{ height: '32px', width: 'auto', opacity: 0.9 }} />
      <span style={{ color: '#3d5a7a', fontSize: '0.82rem', letterSpacing: '0.04em' }}>{msg}</span>
    </div>
  )
}

export default function App() {
  const [pinUnlocked, setPinUnlocked] = useState(false)
  // Three-phase state:
  //   authChecked=false  -> Firebase resolving initial auth state (show splash)
  //   authUser=null      -> Not logged in (show LoginScreen)
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

  // Debounce ref - avoids a Firestore write on every keystroke
  const saveTimerRef = useRef(null)
  const pendingSettingsRef = useRef({})
  const authUserRef = useRef(null)

  // Firebase auth listener - single source of truth
  // We do NOT set authUser from the LoginScreen onLogin callback.
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

        setAuthUser(user)
        setSettingsReady(true)
      } else {
        authUserRef.current = null
        setAuthUser(null)
        setSettingsReady(false)
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
      sessionStorage.removeItem('bluswan:ghtoken')
      sessionStorage.removeItem('bluswan:ghtoken2')
      sessionStorage.removeItem('bluswan:searchkey')
      sessionStorage.removeItem('wrkflow:keys')
      sessionStorage.removeItem('wrkflow:sk')
    } catch {}
    pendingSettingsRef.current = {}
    setModels([])
    setPinUnlocked(false)
  }, [])

  const handlePinUnlock = useCallback(async (pin) => {
    setPinUnlocked(true)
    try {
      // Derive stable email/password from PIN so every device with the same PIN
      // gets the same Firebase UID — enabling cross-device Firestore persistence.
      const email    = `pin-${pin}@bluswan.local`
      const password = `BLUSWAN_${pin}`
      try {
        await signInWithEmail(email, password)
      } catch (err) {
        const code = err.code || ''
        if (['auth/user-not-found', 'auth/invalid-credential', 'auth/invalid-login-credentials'].includes(code)) {
          // First time on any device — create the account
          await signUpWithEmail(email, password)
        } else {
          throw err
        }
      }
      // onAuthStateChange will fire, load Firestore settings, then set authUser + settingsReady.
    } catch (err) {
      console.warn('[Bluswan] PIN auth failed — using local-only mode:', err.message)
      // Allow app to render without cloud settings
      setSettingsReady(true)
    }
  }, [])

  if (!authChecked) return <Splash />
  if (!authUser && !pinUnlocked) return <LoginScreen onUnlock={handlePinUnlock} />
  if (pinUnlocked && !authUser && !settingsReady) return <Splash msg="Connecting…" />
  if (authUser && !settingsReady) return <Splash msg="Loading your settings..." />

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
      <Bluswan
        models={models}
        setModels={handleSetModels}
        selectedModelId={selectedModelId}
        onModelChange={(id) => setSelectedModelId(id)}
        onClose={() => {}}
        onSettingsChanged={handleSettingsChanged}
        onLogout={handleLogout}
        userEmail={authUser?.email || 'pin-user@local'}
        savedModelIds={fbModelIds}
        onModelSaved={handleModelSaved}
      />
    </>
  )
}
