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
    marginBottom: '0.85rem',
    background: 'rgba(7, 15, 30, 0.80)',
    border: '1px solid rgba(77, 156, 255, 0.25)',
    color: '#e8f4ff', borderRadius: '8px', fontSize: '0.95rem', boxSizing: 'border-box',
    outline: 'none',
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh',
      background: 'url(/blkswan-bg.jpg) center/cover no-repeat, radial-gradient(ellipse 100% 80% at 50% 100%, rgba(18,55,160,0.28) 0%, transparent 65%), #030b18',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    }}>
      <form onSubmit={handleSubmit} style={{
        background: 'rgba(4, 10, 24, 0.90)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        padding: '2.5rem 2.25rem',
        borderRadius: '16px',
        minWidth: '340px',
        border: '1px solid rgba(77, 156, 255, 0.22)',
        boxShadow: '0 8px 40px rgba(0,0,0,0.70), 0 0 60px rgba(30,80,200,0.12)',
        textAlign: 'center',
      }}>
        {/* BLKSWAN logo */}
        <div style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'center' }}>
          <img
            src="/blkswan-logo.svg"
            alt="BLKSWAN"
            style={{ height: '36px', width: 'auto' }}
          />
        </div>

        <p style={{ color: '#3d5a7a', fontSize: '0.85rem', marginTop: '-1rem', marginBottom: '1.5rem' }}>
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

        {error && (
          <p style={{ color: '#fb7185', fontSize: '0.85rem', marginBottom: '0.85rem', marginTop: '0.25rem' }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%', padding: '0.65rem',
            background: loading
              ? 'rgba(26, 78, 168, 0.55)'
              : 'linear-gradient(135deg, #1a4ea8 0%, #2a72d8 50%, #4d9cff 100%)',
            color: '#fff',
            border: '1px solid rgba(77, 156, 255, 0.45)',
            borderRadius: '8px',
            cursor: loading ? 'not-allowed' : 'pointer',
            fontSize: '0.95rem',
            fontWeight: '700',
            letterSpacing: '0.08em',
            transition: 'all 0.15s',
            boxShadow: loading ? 'none' : '0 2px 20px rgba(59, 130, 246, 0.40)',
          }}
        >
          {loading ? 'Checking PIN...' : 'Unlock'}
        </button>

        <p style={{ color: '#1c2e4e', fontSize: '0.78rem', marginTop: '1.25rem', textAlign: 'center', lineHeight: 1.5 }}>
          Secure local access · 4-digit PIN
        </p>
      </form>
    </div>
  )
}
