import { memo } from 'react'
import { highlightCode } from '../../utils/codeUtils.js'

// ─── Language display names ───────────────────────────────────────────────────
const LANG_LABEL = {
  javascript:  'JS',
  typescript:  'TS',
  python:      'PY',
  rust:        'RS',
  go:          'GO',
  java:        'JAVA',
  css:         'CSS',
  html:        'HTML',
  json:        'JSON',
  markdown:    'MD',
  bash:        'SH',
  yaml:        'YAML',
}

// Derive a short display name from a file path
function fileBasename(path = '') {
  return path.split('/').pop() || path
}
function fileDirname(path = '') {
  const parts = path.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') : ''
}

// ─── File context bar ─────────────────────────────────────────────────────────
function FileContextBar({ filePath, language }) {
  if (!filePath) return null
  const dir  = fileDirname(filePath)
  const name = fileBasename(filePath)
  const lang = LANG_LABEL[language] || (language ? language.toUpperCase().slice(0, 4) : null)

  return (
    <div className="lk-file-ctx-bar">
      <span className="lk-file-ctx-icon">◈</span>
      {dir && <span className="lk-file-ctx-dir">{dir}/</span>}
      <span className="lk-file-ctx-name">{name}</span>
      {lang && <span className="lk-file-ctx-lang">{lang}</span>}
    </div>
  )
}

// ─── Live plan list ───────────────────────────────────────────────────────────
function LivePlan({ steps }) {
  if (!steps?.length) return null
  return (
    <div className="lk-live-plan">
      <div className="lk-live-plan-hd">
        <span className="lk-live-plan-icon">◈</span>
        Plan
      </div>
      <ol className="lk-live-plan-list">
        {steps.map((step, idx) => (
          <li key={`${step}-${idx}`} className="lk-live-plan-step">
            <span className="lk-live-plan-num">{String(idx + 1).padStart(2, '0')}</span>
            <span className="lk-live-plan-text">{step}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ─── Validation panel ─────────────────────────────────────────────────────────
function ValidationPanel({ results }) {
  if (!results?.length) return null
  return (
    <div className="lk-validation-panel">
      <div className="lk-validation-title">Validation</div>
      {results.map((result, idx) => (
        <div key={`${result}-${idx}`} className="lk-validation-row">{result}</div>
      ))}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
const LogikCodePane = memo(function LogikCodePane({
  generatedCode,
  isGenerating,
  language,
  filePath,
  refinementPrompt,
  onRefinementChange,
  onRefine,
  onReset,
  turnCount,
  validationResults,
  livePlan = [],
  // These are received but drive no rendering in this component
  hasGithub: _hasGithub,
  pipelinePhase: _pipelinePhase,
  pipelineSteps: _pipelineSteps,
}) {
  return (
    <div className="lk-output" style={{ display: 'flex', flexDirection: 'column' }}>

      {/* ── File context bar ─────────────────────────────────────────── */}
      <FileContextBar filePath={filePath} language={language} />

      {/* ── Live plan ────────────────────────────────────────────────── */}
      <LivePlan steps={livePlan} />

      {/* ── Code scroll area ─────────────────────────────────────────── */}
      <div className="lk-code-scroll" style={{ flex: 1 }}>
        {isGenerating && !generatedCode && (
          <div className="lk-generating">
            <span className="lk-spinner" />
            <span className="lk-generating-label">Generating…</span>
          </div>
        )}
        {generatedCode && (
          <pre className="lk-pre">
            <code dangerouslySetInnerHTML={{ __html: highlightCode(generatedCode, language) }} />
          </pre>
        )}
        <ValidationPanel results={validationResults} />
      </div>

      {/* ── Refinement bar ───────────────────────────────────────────── */}
      {generatedCode && !isGenerating && (
        <div className="lk-refine-bar">
          {turnCount > 0 && (
            <span className="lk-turn-info">{turnCount} {turnCount === 1 ? 'turn' : 'turns'}</span>
          )}
          <input
            className="lk-input lk-refine-input"
            placeholder="Refine: 'make it async', 'add error handling', 'add JSDoc'…"
            value={refinementPrompt}
            onChange={e => onRefinementChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onRefine() } }}
          />
          <button className="lk-btn lk-btn--refine" onClick={onRefine} disabled={!refinementPrompt.trim()}>
            ✦ Refine
          </button>
          <button className="lk-btn lk-btn--reset" onClick={onReset} title="Clear and start over">
            ↺
          </button>
        </div>
      )}
    </div>
  )
})

export default LogikCodePane
