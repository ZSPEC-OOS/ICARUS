// ─── Patch Validator ──────────────────────────────────────────────────────────
// Pre-write safety check for edit_file operations.  Called before the GitHub
// API write so that invalid patches fail fast with a self-correcting diagnostic
// instead of silently corrupting the file.
//
// Three-stage validation:
//   Stage 1 — Exact match           : old_str present verbatim → safe to write
//   Stage 2 — Whitespace-drift match : old_str matches after trimStart() per line
//                                      → returns the correct indented version
//   Stage 3 — Fuzzy first-line match : Levenshtein similarity on the first line
//                                      → returns nearest matching region as hint
//
// Additionally runs a lightweight syntax-balance check (bracket/brace counting)
// on the resulting content and returns a warning if delimiters diverge by > 3.
//
// Integration: imported and called inside agentExecutor.js `edit_file` case
// before createOrUpdateFile() is invoked.

import {
  PATCH_VALIDATOR_FUZZY_THRESHOLD,
  PATCH_VALIDATOR_MAX_CONTEXT_LINES,
} from '../config/constants.js'

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a proposed old_str → new_str patch against the current file content.
 *
 * @param {string} filePath       Target file path (used in diagnostic messages)
 * @param {string} oldStr         Text the model intends to replace
 * @param {string} newStr         Replacement text
 * @param {string} currentContent Full current file content (already fetched)
 * @returns {ValidationResult}
 */
export function validatePatch(filePath, oldStr, newStr, currentContent) {
  const content = String(currentContent)
  const old     = String(oldStr)
  const next    = String(newStr)

  // ── Stage 1: exact match ───────────────────────────────────────────────────
  if (content.includes(old)) {
    const resultContent  = content.replace(old, next)
    const syntaxWarning  = _checkSyntaxBalance(resultContent, filePath)
    return {
      valid:        true,
      stage:        'exact',
      syntaxWarning: syntaxWarning || null,
    }
  }

  // ── Stage 2: leading-whitespace-stripped match ─────────────────────────────
  const normContent = content.split('\n').map(l => l.trimStart()).join('\n')
  const normOld     = old.split('\n').map(l => l.trimStart()).join('\n')

  if (normContent.includes(normOld)) {
    const suggestion = _extractWithProperIndent(content, normOld)
    return {
      valid:       false,
      stage:       'whitespace_drift',
      reason:      `old_str matched only after stripping leading whitespace in ${filePath}. ` +
                   `The file's indentation differs from what was provided.`,
      suggestion,   // the correctly-indented version; model should use this as old_str
    }
  }

  // ── Stage 3: first-line fuzzy similarity ───────────────────────────────────
  const firstLine = old.split('\n')[0].trim()
  if (firstLine.length >= 8) {
    const nearestMatch = _findNearestMatch(content, firstLine)
    if (nearestMatch) {
      return {
        valid:        false,
        stage:        'fuzzy',
        reason:       `old_str not found verbatim in ${filePath}. ` +
                      `The file may have changed since it was last read.`,
        nearestMatch,
      }
    }
  }

  // ── Not found at all ───────────────────────────────────────────────────────
  return {
    valid:        false,
    stage:        'not_found',
    reason:       `old_str not found in ${filePath}. ` +
                  `Use grep or read_file to confirm the exact text before retrying.`,
    nearestMatch: null,
  }
}

// ── Syntax balance checker ────────────────────────────────────────────────────
// Counts { } ( ) [ ] after stripping string literals and comments.
// A delta > 3 almost certainly indicates a broken edit.

const BALANCE_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'])

function _checkSyntaxBalance(content, filePath) {
  const ext = (filePath.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || ''
  if (!BALANCE_EXTS.has(ext)) return null

  // Strip approximate string/comment noise to reduce false positives
  const stripped = content
    .replace(/`(?:[^`\\]|\\.)*`/g,    '""')   // template literals
    .replace(/"(?:[^"\\]|\\.)*"/g,    '""')    // double-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g,    "''")    // single-quoted strings
    .replace(/\/\/[^\n]*/g,           '')      // line comments
    .replace(/\/\*[\s\S]*?\*\//g,     '')      // block comments

  const open  = (stripped.match(/[{([]/g) || []).length
  const close = (stripped.match(/[})\]]/g) || []).length
  const delta = Math.abs(open - close)

  if (delta > 3) {
    return `Syntax balance warning: ${open} opening vs ${close} closing delimiters (Δ=${delta}). ` +
           `Review the edit for unmatched brackets.`
  }
  return null
}

// ── Nearest-match finder ──────────────────────────────────────────────────────
// Scans file lines for the best Levenshtein similarity to the first line of
// old_str.  Returns a formatted context excerpt if similarity ≥ threshold.

function _findNearestMatch(content, firstLine) {
  const lines    = content.split('\n')
  let bestScore  = 0
  let bestIdx    = -1

  const limit = Math.min(lines.length, 5000)
  for (let i = 0; i < limit; i++) {
    const score = _similarity(lines[i].trim(), firstLine)
    if (score > bestScore) { bestScore = score; bestIdx = i }
  }

  if (bestScore < PATCH_VALIDATOR_FUZZY_THRESHOLD || bestIdx === -1) return null

  const s       = Math.max(0, bestIdx - 2)
  const e       = Math.min(lines.length, bestIdx + PATCH_VALIDATOR_MAX_CONTEXT_LINES)
  const excerpt = lines.slice(s, e)
    .map((l, i) => `  ${s + i + 1}: ${l}`)
    .join('\n')

  return `Best match (similarity ${Math.round(bestScore * 100)}%) near line ${bestIdx + 1}:\n${excerpt}`
}

// ── Indent-preserving suggestion builder ──────────────────────────────────────
// After a whitespace-drift match, recover the correctly-indented old_str by
// finding the first line of normOld in the strip-normalised content, then
// re-extracting the same span from the *original* content.

function _extractWithProperIndent(content, normOld) {
  const normLines    = normOld.split('\n')
  const contentLines = content.split('\n')
  const firstNorm    = normLines[0]

  const idx = contentLines.findIndex(l => l.trimStart() === firstNorm)
  if (idx === -1) return null

  return contentLines.slice(idx, idx + normLines.length).join('\n')
}

// ── Levenshtein similarity ────────────────────────────────────────────────────
// Returns a [0, 1] score (1 = identical).  Inputs capped at 200 chars for
// performance — sufficient for first-line matching.

function _similarity(a, b) {
  const s = String(a).slice(0, 200)
  const t = String(b).slice(0, 200)
  if (s === t) return 1
  if (!s || !t) return 0

  const m = s.length
  const n = t.length
  // Use two-row DP to keep O(n) space
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  let curr = new Array(n + 1)

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      curr[j] = s[i - 1] === t[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1])
    }
    ;[prev, curr] = [curr, prev]
  }

  return 1 - prev[n] / Math.max(m, n)
}

/**
 * @typedef {{
 *   valid:          boolean,
 *   stage:          'exact'|'whitespace_drift'|'fuzzy'|'not_found',
 *   syntaxWarning?: string|null,
 *   reason?:        string,
 *   suggestion?:    string|null,
 *   nearestMatch?:  string|null,
 * }} ValidationResult
 */
