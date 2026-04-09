// ─── firebaseService ──────────────────────────────────────────────────────────
// Firebase initialisation, authentication, and cloud settings persistence.
// Project: bluswan-ai-coder
//
// Settings are saved to Firestore at users/{uid}/settings.
// Sensitive fields (API keys, tokens) are XOR-encrypted with the user's UID
// before storage, providing defense-in-depth beyond Firestore security rules.

import { initializeApp, getApps } from 'firebase/app'

const FB_CONFIG_KEY = 'bluswan:firebase'

// ── Hardcoded project config ──────────────────────────────────────────────────
const DEFAULT_FIREBASE_CONFIG = {
  apiKey:            'AIzaSyA4sX64h-WXk2rZGFKWioAi00DPnx4wpNw',
  authDomain:        'bluswan-ai-coder.firebaseapp.com',
  projectId:         'bluswan-ai-coder',
  storageBucket:     'bluswan-ai-coder.firebasestorage.app',
  messagingSenderId: '69683631923',
  appId:             '1:69683631923:web:7b1af3e2a9d5756efd5046',
}

let _app     = null
let _db      = null
let _auth    = null
let _storage = null

// ── Config persistence ────────────────────────────────────────────────────────

export function loadFirebaseConfig() {
  try {
    const raw = localStorage.getItem(FB_CONFIG_KEY)
    return raw ? JSON.parse(raw) : DEFAULT_FIREBASE_CONFIG
  } catch {
    return DEFAULT_FIREBASE_CONFIG
  }
}

export function saveFirebaseConfig(config) {
  try { localStorage.setItem(FB_CONFIG_KEY, JSON.stringify(config)) } catch {}
}

export function clearFirebaseConfig() {
  try {
    localStorage.removeItem(FB_CONFIG_KEY)
    _app = null; _db = null; _auth = null; _storage = null
  } catch {}
}

// ── Initialisation ────────────────────────────────────────────────────────────

export function initFirebaseSync(config = DEFAULT_FIREBASE_CONFIG) {
  if (!config?.apiKey || !config?.projectId) return null
  const existing = getApps().find(a => a.options.projectId === config.projectId)
  if (existing) { _app = existing; return _app }
  _app = initializeApp(config)
  saveFirebaseConfig(config)
  return _app
}

export async function initFirebase(config = DEFAULT_FIREBASE_CONFIG) {
  return initFirebaseSync(config)
}

export function getFirebaseApp() { return _app }

// ── Firestore ─────────────────────────────────────────────────────────────────

export async function getFirestore() {
  if (!_app) initFirebaseSync()
  if (!_db) {
    const { getFirestore: _getFS } = await import('firebase/firestore')
    _db = _getFS(_app)
  }
  return _db
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function getAuth() {
  if (!_app) initFirebaseSync()
  if (!_auth) {
    const { getAuth: _getAuth } = await import('firebase/auth')
    _auth = _getAuth(_app)
  }
  return _auth
}

// Returns the currently signed-in Firebase user synchronously (null if not authed).
export function getCurrentUser() {
  return _auth?.currentUser ?? null
}

// Sign in with Google.
// Uses signInWithPopup (triggered by user gesture — works on iPhone/Safari).
// Falls back to signInWithRedirect if the popup is blocked.
export async function signInWithGoogle() {
  const auth = await getAuth()
  const { GoogleAuthProvider, signInWithPopup, signInWithRedirect } = await import('firebase/auth')
  const provider = new GoogleAuthProvider()
  try {
    const cred = await signInWithPopup(auth, provider)
    return cred.user
  } catch (err) {
    // popup-blocked: fall back to redirect
    if (err?.code === 'auth/popup-blocked' || err?.code === 'auth/popup-closed-by-user') {
      await signInWithRedirect(auth, provider)
      return null // page will reload after redirect
    }
    throw err
  }
}

// Sign in with email + password.  Throws a Firebase AuthError on failure.
export async function signInWithEmail(email, password) {
  const auth = await getAuth()
  const { signInWithEmailAndPassword } = await import('firebase/auth')
  const cred = await signInWithEmailAndPassword(auth, email, password)
  return cred.user
}

// Create a new account with email + password.  Throws on failure.
export async function signUpWithEmail(email, password) {
  const auth = await getAuth()
  const { createUserWithEmailAndPassword } = await import('firebase/auth')
  const cred = await createUserWithEmailAndPassword(auth, email, password)
  return cred.user
}

// Sign in anonymously — used for PIN-based login so settings persist via Firestore.
// Firebase reuses the existing anonymous session on the same device, giving a
// stable UID across PIN logins without requiring an email/password or Google account.
export async function signInAnonymously() {
  const auth = await getAuth()
  const { signInAnonymously: _signAnon } = await import('firebase/auth')
  const cred = await _signAnon(auth)
  return cred.user
}

// Sign out the current user.
export async function signOutUser() {
  const auth = await getAuth()
  const { signOut } = await import('firebase/auth')
  await signOut(auth)
}

// Subscribe to auth state changes.  Returns an unsubscribe function.
// callback(user | null) is called immediately with the current state
// and again whenever the state changes.
//
// Uses a flag+ref pattern so the cleanup function always works even
// though the subscription is set up asynchronously.
export function onAuthStateChange(callback) {
  let realUnsub = null
  let cancelled = false

  ;(async () => {
    try {
      const auth = await getAuth()
      if (cancelled) return
      const { onAuthStateChanged } = await import('firebase/auth')
      if (cancelled) return
      realUnsub = onAuthStateChanged(auth, callback)
    } catch (err) {
      console.warn('[Bluswan] onAuthStateChange setup failed:', err.message)
      // Fire callback with null so the app doesn't stay on the loading screen
      if (!cancelled) callback(null)
    }
  })()

  return () => {
    cancelled = true
    realUnsub?.()
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────

export async function getStorage() {
  if (!_app) initFirebaseSync()
  if (!_storage) {
    const { getStorage: _getStorage } = await import('firebase/storage')
    _storage = _getStorage(_app)
  }
  return _storage
}

// ── Status ────────────────────────────────────────────────────────────────────

export function getFirebaseStatus() {
  return {
    configured:  true,
    initialised: !!_app,
    projectId:   DEFAULT_FIREBASE_CONFIG.projectId,
  }
}

// ── Encryption helpers (XOR-cipher keyed on user UID) ─────────────────────────
// Obfuscates sensitive values before writing to Firestore.
// The real access control is Firestore security rules; this adds a second layer.

function xorCipher(text, key) {
  if (!text || !key) return text
  return btoa(
    text.split('').map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))
    ).join('')
  )
}

function xorDecipher(encoded, key) {
  if (!encoded || !key) return encoded
  try {
    const raw = atob(encoded)
    return raw.split('').map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))
    ).join('')
  } catch { return '' }
}

// Fields that contain sensitive credentials — encrypted before Firestore write.
const SENSITIVE_FIELDS = ['githubToken', 'repo2Token', 'webSearchApiKey']

// ── Cloud settings persistence ────────────────────────────────────────────────
// Saved to: users/{uid}/settings  (one document per user)
//
// Firestore security rules should allow only the authenticated user to
// read/write their own settings:
//
//   rules_version = '2';
//   service cloud.firestore {
//     match /databases/{database}/documents {
//       match /users/{userId}/settings {
//         allow read, write: if request.auth != null && request.auth.uid == userId;
//       }
//     }
//   }

export async function saveUserSettings(uid, settings) {
  if (!uid || !settings) return
  try {
    const db = await getFirestore()
    const { doc, setDoc } = await import('firebase/firestore')

    // Encrypt sensitive fields; keep everything else plaintext
    const payload = { ...settings, _v: 1, _ts: Date.now() }
    SENSITIVE_FIELDS.forEach(f => {
      if (payload[f]) payload[f] = xorCipher(payload[f], uid)
    })
    // Encrypt API keys inside the models array
    if (Array.isArray(payload.models)) {
      payload.models = payload.models.map(m => ({
        ...m,
        apiKey: m.apiKey ? xorCipher(m.apiKey, uid) : '',
      }))
    }

    await setDoc(doc(db, 'users', uid, 'data', 'settings'), payload)
  } catch (err) {
    console.warn('[Bluswan] saveUserSettings failed:', err.message)
  }
}

// Returns the decrypted settings object, null if the document doesn't exist yet,
// or throws on a real error (permissions, network) so the caller can decide.
export async function loadUserSettings(uid) {
  if (!uid) return null
  const db = await getFirestore()
  const { doc, getDoc } = await import('firebase/firestore')
  const snap = await getDoc(doc(db, 'users', uid, 'data', 'settings'))
  if (!snap.exists()) return null    // New user — no settings saved yet (not an error)

  const data = snap.data()
  // Decrypt sensitive fields
  SENSITIVE_FIELDS.forEach(f => {
    if (data[f]) data[f] = xorDecipher(data[f], uid)
  })
  // Decrypt model API keys
  if (Array.isArray(data.models)) {
    data.models = data.models.map(m => ({
      ...m,
      apiKey: m.apiKey ? xorDecipher(m.apiKey, uid) : '',
    }))
  }
  return data
}

// ── Chat history persistence ──────────────────────────────────────────────────
// Saved to: users/{uid}/data/conversation
// This is intentionally separate from settings so chat writes can happen
// immediately when a session starts without touching settings payload shape.
export async function saveUserConversation(uid, messages = []) {
  if (!uid) return
  try {
    const db = await getFirestore()
    const { doc, setDoc } = await import('firebase/firestore')
    await setDoc(
      doc(db, 'users', uid, 'data', 'conversation'),
      { messages: Array.isArray(messages) ? messages : [], _ts: Date.now(), _v: 1 },
      { merge: true },
    )
  } catch (err) {
    console.warn('[Bluswan] saveUserConversation failed:', err.message)
  }
}

export async function loadUserConversation(uid) {
  if (!uid) return []
  try {
    const db = await getFirestore()
    const { doc, getDoc } = await import('firebase/firestore')
    const snap = await getDoc(doc(db, 'users', uid, 'data', 'conversation'))
    if (!snap.exists()) return []
    const data = snap.data()
    return Array.isArray(data?.messages) ? data.messages : []
  } catch (err) {
    console.warn('[Bluswan] loadUserConversation failed:', err.message)
    return []
  }
}

// ── Auto-init on module load ──────────────────────────────────────────────────
initFirebaseSync(loadFirebaseConfig())
