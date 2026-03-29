// ─── Self-check / Critique middleware ────────────────────────────────────────
// Rule-based critique pass that can run after a draft response and before final
// output emission. Designed to be non-invasive and fully optional.

/**
 * @typedef {{id:string,severity:'info'|'warning'|'error',message:string}} CritiqueIssue
 */

/**
 * @param {{
 *   draftText:string,
 *   contract?: import('./structuredPrompting.js').StructuredPromptContract,
 *   ragContext?: Array<{text:string,source?:string}>,
 *   config?: {checkGrounding?:boolean,checkConstraints?:boolean,checkCompleteness?:boolean}
 * }} input
 * @returns {{passed:boolean,issues:CritiqueIssue[],summary:string}}
 */
export function runCritiquePass(input) {
  const { draftText = '', contract, ragContext = [], config = {} } = input || {}
  const issues = []

  if (!draftText.trim()) {
    issues.push(issue('missing_output', 'error', 'Draft output is empty.'))
  }

  if (config.checkCompleteness !== false && contract?.goal) {
    const goalTokens = contract.goal.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 8)
    const overlap = goalTokens.filter(t => draftText.toLowerCase().includes(t)).length
    if (goalTokens.length >= 4 && overlap < Math.ceil(goalTokens.length * 0.25)) {
      issues.push(issue('goal_alignment', 'warning', 'Output may not align tightly with the stated goal.'))
    }
  }

  if (config.checkConstraints !== false && contract?.constraints?.length) {
    const missed = contract.constraints.filter(c => !roughContains(draftText, c))
    if (missed.length) {
      issues.push(issue('constraints', 'warning', `Potentially unaddressed constraints: ${missed.slice(0, 3).join(' | ')}`))
    }
  }

  if (config.checkGrounding !== false && ragContext.length > 0) {
    const grounded = ragContext.some(ctx => roughContains(draftText, ctx.text.slice(0, 120)))
    if (!grounded) {
      issues.push(issue('grounding', 'info', 'No obvious overlap with retrieved context; verify factual grounding.'))
    }
  }

  const hardFailures = issues.filter(i => i.severity === 'error').length
  const summary = hardFailures
    ? `Critique failed with ${hardFailures} blocking issue(s).`
    : issues.length
      ? `Critique found ${issues.length} non-blocking issue(s).`
      : 'Critique passed with no issues.'

  return { passed: hardFailures === 0, issues, summary }
}

function issue(id, severity, message) {
  return { id, severity, message }
}

function roughContains(text = '', snippet = '') {
  const normA = String(text).toLowerCase().replace(/\s+/g, ' ').trim()
  const normB = String(snippet).toLowerCase().replace(/\s+/g, ' ').trim()
  if (!normA || !normB) return false
  if (normA.includes(normB)) return true

  const tokens = normB.split(/\W+/).filter(Boolean).slice(0, 10)
  if (!tokens.length) return false
  const matches = tokens.filter(t => normA.includes(t)).length
  return matches >= Math.max(2, Math.ceil(tokens.length * 0.5))
}
