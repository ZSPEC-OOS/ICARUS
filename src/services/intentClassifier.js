// ─── intentClassifier ─────────────────────────────────────────────────────────
// Pure, synchronous function. No API calls, no React.
// Returns { mode, confidence, reason } where mode is one of:
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

// ── Main export ───────────────────────────────────────────────────────────────

export function classifyIntent(message) {
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
  const reason = hit
    ? `"${hit}" → ${topMode} (score ${topScore})`
    : `${topMode} (score ${topScore})`

  return { mode: topMode, confidence, reason }
}
