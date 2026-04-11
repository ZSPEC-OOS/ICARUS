// ── interactivePipeline — phase-based execution model ─────────────────────────
// Drives the structured multi-stage pipeline visible in the activity feed.
// Three intelligence layers wired in here:
//   1. Conversation intelligence  — detectIntent, MemoryBlock compression
//   2. Execution realism          — Task model, FileChange, expanded phases
//   3. UX feedback fidelity       — inferPhaseFromTool, descriptive log messages

// ── Phase definitions ─────────────────────────────────────────────────────────
export const PIPELINE_PHASES = [
  'understanding',
  'planning',
  'scoping',
  'coding',
  'reviewing',
  'validating',
  'finalizing',
  'complete',
]

const STEP_LABELS = {
  understanding: 'Understanding',
  planning:      'Planning',
  scoping:       'Scoping',
  coding:        'Coding',
  reviewing:     'Reviewing',
  validating:    'Validating',
  finalizing:    'Finalizing',
  complete:      'Complete',
}

// ── Intent detection ──────────────────────────────────────────────────────────
// Layer 1: classify user input to drive downstream behavior rules.

export const INTENTS = /** @type {const} */ ([
  'new_feature',
  'modify_existing',
  'debug',
  'explain',
  'refactor',
])

/** @typedef {'new_feature'|'modify_existing'|'debug'|'explain'|'refactor'} Intent */

const INTENT_PATTERNS = [
  { intent: 'debug',           re: /\b(debug|fix|bug|broken|error|failing|issue|crash|exception|why (is|does|isn't|doesn't))\b/i },
  { intent: 'refactor',        re: /\b(refactor|clean up|reorgani[sz]e|rename|extract|simplify|dedup|improve structure)\b/i },
  { intent: 'explain',         re: /\b(explain|describe|how (does|do|is)|what (is|does|are)|why (is|does)|walk me through|show me how|understand)\b/i },
  { intent: 'modify_existing', re: /\b(update|change|modify|edit|adjust|tweak|extend|improve|upgrade|migrate|replace)\b/i },
  { intent: 'new_feature',     re: /\b(add|create|build|implement|make|generate|write|scaffold|new|introduce)\b/i },
]

/**
 * Detect the user's intent from their input text.
 * Rules: debug > refactor > explain > modify_existing > new_feature
 * @param {string} input
 * @returns {Intent}
 */
export function detectIntent(input = '') {
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(input)) return intent
  }
  return 'new_feature'
}

/** Human-readable label for each intent */
export const INTENT_LABELS = {
  new_feature:     'New Feature',
  modify_existing: 'Modify',
  debug:           'Debug',
  explain:         'Explain',
  refactor:        'Refactor',
}

// ── Task model ────────────────────────────────────────────────────────────────
// Layer 2: per-request task tracking with step lifecycle.

/**
 * @typedef {{ id: string, goal: string, status: 'active'|'completed'|'interrupted', steps: string[], currentStep: number }} Task
 */

/** Create a new Task for the given user goal */
export function createTask(goal = '') {
  return {
    id:          `task-${Date.now()}`,
    goal:        goal.slice(0, 120),
    status:      'active',
    steps:       [],
    currentStep: 0,
  }
}

// ── FileChange model ──────────────────────────────────────────────────────────
// Layer 2: track file-level changes with diff/content.

/**
 * @typedef {{ path: string, type: 'create'|'update'|'delete', content?: string, diff?: string }} FileChange
 */

/** Create a FileChange record from an agent file_write event */
export function createFileChange(path, action) {
  return {
    path,
    type: action === 'write' ? 'create' : action === 'edit' ? 'update' : 'delete',
  }
}

// ── Phase inference from tool usage ──────────────────────────────────────────
// Layer 3: infer the current pipeline phase from what tool the agent just called.
// This drives the live phase indicator without needing the model to emit phase events.

const TOOL_PHASE_MAP = {
  analyze_codebase:    'scoping',
  list_directory:      'scoping',
  list_source_directory: 'scoping',
  search_files:        'scoping',
  grep:                'scoping',
  read_file:           'scoping',
  read_many_files:     'scoping',
  read_source_file:    'scoping',
  todo:                'planning',
  write_file:          'coding',
  edit_file:           'coding',
  delete_file:         'coding',
  run_command:         'validating',
  lint_file:           'validating',
  create_pull_request: 'finalizing',
  update_memory:       'finalizing',
  revert_file:         'coding',
  web_search:          'scoping',
  hybrid_search:       'scoping',
  retrieve_context:    'scoping',
  web_fetch:           'scoping',
}

/**
 * Infer the pipeline phase from the name of the tool being called.
 * @param {string} toolName
 * @returns {string} phase key
 */
export function inferPhaseFromTool(toolName) {
  return TOOL_PHASE_MAP[toolName] || 'coding'
}

// ── Human-readable tool log messages ─────────────────────────────────────────
// Layer 3: map each tool call to a descriptive activity message so the feed
// reads like "Analyzing existing route structure…" rather than raw JSON.

/**
 * @param {string} name  tool name
 * @param {object} input tool input
 * @returns {string}
 */
export function toolToLogMessage(name, input = {}) {
  switch (name) {
    case 'analyze_codebase':    return 'Analyzing codebase architecture…'
    case 'read_file':           return `Reading ${input.path || 'file'}…`
    case 'read_many_files':     return `Reading ${input.paths?.length ?? 'multiple'} files…`
    case 'write_file':          return `Writing ${input.path || 'file'}…`
    case 'edit_file':           return `Editing ${input.path || 'file'}…`
    case 'delete_file':         return `Deleting ${input.path || 'file'}…`
    case 'revert_file':         return `Reverting ${input.path || 'file'}…`
    case 'list_directory':      return `Scanning ${input.path || 'root'}/…`
    case 'list_source_directory': return `Scanning source ${input.path || 'root'}/…`
    case 'read_source_file':    return `Reading source ${input.path || 'file'}…`
    case 'search_files':        return `Searching for "${(input.query || '').slice(0, 40)}"…`
    case 'grep':                return `Grepping for \`${(input.pattern || '').slice(0, 40)}\`…`
    case 'run_command':         return `Running: ${(input.cmd || '').slice(0, 60)}…`
    case 'lint_file':           return `Linting ${input.path || 'file'}…`
    case 'get_diff':            return input.path ? `Diffing ${input.path}…` : `Reviewing branch diff (${input.base || 'main'}...${input.head || 'HEAD'})…`
    case 'type_check':          return input.path ? `Type-checking ${input.path}…` : 'Running TypeScript type check…'
    case 'run_tests':           return input.path ? `Running tests in ${input.path}…` : 'Running test suite…'
    case 'web_search':          return `Searching web: "${(input.query || '').slice(0, 40)}"…`
    case 'hybrid_search':       return `Running hybrid retrieval for "${(input.query || '').slice(0, 40)}"…`
    case 'retrieve_context':    return `Retrieving grounded context for "${(input.query || '').slice(0, 40)}"…`
    case 'web_fetch':           return `Fetching ${(input.url || '').slice(0, 50)}…`
    case 'create_pull_request': return `Creating PR: "${(input.title || '').slice(0, 50)}"…`
    case 'update_memory':       return 'Saving note to BLUSWAN.md…'
    case 'todo': {
      const act = input.action || ''
      const t   = (input.task || '').slice(0, 60)
      if (act === 'add')         return `Task queued: ${t}`
      if (act === 'in_progress') return `Working on: ${t}`
      if (act === 'done')        return `Completed: ${t}`
      return `todo(${act}): ${t}`
    }
    default: return `${name}…`
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
export const COMMANDS = new Set([
  '/plan', '/code', '/diff', '/explain', '/reset',
  '/files', '/logs', '/resume',
])

// ── Message factory ───────────────────────────────────────────────────────────

/** @returns {object} fresh assistant message with all intelligence-layer fields */
export function createAssistantMessage(id = `${Date.now()}`) {
  return {
    id,
    role:       'assistant',
    phase:      'understanding',
    intent:     null,   // Layer 1: detected intent
    task:       null,   // Layer 2: active Task object
    steps:      createPipelineSteps('understanding').map(({ label, state }) => ({ label, state })),
    content:    '',
    code:       '',
    validation: [],
    plan:       [],
    scope:      [],     // Layer 2: scoped file list
    diffs:      [],     // Layer 2: FileChange[]
    logs:       [],     // Layer 3: log stream entries
  }
}

// ── Pipeline step builder ─────────────────────────────────────────────────────

export function createPipelineSteps(activePhase = 'understanding') {
  const activeIndex = PIPELINE_PHASES.indexOf(activePhase)
  return PIPELINE_PHASES.map((phase, idx) => ({
    key:   phase,
    label: STEP_LABELS[phase],
    state: idx < activeIndex ? 'done' : idx === activeIndex ? 'active' : 'pending',
  }))
}

// ── Stream event factory + reducer ───────────────────────────────────────────

export function createStreamEvent(type, payload = {}) {
  return { type, ...payload }
}

/**
 * Apply a stream event to an assistant message (immutable update).
 * Handles all event types including the three new intelligence-layer types.
 */
export function applyStreamEvent(message, event) {
  if (!message || !event) return message
  const next = { ...message }

  switch (event.type) {
    case 'status':
      if (event.phase) {
        next.phase = event.phase
        next.steps = createPipelineSteps(event.phase).map(({ label, state }) => ({ label, state }))
      }
      break

    case 'intent':                                             // Layer 1
      if (event.intent) next.intent = event.intent
      break

    case 'task':                                               // Layer 2
      if (event.task)  next.task = { ...next.task, ...event.task }
      break

    case 'plan':
      if (Array.isArray(event.steps)) next.plan = event.steps
      break

    case 'scope':                                              // Layer 2
      if (Array.isArray(event.files)) next.scope = event.files
      break

    case 'content':
      if (event.chunk) next.content = `${next.content || ''}${event.chunk}`
      break

    case 'code':
      if (event.chunk) next.code = `${next.code || ''}${event.chunk}`
      break

    case 'diff':                                               // Layer 2
      if (event.file) {
        next.diffs = [
          ...(next.diffs || []),
          { path: event.file, type: 'update', diff: event.changes },
        ]
      }
      break

    case 'log':                                                // Layer 3
      if (event.message) next.logs = [...(next.logs || []), event.message]
      break

    case 'validation':
      if (Array.isArray(event.results)) next.validation = [...event.results]
      break

    default: break
  }

  return next
}

// ── Command parser ────────────────────────────────────────────────────────────

export function parsePromptCommand(raw = '') {
  const text = raw.trim()
  const [first, ...rest] = text.split(/\s+/)
  if (!COMMANDS.has(first)) return { command: null, content: text }
  return { command: first, content: rest.join(' ').trim() }
}

// ── Memory compression ────────────────────────────────────────────────────────
// Layer 1: compact prior conversation into a MemoryBlock for context injection.

/**
 * @typedef {{ summary: string, keyCodeSnippets: string[], decisions: string[] }} MemoryBlock
 */

/**
 * Compress a conversation message array into a MemoryBlock.
 * Extracts code snippets and decision sentences from assistant turns.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {MemoryBlock}
 */
export function compressToMemoryBlock(messages = []) {
  const keyCodeSnippets = []
  const decisions       = []

  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content !== 'string') continue

    // Extract first code block per message (capped)
    const codeMatch = msg.content.match(/```[\w]*\n([\s\S]{20,300})```/)
    if (codeMatch) keyCodeSnippets.push(codeMatch[1].trim().slice(0, 200))

    // Extract decision-like sentences
    const lines = msg.content.split('\n')
    for (const line of lines) {
      if (/^\s*(I (will|'ll|'ve|am)|Let me|Going to|Will |Added |Created |Updated |Fixed |Removed )/i.test(line.trim())) {
        decisions.push(line.trim().slice(0, 100))
      }
    }
  }

  const turns = Math.floor(messages.length / 2)
  return {
    summary:         `${turns} prior turn${turns !== 1 ? 's' : ''} in this session`,
    keyCodeSnippets: keyCodeSnippets.slice(0, 5),
    decisions:       decisions.slice(0, 8),
  }
}

/**
 * Render a MemoryBlock as a compact digest string for system prompt injection.
 * @param {MemoryBlock} block
 * @returns {string}
 */
export function buildMemoryDigest(block) {
  if (!block) return ''
  const lines = [`[MEMORY DIGEST — ${block.summary}]`]
  if (block.decisions.length)
    lines.push('Prior decisions:', ...block.decisions.map(d => `  • ${d}`))
  if (block.keyCodeSnippets.length)
    lines.push('Key code context:', ...block.keyCodeSnippets.map(s => `  \`\`\`\n  ${s}\n  \`\`\``))
  return lines.join('\n')
}

// ── Structured output formatter ───────────────────────────────────────────────

export function formatStructuredOutput({
  summary    = '',
  plan       = [],
  code       = '',
  changes    = [],
  validation = [],
  notes      = [],
  codeLang   = '',
}) {
  const planLines       = plan.length       ? plan.map((step, i) => `${i + 1}. ${step}`).join('\n')    : '- No plan steps recorded.'
  const changeLines     = changes.length    ? changes.map((c) => `- ${c}`).join('\n')                  : '- No file-level changes listed.'
  const validationLines = validation.length ? validation.map((v) => `- ${v}`).join('\n')               : '- Validation not run.'
  const noteLines       = notes.length      ? notes.map((n) => `- ${n}`).join('\n')                    : '- None.'
  const codeBlock       = code
    ? `\n\n## Code\n\n\`\`\`${codeLang || 'text'}\n${code}\n\`\`\``
    : '\n\n## Code\n\n_No code output for this command._'

  return [
    '## Summary',
    summary || 'Completed request.',
    '',
    '## Plan',
    planLines,
    codeBlock,
    '',
    '## Changes',
    changeLines,
    '',
    '## Validation',
    validationLines,
    '',
    '## Notes',
    noteLines,
  ].join('\n')
}
