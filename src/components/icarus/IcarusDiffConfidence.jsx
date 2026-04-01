import { memo, useState } from 'react'
import { computeDiffRationale, confidenceClass, formatConfidence } from '../../services/rationale/rationaleService.js'
import { memoryGraphService } from '../../services/memoryGraphService.js'

// ─── IcarusDiffConfidence ──────────────────────────────────────────────────────
// Enhanced diff viewer: wraps the raw unified diff with per-hunk confidence
// scores and expandable "why this edit?" rationale panels.
//
// Props:
//   diffText      string         — unified diff produced by computeLineDiff()
//   patchEdits    object[]       — EDIT_START/EDIT_END blocks (may be empty)
//   verification  object|null    — { gates, failedGateIds } from 'verification' event
//   critique      object|null    — { passed, issues, summary } from 'critique' event
//   orchestration object|null    — { role, confidence, strategy, modelId } from 'orchestration' event
//   usedFallback  bool           — true if a fallback model was triggered

// ── Inline confidence badge ───────────────────────────────────────────────────
function ConfBadge({ conf }) {
  const cls = confidenceClass(conf)
  return (
    <span className={`lk-conf-badge lk-${cls}`} title={`Confidence: ${formatConfidence(conf)}`}>
      {formatConfidence(conf)}
    </span>
  )
}

// ── Confidence bar ────────────────────────────────────────────────────────────
function ConfBar({ conf, label }) {
  const cls = confidenceClass(conf)
  const pct = Math.round(conf * 100)
  return (
    <div className="lk-conf-bar-wrap" title={`${label}: ${formatConfidence(conf)}`}>
      <div className={`lk-conf-bar lk-${cls}`} style={{ width: `${pct}%` }} />
      <span className="lk-conf-bar-label">{label}: {formatConfidence(conf)}</span>
    </div>
  )
}

// ── Single hunk ───────────────────────────────────────────────────────────────
const DiffHunk = memo(function DiffHunk({ hunk, index }) {
  const [open, setOpen] = useState(false)
  const cls = confidenceClass(hunk.confidence)

  return (
    <div className={`lk-diff-hunk lk-diff-hunk--${cls}`}>
      {/* Hunk header with confidence */}
      <div className="lk-diff-hunk-hdr">
        <span className="lk-diff-hdr">{hunk.header}</span>
        <ConfBadge conf={hunk.confidence} />
        <button
          className="lk-rationale-toggle"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          title="Why this edit?"
        >
          {open ? '▲ hide' : '▼ why?'}
        </button>
      </div>

      {/* Hunk body */}
      {hunk.lines.map((line, i) => (
        <div key={i} className={
          line.startsWith('+') && !line.startsWith('+++') ? 'lk-diff-add' :
          line.startsWith('-') && !line.startsWith('---') ? 'lk-diff-del' :
          'lk-diff-ctx'
        }>{line}</div>
      ))}

      {/* Rationale panel */}
      {open && (
        <div className="lk-rationale-panel">
          <div className="lk-rationale-icon">◈</div>
          <div className="lk-rationale-text">{hunk.rationale || 'No rationale available.'}</div>
        </div>
      )}
    </div>
  )
})

// ── Patch edit block (EDIT_START/EDIT_END) with confidence ────────────────────
function PatchBlock({ edit, index, confidence }) {
  const cls = confidenceClass(confidence)
  return (
    <div className={`lk-patch-block lk-patch-block--conf-${cls}${edit.applied ? '' : ' lk-patch-block--failed'}`}>
      <div className="lk-patch-hdr">
        Edit {index + 1} — {edit.applied ? '✓ applied' : '✗ not found'}
        <ConfBadge conf={confidence} />
      </div>
      <pre className="lk-patch-pre lk-diff-del">{edit.old}</pre>
      <pre className="lk-patch-pre lk-diff-add">{edit.new}</pre>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
const IcarusDiffConfidence = memo(function IcarusDiffConfidence({
  diffText,
  patchEdits = [],
  verification = null,
  critique = null,
  orchestration = null,
  usedFallback = false,
}) {
  if (!diffText) {
    return (
      <div className="lk-output" style={{ display: 'block' }}>
        <div className="lk-code-scroll" style={{ height: '100%' }}>
          <div className="lk-placeholder">
            <div className="lk-placeholder-glyph">⊕</div>
            <p className="lk-placeholder-body">
              Generate code first — diffs appear automatically for all created and modified files.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Query memory graph for related nodes to enrich rationale
  const memoryHits = orchestration?.role
    ? memoryGraphService.querySemantic({
        query: `${orchestration.role} ${(diffText || '').slice(0, 120)}`,
        limit: 4,
        types: ['prior_fix', 'convention', 'orchestration_run'],
      })
    : []

  const { overallConfidence, hunks, summary } = computeDiffRationale({
    diffText,
    verification,
    critique,
    orchestration,
    memoryHits,
    usedFallback,
  })

  return (
    <div className="lk-output" style={{ display: 'block' }}>
      <div className="lk-code-scroll" style={{ height: '100%' }}>

        {/* ── Overall confidence header ─────────────────────────────────── */}
        <div className="lk-diff-confidence-hdr">
          <ConfBar conf={overallConfidence} label="Edit confidence" />
          {summary && <div className="lk-diff-confidence-summary">{summary}</div>}

          {/* Gate pills */}
          {verification?.gates?.length > 0 && (
            <div className="lk-gate-pills">
              {verification.gates.map(g => (
                <span key={g.id} className={`lk-gate-pill lk-gate-pill--${g.passed ? 'pass' : 'fail'}`}>
                  {g.passed ? '✓' : '✗'} {g.id}
                </span>
              ))}
            </div>
          )}

          {/* Critique summary */}
          {critique && (
            <div className={`lk-critique-summary lk-critique-summary--${critique.passed ? 'pass' : 'fail'}`}>
              <span className="lk-critique-icon">{critique.passed ? '✓' : '⚠'}</span>
              {critique.summary || (critique.passed ? 'Critique passed.' : 'Critique issues found.')}
            </div>
          )}
        </div>

        {/* ── Patch edit blocks ─────────────────────────────────────────── */}
        {patchEdits.length > 0 && (
          <div className="lk-patch-summary">
            {patchEdits.map((e, i) => (
              <PatchBlock key={i} edit={e} index={i} confidence={overallConfidence} />
            ))}
          </div>
        )}

        {/* ── Hunk-level diff with confidence ──────────────────────────── */}
        {!patchEdits.length && (
          <pre className="lk-pre lk-pre--diff">
            {/* File header lines (--- / +++ / diff --git) */}
            {diffText.split('\n').filter(l =>
              l.startsWith('---') || l.startsWith('+++') || l.startsWith('diff ')
            ).map((line, i) => (
              <div key={`hdr-${i}`} className="lk-diff-hdr">{line}</div>
            ))}

            {/* Hunks with confidence */}
            {hunks.map((hunk, i) => (
              <DiffHunk key={i} hunk={hunk} index={i} />
            ))}
          </pre>
        )}
      </div>
    </div>
  )
})

export default IcarusDiffConfidence
