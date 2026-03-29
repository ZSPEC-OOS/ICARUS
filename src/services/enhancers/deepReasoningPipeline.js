import { enforceStructuredPrompt } from './structuredPrompting.js'
import { retrieveContext } from './ragService.js'
import { runCritiquePass } from './critiqueMiddleware.js'
import { createReliabilityLoopFSM } from '../reliability/fsm.js'
import { memoryGraphService } from '../memoryGraphService.js'
import { setTraceLoopState } from '../toolTraceStore.js'

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
  onEvent = () => {},
}) {
  return async function runDeepReasoningTask(task, ctx = {}) {
    const complexity = classifyTaskComplexity(task, enhancerConfig?.plannerExecutor)
    memoryGraphService.init()

    const workflow = {
      structured: null,
      plan: null,
      retrieval: { contexts: [], promptContext: '' },
      result: null,
      critique: { passed: true, issues: [], summary: 'Not run yet.' },
      executionTask: '',
    }

    const fsm = createReliabilityLoopFSM({
      task,
      memoryGraphService,
      onEvent: (event) => {
        if (event?.type === 'fsm_state') {
          const phase = event.state
          setTraceLoopState({
            workflow: 'deep_reasoning',
            phase,
            complexity,
            at: new Date().toISOString(),
          })
        }
        onEvent?.(event)
      },
      handlers: {
        plan: async () => {
          workflow.structured = enforceStructuredPrompt(task)
          workflow.plan = planner
            ? await planner({ task: workflow.structured.contract, complexity, context: ctx })
            : buildFallbackPlan(workflow.structured.contract, complexity)
          return workflow.plan
        },
        execute: async (plan) => {
          workflow.retrieval = enhancerConfig?.rag?.enabled
            ? retrieveContext({ query: workflow.structured.contract.goal, shadowContext, config: enhancerConfig.rag })
            : { contexts: [], promptContext: '' }
          workflow.executionTask = [
            workflow.structured.promptText,
            workflow.retrieval.promptContext ? `\n[RETRIEVED CONTEXT]\n${workflow.retrieval.promptContext}` : '',
            `\n[PLAN]\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
          ].join('\n')
          logger.info?.('[deep-reasoning] running task', { complexity, steps: plan.steps.length })
          workflow.result = await runAgent(workflow.executionTask, { ...ctx, plan, complexity, retrieval: workflow.retrieval })
          return workflow.result
        },
        verify: async ({ execution }) => {
          workflow.critique = enhancerConfig?.critique?.enabled
            ? runCritiquePass({
              draftText: execution?.text || '',
              contract: workflow.structured.contract,
              ragContext: workflow.retrieval.contexts,
              config: enhancerConfig.critique,
            })
            : { passed: true, issues: [], summary: 'Critique disabled.' }
          return {
            passed: workflow.critique.passed,
            failedGateIds: workflow.critique.passed ? [] : ['critique'],
            gates: [{ id: 'critique', passed: workflow.critique.passed }],
            critique: workflow.critique,
          }
        },
        rollback: async () => ({
          rolledBack: false,
          strategy: 'manual_review',
          message: 'Deep reasoning run failed critique; preserving output for manual review.',
        }),
      },
    })

    let runState
    try {
      runState = await fsm.run()
    } finally {
      setTraceLoopState(null)
    }

    const detailed = workflow.result?.text || ''
    const concise = summarize(detailed)
    const failedLoop = runState.current !== 'done' || !workflow.critique?.passed
    return {
      complexity,
      structuredContract: workflow.structured?.contract,
      plan: workflow.plan || buildFallbackPlan(workflow.structured?.contract || { goal: task }, complexity),
      retrieval: workflow.retrieval,
      critique: workflow.critique,
      reliability: {
        state: runState.current,
        history: runState.history,
      },
      concise,
      detailed,
      text: enhancerConfig?.deepReasoning?.summaryStyle === 'concise_only'
        ? concise
        : `${concise}${failedLoop ? '\n\n[Reliability loop] Verification reported issues.' : ''}\n\n---\n\n${detailed}`,
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
