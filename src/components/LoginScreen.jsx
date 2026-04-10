import { useState, useEffect, useRef, useCallback } from 'react'

const APP_PIN = '5522'

export default function LoginScreen({ onUnlock }) {
  const [pin,     setPin]     = useState('')
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)

  // Toolbox state — position in px, width in px
  const [pos,      setPos]      = useState(null)   // null until mounted (centered by default)
  const [boxWidth, setBoxWidth] = useState(400)
  const [showHud,  setShowHud]  = useState(true)
  const dragging  = useRef(null)
  const resizing  = useRef(null)

  // Centre the box once we know viewport dimensions
  useEffect(() => {
    const x = Math.round(window.innerWidth  / 2 - boxWidth / 2)
    const y = Math.round(window.innerHeight / 2 - 210)          // rough vertical centre
    setPos({ x, y })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Drag (move) ──────────────────────────────────────────────
  const onDragDown = useCallback((e) => {
    if (!pos) return
    e.preventDefault()
    const startX = e.clientX - pos.x
    const startY = e.clientY - pos.y
    dragging.current = { startX, startY }

    function onMove(e) {
      setPos({ x: e.clientX - dragging.current.startX, y: e.clientY - dragging.current.startY })
    }
    function onUp() {
      dragging.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [pos])

  // ── Resize (right edge) ───────────────────────────────────────
  const onResizeDown = useCallback((e) => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startW = boxWidth
    resizing.current = true

    function onMove(e) {
      setBoxWidth(Math.max(280, Math.min(700, startW + e.clientX - startX)))
    }
    function onUp() {
      resizing.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [boxWidth])

  async function handlePinSubmit(e) {
    e.preventDefault()
    if (pin !== APP_PIN) { setError('Incorrect PIN.'); return }
    setLoading(true)
    setError('')
    await onUnlock?.()
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

  // Don't render until we have a position (avoids flash at top-left)
  if (!pos) return (
    <div style={{
      minHeight: '100vh',
      background: 'url(/blkswan-bg.jpg) center/cover no-repeat fixed, #030b18',
    }} />
  )

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'url(/blkswan-bg.jpg) center/cover no-repeat fixed, #030b18',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    }}>

      {/* ── Modal card ── */}
      <div
        onMouseDown={onDragDown}
        style={{
          position: 'absolute',
          left: pos.x,
          top:  pos.y,
          width: boxWidth,
          cursor: 'grab',
          userSelect: 'none',
          background: 'rgba(3, 8, 20, 0.90)',
          backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
          borderRadius: '20px',
          border: '1px solid rgba(77, 156, 255, 0.20)',
          boxShadow: '0 16px 64px rgba(0,0,0,0.80), 0 0 100px rgba(20,60,180,0.18), inset 0 1px 0 rgba(255,255,255,0.06)',
          overflow: 'visible',
        }}
      >

        {/* ── Full-width logo banner ── */}
        <div style={{ background: '#020810', borderBottom: '1px solid rgba(77,156,255,0.15)', borderRadius: '20px 20px 0 0', overflow: 'hidden' }}>
          <img
            src="/bluswan-header-logo.jpg"
            alt="BLUSWAN"
            style={{ width: '100%', display: 'block', height: 'auto', pointerEvents: 'none' }}
          />
        </div>

        {/* ── PIN form ── */}
        <div style={{ padding: '1.75rem 1.75rem 2rem' }}>
          <form onSubmit={handlePinSubmit} onMouseDown={e => e.stopPropagation()}>
            <p style={{ color: 'rgba(77,156,255,0.50)', fontSize: '0.82rem', marginBottom: '1.5rem', marginTop: 0, textAlign: 'center', letterSpacing: '0.03em' }}>
              Enter PIN to unlock
            </p>
            <input
              style={{ ...inp, textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.5em', cursor: 'text' }}
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
              onMouseDown={e => e.stopPropagation()}
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

        {/* ── Right-edge resize handle ── */}
        <div
          onMouseDown={onResizeDown}
          title="Drag to resize"
          style={{
            position: 'absolute', top: 0, right: -6,
            width: 12, height: '100%',
            cursor: 'ew-resize',
            zIndex: 10,
          }}
        />

      </div>

      {/* ── Settings HUD ── */}
      <div style={{
        position: 'fixed', bottom: 18, right: 18,
        background: 'rgba(3,8,20,0.92)',
        border: '1px solid rgba(77,156,255,0.30)',
        borderRadius: '12px',
        padding: showHud ? '10px 14px' : '6px 12px',
        backdropFilter: 'blur(12px)',
        fontFamily: 'monospace',
        fontSize: '0.75rem',
        color: '#93c5fd',
        zIndex: 9999,
        userSelect: 'none',
        minWidth: 160,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showHud ? 8 : 0 }}>
          <span style={{ color: 'rgba(77,156,255,0.60)', fontSize: '0.7rem', letterSpacing: '0.06em' }}>TOOLBOX</span>
          <button
            onClick={() => setShowHud(v => !v)}
            style={{
              background: 'none', border: 'none', color: '#4d9cff',
              cursor: 'pointer', fontSize: '0.75rem', padding: '0 0 0 10px', lineHeight: 1,
            }}
          >
            {showHud ? '▼ hide' : '▲ show'}
          </button>
        </div>
        {showHud && (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              {[
                ['Left',  `${pos.x} px`],
                ['Top',   `${pos.y} px`],
                ['Width', `${boxWidth} px`],
              ].map(([label, val]) => (
                <tr key={label}>
                  <td style={{ color: 'rgba(77,156,255,0.50)', paddingRight: 10, paddingBottom: 2 }}>{label}</td>
                  <td style={{ color: '#e8f4ff', fontWeight: 600 }}>{val}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  )
}
