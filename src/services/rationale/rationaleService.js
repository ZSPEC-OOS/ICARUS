// ─── Rationale Service ────────────────────────────────────────────────────────
// Computes per-hunk confidence scores and "why this edit" rationale text by
// combining orchestration routing decisions, reliability gate results, critique
// outcomes, and memory graph hits.
//
// The output is purely presentational — it annotates diff hunks already
// produced by computeLineDiff() and never modifies source files.

// ── Constants ─────────────────────────────────────────────────────────────────
const CONF_GATE_PENALTY   = 0.12  // deducted per failed reliability gate
const CONF_CRITIQUE_HIT   = 0.18  // deducted when critique finds issues
const CONF_FALLBACK_HIT   = 0.10  // deducted when a fallback model was used
const CONF_LOW_ORCH       = 0.20  // penalty when orchestration confidence < 0.5

const ROLE_LABELS = {
  planner:       'Planner',
  debugger:      'Debugger',
  refactorer:    'Refactorer',
  'test-writer': 'Test Writer',
  reviewer:      'Reviewer',
}

// ── Diff hunk parser ──────────────────────────────────────────────────────────

/**
 * Split a unified diff string into logical hunks.
 * @param {string} diffText
 * @returns {Array<{ header: string, lines: string[], addCount: number, delCount: number }>}
 */
export function parseDiffHunks(diffText = '') {
  const lines = String(diffText).split('\n')
  const hunks = []
  let current = null

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current)
      current = { header: line, lines: [], addCount: 0, delCount: 0 }
    } else if (current) {
      current.lines.push(line)
      if (line.startsWith('+') && !line.startsWith('+++')) current.addCount++
      if (line.startsWith('-') && !line.startsWith('---')) current.delCount++
    }
  }
  if (current) hunks.push(current)
  return hunks
}

// ── Confidence scoring ────────────────────────────────────────────────────────

/**
 * Derive an overall confidence score for a generated diff/result.
 *
 * @param {{
 *   verification?:  { gates?: Array<{id:string,passed:boolean}>, failedGateIds?: string[] },
 *   critique?:      { passed: boolean, issues?: string[] },
 *   orchestration?: { confidence?: number, strategy?: string },
 *   usedFallback?:  boolean,
 * }} inputs
 * @returns {number}  0.0 – 1.0
 */
export function computeOverallConfidence({ verification, critique, orchestration, usedFallback = false } = {}) {
  let score = orchestration?.confidence ?? 0.80

  // Failed reliability gates
  const failedGates = (verification?.gates || []).filter(g => !g.passed)
  score -= failedGates.length * CONF_GATE_PENALTY

  // Critique issues
  if (critique && !critique.passed) {
    score -= CONF_CRITIQUE_HIT
    const extras = (critique.issues?.length ?? 0) - 1
    if (extras > 0) score -= Math.min(extras * 0.05, 0.15)
  }

  // Fallback model used
  if (usedFallback) score -= CONF_FALLBACK_HIT

  // Very low orchestration confidence
  if ((orchestration?.confidence ?? 1) < 0.5) score -= CONF_LOW_ORCH

  return Math.max(0.05, Math.min(1.0, score))
}

/**
 * Score an individual diff hunk relative to the overall confidence.
 * Hunks with large deletions or mixed add/del churn score slightly lower.
 *
 * @param {{ addCount: number, delCount: number }} hunk
 * @param {number} baseConf  0.0 – 1.0
 * @param {{ issues?: string[] }} [critique]
 * @returns {number}  0.0 – 1.0
 */
function scoreHunk(hunk, baseConf, critique) {
  let s = baseConf
  // Large-churn hunks (many deletions) are slightly less certain
  const churn = hunk.delCount + hunk.addCount
  if (churn > 20) s -= 0.05
  if (churn > 50) s -= 0.05
  // Hunk is pure addition (no deletions) → slightly more confident
  if (hunk.delCount === 0 && hunk.addCount > 0) s += 0.04
  // Critique tagged this file as an issue area
  if (critique?.issues?.length) s -= 0.03

  return Math.max(0.05, Math.min(1.0, s))
}

// ── Rationale text builder ────────────────────────────────────────────────────

/**
 * Build a short human-readable rationale string for a hunk.
 *
 * @param {{ header: string, addCount: number, delCount: number }} hunk
 * @param {{ role?: string, confidence?: number, strategy?: string, modelId?: string }} [orchestration]
 * @param {Array<{ title: string, type: string, score: number }>} [memoryHits]
 * @param {{ passed: boolean, issues?: string[], summary?: string }} [critique]
 * @param {boolean} usedFallback
 * @returns {string}
 */
function buildHunkRationale(hunk, orchestration, memoryHits, critique, usedFallback) {
  const parts = []

  if (orchestration?.role) {
    const roleLabel = ROLE_LABELS[orchestration.role] || orchestration.role
    const conf = orchestration.confidence != null ? ` (${Math.round(orchestration.confidence * 100)}% confidence)` : ''
    parts.push(`Role: ${roleLabel}${conf}`)
  }
  if (orchestration?.strategy && orchestration.strategy !== 'disabled') {
    parts.push(`Strategy: ${orchestration.strategy}`)
  }
  if (usedFallback) {
    parts.push('⚠ Fallback model was used')
  }
  if (orchestration?.modelId) {
    parts.push(`Model: ${orchestration.modelId}`)
  }

  const topHits = (memoryHits || []).slice(0, 3)
  if (topHits.length) {
    const refs = topHits.map(h => {
      const label = h.path ? h.path.split('/').pop() : h.title
      return `${label} (${h.type})`
    })
    parts.push(`Related memory: ${refs.join(', ')}`)
  }

  if (critique && !critique.passed && critique.issues?.length) {
    parts.push(`Review notes: ${critique.issues.slice(0, 2).join('; ')}`)
  } else if (critique?.passed) {
    parts.push('Critique: passed')
  }

  if (hunk.delCount > 0 && hunk.addCount > 0) {
    parts.push(`Changed ${hunk.delCount} line${hunk.delCount !== 1 ? 's' : ''}, added ${hunk.addCount}`)
  } else if (hunk.addCount > 0) {
    parts.push(`Added ${hunk.addCount} line${hunk.addCount !== 1 ? 's' : ''}`)
  } else if (hunk.delCount > 0) {
    parts.push(`Removed ${hunk.delCount} line${hunk.delCount !== 1 ? 's' : ''}`)
  }

  return parts.join(' · ')
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Annotate a diff with per-hunk confidence scores and "why this edit" rationale.
 *
 * @param {{
 *   diffText:       string,
 *   verification?:  { gates?: Array<{id:string,passed:boolean}>, failedGateIds?: string[] },
 *   critique?:      { passed: boolean, issues?: string[], summary?: string },
 *   orchestration?: { role?: string, confidence?: number, strategy?: string, modelId?: string },
 *   memoryHits?:    Array<{ title: string, type: string, score: number, path?: string }>,
 *   usedFallback?:  boolean,
 * }} inputs
 *
 * @returns {{
 *   overallConfidence: number,
 *   hunks: Array<{
 *     header:     string,
 *     lines:      string[],
 *     addCount:   number,
 *     delCount:   number,
 *     confidence: number,
 *     rationale:  string,
 *   }>,
 *   summary: string,
 * }}
 */
export function computeDiffRationale({
  diffText = '',
  verification,
  critique,
  orchestration,
  memoryHits = [],
  usedFallback = false,
}) {
  const overall = computeOverallConfidence({ verification, critique, orchestration, usedFallback })
  const rawHunks = parseDiffHunks(diffText)

  const hunks = rawHunks.map(hunk => ({
    ...hunk,
    confidence: scoreHunk(hunk, overall, critique),
    rationale:  buildHunkRationale(hunk, orchestration, memoryHits, critique, usedFallback),
  }))

  // One-line summary shown above the whole diff
  const failedGateList = (verification?.failedGateIds || []).join(', ')
  const summaryParts = []
  if (orchestration?.role) summaryParts.push(`${ROLE_LABELS[orchestration.role] || orchestration.role} agent`)
  summaryParts.push(`overall confidence ${Math.round(overall * 100)}%`)
  if (failedGateList) summaryParts.push(`⚠ gates: ${failedGateList}`)
  if (critique && !critique.passed) summaryParts.push('⚠ critique issues')
  if (usedFallback) summaryParts.push('⚠ fallback model')
  const summary = summaryParts.join(' · ')

  return { overallConfidence: overall, hunks, summary }
}

/**
 * Map a confidence value to a CSS colour class name.
 * @param {number} conf  0.0 – 1.0
 * @returns {'conf-high'|'conf-med'|'conf-low'}
 */
export function confidenceClass(conf) {
  if (conf >= 0.75) return 'conf-high'
  if (conf >= 0.50) return 'conf-med'
  return 'conf-low'
}

/**
 * Format a confidence value as a percentage string.
 * @param {number} conf  0.0 – 1.0
 * @returns {string}
 */
export function formatConfidence(conf) {
  return `${Math.round(conf * 100)}%`
}
