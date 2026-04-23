// ─── BluswanTaskComplete ──────────────────────────────────────────────────────
// Post-task completion screen.  Matches the dark-navy mockup spec:
// sidebar + topbar shell, two-column diff/file evidence, terminal test results,
// and a summary strip.  Fully responsive down to iPhone 14 Pro (430 px).
//
// Usage:
//   <BluswanTaskComplete data={taskData} onClose={() => …} />
//
// All data is passed via `data` prop — see DEFAULT_DATA below for shape.

import './BluswanTaskComplete.css'

// ── Syntax-highlight a single code line (very lightweight, no dep) ───────────
function hlCode(text) {
  if (!text) return null
  // Order matters — keywords before identifiers
  const segments = []
  let remaining = text

  const push = (cls, val) => segments.push({ cls, val })

  // Simple tokeniser: walk left-to-right, greedily match patterns
  const patterns = [
    [/^(\/\/.*)/, 'btc-cmt'],
    [/^(import|export|default|from|function|const|let|var|return|class|new|if|else|for|while|async|await|typeof|null|undefined|true|false)\b/, 'btc-kw'],
    [/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/, 'btc-str'],
    [/^(\d+(\.\d+)?)/, 'btc-num'],
    [/^([A-Z][A-Za-z0-9]*)/, 'btc-fn'],   // PascalCase = component/class
    [/^([a-z_$][a-zA-Z0-9_$]*(?=\s*\())/, 'btc-fn'],  // func call
    [/^([{}[\]().,;:=<>/\\])/, 'btc-pun'],
  ]

  while (remaining.length > 0) {
    let matched = false
    for (const [re, cls] of patterns) {
      const m = remaining.match(re)
      if (m) {
        push(cls, m[1] !== undefined ? m[1] : m[0])
        remaining = remaining.slice(m[0].length)
        matched = true
        break
      }
    }
    if (!matched) {
      push('', remaining[0])
      remaining = remaining.slice(1)
    }
  }

  return segments.map((s, i) =>
    s.cls ? <span key={i} className={s.cls}>{s.val}</span> : s.val
  )
}

// ── Default demo data — replace with real task data from parent ───────────────
export const DEFAULT_DATA = {
  taskTitle: 'Updates to BLUSWAN',
  status: 'success',
  successMessage: 'All steps finished successfully!',
  user: { name: 'J. Harper', avatarUrl: null, initials: 'JH' },
  sectionContext: 'Dashboard',
  navItems: [
    { icon: '⊙', label: 'Dashboard', active: true },
    { icon: '◎', label: 'API Status', active: false },
    { icon: '≡', label: 'Logs',       active: false },
    { icon: '⚙', label: 'Settings',   active: false },
  ],
  changedFile: {
    meta: '## @@ -11,6 +11,10 @@',
    lines: [
      { type: 'ctx',    num: 1,  code: "import Chart from 'recharts';" },
      { type: 'add',    num: 2,  code: "import StatsCard from '../components/StatsCard.js';" },
      { type: 'remove', num: 1,  code: '···' },
      { type: 'ctx',    num: 1,  code: "<div className='stats'>" },
      { type: 'ctx',    num: 1,  code: '  <div>' },
      { type: 'add',    num: '', code: "    <StatsCard title='Users'   value={userCount} />" },
      { type: 'add',    num: '', code: "    <StatsCard title='Sales'   value={salesCount} />" },
      { type: 'add',    num: '', code: "    <StatsCard title='Revenue' value={revenueCount} />" },
      { type: 'ctx',    num: 1,  code: '  </div>' },
    ],
  },
  createdFile: {
    name: 'StatsCard.js',
    lines: [
      "import React from 'react';",
      '',
      'function StatsCard({ title, value }) {',
      '  return (',
      '    <div className="card">',
      '      <h3>{title}</h3>',
      '      <p>{value}</p>',
      '    </div>',
      '  );',
      '}',
      '',
      'export default StatsCard;',
    ],
  },
  tests: {
    command: 'npm test',
    lines: [
      { type: 'cmd',     text: '$ npm test' },
      { type: 'running', text: '> Running tests...' },
      { type: 'pass',    text: 'HomePage renders correctly' },
      { type: 'pass',    text: 'StatsCard component tests' },
    ],
  },
  summary: {
    parts: [
      { text: 'Updated ' },
      { text: 'Home page', highlight: true },
      { text: ' with new Stats cards. All tests passed successfully.' },
    ],
  },
}

// ── Tiny presentational helpers ───────────────────────────────────────────────

function SectionHeader({ icon, title }) {
  return (
    <div className="btc-section-header">
      <span className="btc-section-icon">{icon}</span>
      <span className="btc-section-title">{title}</span>
    </div>
  )
}

function Divider({ mb = 22 }) {
  return <div style={{ height: 1, background: 'rgba(40,80,160,0.16)', marginBottom: mb }} />
}

function StatusChip({ status }) {
  const map = {
    success: ['✓', 'success', 'Passed'],
    warning: ['⚠', 'warning', 'Warning'],
    failed:  ['✗', 'failed',  'Failed'],
  }
  const [icon, cls, label] = map[status] || map.success
  return (
    <span className={`btc-status-chip btc-status-chip--${cls}`}>
      {icon} {label}
    </span>
  )
}

// ── Diff panel ────────────────────────────────────────────────────────────────
function DiffPanel({ file }) {
  return (
    <div className="btc-panel">
      <div className="btc-panel-header">
        <span className="btc-panel-icon">📋</span>
        <span className="btc-panel-title">Actions Performed</span>
      </div>
      <div className="btc-panel-body">
        <div className="btc-diff-wrap">
          <div className="btc-diff-meta">{file.meta}</div>
          {file.lines.map((line, i) => (
            <div key={i} className={`btc-diff-line btc-diff-line--${line.type}`}>
              <span className="btc-diff-gutter">{line.num || ''}</span>
              <span className="btc-diff-sigil">
                {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
              </span>
              <span className="btc-diff-code">{hlCode(line.code)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── New-file code panel ───────────────────────────────────────────────────────
function FilePanel({ file }) {
  return (
    <div className="btc-panel">
      <div className="btc-panel-header">
        <span className="btc-panel-icon">📁</span>
        <span className="btc-panel-title">
          New File: <span className="btc-panel-title-accent">{file.name}</span>
        </span>
      </div>
      <div className="btc-panel-body">
        <div className="btc-code-wrap">
          {file.lines.map((line, i) => (
            <div key={i} className="btc-code-line">
              <span className="btc-code-ln">{i + 1}</span>
              <span className="btc-code-text">{hlCode(line)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Terminal test results ─────────────────────────────────────────────────────
function TerminalPanel({ tests }) {
  const iconMap = {
    cmd:     { cls: 'btc-terminal-mark--cmd',  icon: '$' },
    running: { cls: 'btc-terminal-mark--spin', icon: '▶' },
    pass:    { cls: 'btc-terminal-mark--pass', icon: '✓' },
    fail:    { cls: 'btc-terminal-mark--fail', icon: '✗' },
    log:     { cls: 'btc-terminal-mark--cmd',  icon: ' ' },
  }
  return (
    <div className="btc-terminal">
      <div className="btc-terminal-titlebar">
        <div className="btc-terminal-dot" />
        <div className="btc-terminal-dot" />
        <div className="btc-terminal-dot" />
        <span className="btc-terminal-label">test runner</span>
      </div>
      <div className="btc-terminal-body">
        {tests.lines.map((line, i) => {
          const { cls, icon } = iconMap[line.type] || iconMap.log
          return (
            <div key={i} className={`btc-terminal-line btc-terminal-line--${line.type}`}>
              <span className={`btc-terminal-mark ${cls}`}>{icon}</span>
              <span>{line.text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Summary strip ─────────────────────────────────────────────────────────────
function SummaryPanel({ summary }) {
  return (
    <div className="btc-summary">
      <div className="btc-summary-header">
        <span className="btc-summary-icon">💡</span>
        <span className="btc-summary-title">Summary:</span>
      </div>
      <div className="btc-summary-body">
        {summary.parts.map((part, i) =>
          part.highlight
            ? <span key={i} className="btc-summary-hl">{part.text}</span>
            : <span key={i}>{part.text}</span>
        )}
      </div>
    </div>
  )
}

// ── Avatar ────────────────────────────────────────────────────────────────────
function Avatar({ user, className = 'btc-avatar' }) {
  return (
    <div className={className}>
      {user.avatarUrl
        ? <img src={user.avatarUrl} alt={user.name} />
        : user.initials || (user.name || '?').charAt(0).toUpperCase()
      }
    </div>
  )
}

// ── Root component ────────────────────────────────────────────────────────────
export default function BluswanTaskComplete({ data = DEFAULT_DATA, onClose }) {
  const d = { ...DEFAULT_DATA, ...data }

  return (
    <div className="btc-backdrop" role="main" aria-label="Task complete">
      <div className="btc-shell">

        {/* ── Left sidebar (desktop) ──────────────────────────────────── */}
        <aside className="btc-sidebar" aria-label="Navigation">
          <div className="btc-brand">
            <img src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN logo" className="btc-brand-logo" />
            <span className="btc-brand-wordmark">BLUSWAN</span>
          </div>
          <nav className="btc-nav">
            {d.navItems.map(item => (
              <button
                key={item.label}
                className={`btc-nav-item${item.active ? ' btc-nav-item--active' : ''}`}
                aria-current={item.active ? 'page' : undefined}
              >
                <span className="btc-nav-icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* ── Main column ──────────────────────────────────────────────── */}
        <div className="btc-main">

          {/* Mobile sticky topbar — hidden ≥ 430px */}
          <div className="btc-mobile-topbar" aria-hidden="true">
            <div className="btc-mobile-brand">
              <img src="/BLUSWAN-logo-transparent.png" alt="" className="btc-mobile-brand-logo" />
              <span className="btc-mobile-brand-name">BLUSWAN</span>
            </div>
            <div className="btc-mobile-user">
              <span style={{ fontSize: 12, color: '#6a96c8' }}>{d.user.name}</span>
              <Avatar user={d.user} className="btc-mobile-avatar" />
            </div>
          </div>

          {/* Desktop top bar — hidden on iPhone */}
          <header className="btc-topbar">
            <div className="btc-topbar-left">
              <div className="btc-topbar-icon">✓</div>
              <span>{d.sectionContext}</span>
            </div>
            <div className="btc-topbar-right">
              <span className="btc-user-name">{d.user.name}</span>
              <span className="btc-user-chevron">▾</span>
              <Avatar user={d.user} />
            </div>
          </header>

          {/* ── Content ──────────────────────────────────────────────── */}
          <main className="btc-content">

            {/* Title */}
            <div className="btc-title-row">
              <h1 className="btc-title">
                <span className="btc-title-label">Task Complete: </span>
                <span className="btc-title-name">{d.taskTitle}</span>
                <StatusChip status={d.status} />
              </h1>
            </div>

            {/* Success banner */}
            <div className="btc-success-row">
              <div className="btc-success-icon">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <span className="btc-success-text">{d.successMessage}</span>
            </div>

            <Divider mb={18} />

            {/* Evidence grid */}
            <div className="btc-evidence-grid">
              {d.changedFile && <DiffPanel file={d.changedFile} />}
              {d.createdFile && <FilePanel file={d.createdFile} />}
            </div>

            {/* Test results */}
            {d.tests && (
              <div className="btc-tests-section">
                <SectionHeader icon="🗂" title="Test Results:" />
                <TerminalPanel tests={d.tests} />
              </div>
            )}

            <Divider mb={18} />

            {/* Summary */}
            {d.summary && <SummaryPanel summary={d.summary} />}

          </main>
        </div>
      </div>
    </div>
  )
}
