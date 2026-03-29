import { useState } from 'react'
import { signInWithEmail, signUpWithEmail } from '../services/firebaseService.js'

// LoginScreen does NOT receive an onLogin callback - the Firebase auth state
// listener in App.jsx is the single source of truth. After a successful
// sign-in the form stays in loading state until Firebase confirms the session
// and App.jsx unmounts this component.

function authErrorMsg(code) {
  switch (code) {
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential': return 'Incorrect email or password.'
    case 'auth/email-already-in-use': return 'An account with this email already exists.'
    case 'auth/invalid-email': return 'Please enter a valid email address.'
    case 'auth/weak-password': return 'Password must be at least 6 characters.'
    case 'auth/too-many-requests': return 'Too many attempts - please wait a moment and try again.'
    case 'auth/network-request-failed': return 'Network error - check your connection and try again.'
    default: return 'Something went wrong. Please try again.'
  }
}

export default function LoginScreen() {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      mode === 'signup'
        ? await signUpWithEmail(email.trim(), password)
        : await signInWithEmail(email.trim(), password)
    } catch (err) {
      setError(authErrorMsg(err.code))
      setLoading(false)
    }
  }

  const inp = {
    display: 'block', width: '100%', padding: '0.55rem 0.75rem',
    marginBottom: '0.85rem', background: '#1e1e2a', border: '1px solid #3a3a52',
    color: '#e8e8f0', borderRadius: '6px', fontSize: '0.95rem', boxSizing: 'border-box',
    outline: 'none',
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: '#0d0d14',
      fontFamily: "'EB Garamond', Georgia, serif",
    }}>
      <form onSubmit={handleSubmit} style={{
        background: '#13131e', padding: '2.5rem 2.25rem', borderRadius: '10px',
        minWidth: '340px', border: '1px solid #2a2a3a', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <div style={{ marginBottom: '1.75rem', textAlign: 'center' }}>
          <span style={{ fontSize: '1.6rem', color: '#a78bfa', fontFamily: "'Cormorant Upright', serif", letterSpacing: '0.15em' }}>LOGIK</span>
          <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '0.4rem', marginBottom: 0 }}>AI Coding Assistant</p>
        </div>

        <div style={{ display: 'flex', marginBottom: '1.5rem', borderBottom: '1px solid #2a2a3a' }}>
          {[['signin', 'Sign In'], ['signup', 'Create Account']].map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setError('') }}
              style={{
                flex: 1, padding: '0.45rem', background: 'none',
                border: 'none', borderBottom: mode === m ? '2px solid #a78bfa' : '2px solid transparent',
                color: mode === m ? '#a78bfa' : '#666', cursor: 'pointer',
                fontSize: '0.875rem', fontFamily: 'inherit', marginBottom: '-1px',
                transition: 'color 0.15s',
              }}
            >{label}</button>
          ))}
        </div>

        <input
          style={inp}
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          autoFocus
          autoComplete="email"
          required
        />
        <input
          style={inp}
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          required
        />

        {error && (
          <p style={{ color: '#f87171', fontSize: '0.85rem', marginBottom: '0.85rem', marginTop: '-0.3rem' }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%', padding: '0.6rem',
            background: loading ? '#4a3fa0' : '#6c5ce7',
            color: '#fff', border: 'none', borderRadius: '6px',
            cursor: loading ? 'not-allowed' : 'pointer',
            fontSize: '0.95rem', letterSpacing: '0.05em',
            transition: 'background 0.15s',
          }}
        >
          {loading ? 'Loading...' : mode === 'signup' ? 'Create Account' : 'Sign In'}
        </button>

        <p style={{ color: '#555', fontSize: '0.78rem', marginTop: '1.25rem', textAlign: 'center', lineHeight: 1.5 }}>
          Your API keys are encrypted and stored securely in your account.
        </p>
      </form>
    </div>
  )
}
