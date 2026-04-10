import { useState, useEffect, useRef, useCallback } from 'react'

const APP_PIN = '5522'

// ── Toolbox slider row ────────────────────────────────────────────────────────
function Row({ label, value, min, max, step = 1, unit = '', onChange }) {
  return (
    <tr>
      <td style={{ color: 'rgba(147,197,253,0.6)', fontSize: '0.7rem', paddingRight: 8, paddingBottom: 5, whiteSpace: 'nowrap' }}>
        {label}
      </td>
      <td style={{ paddingBottom: 5 }}>
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))}
          style={{ width: 100, accentColor: '#4d9cff', verticalAlign: 'middle' }}
        />
      </td>
      <td style={{ color: '#e8f4ff', fontSize: '0.72rem', fontWeight: 600, paddingLeft: 6, paddingBottom: 5, whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
        <input
          type="number" min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))}
          style={{
            width: 52, background: 'rgba(5,12,28,0.8)', border: '1px solid rgba(77,156,255,0.2)',
            borderRadius: 5, color: '#e8f4ff', fontSize: '0.72rem', padding: '1px 4px',
            fontFamily: 'monospace', textAlign: 'right',
          }}
        />
        <span style={{ color: 'rgba(147,197,253,0.5)', marginLeft: 2 }}>{unit}</span>
      </td>
    </tr>
  )
}

export default function LoginScreen({ onUnlock }) {
  const [pin,     setPin]     = useState('')
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)

  // ── Box geometry ─────────────────────────────────────────────
  const [posX,   setPosX]   = useState(null)   // null until mounted
  const [posY,   setPosY]   = useState(null)
  const [width,  setWidth]  = useState(400)

  // ── Appearance ───────────────────────────────────────────────
  const [bgOpacity,      setBgOpacity]      = useState(90)   // %
  const [blur,           setBlur]           = useState(24)   // px
  const [borderRadius,   setBorderRadius]   = useState(20)   // px
  const [borderOpacity,  setBorderOpacity]  = useState(20)   // %
  const [padding,        setPadding]        = useState(28)   // px

  // ── Toolbox UI ───────────────────────────────────────────────
  const [showHud, setShowHud] = useState(true)

  const dragging = useRef(null)
  const resizing = useRef(null)

  // Centre horizontally on mount
  useEffect(() => {
    const x = Math.round((window.innerWidth - width) / 2)
    const y = Math.round(window.innerHeight / 2 - 210)
    setPosX(x)
    setPosY(y)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep horizontally centred when width changes (only before user has dragged)
  // (After first drag, posX is set manually so we leave it alone)

  // ── Drag ─────────────────────────────────────────────────────
  const onDragDown = useCallback((e) => {
    if (posX === null) return
    e.preventDefault()
    const startX = e.clientX - posX
    const startY = e.clientY - posY
    dragging.current = { startX, startY }
    function onMove(e) {
      setPosX(e.clientX - dragging.current.startX)
      setPosY(e.clientY - dragging.current.startY)
    }
    function onUp() {
      dragging.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [posX, posY])

  // ── Resize (right edge) ───────────────────────────────────────
  const onResizeDown = useCallback((e) => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    function onMove(e) {
      setWidth(Math.max(280, Math.min(800, startW + e.clientX - startX)))
    }
    function onUp() {
      resizing.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    e.stopPropagation()
  }, [width])

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

  if (posX === null) return (
    <div style={{ minHeight: '100vh', background: 'url(/blkswan-bg.jpg) center/cover no-repeat fixed, #030b18' }} />
  )

  const bgAlpha    = (bgOpacity    / 100).toFixed(2)
  const borderAlpha = (borderOpacity / 100).toFixed(2)

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'url(/blkswan-bg.jpg) center/cover no-repeat fixed, #030b18',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    }}>

      {/* ── Modal card ───────────────────────────────────────── */}
      <div
        onMouseDown={onDragDown}
        style={{
          position: 'absolute',
          left: posX,
          top:  posY,
          width,
          cursor: 'grab',
          userSelect: 'none',
          background: `rgba(3, 8, 20, ${bgAlpha})`,
          backdropFilter: `blur(${blur}px)`,
          WebkitBackdropFilter: `blur(${blur}px)`,
          borderRadius: borderRadius,
          border: `1px solid rgba(77, 156, 255, ${borderAlpha})`,
          boxShadow: '0 16px 64px rgba(0,0,0,0.80), 0 0 100px rgba(20,60,180,0.18), inset 0 1px 0 rgba(255,255,255,0.06)',
          overflow: 'visible',
        }}
      >
        {/* Logo banner */}
        <div style={{
          background: '#020810',
          borderBottom: `1px solid rgba(77,156,255,${borderAlpha})`,
          borderRadius: `${borderRadius}px ${borderRadius}px 0 0`,
          overflow: 'hidden',
        }}>
          <img
            src="/bluswan-header-logo.jpg"
            alt="BLUSWAN"
            style={{ width: '100%', display: 'block', height: 'auto', pointerEvents: 'none' }}
          />
        </div>

        {/* PIN form */}
        <div style={{ padding: padding }}>
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

        {/* Right-edge resize handle */}
        <div
          onMouseDown={onResizeDown}
          style={{
            position: 'absolute', top: 0, right: -6,
            width: 12, height: '100%',
            cursor: 'ew-resize', zIndex: 10,
          }}
        />
      </div>

      {/* ── Settings Toolbox HUD ─────────────────────────────── */}
      <div
        onMouseDown={e => e.stopPropagation()}
        style={{
          position: 'fixed', bottom: 18, right: 18,
          background: 'rgba(3,8,20,0.95)',
          border: '1px solid rgba(77,156,255,0.30)',
          borderRadius: '14px',
          padding: '10px 14px',
          backdropFilter: 'blur(16px)',
          fontFamily: 'monospace',
          fontSize: '0.75rem',
          color: '#93c5fd',
          zIndex: 9999,
          userSelect: 'none',
          minWidth: 260,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, borderBottom: '1px solid rgba(77,156,255,0.15)', paddingBottom: 7 }}>
          <span style={{ color: '#4d9cff', fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.1em' }}>TOOLBOX</span>
          <button
            onClick={() => setShowHud(v => !v)}
            style={{ background: 'none', border: 'none', color: '#4d9cff', cursor: 'pointer', fontSize: '0.72rem', padding: 0 }}
          >
            {showHud ? 'hide ▲' : 'show ▼'}
          </button>
        </div>

        {showHud && (
          <>
            {/* Section: Position & Size */}
            <div style={{ color: 'rgba(77,156,255,0.45)', fontSize: '0.65rem', letterSpacing: '0.08em', marginBottom: 4 }}>POSITION &amp; SIZE</div>
            <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 8 }}>
              <tbody>
                <Row label="Left"  value={posX}  min={-200} max={2000} onChange={setPosX}  unit="px" />
                <Row label="Top"   value={posY}  min={-200} max={2000} onChange={setPosY}  unit="px" />
                <Row label="Width" value={width} min={280}  max={800}  onChange={setWidth} unit="px" />
              </tbody>
            </table>

            {/* Section: Appearance */}
            <div style={{ color: 'rgba(77,156,255,0.45)', fontSize: '0.65rem', letterSpacing: '0.08em', marginBottom: 4 }}>APPEARANCE</div>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <tbody>
                <Row label="BG Opacity"     value={bgOpacity}     min={0}  max={100} onChange={setBgOpacity}     unit="%" />
                <Row label="Blur"           value={blur}          min={0}  max={60}  onChange={setBlur}          unit="px" />
                <Row label="Corner Radius"  value={borderRadius}  min={0}  max={50}  onChange={setBorderRadius}  unit="px" />
                <Row label="Border Opacity" value={borderOpacity} min={0}  max={100} onChange={setBorderOpacity} unit="%" />
                <Row label="Padding"        value={padding}       min={8}  max={80}  onChange={setPadding}       unit="px" />
              </tbody>
            </table>

            {/* Reset button */}
            <button
              onClick={() => {
                const x = Math.round((window.innerWidth - 400) / 2)
                const y = Math.round(window.innerHeight / 2 - 210)
                setPosX(x); setPosY(y); setWidth(400)
                setBgOpacity(90); setBlur(24); setBorderRadius(20)
                setBorderOpacity(20); setPadding(28)
              }}
              style={{
                marginTop: 10, width: '100%', padding: '4px 0',
                background: 'rgba(26,78,168,0.25)', border: '1px solid rgba(77,156,255,0.20)',
                borderRadius: 7, color: '#93c5fd', cursor: 'pointer', fontSize: '0.7rem',
              }}
            >
              Reset to defaults
            </button>
          </>
        )}
      </div>

    </div>
  )
}
