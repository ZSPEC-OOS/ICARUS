// ─── IntentAmplifier — Phase 2 ───────────────────────────────────────────────
// Detects when a prompt is vague and silently expands it into a full
// specification using project conventions from ShadowContext.
// Never asks the user a question — makes smart assumptions and reports them.
//
// Usage:
//   const { enrichedPrompt, decisions } = await amplifyPrompt(prompt, conventions, model, signal)
//   // decisions → ['Using JWT because jsonwebtoken found in package.json', …]

import { runPrompt } from './aiService.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('IntentAmplifier')

// A prompt is "vague" if it's short and lacks technical specifics, OR contains
// unresolved pronoun/reference that requires prior context to understand.
export function isVaguePrompt(text) {
  if (!text?.trim()) return false
  const words    = text.trim().split(/\s+/)
  const hasPath  = /[./\\]/.test(text)
  const hasCode  = /function|class|import|export|const|let|var|def |async|interface|type |struct/.test(text)
  // Unresolved references make a prompt vague regardless of its length or code content
  const hasUnresolvedRef = /\b(fix it|update it|change it|make it|that (file|component|hook|function|page|code|class|style)|the same( thing)?|like before|like we discussed|from earlier|do the same|same (approach|pattern|way)|same as (above|before))\b/i.test(text)
  const hasSpec  = words.length >= 20 && !hasUnresolvedRef
  return hasUnresolvedRef || (!hasPath && !hasCode && !hasSpec)
}

// Build a concise conventions summary string to inject into the amplifier prompt.
function summariseConventions(conv) {
  if (!conv) return 'No project context available.'
  const lines = [
    `Framework: ${conv.framework}`,
    `Language: ${conv.language}`,
    `Test framework: ${conv.testFramework}`,
    `Naming convention: ${conv.namingConvention}`,
    conv.srcDir     ? `Source root: ${conv.srcDir}/` : '',
    conv.hooks?.length  ? `Existing hooks: ${conv.hooks.slice(0, 4).join(', ')}` : '',
    conv.deps?.length   ? `Key deps: ${conv.deps.filter(d => !/^(@types|eslint|prettier|typescript|webpack|babel|vite)/.test(d)).slice(0, 12).join(', ')}` : '',
    conv.pathAliases && Object.keys(conv.pathAliases).length
      ? `Import aliases: ${Object.entries(conv.pathAliases).map(([k, v]) => `${k}/ → ${v}/`).join(', ')}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

// Main entry point. Returns the original prompt on any failure so the caller
// can always proceed — this function must never throw.
//
// recentTurns — last few conversation messages, used to resolve pronoun references
// ("fix it", "the same thing", etc.) against prior context.
export async function amplifyPrompt(vaguePrompt, conventions, model, signal, recentTurns = []) {
  if (!model?.apiKey) return { enrichedPrompt: vaguePrompt, decisions: [] }

  const convSummary = summariseConventions(conventions)

  // Inject the last 3 conversation turns (6 messages max) so the model can
  // resolve references like "fix that", "add the same thing here", etc.
  const recentCtx = recentTurns.length > 0
    ? `\nRecent conversation (use this to resolve any pronouns or references in the request):\n${
        recentTurns.slice(-6).map(m => `${m.role}: ${String(m.content).slice(0, 300)}`).join('\n')
      }\n`
    : ''

  const systemMsg = [
    'You are a senior developer who translates vague feature requests into precise implementation specs.',
    'Use the project context to make concrete, opinionated decisions — do NOT ask clarifying questions.',
    'If the request contains pronouns like "it", "that", or "the same thing", resolve them using the recent conversation.',
    'Output a JSON object with exactly two fields:',
    '  "enrichedPrompt": a detailed (100–200 word) implementation specification.',
    '  "decisions": an array of short strings, one per assumption made (e.g. "Using JWT auth because jsonwebtoken is in package.json").',
    'Keep decisions concise. Only list non-obvious choices.',
    'Output valid JSON only — no markdown fences, no extra text.',
  ].join('\n')

  const context = [
    { role: 'user',      content: systemMsg },
    { role: 'assistant', content: '{"enrichedPrompt":' },  // prime JSON output
  ]

  try {
    const raw = await runPrompt(
      model,
      `Project context:\n${convSummary}${recentCtx}\n\nVague request: "${vaguePrompt}"\n\nExpand into a full specification.`,
      context,
      null,   // no streaming needed
      signal,
    )

    // The assistant was primed with '{"enrichedPrompt":' so we prepend it back
    const jsonStr = raw.startsWith('{"enrichedPrompt":') ? raw : `{"enrichedPrompt":${raw}`
    // Also handle responses that wrap in a code block
    const cleaned = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    const parsed  = JSON.parse(cleaned.startsWith('{') ? cleaned : `{"enrichedPrompt":${cleaned}`)

    if (typeof parsed.enrichedPrompt === 'string' && parsed.enrichedPrompt.length > 20) {
      return {
        enrichedPrompt: parsed.enrichedPrompt,
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      }
    }
  } catch (e) {
    // Silent fallback — original prompt is used
    log.warn('parse failed', e.message)
  }

  return { enrichedPrompt: vaguePrompt, decisions: [] }
}
