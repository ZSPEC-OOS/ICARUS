import { useState } from 'react'
import { signInWithEmail } from '../services/firebaseService'

const APP_PIN = '5522'

export default function LoginScreen({ onUnlock, onFirebaseLogin }) {
  const [mode,     setMode]     = useState('pin')   // 'pin' | 'email'
  const [pin,      setPin]      = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  async function handlePinSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    if (pin === APP_PIN) {
      onUnlock?.()
    } else {
      setError('Incorrect PIN. Please try again.')
      setLoading(false)
    }
  }

  async function handleEmailSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signInWithEmail(email.trim(), password)
      // onAuthStateChange in App.jsx fires automatically — it will load cloud
      // settings (models, tokens) before rendering Icarus.
      onFirebaseLogin?.()
    } catch (err) {
      const msg = err?.code === 'auth/invalid-credential' || err?.code === 'auth/wrong-password'
        ? 'Incorrect email or password.'
        : err?.code === 'auth/user-not-found'
        ? 'No account found for that email.'
        : err?.code === 'auth/too-many-requests'
        ? 'Too many attempts — try again later.'
        : `Sign-in failed: ${err?.message || 'Unknown error'}`
      setError(msg)
      setLoading(false)
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
    width: '100%',
    maxWidth: '360px',
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
    fontSize: '16px', /* prevent iOS zoom */
    boxSizing: 'border-box', outline: 'none',
    fontFamily: 'inherit',
  }

  const primaryBtn = (disabled) => ({
    width: '100%', padding: '0.65rem',
    background: disabled
      ? 'rgba(26, 78, 168, 0.45)'
      : 'linear-gradient(135deg, #1a4ea8 0%, #2a72d8 50%, #4d9cff 100%)',
    color: '#fff',
    border: '1px solid rgba(77, 156, 255, 0.45)',
    borderRadius: '8px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '0.95rem', fontWeight: '700', letterSpacing: '0.08em',
    transition: 'all 0.15s',
    boxShadow: disabled ? 'none' : '0 2px 20px rgba(59, 130, 246, 0.40)',
    fontFamily: 'inherit',
  })

  const tabBtn = (active) => ({
    flex: 1,
    padding: '0.45rem 0',
    background: active ? 'rgba(59, 142, 240, 0.18)' : 'transparent',
    color: active ? '#60a5fa' : '#3d5a7a',
    border: 'none',
    borderBottom: active ? '2px solid #3b8ef0' : '2px solid transparent',
    cursor: 'pointer',
    fontSize: '0.82rem',
    fontWeight: active ? '700' : '400',
    letterSpacing: '0.04em',
    transition: 'all 0.14s',
    fontFamily: 'inherit',
  })

  return (
    <div style={bg}>
      <div style={card}>

        {/* Logo */}
        <div style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'center' }}>
          <img
            src="/blkswan-header.jpg"
            alt="BLKSWAN"
            style={{ height: '36px', width: 'auto', borderRadius: '4px', objectFit: 'contain' }}
          />
        </div>

        {/* Tab switcher */}
        <div style={{ display: 'flex', marginBottom: '1.5rem', borderBottom: '1px solid rgba(77,156,255,0.12)' }}>
          <button style={tabBtn(mode === 'pin')}   onClick={() => { setMode('pin');   setError('') }}>PIN</button>
          <button style={tabBtn(mode === 'email')} onClick={() => { setMode('email'); setError('') }}>
            Sign in &amp; Sync
          </button>
        </div>

        {/* PIN form */}
        {mode === 'pin' && (
          <form onSubmit={handlePinSubmit}>
            <p style={{ color: '#3d5a7a', fontSize: '0.82rem', marginBottom: '1rem', marginTop: 0 }}>
              Enter your 4-digit PIN
            </p>
            <input
              style={inp}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              placeholder="••••"
              value={pin}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, '').slice(0, 4)
                setPin(digits)
                if (error) setError('')
              }}
              autoFocus
              autoComplete="one-time-code"
              required
            />
            {error && <p style={{ color: '#fb7185', fontSize: '0.82rem', margin: '0 0 0.75rem' }}>{error}</p>}
            <button type="submit" disabled={loading} style={primaryBtn(loading)}>
              {loading ? 'Checking…' : 'Unlock'}
            </button>
            <p style={{ color: '#1c2e4e', fontSize: '0.72rem', marginTop: '1rem', lineHeight: 1.5 }}>
              PIN gives local access only — no cloud sync.
            </p>
          </form>
        )}

        {/* Email / Firebase form */}
        {mode === 'email' && (
          <form onSubmit={handleEmailSubmit}>
            <p style={{ color: '#3d5a7a', fontSize: '0.82rem', marginBottom: '1rem', marginTop: 0 }}>
              Sign in to sync your models &amp; settings across devices.
            </p>
            <input
              style={inp}
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (error) setError('') }}
              autoComplete="email"
              required
            />
            <input
              style={inp}
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); if (error) setError('') }}
              autoComplete="current-password"
              required
            />
            {error && <p style={{ color: '#fb7185', fontSize: '0.82rem', margin: '0 0 0.75rem' }}>{error}</p>}
            <button type="submit" disabled={loading} style={primaryBtn(loading)}>
              {loading ? 'Signing in…' : 'Sign In & Sync Models'}
            </button>
            <p style={{ color: '#1c2e4e', fontSize: '0.72rem', marginTop: '1rem', lineHeight: 1.5 }}>
              Restores all your saved models &amp; API keys automatically.
            </p>
          </form>
        )}

      </div>
    </div>
  )
}
