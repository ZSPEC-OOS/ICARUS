// ─── Context Compressor ───────────────────────────────────────────────────────
// Structured replacement for makeSessionDiary.  While the diary simply collects
// file lists and text snippets, the compressor extracts semantically meaningful
// entities from each agent turn and produces a richer, more compact digest when
// older messages are pruned from the context window.
//
// Entities extracted per turn:
//   • Goal statement  — the primary objective inferred from early model text
//   • Decisions       — sentences signalling a choice ("I'll…", "decided to…")
//   • Key facts       — file-path or symbol mentions with descriptive context
//   • Errors          — tool result failures (captured via onToolResult)
//   • Files read / modified
//
// Progressive compression:
//   The digest output is always compact (<= COMPRESSOR_DIGEST_MAX_CHARS chars).
//   When many entities accumulate, older decisions and facts are elided first,
//   preserving the most recent state information for the model.
//
// Memory graph integration:
//   On digest build, extracted decisions and facts are pushed into the memory
//   graph service so they survive across sessions (queryable by later tasks).
//
// Integration: replaces makeSessionDiary() in agentLoop.js.
//   const compressor = createContextCompressor({ memoryGraphService })
//   compressor.onFileRead(path)
//   compressor.onFileWrite(path, action)
//   compressor.onModelText(text)
//   compressor.onToolResult(toolName, result)
//   compressor.hasContent() → boolean
//   compressor.buildDigest(droppedTurns) → string

import { COMPRESSOR_MAX_DECISIONS, COMPRESSOR_MAX_FACTS, COMPRESSOR_DIGEST_MAX_CHARS } from '../config/constants.js'

// ── Entity extractors ─────────────────────────────────────────────────────────

// Sentence patterns that signal a decision or intent
const DECISION_PATTERNS = [
  /\bI(?:'ll| will| need to| should| must| am going to)\s+([^.!?\n]{15,100})/gi,
  /\b(?:decided?|choosing|going)\s+to\s+([^.!?\n]{10,80})/gi,
  /\bThe (?:approach|strategy|plan|fix|solution) (?:is|will be)\s+([^.!?\n]{10,80})/gi,
  /\b(?:Instead|Rather),?\s+(?:I'll|I will|we'll|let's)\s+([^.!?\n]{10,80})/gi,
]

// Patterns that flag a key fact about the codebase
const FACT_PATTERNS = [
  /`([\w/.\-]+\.[a-z]{2,5})`\s+(?:contains?|handles?|is responsible for|defines?|exports?)\s+([^.!?\n]{10,80})/gi,
  /The\s+`([\w$]+)`\s+(?:function|class|hook|component|service)\s+([^.!?\n]{10,80})/gi,
  /Found\s+(?:the\s+)?([^.!?\n]{10,60})\s+in\s+`([\w/.\-]+)`/gi,
]

// Tool result prefixes that signal a failure worth recording
const ERROR_SIGNALS = ['ERROR:', 'edit_file failed:', 'File not found:', 'exec bridge unavailable', 'failed:', 'error:']

function extractDecisions(text) {
  const found = []
  for (const pattern of DECISION_PATTERNS) {
    pattern.lastIndex = 0
    let m
    while ((m = pattern.exec(text)) !== null) {
      const decision = m[1].replace(/\s+/g, ' ').trim()
      if (decision.length >= 15 && !found.includes(decision)) {
        found.push(decision)
      }
    }
  }
  return found.slice(0, 4)  // max 4 decisions per turn
}

function extractFacts(text) {
  const found = []
  for (const pattern of FACT_PATTERNS) {
    pattern.lastIndex = 0
    let m
    while ((m = pattern.exec(text)) !== null) {
      // Combine match groups into a single fact string
      const fact = [m[1], m[2]].filter(Boolean).join(' — ').replace(/\s+/g, ' ').trim()
      if (fact.length >= 10 && !found.includes(fact)) found.push(fact)
    }
  }
  return found.slice(0, 3)  // max 3 facts per turn
}

function extractGoal(text) {
  // Pull the first meaningful sentence or clause as the session goal
  const sentence = text.split(/[.!?\n]/)[0]?.replace(/\s+/g, ' ').trim() || ''
  return sentence.length >= 20 ? sentence.slice(0, 160) : ''
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a context compressor for one agent session.
 *
 * @param {{ memoryGraphService?: object }} [opts]
 * @returns {ContextCompressor}
 */
export function createContextCompressor({ memoryGraphService } = {}) {
  const filesRead    = new Set()
  const filesChanged = []        // [{ path, action }]
  const decisions    = []        // string[]
  const facts        = []        // string[]
  const errors       = []        // string[]
  let   goalStatement = ''

  return {
    /** Called when the agent reads a file. */
    onFileRead(path) {
      filesRead.add(path)
    },

    /** Called when the agent writes or edits a file. */
    onFileWrite(path, action) {
      const existing = filesChanged.find(f => f.path === path)
      if (existing) {
        existing.action = action  // keep latest action (write trumps edit)
      } else {
        filesChanged.push({ path, action })
      }
    },

    /** Called with each chunk of model narration text. */
    onModelText(text = '') {
      const t = String(text)
      if (!goalStatement && t.trim().length >= 20) {
        goalStatement = extractGoal(t)
      }
      const newDecisions = extractDecisions(t)
      for (const d of newDecisions) {
        if (!decisions.includes(d) && decisions.length < COMPRESSOR_MAX_DECISIONS) {
          decisions.push(d)
        }
      }
      const newFacts = extractFacts(t)
      for (const f of newFacts) {
        if (!facts.includes(f) && facts.length < COMPRESSOR_MAX_FACTS) {
          facts.push(f)
        }
      }
    },

    /** Called with each completed tool result to capture errors. */
    onToolResult(toolName = '', result = '') {
      const r = String(result)
      const isError = ERROR_SIGNALS.some(sig => r.startsWith(sig) || r.includes(sig))
      if (isError) {
        const snippet = `${toolName}: ${r.slice(0, 120).replace(/\n/g, ' ')}`
        if (!errors.includes(snippet) && errors.length < 8) errors.push(snippet)
      }
    },

    /** True when there is any accumulated content worth including in a digest. */
    hasContent() {
      return filesRead.size > 0 || filesChanged.length > 0 ||
             decisions.length > 0 || facts.length > 0 || errors.length > 0
    },

    /**
     * Build a compact structured digest of the compacted turns.
     * Pushes key entities into memoryGraphService before returning.
     *
     * @param {number} droppedTurns
     * @returns {string}
     */
    buildDigest(droppedTurns) {
      const lines = [
        `[SESSION DIGEST — ${droppedTurns} earlier turn${droppedTurns !== 1 ? 's' : ''} compacted]`,
      ]

      if (goalStatement) {
        lines.push(`Current goal: ${goalStatement}`)
      }

      if (filesChanged.length > 0) {
        lines.push(`Files modified: ${filesChanged.map(f => `${f.path} (${f.action})`).join(', ')}`)
      }

      if (filesRead.size > 0) {
        const read = [...filesRead].slice(0, 15)
        const extra = filesRead.size > 15 ? ` (and ${filesRead.size - 15} more)` : ''
        lines.push(`Files read: ${read.join(', ')}${extra}`)
      }

      if (decisions.length > 0) {
        lines.push('Decisions made:')
        // Keep most recent decisions if we're over budget
        const keep = decisions.slice(-Math.min(decisions.length, 6))
        keep.forEach(d => lines.push(`  • ${d}`))
      }

      if (facts.length > 0) {
        lines.push('Key facts:')
        facts.slice(-Math.min(facts.length, 4)).forEach(f => lines.push(`  • ${f}`))
      }

      if (errors.length > 0) {
        lines.push('Errors encountered:')
        errors.slice(-4).forEach(e => lines.push(`  • ${e}`))
      }

      // Progressive compression: if digest is still too long, elide facts first,
      // then older decisions, keeping goal + files + recent decisions intact.
      let digest = lines.join('\n')
      if (digest.length > COMPRESSOR_DIGEST_MAX_CHARS) {
        const trimmed = [
          lines[0],
          goalStatement ? `Current goal: ${goalStatement}` : null,
          filesChanged.length > 0 ? `Files modified: ${filesChanged.map(f => `${f.path} (${f.action})`).join(', ')}` : null,
          decisions.length > 0 ? `Decisions: ${decisions.slice(-3).join(' | ')}` : null,
          errors.length > 0 ? `Errors: ${errors.slice(-2).join(' | ')}` : null,
        ].filter(Boolean)
        digest = trimmed.join('\n')
      }

      // Push entities to memory graph for cross-session persistence
      _persistToMemoryGraph({ memoryGraphService, goalStatement, decisions, facts, filesChanged })

      return digest
    },
  }
}

// ── Memory graph persistence ──────────────────────────────────────────────────
function _persistToMemoryGraph({ memoryGraphService, goalStatement, decisions, facts, filesChanged }) {
  if (!memoryGraphService) return
  try {
    // Ingest a synthetic "session summary" node so future RAG queries can surface it
    for (const f of filesChanged) {
      memoryGraphService.ingestFileChange?.({
        path:    f.path,
        action:  f.action,
        content: [goalStatement, ...decisions.slice(0, 2)].filter(Boolean).join(' ').slice(0, 400),
        source:  'context_compressor',
      })
    }
  } catch { /* memory graph failures must never affect the main loop */ }
}

/**
 * @typedef {{
 *   onFileRead(path: string): void,
 *   onFileWrite(path: string, action: string): void,
 *   onModelText(text: string): void,
 *   onToolResult(toolName: string, result: string): void,
 *   hasContent(): boolean,
 *   buildDigest(droppedTurns: number): string,
 * }} ContextCompressor
 */
