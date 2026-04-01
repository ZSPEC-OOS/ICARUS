import { enforceStructuredPrompt } from './structuredPrompting.js'
import { retrieveContext } from './ragService.js'
import { runCritiquePass } from './critiqueMiddleware.js'
import { createReliabilityLoopFSM } from '../reliability/fsm.js'
import { memoryGraphService } from '../memoryGraphService.js'
import { setTraceLoopState, traceOrchestrationDecision } from '../toolTraceStore.js'
import { packContextSections } from './contextPacker.js'
import { enforceQualityFloor } from './qualityFloor.js'
import { efficiencyMetricsService } from '../efficiency/metricsService.js'
import { classifyTask } from '../orchestration/taskClassifier.js'

/**
 * @typedef {'simple'|'moderate'|'complex'} TaskComplexity
 */

/**
 * Build a configurable deep reasoning workflow runner around existing executor.
 * Integrates planner/rag/critique stages while preserving existing agent loop.
 *
 * @param {object}  options
 * @param {object}  options.enhancerConfig
 * @param {object}  [options.shadowContext]
 * @param {Function} [options.planner]
 * @param {Function} options.runAgent          async (task, ctx) => { text }
 * @param {object}  [options.modelRouter]      Router from createModelRouter — enables per-step dispatch
 * @param {object}  [options.defaultModelConfig]  Fallback model config for router
 * @param {object}  [options.logger]
 * @param {Function} [options.onEvent]
 */
export function createDeepReasoningWorkflow({
  enhancerConfig,
  shadowContext,
  planner,
  runAgent,
  modelRouter = null,
  defaultModelConfig = null,
  logger = console,
  onEvent = () => {},
}) {
  return async function runDeepReasoningTask(task, ctx = {}) {
    const taskId = `deep-${Date.now()}`
    const startedAt = Date.now()
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

          // Per-step model routing: classify the goal to pick the specialist model
          workflow.routing = null
          if (modelRouter && defaultModelConfig) {
            const stepClassification = classifyTask(workflow.structured.contract.goal || task)
            workflow.routing = modelRouter.route(stepClassification, defaultModelConfig)
            const orchCfg = enhancerConfig?.orchestration
            if (orchCfg?.logDecisions) {
              onEvent?.({
                type: 'orchestration',
                source: 'deep_reasoning',
                role: workflow.routing.role,
                confidence: workflow.routing.confidence,
                strategy: workflow.routing.strategy,
                modelId: workflow.routing.modelConfig?.modelId || workflow.routing.modelConfig?.id,
                reasoning: workflow.routing.reasoning,
              })
              traceOrchestrationDecision({
                taskSnippet: String(workflow.structured.contract.goal || task).slice(0, 200),
                role: workflow.routing.role,
                confidence: workflow.routing.confidence,
                strategy: workflow.routing.strategy,
                modelId: workflow.routing.modelConfig?.modelId || workflow.routing.modelConfig?.id || '',
                reasoning: `[deep-reasoning] ${workflow.routing.reasoning}`,
                scores: workflow.routing.scores,
              })
              memoryGraphService.logOrchestrationDecision({
                task: String(workflow.structured.contract.goal || task).slice(0, 160),
                role: workflow.routing.role,
                confidence: workflow.routing.confidence,
                strategy: workflow.routing.strategy,
                modelId: workflow.routing.modelConfig?.modelId || workflow.routing.modelConfig?.id || '',
                modelName: workflow.routing.modelConfig?.name || '',
                reasoning: `[deep-reasoning] ${workflow.routing.reasoning}`,
                scores: workflow.routing.scores,
              })
            }
          }

          const packed = packContextSections([
            { heading: 'TASK', content: workflow.structured.promptText },
            { heading: 'RETRIEVED CONTEXT', content: workflow.retrieval.promptContext || '' },
            { heading: 'PLAN', content: plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') },
          ], ctx.previousPackedContext || '')
          workflow.executionTask = packed.text
          workflow.packing = packed
          logger.info?.('[deep-reasoning] running task', { complexity, steps: plan.steps.length, role: workflow.routing?.role })
          workflow.result = await runAgent(workflow.executionTask, {
            ...ctx,
            plan,
            complexity,
            retrieval: workflow.retrieval,
            routedModelConfig: workflow.routing?.modelConfig || null,
            orchestrationRole: workflow.routing?.role || null,
          })
          return workflow.result
        },
        verify: async ({ execution }) => {
          const qualityFloor = enforceQualityFloor({
            text: execution?.text || '',
            plan: workflow.plan,
            minChars: enhancerConfig?.deepReasoning?.qualityFloorMinChars ?? 140,
            minPlanSteps: enhancerConfig?.deepReasoning?.qualityFloorMinPlanSteps ?? 1,
          })
          workflow.critique = enhancerConfig?.critique?.enabled
            ? runCritiquePass({
              draftText: execution?.text || '',
              contract: workflow.structured.contract,
              ragContext: workflow.retrieval.contexts,
              config: enhancerConfig.critique,
            })
            : { passed: true, issues: [], summary: 'Critique disabled.' }
          const passed = workflow.critique.passed && qualityFloor.passed
          return {
            passed,
            failedGateIds: passed ? [] : [
              ...(!workflow.critique.passed ? ['critique'] : []),
              ...(!qualityFloor.passed ? ['quality_floor'] : []),
            ],
            gates: [
              { id: 'critique', passed: workflow.critique.passed },
              { id: 'quality_floor', passed: qualityFloor.passed, issues: qualityFloor.issues },
            ],
            critique: workflow.critique,
            qualityFloor,
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
    efficiencyMetricsService.record({
      taskId,
      stage: 'deep_reasoning',
      latencyMs: Date.now() - startedAt,
      inputTokens: Math.ceil((workflow.executionTask || '').length / 4),
      outputTokens: Math.ceil(detailed.length / 4),
      cacheHit: Boolean(workflow.retrieval?.cached),
      meta: { complexity },
    })
    return {
      complexity,
      structuredContract: workflow.structured?.contract,
      plan: workflow.plan || buildFallbackPlan(workflow.structured?.contract || { goal: task }, complexity),
      retrieval: workflow.retrieval,
      critique: workflow.critique,
      contextPacking: workflow.packing || { text: workflow.executionTask || '', stats: [] },
      reliability: {
        state: runState.current,
        history: runState.history,
      },
      orchestration: workflow.routing
        ? { role: workflow.routing.role, confidence: workflow.routing.confidence, strategy: workflow.routing.strategy, modelId: workflow.routing.modelConfig?.modelId || null }
        : null,
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
