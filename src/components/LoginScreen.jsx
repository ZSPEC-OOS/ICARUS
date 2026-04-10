import { useState } from 'react'

const APP_PIN = '5522'

export default function LoginScreen({ onUnlock }) {
  const [pin,     setPin]     = useState('')
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)

  async function handlePinSubmit(e) {
    e.preventDefault()
    if (pin !== APP_PIN) { setError('Incorrect PIN.'); return }
    setLoading(true)
    setError('')
    await onUnlock?.(pin)
    // Loading state intentionally stays true — App.jsx will unmount this screen
    // once Firebase anonymous auth completes and authUser is set.
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
        <div style={{ background: '#020810', borderBottom: '1px solid rgba(77,156,255,0.15)', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px 32px' }}>
          <img
            src="/NEWLOGO-header.png"
            alt="BLUSWAN"
            style={{ maxWidth: '100%', maxHeight: '80px', width: 'auto', height: 'auto', display: 'block', objectFit: 'contain' }}
          />
        </div>

        {/* ── PIN form ── */}
        <div style={{ padding: '1.75rem 1.75rem 2rem' }}>
          <form onSubmit={handlePinSubmit}>
            <p style={{ color: 'rgba(77,156,255,0.50)', fontSize: '0.82rem', marginBottom: '1.5rem', marginTop: 0, textAlign: 'center', letterSpacing: '0.03em' }}>
              Enter PIN to unlock
            </p>
            <input
              style={{ ...inp, textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.5em' }}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              placeholder="••••"
              value={pin}
              onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setError('') }}
              autoFocus
              autoComplete="one-time-code"
              required
              disabled={loading}
            />
            {error && (
              <p style={{ color: '#fb7185', fontSize: '0.82rem', margin: '0 0 0.75rem', textAlign: 'center' }}>{error}</p>
            )}
            <button
              type="submit"
              disabled={loading || pin.length < 4}
              style={{
                width: '100%', padding: '0.7rem',
                background: loading || pin.length < 4 ? 'rgba(26,78,168,0.35)' : 'linear-gradient(135deg,#1a4ea8,#4d9cff)',
                color: '#fff', border: '1px solid rgba(77,156,255,0.45)',
                borderRadius: '10px', cursor: loading || pin.length < 4 ? 'not-allowed' : 'pointer',
                fontSize: '0.95rem', fontWeight: '700', fontFamily: 'inherit',
                transition: 'background 0.15s',
              }}
            >
              {loading ? 'Unlocking…' : 'Unlock'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
