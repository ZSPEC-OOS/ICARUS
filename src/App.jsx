import { useState, useEffect, useRef, useCallback } from 'react'
import LoginScreen from './components/LoginScreen'
import Logik from './components/Logik'
import { loadModels, saveModels, saveSearchKey } from './services/aiService'
import {
  onAuthStateChange,
  signOutUser,
  loadUserSettings,
  saveUserSettings,
} from './services/firebaseService'

// Populate localStorage + sessionStorage from cloud settings
// Called after login so that Logik's loadSettings() reads the cloud values on
// first render. Each value uses the same storage path that Logik writes to,
// so the component initialises transparently with persisted data.
function injectCloudSettings(settings) {
  if (!settings) return
  try {
    const { githubToken, repo2Token, webSearchApiKey, models,
            permissionMode, _v, _ts, ...rest } = settings

    // Non-secret settings -> localStorage (same key Logik uses)
    localStorage.setItem('logik:settings', JSON.stringify(rest))

    // permissionMode has its own key in localStorage
    if (permissionMode) localStorage.setItem('logik:permMode', permissionMode)

    // GitHub tokens -> sessionStorage as plaintext (matching Logik's read path)
    if (githubToken !== undefined) sessionStorage.setItem('logik:ghtoken', githubToken || '')
    if (repo2Token !== undefined) sessionStorage.setItem('logik:ghtoken2', repo2Token || '')

    // Search key must be stored via saveSearchKey() because loadSearchKey() decrypts it
    if (webSearchApiKey !== undefined) saveSearchKey(webSearchApiKey || '')

    // Models (with API keys) -> aiService storage (handles its own encryption)
    if (Array.isArray(models) && models.length > 0) saveModels(models)
  } catch (err) {
    console.warn('[Logik] injectCloudSettings failed:', err.message)
  }
}

function Splash({ msg = 'Loading...' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: '#0d0d14', color: '#555',
      fontFamily: "'EB Garamond', Georgia, serif", fontSize: '1rem', gap: '0.5rem',
    }}>
      <span style={{ color: '#a78bfa' }}>*</span>{msg}
    </div>
  )
}

export default function App() {
  // Three-phase state:
  //   authChecked=false  -> Firebase resolving initial auth state (show splash)
  //   authUser=null      -> Not logged in (show LoginScreen)
  //   settingsReady=false -> Logged in but loading Firestore (show splash)
  //   settingsReady=true  -> Ready (show Logik)
  const [authChecked, setAuthChecked] = useState(false)
  const [authUser, setAuthUser] = useState(null)
  const [settingsReady, setSettingsReady] = useState(false)
  const [cloudError, setCloudError] = useState('')

  const [models, setModels] = useState(loadModels)
  const [selectedModelId, setSelectedModelId] = useState(() => loadModels()[0]?.id || '')

  // Debounce ref - avoids a Firestore write on every keystroke
  const saveTimerRef = useRef(null)
  const pendingSettingsRef = useRef({})
  const authUserRef = useRef(null)

  // Firebase auth listener - single source of truth
  // We do NOT set authUser from the LoginScreen onLogin callback.
  // This listener fires when Firebase confirms login, giving us time to load
  // Firestore settings BEFORE rendering Logik (so it initialises with correct values).
  useEffect(() => {
    const unsub = onAuthStateChange(async (user) => {
      if (user) {
        authUserRef.current = user
        setCloudError('')

        // Load cloud settings and hydrate localStorage before mounting Logik
        let cloud = null
        try {
          cloud = await loadUserSettings(user.uid)
        } catch (err) {
          // Real error (permissions, network) - log it and proceed with local defaults
          console.warn('[Logik] Could not load cloud settings:', err.message)
          setCloudError('Could not load cloud settings - using local data. Check Firestore rules.')
        }

        if (cloud) {
          injectCloudSettings(cloud)
          const freshModels = loadModels()
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
        console.warn('[Logik] Cloud save failed:', err.message)
      )
    }, 1500)
  }, [])

  // Settings changes from Logik (github tokens, theme, repo config, etc.)
  // Logik calls this whenever any persisted setting changes.
  // We merge with the latest models so the cloud doc is always complete.
  const handleSettingsChanged = useCallback((settings) => {
    const uid = authUserRef.current?.uid
    if (!uid) return
    scheduleCloudSave(uid, { ...settings, models: loadModels() })
  }, [scheduleCloudSave])

  // Model changes from LogikSettings (API key entered/changed)
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
        await saveUserSettings(uid, { ...pendingSettingsRef.current, models: loadModels() })
          .catch(() => {})
      }
    }
    await signOutUser().catch(() => {})
    // Clear sensitive local session data
    try {
      sessionStorage.removeItem('logik:ghtoken')
      sessionStorage.removeItem('logik:ghtoken2')
      sessionStorage.removeItem('logik:searchkey')
      sessionStorage.removeItem('wrkflow:keys')
      sessionStorage.removeItem('wrkflow:sk')
    } catch {}
    pendingSettingsRef.current = {}
    setModels(loadModels())
  }, [])

  if (!authChecked) return <Splash />
  if (!authUser) return <LoginScreen />
  if (!settingsReady) return <Splash msg="Loading your settings..." />

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
      <Logik
        models={models}
        setModels={handleSetModels}
        selectedModelId={selectedModelId}
        onModelChange={(id) => setSelectedModelId(id)}
        onClose={() => {}}
        onSettingsChanged={handleSettingsChanged}
        onLogout={handleLogout}
        userEmail={authUser.email}
      />
    </>
  )
}
