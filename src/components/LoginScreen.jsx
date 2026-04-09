import { useState } from 'react'
import { signInWithEmail } from '../services/firebaseService'

const APP_PIN = '5522'

export default function LoginScreen({ onUnlock }) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const [showPin,  setShowPin]  = useState(false)
  const [pin,      setPin]      = useState('')

  // Primary: Firebase email/password — session persists, models sync automatically
  async function handleEmailSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signInWithEmail(email.trim(), password)
      // onAuthStateChange in App.jsx fires automatically — loads all cloud settings
      // (models + API keys) from Firestore before Icarus renders.
    } catch (err) {
      const code = err?.code || ''
      const msg =
        code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/invalid-email'
          ? 'Incorrect email or password.'
          : code === 'auth/user-not-found'
          ? 'No account found for that email.'
          : code === 'auth/too-many-requests'
          ? 'Too many attempts — try again later.'
          : `Sign-in error: ${err?.message || 'Unknown error'}`
      setError(msg)
      setLoading(false)
    }
  }

  // Fallback: PIN — local access only, no cloud sync
  async function handlePinSubmit(e) {
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
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    padding: '2.25rem 2rem',
    borderRadius: '16px',
    width: '100%', maxWidth: '360px',
    border: '1px solid rgba(77, 156, 255, 0.22)',
    boxShadow: '0 8px 40px rgba(0,0,0,0.70), 0 0 60px rgba(30,80,200,0.12)',
    textAlign: 'center',
    margin: '0 16px',
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

  const primaryBtn = (disabled) => ({
    width: '100%', padding: '0.65rem',
    background: disabled
      ? 'rgba(26, 78, 168, 0.45)'
      : 'linear-gradient(135deg, #1a4ea8 0%, #2a72d8 50%, #4d9cff 100%)',
    color: '#fff', border: '1px solid rgba(77, 156, 255, 0.45)',
    borderRadius: '8px', cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '0.95rem', fontWeight: '700', letterSpacing: '0.06em',
    boxShadow: disabled ? 'none' : '0 2px 20px rgba(59, 130, 246, 0.40)',
    fontFamily: 'inherit',
  })

  return (
    <div style={bg}>
      <div style={card}>

        {/* Logo */}
        <div style={{ marginBottom: '1.75rem', display: 'flex', justifyContent: 'center' }}>
          <img src="/blkswan-header.jpg" alt="BLKSWAN"
            style={{ height: '36px', width: 'auto', borderRadius: '4px', objectFit: 'contain' }} />
        </div>

        {!showPin ? (
          /* ── Email / Firebase login (primary) ── */
          <form onSubmit={handleEmailSubmit}>
            <p style={{ color: '#3d5a7a', fontSize: '0.82rem', marginBottom: '1.25rem', marginTop: 0 }}>
              Sign in to access your models &amp; settings on any device.
            </p>

            <input style={inp} type="email" placeholder="Email"
              value={email} onChange={e => { setEmail(e.target.value); setError('') }}
              autoComplete="email" autoFocus required />

            <input style={inp} type="password" placeholder="Password"
              value={password} onChange={e => { setPassword(e.target.value); setError('') }}
              autoComplete="current-password" required />

            {error && (
              <p style={{ color: '#fb7185', fontSize: '0.82rem', margin: '0 0 0.75rem' }}>{error}</p>
            )}

            <button type="submit" disabled={loading} style={primaryBtn(loading)}>
              {loading ? 'Signing in…' : 'Sign In'}
            </button>

            <button
              type="button"
              onClick={() => { setShowPin(true); setError('') }}
              style={{
                marginTop: '1rem', background: 'none', border: 'none',
                color: '#1c2e4e', fontSize: '0.75rem', cursor: 'pointer',
                fontFamily: 'inherit', textDecoration: 'underline',
              }}
            >
              Use PIN (offline / no sync)
            </button>
          </form>
        ) : (
          /* ── PIN fallback (offline only) ── */
          <form onSubmit={handlePinSubmit}>
            <p style={{ color: '#3d5a7a', fontSize: '0.82rem', marginBottom: '1rem', marginTop: 0 }}>
              PIN gives local access only — saved models won't sync.
            </p>

            <input style={inp} type="password" inputMode="numeric" pattern="[0-9]*"
              maxLength={4} placeholder="••••" value={pin}
              onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setError('') }}
              autoFocus autoComplete="one-time-code" required />

            {error && (
              <p style={{ color: '#fb7185', fontSize: '0.82rem', margin: '0 0 0.75rem' }}>{error}</p>
            )}

            <button type="submit" style={primaryBtn(false)}>Unlock</button>

            <button
              type="button"
              onClick={() => { setShowPin(false); setError('') }}
              style={{
                marginTop: '1rem', background: 'none', border: 'none',
                color: '#1c2e4e', fontSize: '0.75rem', cursor: 'pointer',
                fontFamily: 'inherit', textDecoration: 'underline',
              }}
            >
              ← Sign in instead
            </button>
          </form>
        )}

      </div>
    </div>
  )
}
