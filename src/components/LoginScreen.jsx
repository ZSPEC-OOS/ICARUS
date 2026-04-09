import { useState } from 'react'
import { signInWithGoogle, signInWithEmail } from '../services/firebaseService'

const APP_PIN = '5522'

export default function LoginScreen({ onUnlock }) {
  const [showEmail, setShowEmail] = useState(false)
  const [showPin,   setShowPin]   = useState(false)
  const [email,     setEmail]     = useState('')
  const [password,  setPassword]  = useState('')
  const [pin,       setPin]       = useState('')
  const [error,     setError]     = useState('')
  const [loading,   setLoading]   = useState(false)

  async function handleGoogle() {
    setError('')
    setLoading(true)
    try {
      await signInWithGoogle()
      // signInWithGoogle does a full-page redirect to Google.
      // When it returns, onAuthStateChange in App.jsx fires automatically
      // and loads all cloud settings (models, API keys) from Firestore.
    } catch (err) {
      setError('Google sign-in failed. Try again.')
      setLoading(false)
    }
  }

  async function handleEmailSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signInWithEmail(email.trim(), password)
      // onAuthStateChange fires automatically — no further action needed
    } catch (err) {
      const code = err?.code || ''
      setError(
        code === 'auth/invalid-credential' || code === 'auth/wrong-password'
          ? 'Incorrect email or password.'
          : code === 'auth/user-not-found'
          ? 'No account found for that email.'
          : code === 'auth/too-many-requests'
          ? 'Too many attempts — try again later.'
          : `Sign-in error: ${err?.message || 'Unknown error'}`
      )
      setLoading(false)
    }
  }

  function handlePinSubmit(e) {
    e.preventDefault()
    if (pin === APP_PIN) {
      onUnlock?.()
    } else {
      setError('Incorrect PIN.')
    }
  }

  const bg = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '100vh',
    background: 'url(/blkswan-bg.jpg) center/cover no-repeat, #030b18',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  }

  const card = {
    background: 'rgba(4, 10, 24, 0.92)',
    backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
    padding: '2.25rem 2rem', borderRadius: '16px',
    width: '100%', maxWidth: '360px',
    border: '1px solid rgba(77, 156, 255, 0.22)',
    boxShadow: '0 8px 40px rgba(0,0,0,0.70), 0 0 60px rgba(30,80,200,0.12)',
    textAlign: 'center', margin: '0 16px',
  }

  const inp = {
    display: 'block', width: '100%', padding: '0.6rem 0.75rem',
    marginBottom: '0.75rem',
    background: 'rgba(7, 15, 30, 0.80)',
    border: '1px solid rgba(77, 156, 255, 0.25)',
    color: '#e8f4ff', borderRadius: '8px',
    fontSize: '16px', boxSizing: 'border-box', outline: 'none',
    fontFamily: 'inherit',
  }

  const ghostLink = {
    display: 'block', marginTop: '0.9rem',
    background: 'none', border: 'none', color: '#1c2e4e',
    fontSize: '0.75rem', cursor: 'pointer',
    fontFamily: 'inherit', textDecoration: 'underline',
  }

  const divider = {
    display: 'flex', alignItems: 'center', gap: '10px',
    margin: '1rem 0', color: '#1c2e4e', fontSize: '0.72rem',
  }

  return (
    <div style={bg}>
      <div style={card}>

        {/* Logo */}
        <div style={{ marginBottom: '1.75rem', display: 'flex', justifyContent: 'center' }}>
          <img src="/blkswan-header.jpg" alt="BLKSWAN"
            style={{ height: '36px', width: 'auto', borderRadius: '4px', objectFit: 'contain' }} />
        </div>

        {!showPin ? (
          <>
            {/* ── Google sign-in (primary) ── */}
            <button
              onClick={handleGoogle}
              disabled={loading}
              style={{
                width: '100%', padding: '0.65rem',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                background: loading ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.10)',
                color: '#e8f4ff', border: '1px solid rgba(255,255,255,0.18)',
                borderRadius: '8px', cursor: loading ? 'not-allowed' : 'pointer',
                fontSize: '0.95rem', fontWeight: '600',
                fontFamily: 'inherit', transition: 'all 0.15s',
              }}
            >
              {/* Google 'G' icon */}
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
                <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
                <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
              </svg>
              {loading ? 'Redirecting…' : 'Continue with Google'}
            </button>

            {/* ── Divider ── */}
            {!showEmail && (
              <div style={divider}>
                <div style={{ flex: 1, height: 1, background: 'rgba(77,156,255,0.12)' }} />
                or
                <div style={{ flex: 1, height: 1, background: 'rgba(77,156,255,0.12)' }} />
              </div>
            )}

            {/* ── Email/password (secondary, expandable) ── */}
            {!showEmail ? (
              <button
                onClick={() => { setShowEmail(true); setError('') }}
                style={{
                  width: '100%', padding: '0.6rem',
                  background: 'transparent',
                  color: '#3d5a7a', border: '1px solid rgba(77,156,255,0.18)',
                  borderRadius: '8px', cursor: 'pointer',
                  fontSize: '0.85rem', fontFamily: 'inherit',
                }}
              >
                Sign in with email
              </button>
            ) : (
              <form onSubmit={handleEmailSubmit}>
                <input style={inp} type="email" placeholder="Email"
                  value={email} onChange={e => { setEmail(e.target.value); setError('') }}
                  autoComplete="email" autoFocus required />
                <input style={inp} type="password" placeholder="Password"
                  value={password} onChange={e => { setPassword(e.target.value); setError('') }}
                  autoComplete="current-password" required />
                <button
                  type="submit" disabled={loading}
                  style={{
                    width: '100%', padding: '0.6rem',
                    background: loading ? 'rgba(26,78,168,0.45)' : 'linear-gradient(135deg,#1a4ea8,#4d9cff)',
                    color: '#fff', border: '1px solid rgba(77,156,255,0.45)',
                    borderRadius: '8px', cursor: loading ? 'not-allowed' : 'pointer',
                    fontSize: '0.9rem', fontWeight: '700', fontFamily: 'inherit',
                  }}
                >{loading ? 'Signing in…' : 'Sign In'}</button>
                <button type="button" onClick={() => { setShowEmail(false); setError('') }} style={ghostLink}>
                  ← Back
                </button>
              </form>
            )}

            {error && (
              <p style={{ color: '#fb7185', fontSize: '0.82rem', margin: '0.75rem 0 0' }}>{error}</p>
            )}

            <button onClick={() => { setShowPin(true); setError('') }} style={ghostLink}>
              Use PIN (offline / no sync)
            </button>
          </>
        ) : (
          /* ── PIN fallback ── */
          <form onSubmit={handlePinSubmit}>
            <p style={{ color: '#3d5a7a', fontSize: '0.82rem', marginBottom: '1rem', marginTop: 0 }}>
              Local access only — models won't sync.
            </p>
            <input style={inp} type="password" inputMode="numeric" pattern="[0-9]*"
              maxLength={4} placeholder="••••" value={pin}
              onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setError('') }}
              autoFocus autoComplete="one-time-code" required />
            {error && <p style={{ color: '#fb7185', fontSize: '0.82rem', margin: '0 0 0.75rem' }}>{error}</p>}
            <button
              type="submit"
              style={{
                width: '100%', padding: '0.65rem',
                background: 'linear-gradient(135deg,#1a4ea8,#4d9cff)',
                color: '#fff', border: '1px solid rgba(77,156,255,0.45)',
                borderRadius: '8px', cursor: 'pointer',
                fontSize: '0.95rem', fontWeight: '700', fontFamily: 'inherit',
              }}
            >Unlock</button>
            <button type="button" onClick={() => { setShowPin(false); setError('') }} style={ghostLink}>
              ← Sign in instead
            </button>
          </form>
        )}

      </div>
    </div>
  )
}
