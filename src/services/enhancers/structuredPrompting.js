// ─── Structured Prompting Contract ───────────────────────────────────────────
// Enforces a stable schema for user intent and execution criteria. This helps
// planner/executor and critique stages reason over explicit fields.

const HEADERS = {
  goal: 'Goal',
  constraints: 'Constraints',
  inputs: 'Inputs/Data',
  expectedOutputs: 'Expected Output/Format',
  acceptanceTests: 'Acceptance Tests/Verification',
}

/**
 * @typedef {object} StructuredPromptContract
 * @property {string} goal
 * @property {string[]} constraints
 * @property {string[]} inputs
 * @property {string[]} expectedOutputs
 * @property {string[]} acceptanceTests
 */

/**
 * @param {Partial<StructuredPromptContract>} draft
 * @returns {{ok:boolean,errors:string[],value:StructuredPromptContract}}
 */
export function validateStructuredContract(draft = {}) {
  const errors = []
  const value = {
    goal: typeof draft.goal === 'string' ? draft.goal.trim() : '',
    constraints: normalizeList(draft.constraints),
    inputs: normalizeList(draft.inputs),
    expectedOutputs: normalizeList(draft.expectedOutputs),
    acceptanceTests: normalizeList(draft.acceptanceTests),
  }

  if (!value.goal) errors.push('goal is required')
  if (value.goal.length > 800) errors.push('goal is too long (max 800 chars)')

  for (const [k, list] of Object.entries(value)) {
    if (k === 'goal') continue
    if (!Array.isArray(list)) errors.push(`${k} must be an array`) // safety
    if (list.some(item => item.length > 500)) errors.push(`${k} contains entries over 500 chars`)
  }

  return { ok: errors.length === 0, errors, value }
}

function normalizeList(maybeList) {
  if (!Array.isArray(maybeList)) return []
  return maybeList
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .slice(0, 20)
}

/**
 * Parse free-form user text into the structured contract.
 * Lightweight heuristic parser keeps backward compatibility with existing input.
 * @param {string} task
 * @returns {StructuredPromptContract}
 */
export function parseStructuredPrompt(task = '') {
  const sections = {
    goal: task.trim(),
    constraints: [],
    inputs: [],
    expectedOutputs: [],
    acceptanceTests: [],
  }

  const lower = task.toLowerCase()
  const hasBulletSections = /constraints?:|inputs?:|expected|acceptance|tests?:/i.test(task)
  if (!hasBulletSections) return sections

  const blocks = task.split(/\n(?=\s*(goal|constraints?|inputs?|expected outputs?|acceptance tests?)\s*:)/i)
  for (const block of blocks) {
    const m = block.match(/^\s*(goal|constraints?|inputs?|expected outputs?|acceptance tests?)\s*:\s*([\s\S]*)$/i)
    if (!m) continue
    const key = mapHeaderToKey(m[1])
    const payload = m[2]
    if (key === 'goal') {
      sections.goal = payload.trim() || sections.goal
      continue
    }
    sections[key] = payload
      .split('\n')
      .map(line => line.replace(/^\s*[-*\d.)]+\s*/, '').trim())
      .filter(Boolean)
  }

  return sections
}

function mapHeaderToKey(raw = '') {
  const h = raw.toLowerCase()
  if (h.startsWith('goal')) return 'goal'
  if (h.startsWith('constraint')) return 'constraints'
  if (h.startsWith('input')) return 'inputs'
  if (h.startsWith('expected')) return 'expectedOutputs'
  return 'acceptanceTests'
}

/**
 * Builds canonical prompt text injected into model messages.
 * @param {StructuredPromptContract} contract
 * @returns {string}
 */
export function buildStructuredPromptText(contract) {
  const lines = ['[STRUCTURED EXECUTION CONTRACT]']
  lines.push(`${HEADERS.goal}: ${contract.goal}`)
  lines.push(formatListSection('constraints', contract.constraints))
  lines.push(formatListSection('inputs', contract.inputs))
  lines.push(formatListSection('expectedOutputs', contract.expectedOutputs))
  lines.push(formatListSection('acceptanceTests', contract.acceptanceTests))
  return lines.join('\n')
}

function formatListSection(key, items) {
  const title = HEADERS[key]
  if (!items?.length) return `${title}: (none provided)`
  return `${title}:\n${items.map((item, idx) => `  ${idx + 1}. ${item}`).join('\n')}`
}

/**
 * Middleware helper: convert raw task into normalized task text.
 * @param {string} task
 * @returns {{contract: StructuredPromptContract, promptText: string, errors: string[]}}
 */
export function enforceStructuredPrompt(task = '') {
  const parsed = parseStructuredPrompt(task)
  const validated = validateStructuredContract(parsed)
  const contract = validated.value
  return {
    contract,
    promptText: buildStructuredPromptText(contract),
    errors: validated.errors,
  }
}
