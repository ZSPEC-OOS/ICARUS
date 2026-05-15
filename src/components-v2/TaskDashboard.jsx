import { useState, useEffect } from 'react'
import EngineToggle from './EngineToggle.jsx'
import ModelSetup from './ModelSetup.jsx'
import DeliverableList from './DeliverableList.jsx'
import BudgetBar from './BudgetBar.jsx'
import QualitySignals from './QualitySignals.jsx'
import './styles.css'

const RUNNING_PHASES = new Set([
  'planning', 'plan_review', 'cycle_prep', 'cycle_exec',
  'cycle_validate', 'completion_check', 'completion_confirm',
])

const TERMINAL_PHASES = new Set(['done', 'failed', 'halted'])

const PHASE_STEPS = [
  { key: 'plan',     label: 'Planning',   phases: new Set(['planning', 'plan_review']) },
  { key: 'exec',     label: 'Executing',  phases: new Set(['cycle_prep', 'cycle_exec', 'cycle_validate']) },
  { key: 'complete', label: 'Completing', phases: new Set(['completion_check', 'completion_confirm']) },
  { key: 'done',     label: 'Done',       phases: new Set(['done', 'failed', 'halted']) },
]

const RESULT_META = {
  done:   { icon: '✓', title: 'Task Complete', titleClass: 'done' },
  failed: { icon: '✗', title: 'Task Failed',   titleClass: 'failed' },
  halted: { icon: '⏸', title: 'Task Halted',   titleClass: 'halted' },
}

function miniBarFill(pct) {
  if (pct > 85) return 'danger'
  if (pct > 65) return 'warn'
  return 'ok'
}

function PhaseStepper({ phase }) {
  const activeIdx = PHASE_STEPS.findIndex(s => s.phases.has(phase))
  const isTerminal = TERMINAL_PHASES.has(phase)
  const isFailed = phase === 'failed' || phase === 'halted'

  return (
    <div className="v2-phase-stepper">
      {PHASE_STEPS.map((step, i) => {
        let cls = 'v2-phase-step'
        if (isTerminal) {
          if (i < 3) cls += ' v2-phase-step--done'
          else cls += isFailed ? ' v2-phase-step--error' : ' v2-phase-step--done'
        } else if (activeIdx === i) {
          cls += ' v2-phase-step--active'
        } else if (i < activeIdx) {
          cls += ' v2-phase-step--done'
        }
        return (
          <span key={step.key} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            {i > 0 && <span className="v2-phase-sep">›</span>}
            <span className={cls}>{step.label}</span>
          </span>
        )
      })}
    </div>
  )
}

function FeedEntry({ event }) {
  const type = event.type || 'info'
  let icon = '·'
  if (type === 'phase') icon = '◆'
  else if (type === 'tool') icon = '⚙'
  else if (type === 'error') icon = '✗'

  return (
    <div className={`v2-feed-entry v2-feed-entry--${type}`}>
      <span className="v2-feed-entry-icon">{icon}</span>
      <div className="v2-feed-entry-body">
        {type === 'phase' && (
          <span className="v2-feed-phase-text">{event.data?.phase || event.message || ''}</span>
        )}
        {type === 'tool' && (
          <>
            <span className="v2-feed-tool-name">{event.data?.tool || event.message || 'tool'}</span>
            {event.data?.path && <div className="v2-feed-tool-path">{event.data.path}</div>}
          </>
        )}
        {type !== 'phase' && type !== 'tool' && (
          <span style={{ color: type === 'error' ? 'var(--lk-danger)' : 'var(--lk-text-muted)' }}>
            {event.message || (event.data ? JSON.stringify(event.data) : '')}
          </span>
        )}
      </div>
    </div>
  )
}

function loadRepoConfig() {
  try {
    const s = JSON.parse(localStorage.getItem('bluswan:settings') || '{}')
    return {
      token: sessionStorage.getItem('bluswan:ghtoken') || '',
      owner: s.repoOwner || '',
      name: s.repoName || '',
      branch: s.baseBranch || 'main',
    }
  } catch {
    return { token: '', owner: '', name: '', branch: 'main' }
  }
}

function saveRepoConfig({ token, owner, name, branch }) {
  try {
    sessionStorage.setItem('bluswan:ghtoken', token)
    const settings = JSON.parse(localStorage.getItem('bluswan:settings') || '{}')
    localStorage.setItem('bluswan:settings', JSON.stringify({
      ...settings, repoOwner: owner, repoName: name, baseBranch: branch,
    }))
  } catch {}
}

function RepoSection() {
  const [cfg, setCfg] = useState(loadRepoConfig)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(cfg)

  const isConnected = Boolean(cfg.token && cfg.owner && cfg.name)

  function handleSave(e) {
    e.preventDefault()
    saveRepoConfig(form)
    setCfg(form)
    setEditing(false)
  }

  if (editing) {
    return (
      <form className="v2-repo-form" onSubmit={handleSave}>
        <div className="v2-repo-form-row">
          <label className="v2-sidebar-section-label">GitHub Token</label>
          <input
            className="v2-repo-input"
            type="password"
            placeholder="ghp_..."
            value={form.token}
            onChange={e => setForm(f => ({ ...f, token: e.target.value }))}
            autoComplete="new-password"
          />
        </div>
        <div className="v2-repo-form-row">
          <label className="v2-sidebar-section-label">Owner / Repo</label>
          <div style={{ display: 'flex', gap: '0.3rem' }}>
            <input
              className="v2-repo-input"
              placeholder="owner"
              value={form.owner}
              onChange={e => setForm(f => ({ ...f, owner: e.target.value }))}
            />
            <input
              className="v2-repo-input"
              placeholder="repo"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </div>
        </div>
        <div className="v2-repo-form-row">
          <label className="v2-sidebar-section-label">Branch</label>
          <input
            className="v2-repo-input"
            placeholder="main"
            value={form.branch}
            onChange={e => setForm(f => ({ ...f, branch: e.target.value }))}
          />
        </div>
        <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.45rem' }}>
          <button type="submit" className="btn-primary" style={{ flex: 1, fontSize: '0.72rem', padding: '0.3rem 0.6rem' }}>
            Save
          </button>
          <button type="button" className="btn-ghost" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="v2-repo-summary">
      {isConnected ? (
        <>
          <span className="v2-repo-connected">● {cfg.owner}/{cfg.name}</span>
          <span className="v2-repo-branch">{cfg.branch}</span>
        </>
      ) : (
        <span className="v2-repo-empty">Not connected</span>
      )}
      <button type="button" className="v2-repo-edit-btn" onClick={() => { setForm(cfg); setEditing(true) }}>
        {isConnected ? 'Edit' : 'Connect →'}
      </button>
    </div>
  )
}

export default function TaskDashboard({
  v2State = {},
  onStartTask,
  models = [],
  selectedModelId = '',
  onModelChange,
  onModelsUpdate,
}) {
  const [goal, setGoal] = useState('')
  const [maxCycles, setMaxCycles] = useState(3)
  const [maxTurnsPerCycle, setMaxTurnsPerCycle] = useState(25)
  const [showModelSetup, setShowModelSetup] = useState(false)

  const {
    phase = 'idle',
    plan = null,
    cycles = [],
    budget = null,
    gates = [],
    securityScan = null,
    taskSpec = null,
    error = null,
    events = [],
    haltReason = null,
  } = v2State

  const deliverables = plan?.deliverables || []
  const completedCount = deliverables.filter(d => d.completed).length
  const isRunning = RUNNING_PHASES.has(phase)
  const isTerminal = TERMINAL_PHASES.has(phase)

  const selectedModel = models.find(m => m.id === selectedModelId) || models[0]
  const hasModel = Boolean(selectedModel?.apiKey)

  const tokenPct = budget?.tokens ? Math.round(budget.tokens.used / budget.tokens.total * 100) : 0
  const cyclePct = budget?.cycles ? Math.round(budget.cycles.used / budget.cycles.total * 100) : 0

  function handleStart(e) {
    e.preventDefault()
    if (!goal.trim() || !hasModel) return
    const taskId = 'task-' + Date.now().toString(36)
    onStartTask?.({
      taskId,
      goal: goal.trim(),
      plan: {
        version: '2026.1',
        taskId,
        goal: goal.trim(),
        deliverables: [],
        dependencies: [],
        validationSteps: [],
        estimatedCycles: maxCycles,
        contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
      },
      options: {
        maxCycles,
        maxTurnsPerCycle,
        contextWindow: 128000,
        requirePlanReview: false,
        requireCompletionConfirm: false,
      },
    })
  }

  const resultMeta = RESULT_META[phase] || RESULT_META.failed
  const hasTopbarBudget = Boolean(budget?.tokens || budget?.cycles)

  return (
    <div className="lk-root v2-root">

      {/* ── Mobile top bar (phones only, ≤640px) ─────────────────── */}
      <div className="v2-mobile-bar">
        <span className="v2-mobile-bar-brand">BLUSWAN</span>
        <select
          className="v2-mobile-bar-select"
          value={selectedModelId}
          onChange={e => onModelChange?.(e.target.value)}
          disabled={isRunning}
        >
          {models.length === 0 && <option value="">No model</option>}
          {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button
          type="button"
          className="v2-mobile-bar-btn"
          onClick={() => setShowModelSetup(true)}
          aria-label="API Keys"
        >
          🔑
        </button>
        <EngineToggle position="header" />
      </div>

      {/* ── Body row: sidebar + main + right panel ───────────────── */}
      <div className="v2-body-row">

      {/* ── Sidebar (desktop only, >640px) ───────────────────────── */}
      <aside className="v2-sidebar">
        <div className="v2-sidebar-brand">
          <span className="v2-sidebar-brand-name">BLUSWAN</span>
          <span className="v2-sidebar-brand-tag">V2</span>
        </div>

        <div className="v2-sidebar-section">
          <div className="v2-sidebar-section-label">Model</div>
          <select
            className="v2-model-select"
            value={selectedModelId}
            onChange={e => onModelChange?.(e.target.value)}
            disabled={isRunning}
          >
            {models.length === 0 && <option value="">No models configured</option>}
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <div className="v2-model-hint">
            {hasModel
              ? selectedModel?.modelId || ''
              : <button type="button" onClick={() => setShowModelSetup(true)}>Add API key →</button>
            }
          </div>
        </div>

        <div className="v2-sidebar-section">
          <button type="button" className="v2-sidebar-btn" onClick={() => setShowModelSetup(true)}>
            <span className="v2-sidebar-btn-icon">🔑</span>
            <span>API Keys</span>
          </button>
        </div>

        <div className="v2-sidebar-section">
          <div className="v2-sidebar-section-label">Repository</div>
          <RepoSection />
        </div>

        <div className="v2-sidebar-footer">
          <EngineToggle position="sidebar" />
        </div>
      </aside>

      {/* ── Main ─────────────────────────────────────────────────── */}
      <div className="v2-main">

        {/* Topbar */}
        <div className="v2-topbar">
          <PhaseStepper phase={phase} />
          {hasTopbarBudget && (
            <div className="v2-topbar-right">
              {budget?.tokens && (
                <div className="v2-topbar-budget-item">
                  <span>Ctx</span>
                  <div className="v2-topbar-mini-bar">
                    <div
                      className={`v2-topbar-mini-fill v2-topbar-mini-fill--${miniBarFill(tokenPct)}`}
                      style={{ width: `${Math.min(tokenPct, 100)}%` }}
                    />
                  </div>
                  <span>{tokenPct}%</span>
                </div>
              )}
              {budget?.cycles && (
                <div className="v2-topbar-budget-item">
                  <span>Cyc</span>
                  <div className="v2-topbar-mini-bar">
                    <div
                      className={`v2-topbar-mini-fill v2-topbar-mini-fill--${miniBarFill(cyclePct)}`}
                      style={{ width: `${Math.min(cyclePct, 100)}%` }}
                    />
                  </div>
                  <span>{cyclePct}%</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="v2-content">

          {/* Idle: Composer */}
          {phase === 'idle' && (
            <div className="v2-composer">
              <div className="v2-composer-inner">
                <h1 className="v2-composer-heading">What do you want to build?</h1>
                <p className="v2-composer-sub">
                  Describe your task. BLUSWAN V2 will plan, execute, and validate it.
                </p>

                {!hasModel && (
                  <div className="v2-composer-no-model">
                    <span>No model with API key configured.</span>
                    <button type="button" className="btn-secondary" onClick={() => setShowModelSetup(true)}>
                      Configure →
                    </button>
                  </div>
                )}

                <form onSubmit={handleStart}>
                  <textarea
                    className="v2-composer-textarea"
                    placeholder="e.g. Add a dark mode toggle to the settings page, update the CSS, and write a unit test."
                    value={goal}
                    onChange={e => setGoal(e.target.value)}
                    rows={5}
                  />

                  <div className="v2-composer-options">
                    <div className="v2-composer-opt">
                      <span className="v2-composer-opt-label">Max Cycles</span>
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={maxCycles}
                        onChange={e => setMaxCycles(Number(e.target.value))}
                      />
                    </div>
                    <div className="v2-composer-opt">
                      <span className="v2-composer-opt-label">Turns / Cycle</span>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={maxTurnsPerCycle}
                        onChange={e => setMaxTurnsPerCycle(Number(e.target.value))}
                      />
                    </div>
                  </div>

                  <div className="v2-composer-footer">
                    <button
                      type="submit"
                      className="v2-composer-submit"
                      disabled={!goal.trim() || !hasModel}
                    >
                      Start Task
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Running: Live exec feed */}
          {isRunning && (
            <div className="v2-exec-feed">
              {events.length === 0 ? (
                <div className="v2-feed-waiting">
                  <span className="v2-feed-spinner" />
                  {phase === 'planning' ? 'Generating plan…' : `${phase.replace(/_/g, ' ')}…`}
                </div>
              ) : (
                events.map((ev, i) => <FeedEntry key={i} event={ev} />)
              )}
              {events.length > 0 && (
                <div className="v2-feed-waiting">
                  <span className="v2-feed-spinner" />
                  <span>{phase.replace(/_/g, ' ')}…</span>
                </div>
              )}
            </div>
          )}

          {/* Terminal: Result view */}
          {isTerminal && (
            <div className="v2-result">
              <div className="v2-result-card">
                <div className="v2-result-header">
                  <span className="v2-result-icon">{resultMeta.icon}</span>
                  <h2 className={`v2-result-title v2-result-title--${resultMeta.titleClass}`}>
                    {resultMeta.title}
                  </h2>
                  <span className={`phase-badge phase-badge--${phase}`}>{phase}</span>
                </div>

                {(taskSpec?.goal || goal) && (
                  <div className="v2-result-goal">{taskSpec?.goal || goal}</div>
                )}

                <div className="v2-result-meta">
                  <div className="v2-result-meta-item">
                    <span className="v2-result-meta-label">Cycles</span>
                    <span className="v2-result-meta-value">{cycles.length}</span>
                  </div>
                  <div className="v2-result-meta-item">
                    <span className="v2-result-meta-label">Deliverables</span>
                    <span className="v2-result-meta-value">{completedCount}/{deliverables.length}</span>
                  </div>
                  {budget?.tokens && (
                    <div className="v2-result-meta-item">
                      <span className="v2-result-meta-label">Tokens</span>
                      <span className="v2-result-meta-value">{(budget.tokens.used / 1000).toFixed(1)}k</span>
                    </div>
                  )}
                </div>

                {haltReason && (
                  <div className="v2-result-halt-reason">{haltReason}</div>
                )}

                {error && (
                  <div className="v2-result-halt-reason" style={{
                    color: 'var(--lk-danger)',
                    borderLeftColor: 'var(--lk-danger)',
                    background: 'var(--lk-danger-bg)',
                  }}>
                    {String(error)}
                  </div>
                )}

                <div className="v2-result-actions">
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => { setGoal(''); onStartTask?.(null) }}
                  >
                    New Task
                  </button>
                  {phase !== 'done' && taskSpec && (
                    <button type="button" className="btn-secondary" onClick={() => onStartTask?.(taskSpec)}>
                      Retry
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ── Right Panel ───────────────────────────────────────────── */}
      <aside className="v2-right-panel">
        <div className="v2-panel-section">
          <div className="v2-panel-section-title">
            <span>Deliverables</span>
            {deliverables.length > 0 && (
              <span className="status-badge status-badge--completed">{completedCount}/{deliverables.length}</span>
            )}
          </div>
          {deliverables.length === 0
            ? <div className="v2-panel-empty">No deliverables yet</div>
            : <DeliverableList deliverables={deliverables} />
          }
        </div>

        {(budget?.tokens || budget?.cycles) && (
          <div className="v2-panel-section">
            <div className="v2-panel-section-title"><span>Budget</span></div>
            {budget?.tokens && (
              <BudgetBar
                used={budget.tokens.used}
                total={budget.tokens.total}
                label="Tokens"
                type="tokens"
              />
            )}
            {budget?.cycles && (
              <BudgetBar
                used={budget.cycles.used}
                total={budget.cycles.total}
                label="Cycles"
                type="cycles"
              />
            )}
          </div>
        )}

        {gates.length > 0 && (
          <div className="v2-panel-section">
            <div className="v2-panel-section-title"><span>Quality Signals</span></div>
            <QualitySignals gates={gates} securityScan={securityScan} />
          </div>
        )}
      </aside>

      </div>{/* end .v2-body-row */}

      {/* ── ModelSetup Modal ──────────────────────────────────────── */}
      {showModelSetup && (
        <ModelSetup
          models={models}
          onSave={updated => onModelsUpdate?.(updated)}
          onClose={() => setShowModelSetup(false)}
        />
      )}
    </div>
  )
}
