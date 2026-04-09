import { useState, useEffect, useRef, useCallback } from 'react'
import LoginScreen from './components/LoginScreen'
import Icarus from './components/Icarus'
import { loadModels, saveModels, saveSearchKey } from './services/aiService'
import {
  onAuthStateChange,
  signOutUser,
  signInAnonymously,
  loadUserSettings,
  saveUserSettings,
} from './services/firebaseService'

// Populate localStorage + sessionStorage from cloud settings
// Called after login so that Icarus's loadSettings() reads the cloud values on
// first render. Each value uses the same storage path that Icarus writes to,
// so the component initialises transparently with persisted data.
async function injectCloudSettings(settings) {
  if (!settings) return
  try {
    const { githubToken, repo2Token, webSearchApiKey, models,
            permissionMode, _v, _ts, ...rest } = settings

    // Non-secret settings -> localStorage (same key Icarus uses)
    localStorage.setItem('icarus:settings', JSON.stringify(rest))

    // permissionMode has its own key in localStorage
    if (permissionMode) localStorage.setItem('icarus:permMode', permissionMode)

    // GitHub tokens -> sessionStorage as plaintext (matching Icarus's read path)
    if (githubToken !== undefined) sessionStorage.setItem('icarus:ghtoken', githubToken || '')
    if (repo2Token !== undefined) sessionStorage.setItem('icarus:ghtoken2', repo2Token || '')

    // Search key must be stored via saveSearchKey() because loadSearchKey() decrypts it
    if (webSearchApiKey !== undefined) await saveSearchKey(webSearchApiKey || '')

    // Models (with API keys) -> aiService storage (handles its own encryption)
    if (Array.isArray(models) && models.length > 0) await saveModels(models)
  } catch (err) {
    console.warn('[Icarus] injectCloudSettings failed:', err.message)
  }
}

function Splash({ msg = 'Loading...' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh',
      background: 'url(/blkswan-bg.jpg) center/cover no-repeat, #030b18',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
      fontSize: '0.9rem',
      flexDirection: 'column',
      gap: '1.25rem',
    }}>
      <img src="/bluswan-header-logo.jpg" alt="BLUSWAN" style={{ height: '32px', width: 'auto', opacity: 0.9 }} />
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
  //   settingsReady=true  -> Ready (show Icarus)
  const [authChecked, setAuthChecked] = useState(false)
  const [authUser, setAuthUser] = useState(null)
  const [settingsReady, setSettingsReady] = useState(false)
  const [cloudError, setCloudError] = useState('')

  const [models, setModels] = useState([])
  const [selectedModelId, setSelectedModelId] = useState('')

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
  // Firestore settings BEFORE rendering Icarus (so it initialises with correct values).
  useEffect(() => {
    const unsub = onAuthStateChange(async (user) => {
      if (user) {
        authUserRef.current = user
        setCloudError('')

        // Load cloud settings and hydrate localStorage before mounting Icarus
        let cloud = null
        try {
          cloud = await loadUserSettings(user.uid)
        } catch (err) {
          // Real error (permissions, network) - log it and proceed with local defaults
          console.warn('[Icarus] Could not load cloud settings:', err.message)
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
        console.warn('[Icarus] Cloud save failed:', err.message)
      )
    }, 1500)
  }, [])

  // Settings changes from Icarus (github tokens, theme, repo config, etc.)
  // Icarus calls this whenever any persisted setting changes.
  // We merge with the latest models so the cloud doc is always complete.
  const handleSettingsChanged = useCallback((settings) => {
    const uid = authUserRef.current?.uid
    if (!uid) return
    loadModels().then(m => scheduleCloudSave(uid, { ...settings, models: m })).catch(() => {})
  }, [scheduleCloudSave])

  // Model changes from IcarusSettings (API key entered/changed)
  const handleSetModels = useCallback((updated) => {
    setModels(updated)
    const uid = authUserRef.current?.uid
    if (!uid) return
    scheduleCloudSave(uid, { ...pendingSettingsRef.current, models: updated })
  }, [scheduleCloudSave])

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
      sessionStorage.removeItem('icarus:ghtoken')
      sessionStorage.removeItem('icarus:ghtoken2')
      sessionStorage.removeItem('icarus:searchkey')
      sessionStorage.removeItem('wrkflow:keys')
      sessionStorage.removeItem('wrkflow:sk')
    } catch {}
    pendingSettingsRef.current = {}
    setModels([])
    setPinUnlocked(false)
  }, [])

  const handlePinUnlock = useCallback(async () => {
    setPinUnlocked(true)
    try {
      // Anonymous auth gives a stable UID so Firestore settings (including API keys)
      // persist across PIN logins on the same device.
      await signInAnonymously()
      // onAuthStateChange will fire, load Firestore settings, then set authUser + settingsReady.
    } catch (err) {
      console.warn('[Icarus] Anonymous auth failed — using local-only mode:', err.message)
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
      <Icarus
        models={models}
        setModels={handleSetModels}
        selectedModelId={selectedModelId}
        onModelChange={(id) => setSelectedModelId(id)}
        onClose={() => {}}
        onSettingsChanged={handleSettingsChanged}
        onLogout={handleLogout}
        userEmail={authUser?.email || 'pin-user@local'}
      />
    </>
  )
}
