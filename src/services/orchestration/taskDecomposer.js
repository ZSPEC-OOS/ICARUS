// ─── Task Decomposer ──────────────────────────────────────────────────────────
// Detects compound/complex tasks, splits them into role-stamped subtasks, and
// runs parallel single-shot model analyses for each role.  The merged result is
// injected as structured context before the main agent loop begins, giving the
// model a pre-computed multi-perspective work breakdown without spawning
// recursive full-loop sub-agents (which would create depth / cost problems).
//
// Integration: called from agentLoop.js when plannerExecutor.enabled=true and
// task complexity exceeds DECOMPOSE_COMPLEXITY_THRESHOLD.
//
// Architecture:
//   task → scoreComplexity() → [SubTask, …]
//        → parallel callModel(role-system-prompt) per subtask
//        → mergeAnalyses()
//        → context block injected into first user message

import { classifyTask, AGENT_ROLES } from './taskClassifier.js'
import { callWithToolsStreaming } from '../aiService.js'
import {
  DECOMPOSE_COMPLEXITY_THRESHOLD,
  DECOMPOSE_MAX_SUBTASKS,
} from '../../config/constants.js'

// ── Role system prompts ───────────────────────────────────────────────────────
// Each role gets a focused one-shot prompt that extracts the sub-problem
// relevant to that specialist.  No tool calls — pure reasoning output.

const ROLE_SYSTEM_PROMPTS = {
  planner: `You are a software architect. Given a compound task, extract and outline the DESIGN and PLANNING sub-problem only.
Describe: (1) what needs to be created/modified at a high level, (2) key dependencies or constraints, (3) suggested file locations.
Be concise — 3–8 bullet points. Do not write code. Do not address testing or debugging concerns.`,

  debugger: `You are a debugging specialist. Given a compound task, extract and analyse the BUG-FIX or ROOT CAUSE sub-problem only.
Describe: (1) the likely root cause, (2) where in the codebase to look, (3) the minimal fix strategy.
Be concise — 3–8 bullet points. Do not write code or address feature work.`,

  refactorer: `You are a refactoring specialist. Given a compound task, extract the CODE QUALITY / RESTRUCTURING sub-problem only.
Describe: (1) what needs to be simplified or reorganised, (2) the safest refactoring sequence, (3) risk of breaking changes.
Be concise — 3–8 bullet points. Do not address new feature work or tests.`,

  'test-writer': `You are a test engineering specialist. Given a compound task, extract the TESTING sub-problem only.
Describe: (1) what behaviours need test coverage, (2) what test type is appropriate (unit/integration/e2e), (3) key edge cases.
Be concise — 3–8 bullet points. Do not address implementation or bug fixes.`,

  reviewer: `You are a code reviewer. Given a compound task, extract the CODE REVIEW / QUALITY GATE sub-problem only.
Describe: (1) what quality concerns exist, (2) security or API-stability risks, (3) conventions to check.
Be concise — 3–8 bullet points. Do not address implementation details.`,
}

// ── Complexity scoring ────────────────────────────────────────────────────────
// Returns an integer score: 0 = trivial, ≥ DECOMPOSE_COMPLEXITY_THRESHOLD = complex.
function scoreComplexity(task = '') {
  const text = String(task).trim()
  let score = 0

  // Word count
  const words = text.split(/\s+/).filter(Boolean).length
  if (words > 40)  score += 1
  if (words > 100) score += 1
  if (words > 220) score += 1

  // Multiple distinct action verbs
  const actions = (text.match(
    /\b(fix|add|implement|refactor|write|test|review|update|create|delete|move|rename|migrate|debug|document|deploy)\b/gi
  ) || []).length
  if (actions >= 2) score += 1
  if (actions >= 4) score += 2

  // Explicit sequencing conjunctions
  const seqWords = (text.match(
    /\b(and then|then|also|additionally|furthermore|as well as|plus|next|finally|afterwards)\b/gi
  ) || []).length
  if (seqWords >= 1) score += 1
  if (seqWords >= 3) score += 1

  // Multi-role signal (how many distinct role keyword sets fire)
  const roleScores = Object.entries(classifyTask(text).scores || {})
  const activeRoles = roleScores.filter(([, s]) => s > 0).length
  if (activeRoles >= 2) score += 2
  if (activeRoles >= 3) score += 2

  return score
}

// ── Subtask text splitter ─────────────────────────────────────────────────────
// Splits a compound task on natural clause boundaries.
// Falls back to the original text when splitting produces only one clause.
function splitIntoSubtaskTexts(task) {
  const text = String(task).trim()
  const parts = text
    .split(/(?:\s*\.\s+(?=[A-Z])|\s*;\s*|\s+and then\s+|\s+then\s+|\s+after (?:that|which)\s+|\s+finally\s+)/i)
    .map(p => p.trim())
    .filter(p => p.split(/\s+/).length >= 5)  // drop fragments shorter than 5 words

  return (parts.length >= 2 && parts.length <= DECOMPOSE_MAX_SUBTASKS)
    ? parts
    : [text]
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * Create a task decomposer that is bound to a specific event emitter.
 *
 * @param {{ onEvent?: Function }} opts
 * @returns {{ decomposeTask: Function, runDecomposition: Function }}
 */
export function createTaskDecomposer({ onEvent = () => {} } = {}) {

  /**
   * Analyse task complexity and build a subtask plan.
   * Pure — no I/O, no async.
   *
   * @param {string} task
   * @returns {{ complex: boolean, complexity: number, subtasks: SubTask[] }}
   */
  function decomposeTask(task) {
    const complexity = scoreComplexity(task)
    if (complexity < DECOMPOSE_COMPLEXITY_THRESHOLD) {
      return { complex: false, complexity, subtasks: [] }
    }

    const texts = splitIntoSubtaskTexts(task)
    const subtasks = texts.map((description, idx) => {
      const { role, confidence, scores } = classifyTask(description)
      return {
        id: `st-${idx}`,
        description,
        role,
        confidence,
        scores,
        dependsOn: [],   // all independent for Phase 1; DAG edges reserved for Phase 2
      }
    })

    // If every subtask landed on the same role, also add the top-2 other roles
    // so we get at least two perspectives on complex single-domain tasks.
    const uniqueRoles = new Set(subtasks.map(s => s.role))
    if (uniqueRoles.size === 1 && subtasks.length === 1) {
      const topRole = subtasks[0].role
      const otherRoles = AGENT_ROLES.filter(r => r !== topRole).slice(0, 1)
      for (const role of otherRoles) {
        subtasks.push({ id: `st-${subtasks.length}`, description: task, role, confidence: 0.5, scores: {}, dependsOn: [] })
      }
    }

    return { complex: true, complexity, subtasks }
  }

  /**
   * Execute the decomposition: run parallel role-specific analyses via single-shot
   * model calls (no tool loops), then merge into a context block.
   *
   * @param {SubTask[]} subtasks
   * @param {{ modelConfig: object, signal?: AbortSignal }} opts
   * @returns {Promise<string>}  Merged context block for injection into agent loop
   */
  async function runDecomposition(subtasks, { modelConfig, signal }) {
    if (!subtasks.length) return ''

    onEvent({ type: 'decompose_start', subtaskCount: subtasks.length, roles: subtasks.map(s => s.role) })

    const isAnthropic = modelConfig.provider === 'anthropic' ||
      (!modelConfig.provider && modelConfig.baseUrl?.includes('api.anthropic.com'))

    // Run all sub-analyses in parallel — single model call per subtask, no tools.
    const settled = await Promise.allSettled(subtasks.map(async (subtask) => {
      onEvent({ type: 'subtask_start', subtaskId: subtask.id, role: subtask.role })

      const rolePrompt = ROLE_SYSTEM_PROMPTS[subtask.role] || ROLE_SYSTEM_PROMPTS.planner
      const messages = [
        ...(isAnthropic ? [] : [{ role: 'system', content: rolePrompt }]),
        { role: 'user', content: `Task: ${subtask.description}` },
      ]
      const systemField = isAnthropic ? rolePrompt : undefined

      try {
        const result = await callWithToolsStreaming(
          modelConfig,
          messages,
          [],       // no tools — pure reasoning call
          signal,
          systemField,
          null,     // no streaming delta callback needed
        )
        const text = result?.text?.trim() || '(no analysis)'
        onEvent({ type: 'subtask_done', subtaskId: subtask.id, role: subtask.role, success: true })
        return { subtask, text }
      } catch (err) {
        if (err?.name === 'AbortError') throw err
        onEvent({ type: 'subtask_done', subtaskId: subtask.id, role: subtask.role, success: false, error: err.message })
        return { subtask, text: `(analysis unavailable: ${err.message})` }
      }
    }))

    const analyses = settled
      .map(r => r.status === 'fulfilled' ? r.value : null)
      .filter(Boolean)

    const merged = mergeAnalyses(analyses)
    onEvent({ type: 'decompose_done', analysisCount: analyses.length })
    return merged
  }

  return { decomposeTask, runDecomposition }
}

// ── Result merger ─────────────────────────────────────────────────────────────
function mergeAnalyses(analyses) {
  if (!analyses.length) return ''
  const sections = analyses.map(({ subtask, text }) => {
    const badge = subtask.role.toUpperCase().replace('-', ' ')
    return `[${badge} ANALYSIS]\n${text}`
  })
  return [
    '=== Multi-Role Pre-Analysis ===',
    'The following specialist analyses were computed before execution begins.',
    'Use them to inform your implementation strategy.',
    '',
    sections.join('\n\n'),
    '=== End Pre-Analysis ===',
  ].join('\n')
}

/**
 * @typedef {{
 *   id: string,
 *   description: string,
 *   role: string,
 *   confidence: number,
 *   scores: object,
 *   dependsOn: string[],
 * }} SubTask
 */
