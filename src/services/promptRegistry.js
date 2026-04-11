// ─── Prompt Template Registry ─────────────────────────────────────────────────
// Centralises all prompt template variants, tracks per-variant performance, and
// provides stable A/B assignment so each session sees a consistent variant.
//
// Design:
//   register(name, variants)  — declare a named template with ≥1 variants
//   get(name, sessionId)      — consistent variant assignment via stable hash
//   recordOutcome(name, variantId, success)  — accumulate win/loss counts
//   getStats(name)            — per-variant success rates + sample counts
//   getWinner(name, minSamples) — return winning variant once significant
//   persistStats() / loadStats() — localStorage persistence
//
// A/B assignment uses djb2 hash(sessionId + name) % variants.length so a given
// session always sees the same variant for the same template — no mid-session
// flipping.  When only one variant is registered (or sessionId is empty),
// variant[0] is always returned.
//
// Integration:
//   agentTools.js — buildAgentSystemPrompt() calls promptRegistry.get() for
//   specific sections (identity, narration) so prompt copy can be A/B tested
//   without code changes.
//
//   agentLoop.js — calls promptRegistry.recordOutcome() when the FSM reaches
//   DONE (success=true) or FAILED (success=false).

import { KEYS } from '../shared/storageKeys.js'

const STATS_KEY = KEYS.LS.PROMPT_REGISTRY_STATS

// ── Djb2 hash (stable, no crypto needed) ─────────────────────────────────────
function djb2(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h, 33) ^ str.charCodeAt(i)
  }
  return Math.abs(h)
}

// ── In-memory stores ──────────────────────────────────────────────────────────
/** @type {Map<string, Variant[]>} */
const _registry = new Map()
/** @type {Map<string, Record<string, VariantStats>>} */
let _stats = new Map()

// ── Persistence ───────────────────────────────────────────────────────────────
function _loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY)
    if (!raw) return
    const obj = JSON.parse(raw)
    for (const [name, varStats] of Object.entries(obj)) {
      _stats.set(name, varStats)
    }
  } catch { /* non-fatal */ }
}

function _saveStats() {
  try {
    const obj = {}
    for (const [name, varStats] of _stats) obj[name] = varStats
    localStorage.setItem(STATS_KEY, JSON.stringify(obj))
  } catch { /* non-fatal */ }
}

// Load on module init
try { _loadStats() } catch {}

// ── Public API ────────────────────────────────────────────────────────────────

export const promptRegistry = {

  /**
   * Register a named template with one or more A/B variants.
   * Existing registrations are replaced.
   *
   * @param {string}    name      Template identifier, e.g. 'agent.identity'
   * @param {Variant[]} variants  Array of { id, content, description } objects
   */
  register(name, variants) {
    if (!name || !Array.isArray(variants) || variants.length === 0) return
    _registry.set(name, variants)
    // Ensure stats slots exist for all variants
    if (!_stats.has(name)) _stats.set(name, {})
    const varStats = _stats.get(name)
    for (const v of variants) {
      if (!varStats[v.id]) varStats[v.id] = { wins: 0, losses: 0, samples: 0 }
    }
  },

  /**
   * Get the variant to use for this session.
   * Returns null when the template is not registered.
   *
   * @param {string} name
   * @param {string} [sessionId]  Stable session identifier for consistent assignment
   * @returns {Variant|null}
   */
  get(name, sessionId = '') {
    const variants = _registry.get(name)
    if (!variants || variants.length === 0) return null
    if (variants.length === 1) return variants[0]

    // Check if there's a promoted winner with enough data
    const winner = this.getWinner(name)
    if (winner) return winner

    // Stable hash assignment
    const idx = djb2(String(sessionId) + name) % variants.length
    return variants[idx]
  },

  /**
   * Record a task outcome for the variant that was used in this session.
   *
   * @param {string}  name
   * @param {string}  variantId
   * @param {boolean} success
   */
  recordOutcome(name, variantId, success) {
    if (!_stats.has(name)) _stats.set(name, {})
    const varStats = _stats.get(name)
    if (!varStats[variantId]) varStats[variantId] = { wins: 0, losses: 0, samples: 0 }
    const s = varStats[variantId]
    s.samples++
    if (success) s.wins++; else s.losses++
    _saveStats()
  },

  /**
   * Return per-variant win-rate statistics for a template.
   *
   * @param {string} name
   * @returns {Record<string, { wins: number, losses: number, samples: number, winRate: number }>}
   */
  getStats(name) {
    const varStats = _stats.get(name) || {}
    const out = {}
    for (const [id, s] of Object.entries(varStats)) {
      out[id] = { ...s, winRate: s.samples > 0 ? s.wins / s.samples : null }
    }
    return out
  },

  /**
   * Return the winning variant if one has a meaningfully higher win rate and
   * at least minSamples data points.  Returns null when data is insufficient.
   *
   * @param {string} name
   * @param {number} [minSamples]  Minimum samples required per variant
   * @param {number} [minLift]     Minimum win-rate lift to declare a winner (0–1)
   * @returns {Variant|null}
   */
  getWinner(name, minSamples = 20, minLift = 0.08) {
    const variants  = _registry.get(name) || []
    const varStats  = _stats.get(name) || {}
    if (variants.length < 2) return null

    const ranked = variants
      .map(v => {
        const s = varStats[v.id] || { wins: 0, losses: 0, samples: 0 }
        return { variant: v, winRate: s.samples >= minSamples ? s.wins / s.samples : null, samples: s.samples }
      })
      .filter(r => r.winRate !== null)
      .sort((a, b) => b.winRate - a.winRate)

    if (ranked.length < 2) return null
    if (ranked[0].winRate - ranked[1].winRate >= minLift) return ranked[0].variant
    return null
  },

  /**
   * List all registered template names.
   * @returns {string[]}
   */
  list() {
    return [..._registry.keys()]
  },

  /** Reset all stats (useful for testing). */
  _resetStats() {
    _stats = new Map()
    try { localStorage.removeItem(STATS_KEY) } catch {}
  },
}

// ── Built-in template registrations ──────────────────────────────────────────
// Register the default A/B variants for key system-prompt sections.
// These are referenced by name in buildAgentSystemPrompt() in agentTools.js.

promptRegistry.register('agent.identity', [
  {
    id:          'a-autonomous',
    description: 'Autonomous AI coding assistant framing',
    content:     'an autonomous AI coding assistant',
  },
  {
    id:          'b-expert-engineer',
    description: 'Expert software engineer framing',
    content:     'an expert software engineer with deep knowledge of the codebase',
  },
])

promptRegistry.register('agent.narration', [
  {
    id:          'a-standard',
    description: 'Standard narration instruction (current default)',
    content: [
      `As you work, write short natural-language sentences before and after significant actions — what you are about to do and why, what you found, what decision you made. Write like a developer talking to their colleague: direct, specific, and informative.`,
      `Examples of good narration:`,
      `  "I'll start by checking how the existing auth middleware works before touching the routes."`,
      `  "Found the token validation in three places — I'll update all of them consistently."`,
      `  "The component re-renders on every keystroke because the handler is recreated inline. I'll memoize it."`,
      `Keep it brief (1–2 sentences). Do not restate what the tool call itself already shows.`,
    ].join('\n'),
  },
  {
    id:          'b-concise',
    description: 'Concise narration — one sentence per action, no examples',
    content: [
      `Narrate your reasoning in one sentence before each significant action (why you're doing it) and one sentence after (what you found or decided).`,
      `Be specific and direct. Skip narration for mechanical steps (reading a file you just mentioned, running a linter). Focus on decisions, surprises, and choices between approaches.`,
    ].join('\n'),
  },
])

promptRegistry.register('agent.verification', [
  {
    id:          'a-full-loop',
    description: 'Full verification loop (lint + typecheck + test)',
    content:     `VERIFICATION LOOP — run after every set of edits:\n   a. lint_file on each changed .js/.jsx/.ts/.tsx file\n   b. type_check to surface TypeScript errors\n   c. run_tests to confirm the test suite passes\n   Fix any errors found before moving on.`,
  },
  {
    id:          'b-test-first',
    description: 'Test-first verification (tests then lint)',
    content:     `VERIFICATION LOOP — run after every set of edits:\n   a. run_tests first — if tests pass, the logic is correct\n   b. lint_file on changed files to catch style issues\n   c. type_check if TypeScript errors are a concern\n   Fix failures before moving on.`,
  },
])

/**
 * @typedef {{ id: string, content: string, description: string }} Variant
 * @typedef {{ wins: number, losses: number, samples: number }} VariantStats
 */
