import { useState } from 'react'

const APP_PIN = '5522'

export default function LoginScreen({ onUnlock }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
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
        minWidth: '340px', border: '1px solid #2a2a3a', boxShadow: '0 8px 32px rgba(0,0,0,0.5)', textAlign: 'center',
      }}>
        <div style={{ marginBottom: '1.75rem', textAlign: 'center' }}>
          <span style={{ fontSize: '1.6rem', color: '#a78bfa', fontFamily: "'Cormorant Upright', serif", letterSpacing: '0.15em' }}>LOGIK</span>
          <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '0.4rem', marginBottom: 0 }}>Enter your 4-digit PIN</p>
        </div>

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

        {error && (
          <p style={{ color: '#f87171', fontSize: '0.85rem', marginBottom: '0.85rem', marginTop: '0.25rem' }}>
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
          {loading ? 'Checking PIN...' : 'Unlock'}
        </button>

        <p style={{ color: '#555', fontSize: '0.78rem', marginTop: '1.25rem', textAlign: 'center', lineHeight: 1.5 }}>
          Secure local access enabled with a 4-digit PIN.
        </p>
      </form>
    </div>
  )
}
