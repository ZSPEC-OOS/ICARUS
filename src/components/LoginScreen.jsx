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
    } catch (err) {
      const code = err?.code || ''
      const msg =
        code === 'auth/operation-not-allowed'
          ? 'Google sign-in is not enabled in Firebase — enable it under Authentication → Sign-in methods.'
          : code === 'auth/unauthorized-domain'
          ? 'This domain is not authorised in Firebase — add it under Authentication → Authorized domains.'
          : code === 'auth/cancelled-popup-request' || code === 'auth/popup-closed-by-user'
          ? 'Sign-in cancelled.'
          : `Google sign-in failed (${code || err?.message || 'unknown error'})`
      setError(msg)
      setLoading(false)
    }
  }

  async function handleEmailSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signInWithEmail(email.trim(), password)
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

  const inp = {
    display: 'block', width: '100%', padding: '0.65rem 0.85rem',
    marginBottom: '0.75rem',
    background: 'rgba(5, 12, 28, 0.85)',
    border: '1px solid rgba(77, 156, 255, 0.22)',
    color: '#e8f4ff', borderRadius: '10px',
    fontSize: '16px', boxSizing: 'border-box', outline: 'none',
    fontFamily: 'inherit',
  }

  const ghostLink = {
    display: 'block', marginTop: '0.9rem',
    background: 'none', border: 'none', color: 'rgba(77,156,255,0.40)',
    fontSize: '0.75rem', cursor: 'pointer',
    fontFamily: 'inherit', textDecoration: 'none', letterSpacing: '0.02em',
  }

  const divider = {
    display: 'flex', alignItems: 'center', gap: '10px',
    margin: '1.1rem 0', color: 'rgba(77,156,255,0.30)', fontSize: '0.72rem',
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh',
      background: 'url(/blkswan-bg.jpg) center/cover no-repeat fixed, #030b18',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    }}>
      <div style={{
        background: 'rgba(3, 8, 20, 0.90)',
        backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
        borderRadius: '20px',
        width: '100%', maxWidth: '400px',
        border: '1px solid rgba(77, 156, 255, 0.20)',
        boxShadow: '0 16px 64px rgba(0,0,0,0.80), 0 0 100px rgba(20,60,180,0.18), inset 0 1px 0 rgba(255,255,255,0.06)',
        margin: '0 16px',
        overflow: 'hidden',
      }}>

        {/* ── Full-width logo banner ── */}
        <div style={{ background: '#020810', borderBottom: '1px solid rgba(77,156,255,0.15)' }}>
          <img
            src="/blkswan-header.jpg"
            alt="BLKSWAN"
            style={{ width: '100%', display: 'block', height: 'auto' }}
          />
        </div>

        {/* ── Form content ── */}
        <div style={{ padding: '1.75rem 1.75rem 2rem' }}>

          {!showPin ? (
            <>
              {/* ── Google sign-in (primary) ── */}
              <button
                onClick={handleGoogle}
                disabled={loading}
                style={{
                  width: '100%', padding: '0.7rem',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                  background: loading ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.10)',
                  color: '#e8f4ff', border: '1px solid rgba(255,255,255,0.18)',
                  borderRadius: '10px', cursor: loading ? 'not-allowed' : 'pointer',
                  fontSize: '0.95rem', fontWeight: '600',
                  fontFamily: 'inherit', transition: 'background 0.15s',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                  <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
                  <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
                  <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
                </svg>
                {loading ? 'Redirecting…' : 'Continue with Google'}
              </button>

              {!showEmail && (
                <div style={divider}>
                  <div style={{ flex: 1, height: 1, background: 'rgba(77,156,255,0.12)' }} />
                  or
                  <div style={{ flex: 1, height: 1, background: 'rgba(77,156,255,0.12)' }} />
                </div>
              )}

              {!showEmail ? (
                <button
                  onClick={() => { setShowEmail(true); setError('') }}
                  style={{
                    width: '100%', padding: '0.65rem',
                    background: 'transparent',
                    color: 'rgba(77,156,255,0.60)', border: '1px solid rgba(77,156,255,0.18)',
                    borderRadius: '10px', cursor: 'pointer',
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
                      width: '100%', padding: '0.65rem',
                      background: loading ? 'rgba(26,78,168,0.45)' : 'linear-gradient(135deg,#1a4ea8,#4d9cff)',
                      color: '#fff', border: '1px solid rgba(77,156,255,0.45)',
                      borderRadius: '10px', cursor: loading ? 'not-allowed' : 'pointer',
                      fontSize: '0.9rem', fontWeight: '700', fontFamily: 'inherit',
                    }}
                  >{loading ? 'Signing in…' : 'Sign In'}</button>
                  <button type="button" onClick={() => { setShowEmail(false); setError('') }} style={ghostLink}>
                    ← Back
                  </button>
                </form>
              )}

              {error && (
                <p style={{ color: '#fb7185', fontSize: '0.82rem', margin: '0.75rem 0 0', textAlign: 'center' }}>{error}</p>
              )}

              <button onClick={() => { setShowPin(true); setError('') }} style={ghostLink}>
                Use PIN (offline / no sync)
              </button>
            </>
          ) : (
            /* ── PIN fallback ── */
            <form onSubmit={handlePinSubmit}>
              <p style={{ color: 'rgba(77,156,255,0.45)', fontSize: '0.82rem', marginBottom: '1.25rem', marginTop: 0, textAlign: 'center' }}>
                Local access only — models won't sync.
              </p>
              <input style={{ ...inp, textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.5em' }}
                type="password" inputMode="numeric" pattern="[0-9]*"
                maxLength={4} placeholder="••••" value={pin}
                onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setError('') }}
                autoFocus autoComplete="one-time-code" required />
              {error && <p style={{ color: '#fb7185', fontSize: '0.82rem', margin: '0 0 0.75rem', textAlign: 'center' }}>{error}</p>}
              <button
                type="submit"
                style={{
                  width: '100%', padding: '0.7rem',
                  background: 'linear-gradient(135deg,#1a4ea8,#4d9cff)',
                  color: '#fff', border: '1px solid rgba(77,156,255,0.45)',
                  borderRadius: '10px', cursor: 'pointer',
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
    </div>
  )
}
