// ─── RouteBadge ───────────────────────────────────────────────────────────────
// Shows the active routing mode inline in the toolbar.
// Hidden when the input is empty so it never clutters an idle state.
//
// Clicking cycles:  auto → chat → plan → build → creative → long → auto
// The × resets to auto without cycling through all modes.

const CYCLE = [null, 'chat', 'plan', 'build', 'creative', 'long']

const ICONS  = { chat: '💬', plan: '🔍', build: '🔨', creative: '🎨', long: '⇥' }
const LABELS = { chat: 'Chat', plan: 'Plan', build: 'Build', creative: 'Creative', long: 'Multi-step' }

const TITLES = {
  chat:     'Chat — question or discussion, no code changes',
  plan:     'Plan — read and analyse only, no writes',
  build:    'Build — active code changes with full tool access',
  creative: 'Creative — aesthetic / design / style work',
  long:     'Multi-step — large scope, decomposed into phases first',
}

export default function RouteBadge({ routeOverride, setRouteOverride, classification, hasPrompt }) {
  if (!hasPrompt) return null

  const displayMode = routeOverride ?? classification?.mode ?? 'build'
  const isAuto      = routeOverride === null

  function cycle() {
    const idx  = CYCLE.indexOf(routeOverride)
    const next = CYCLE[(idx + 1) % CYCLE.length]
    setRouteOverride(next)
  }

  function reset(e) {
    e.stopPropagation()
    setRouteOverride(null)
  }

  return (
    <button
      className={`lk-route-badge${isAuto ? '' : ' lk-route-badge--override'}`}
      onClick={cycle}
      title={`${isAuto ? 'Auto-detected: ' : 'Override: '}${TITLES[displayMode] ?? displayMode}\nClick to cycle mode`}
    >
      <span className="lk-route-badge-prefix">{isAuto ? 'auto' : '⊙'}</span>
      <span className="lk-route-badge-sep">·</span>
      <span className="lk-route-badge-icon">{ICONS[displayMode]}</span>
      <span className="lk-route-badge-label">{LABELS[displayMode]}</span>
      {!isAuto && (
        <span className="lk-route-badge-reset" onClick={reset} title="Reset to auto">×</span>
      )}
    </button>
  )
}
