// ─── intentClassifier ─────────────────────────────────────────────────────────
// Pure, synchronous functions. No API calls, no React.
//
// estimateScope(message, shadowContext) → 'single' | 'multi' | 'arch'
//   Matches identifier-like words in the message against the shadow content
//   index to estimate how many files the task is likely to touch.
//
// classifyIntent(message, repoSignals?) → { mode, confidence, reason }
//   mode is one of:
//   'chat'     — question / explanation / discussion, no code action needed
//   'plan'     — read-only analysis: find, audit, trace, review
//   'build'    — active code change: add, fix, refactor, implement
//   'creative' — aesthetic / design / style work (routes to DRCT pipeline)
//   'long'     — multi-file architectural task (routes to LRM decomposition)
//
// Scoring: phrase hits carry 2 pts, keyword hits carry 1 pt.
// The mode with the highest score wins. On a tie, 'build' takes precedence.
// Confidence reflects the gap between first and second place.

// ── Signal tables ─────────────────────────────────────────────────────────────

const CHAT_PHRASES = [
  'what is', 'what are', 'what does', 'what do', 'what would', 'what should',
  'why does', 'why is', 'why are', 'why do', 'why would', 'why should',
  'how does', 'how do', 'how is', 'how are', 'how would', 'how should',
  'how can', 'how to',
  'can you explain', 'could you explain', 'help me understand', 'help me learn',
  'tell me about', 'tell me more', 'tell me how',
  'explain', 'describe', 'clarify',
  "what's the difference", 'what is the difference', 'difference between',
  'compare', 'comparison between', 'versus', ' vs ',
  'summarize', 'summarise', 'summary of', 'overview of',
  'is it possible', 'is there a way', 'what if', 'what happens if',
  'brainstorm', 'ideas for', 'suggestions for',
  'pros and cons', 'trade-off', 'tradeoff', 'advantages', 'disadvantages',
  'when should', 'when would', 'when do', 'should i', 'should we',
]

const PLAN_KEYWORDS = [
  'analyze', 'analyse', 'audit', 'review', 'inspect', 'assess',
  'find', 'locate', 'look at', 'look for', 'look into',
  'show me', 'list', 'where is', 'where are', 'what files',
  'trace', 'walk me through', 'walk through',
  'outline', 'map out', 'identify', 'check if', 'check whether',
  'scan', 'explore', 'understand',
]

const BUILD_KEYWORDS = [
  'create', 'implement', 'add', 'remove', 'delete', 'fix', 'refactor',
  'update', 'change', 'rename', 'move', 'write', 'generate', 'make',
  'edit', 'patch', 'install', 'convert', 'replace', 'extract',
  'merge', 'split', 'extend', 'integrate', 'configure', 'set up', 'setup',
  'connect', 'wire up', 'hook up', 'enable', 'disable',
  'debug', 'resolve', 'correct', 'handle', 'build',
]

const CREATIVE_PHRASES = [
  'redesign', 'restyle', 'look and feel', 'visual design',
  'color scheme', 'colour scheme', 'typography', 'spacing',
  'theme', 'branding', 'aesthetic', 'visual style',
  'rewrite for clarity', 'improve the prose', 'improve the writing',
  'tone of voice', 'writing style', 'voice and tone',
  'make it look', 'make it feel',
  'creative direction', 'artistic',
]

const LONG_PHRASES = [
  'entire codebase', 'whole codebase', 'across the codebase',
  'all files', 'every file', 'all components', 'all pages', 'all routes',
  'restructure', 'overhaul', 'from scratch', 'rewrite the entire',
  'comprehensive', 'end-to-end', 'full implementation', 'full refactor',
  'major refactor', 'large scale', 'large-scale', 'system-wide',
  'codebase-wide', 'migration plan', 'migration strategy',
  'phase 1', 'step by step', 'step-by-step', 'multi-step',
  'architecture', 'architectural', 'redesign the system',
  'v2', 'version 2', 'ground up',
]

const GREETING_RE = /^(hi|hello|hey|yo|good morning|good afternoon|howdy|greetings)[,!.?\s]/i
const THANKS_RE   = /^(thanks|thank you|cheers|thx|ty)[,!.?\s]/i

// ── Scoring ───────────────────────────────────────────────────────────────────

function phraseScore(text, phrases) {
  return phrases.reduce((n, ph) => n + (text.includes(ph) ? 2 : 0), 0)
}

function keywordScore(text, keywords) {
  return keywords.reduce((n, kw) => n + (text.includes(kw) ? 1 : 0), 0)
}

// ── Scope estimator ───────────────────────────────────────────────────────────
// Synchronous — scans the in-memory content index; typically <1 ms.
// Returns 'single' | 'multi' | 'arch'.
//
// Thresholds:
//   0 symbol matches  → single (assume focused task)
//   1–3 file matches  → single
//   4–15 file matches → multi  (likely needs LRM decomposition)
//   >15 file matches  → arch   (cross-cutting — force LRM)
//
// Falls back to file-count heuristic when shadowContext isn't ready or
// the message contains no recognisable identifiers.

export function estimateScope(message, shadow) {
  if (!shadow?.isReady || !shadow._contentIndex) return 'single'

  const fileCount = shadow._totalRepoFiles || shadow._fileIndex?.length || 0

  // Extract candidate identifier tokens: camelCase, PascalCase, snake_case ≥3 chars
  const tokens = (message.match(/\b([A-Z][a-zA-Z0-9]{2,}|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[a-z][a-z0-9_]{2,})\b/g) || [])
    .map(t => t.toLowerCase())

  if (tokens.length === 0) {
    // No identifiers — fall back to repo size
    if (fileCount > 400) return 'arch'
    if (fileCount > 80)  return 'multi'
    return 'single'
  }

  const matchedFiles = new Set()
  for (const [path, entry] of Object.entries(shadow._contentIndex)) {
    const syms = (entry.symbols || []).map(s => s.toLowerCase())
    if (tokens.some(tok => syms.some(sym => sym === tok || sym.includes(tok)))) {
      matchedFiles.add(path)
      if (matchedFiles.size > 15) return 'arch'  // early exit
    }
  }

  if (matchedFiles.size > 3)  return 'multi'
  return 'single'
}

// ── Main export ───────────────────────────────────────────────────────────────

export function classifyIntent(message, repoSignals = null) {
  const raw  = String(message || '').trim()
  const text = raw.toLowerCase()

  if (!text) return { mode: 'chat', confidence: 1, reason: 'empty message' }

  const wordCount       = text.split(/\s+/).length
  const endsWithQ       = text.endsWith('?')
  const isGreeting      = (GREETING_RE.test(text) || THANKS_RE.test(text)) && wordCount < 15

  if (isGreeting) return { mode: 'chat', confidence: 1, reason: 'greeting or acknowledgement' }

  const scores = {
    chat:     phraseScore(text, CHAT_PHRASES),
    plan:     keywordScore(text, PLAN_KEYWORDS),
    build:    keywordScore(text, BUILD_KEYWORDS),
    creative: phraseScore(text, CREATIVE_PHRASES),
    long:     phraseScore(text, LONG_PHRASES),
  }

  // Structural boosts
  if (endsWithQ)       scores.chat  += 2
  if (wordCount < 12 && endsWithQ) scores.chat += 1   // short questions are nearly always chat
  if (wordCount > 60)  scores.long  += 2               // long prompts suggest multi-phase scope
  if (wordCount > 30)  scores.build += 1               // medium-length prompts lean toward build

  // Strong creative or long signals suppress plain build noise
  if (scores.creative >= 4) scores.build = Math.max(0, scores.build - 2)
  if (scores.long     >= 4) scores.build = 0

  // Repo-aware scope boosts — widen to 'long' when symbol search shows broad impact
  if (repoSignals?.scope === 'arch')  { scores.long += 3; scores.build = 0 }
  if (repoSignals?.scope === 'multi') { scores.long += 1.5 }

  // Find winner — on equal scores build beats plan beats chat
  const ORDER = ['build', 'plan', 'chat', 'long', 'creative']
  const sorted = [...ORDER].sort((a, b) => scores[b] - scores[a])
  const topMode    = sorted[0]
  const topScore   = scores[topMode]
  const secondScore = scores[sorted[1]]

  // No signals at all → default to build (same as previous behaviour)
  if (topScore === 0) {
    return { mode: 'build', confidence: 0.4, reason: 'no clear signals — defaulting to build' }
  }

  const gap        = topScore - secondScore
  const confidence = Math.min(0.95, 0.5 + gap * 0.12)

  // Find the first keyword/phrase that fired for the winning mode
  const allSignals = topMode === 'chat'     ? CHAT_PHRASES
    : topMode === 'plan'                    ? PLAN_KEYWORDS
    : topMode === 'build'                   ? BUILD_KEYWORDS
    : topMode === 'creative'                ? CREATIVE_PHRASES
    : LONG_PHRASES
  const hit = allSignals.find(s => text.includes(s)) || ''
  const scopePart = repoSignals?.scope && repoSignals.scope !== 'single' ? `, scope:${repoSignals.scope}` : ''
  const reason = hit
    ? `"${hit}" → ${topMode} (score ${topScore}${scopePart})`
    : `${topMode} (score ${topScore}${scopePart})`

  return { mode: topMode, confidence, reason, scope: repoSignals?.scope ?? 'unknown' }
}
