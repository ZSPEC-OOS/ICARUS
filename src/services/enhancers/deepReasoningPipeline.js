import { enforceStructuredPrompt } from './structuredPrompting.js'
import { retrieveContext } from './ragService.js'
import { runCritiquePass } from './critiqueMiddleware.js'

/**
 * @typedef {'simple'|'moderate'|'complex'} TaskComplexity
 */

/**
 * Build a configurable deep reasoning workflow runner around existing executor.
 * Integrates planner/rag/critique stages while preserving existing agent loop.
 */
export function createDeepReasoningWorkflow({
  enhancerConfig,
  shadowContext,
  planner,
  runAgent,
  logger = console,
}) {
  return async function runDeepReasoningTask(task, ctx = {}) {
    const complexity = classifyTaskComplexity(task, enhancerConfig?.plannerExecutor)
    const structured = enforceStructuredPrompt(task)

    const plan = planner
      ? await planner({ task: structured.contract, complexity, context: ctx })
      : buildFallbackPlan(structured.contract, complexity)

    const retrieval = enhancerConfig?.rag?.enabled
      ? retrieveContext({ query: structured.contract.goal, shadowContext, config: enhancerConfig.rag })
      : { contexts: [], promptContext: '' }

    const executionTask = [
      structured.promptText,
      retrieval.promptContext ? `\n[RETRIEVED CONTEXT]\n${retrieval.promptContext}` : '',
      `\n[PLAN]\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    ].join('\n')

    logger.info?.('[deep-reasoning] running task', { complexity, steps: plan.steps.length })
    const result = await runAgent(executionTask, { ...ctx, plan, complexity })

    const critique = enhancerConfig?.critique?.enabled
      ? runCritiquePass({
        draftText: result?.text || '',
        contract: structured.contract,
        ragContext: retrieval.contexts,
        config: enhancerConfig.critique,
      })
      : { passed: true, issues: [], summary: 'Critique disabled.' }

    return {
      complexity,
      structuredContract: structured.contract,
      plan,
      retrieval,
      critique,
      concise: summarize(result?.text || ''),
      detailed: result?.text || '',
      text: enhancerConfig?.deepReasoning?.summaryStyle === 'concise_only'
        ? summarize(result?.text || '')
        : `${summarize(result?.text || '')}\n\n---\n\n${result?.text || ''}`,
    }
  }
}

export function classifyTaskComplexity(task = '', cfg = {}) {
  const size = String(task).trim().length
  const moderate = cfg?.complexityThreshold?.moderate ?? 120
  const complex = cfg?.complexityThreshold?.complex ?? 280
  if (size >= complex) return 'complex'
  if (size >= moderate) return 'moderate'
  return 'simple'
}

function buildFallbackPlan(contract, complexity) {
  const base = [
    `Clarify scope for: ${contract.goal}`,
    'Inspect relevant files and dependencies',
    'Implement changes incrementally',
    'Validate via lint/tests and review edge cases',
  ]
  if (complexity === 'complex') base.splice(2, 0, 'Break work into dependency-ordered subtasks with checkpoints')
  return { steps: base, dependencies: [] }
}

function summarize(text = '') {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return 'No output produced.'
  return cleaned.length <= 280 ? cleaned : `${cleaned.slice(0, 277)}...`
}
