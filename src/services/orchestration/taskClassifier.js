// ─── Task Classifier ──────────────────────────────────────────────────────────
// Analyses task text and returns the most appropriate specialist agent role.
// Roles map 1-to-1 with specialised model slots in orchestrationConfig.roles.

/** @typedef {'planner'|'debugger'|'refactorer'|'test-writer'|'reviewer'} AgentRole */

export const AGENT_ROLES = /** @type {const} */ (['planner', 'debugger', 'refactorer', 'test-writer', 'reviewer'])

/**
 * Per-role signal patterns (order matters — earlier patterns are slightly
 * heavier because they tend to be more unambiguous).
 * @type {Record<AgentRole, RegExp[]>}
 */
const ROLE_PATTERNS = {
  planner: [
    /\b(design|architect|blueprint|scaffold|outline|plan|propose|draft)\b/i,
    /\b(new (file|component|module|service|feature|page|hook|util|class|schema|api))\b/i,
    /\bfrom scratch\b/i,
    /\b(create|build|add|implement)\s+(a|an|the)?\s*(new|fresh)?\s*(system|architecture|structure|layout|framework)\b/i,
    /\b(setup|initialize|bootstrap|boilerplate|skeleton|initial)\b/i,
  ],
  debugger: [
    /\b(debug|fix\b|bug\b|error\b|crash\b|broken|issue|problem|failing|regression|incident)\b/i,
    /\b(not working|doesn'?t work|can'?t run|won'?t (start|run|load|compile))\b/i,
    /\b(exception|traceback|stack ?trace|undefined|null pointer|segfault|panic)\b/i,
    /\b(why (is|does|isn'?t|doesn'?t)|unexpected (behavior|result|output))\b/i,
    /\b(TypeError|ReferenceError|SyntaxError|AttributeError|ImportError|ValueError|KeyError)\b/,
  ],
  refactorer: [
    /\b(refactor|clean ?up|reorganize|restructure|extract|decompose|decouple|consolidate)\b/i,
    /\b(simplify|optimize|improve|modernize|migrate|upgrade|rename|move|split|merge)\b/i,
    /\b(too (complex|long|messy|coupled|verbose)|hard to (read|maintain|understand|test))\b/i,
    /\b(code smell|technical debt|duplicate code|dead code|over-?engineer)\b/i,
  ],
  'test-writer': [
    /\b(test|spec|coverage|assert|mock|stub|spy|snapshot|fixture|suite)\b/i,
    /\b(unit ?test|integration ?test|e2e|end-?to-?end|tdd|bdd)\b/i,
    /\b(write (a |the |some )?tests?|add tests?|create tests?|generate tests?)\b/i,
    /\b(vitest|jest|pytest|mocha|chai|cypress|playwright|testing-library)\b/i,
  ],
  reviewer: [
    /\b(review|audit|critique|evaluate|assess|appraise|examine|inspect)\b/i,
    /\b(check (this|my|the)|look (at|over)|analyze|scan|lint|validate)\b/i,
    /\b(code quality|best practice|code style|convention|anti-?pattern|smell)\b/i,
    /\b(is this (correct|right|good|ok|proper|safe)|does this look|what do you think|feedback on)\b/i,
  ],
}

/**
 * Classify a task string into the most appropriate agent role.
 *
 * @param {string} task  Raw task description
 * @returns {{
 *   role: AgentRole,
 *   confidence: number,
 *   scores: Record<AgentRole, number>,
 *   signals: string[],
 * }}
 */
export function classifyTask(task = '') {
  const text = String(task).trim()
  /** @type {Record<string, number>} */
  const scores = {}

  for (const [role, patterns] of Object.entries(ROLE_PATTERNS)) {
    let score = 0
    for (const pattern of patterns) {
      if (pattern.test(text)) score += 1
    }
    scores[role] = score
  }

  // Find top role (default 'planner' when no signals fire)
  let topRole = /** @type {AgentRole} */ ('planner')
  let topScore = 0
  for (const [role, score] of Object.entries(scores)) {
    if (score > topScore) {
      topScore = score
      topRole = /** @type {AgentRole} */ (role)
    }
  }

  // Confidence: 0.30 when no signal, scales toward 0.95 as patterns match
  const totalPatterns = ROLE_PATTERNS[topRole].length
  const confidence = topScore === 0
    ? 0.30
    : Math.min(0.95, 0.40 + (topScore / totalPatterns) * 0.55)

  const signals = ROLE_PATTERNS[topRole]
    .filter(p => p.test(text))
    .map(p => p.source.slice(0, 60))

  return { role: topRole, confidence, scores, signals }
}
