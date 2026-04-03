import { callWithToolsStreaming } from './aiService.js'
import { AGENT_MAX_TURNS, AGENT_KEEP_TURNS } from '../config/constants.js'
import { resolveEnhancerConfig } from './enhancers/config.js'
import { enforceStructuredPrompt } from './enhancers/structuredPrompting.js'
import { memoryGraphService } from './memoryGraphService.js'
import { createReliabilityLoopFSM } from './reliability/fsm.js'
import { evaluateReliabilityGates, detectApiSignatureChange, evaluateBenchmarkRegressionGate } from './reliability/gateEvaluators.js'
import { createRollbackHandler } from './reliability/rollbackHandler.js'
import { setTraceLoopState, traceOrchestrationDecision, traceOrchestrationFallback } from './toolTraceStore.js'
import { semanticCacheService } from './efficiency/cacheService.js'
import { efficiencyMetricsService } from './efficiency/metricsService.js'
import { packContextSections } from './enhancers/contextPacker.js'
import { enforceQualityFloor } from './enhancers/qualityFloor.js'
import { createModelRouter } from './orchestration/modelRouter.js'

function makeSessionDiary() {
  const filesRead = new Set()
  const filesChanged = []
  const textSnippets = []
  return {
    onFileRead(path) { filesRead.add(path) },
    onFileWrite(path, action) { filesChanged.push({ path, action }) },
    onModelText(text) {
      const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 120)
      if (snippet.length > 20) textSnippets.push(snippet)
    },
    hasContent() { return filesRead.size > 0 || filesChanged.length > 0 || textSnippets.length > 0 },
    buildDigest(droppedTurns) {
      const lines = [`[SESSION DIGEST — ${droppedTurns} earlier turn${droppedTurns !== 1 ? 's' : ''} compacted to free context space]`]
      if (filesRead.size > 0) lines.push(`Files read: ${[...filesRead].slice(0, 20).join(', ')}`)
      if (filesChanged.length > 0) lines.push(`Files changed: ${filesChanged.map(f => `${f.path} (${f.action})`).join(', ')}`)
      if (textSnippets.length > 0) {
        lines.push('Key progress notes:')
        textSnippets.slice(-6).forEach(s => lines.push(`  • ${s}`))
      }
      return lines.join('\n')
    },
  }
}

const EDIT_FAILURE_REMINDER =
  '[REMINDER] edit_file requires exact whitespace in old_str. Use grep to find the exact text, or read_file with start_line/end_line. The diagnostic above shows the nearest matching lines.'

const LOOP_WINDOW = 3
const CACHEABLE_TOOLS = new Set(['analyze_codebase', 'read_file', 'read_many_files', 'list_directory', 'search_files', 'grep'])
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'revert_file'])

function toolSignature(toolCalls) {
  return toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.input).slice(0, 100)}`).sort().join('|')
}

function stripReadWrapper(raw = '') {
  return String(raw).replace(/^---[^\n]*---\n?/, '')
}

function buildToolResultMessages(toolCalls, results, isAnthropic, rawAssistantContent) {
  const hadEditFailure = toolCalls.some((tc, i) => tc.name === 'edit_file' && String(results[i] ?? '').startsWith('edit_file failed'))
  if (isAnthropic) {
    return [
      { role: 'assistant', content: rawAssistantContent },
      {
        role: 'user',
        content: [
          ...toolCalls.map((tc, i) => ({ type: 'tool_result', tool_use_id: tc.id, content: String(results[i] ?? '') })),
          ...(hadEditFailure ? [{ type: 'text', text: EDIT_FAILURE_REMINDER }] : []),
        ],
      },
    ]
  }
  return [
    rawAssistantContent,
    ...toolCalls.map((tc, i) => ({ role: 'tool', tool_call_id: tc.id, content: String(results[i] ?? '') })),
    ...(hadEditFailure ? [{ role: 'user', content: EDIT_FAILURE_REMINDER }] : []),
  ]
}

function pruneMessages(messages, diary = null, isAnthropic = false) {
  const head = messages.slice(0, 2)
  const tail = messages.slice(2)
  const keep = AGENT_KEEP_TURNS * 2
  if (tail.length <= keep) return messages
  const droppedCount = Math.floor((tail.length - keep) / 2)
  let trimmed = tail.slice(-keep)
  if (!isAnthropic) {
    const firstNonTool = trimmed.findIndex(m => m.role !== 'tool')
    if (firstNonTool > 0) trimmed = trimmed.slice(firstNonTool)
  }
  if (diary?.hasContent()) return [...head, { role: 'user', content: diary.buildDigest(droppedCount) }, ...trimmed]
  return [...head, ...trimmed]
}

export async function runAgentLoop({
  task,
  systemPrompt,
  tools,
  executeTool,
  modelConfig,
  onEvent,
  signal,
  conversationHistory,
  enhancerConfig: enhancerConfigOverrides,
  availableModels,
}) {
  const enhancerConfig = resolveEnhancerConfig(enhancerConfigOverrides)
  memoryGraphService.init()

  // ── Model Orchestration: classify task → route to specialised model ────────
  const orchCfg = enhancerConfig.orchestration
  const router = createModelRouter(orchCfg, availableModels || [])
  const routeStart = Date.now()
  const routing = router.classifyAndRoute(task, modelConfig)
  const routeDurationMs = Date.now() - routeStart

  // Effective model config — may differ from the caller-supplied default
  let activeModelConfig = routing.modelConfig

  if (orchCfg?.logDecisions) {
    onEvent?.({
      type: 'orchestration',
      role: routing.role,
      confidence: routing.confidence,
      strategy: routing.strategy,
      modelId: activeModelConfig.modelId || activeModelConfig.id,
      reasoning: routing.reasoning,
      scores: routing.scores,
    })
    traceOrchestrationDecision({
      taskSnippet: String(task || '').slice(0, 200),
      role: routing.role,
      confidence: routing.confidence,
      strategy: routing.strategy,
      modelId: activeModelConfig.modelId || activeModelConfig.id || '',
      reasoning: routing.reasoning,
      scores: routing.scores,
      durationMs: routeDurationMs,
    })
    memoryGraphService.logOrchestrationDecision({
      task: String(task || '').slice(0, 160),
      role: routing.role,
      confidence: routing.confidence,
      strategy: routing.strategy,
      modelId: activeModelConfig.modelId || activeModelConfig.id || '',
      modelName: activeModelConfig.name || '',
      reasoning: routing.reasoning,
      scores: routing.scores,
      durationMs: routeDurationMs,
    })
  }

  const isAnthropic = activeModelConfig.provider === 'anthropic' || (!activeModelConfig.provider && activeModelConfig.baseUrl?.includes('api.anthropic.com'))

  const filesChanged = []
  const diary = makeSessionDiary()
  const recentSigs = []
  const taskId = `agent-${Date.now()}`
  const executionTrace = { mutations: [], commandRuns: [] }
  let finalText = ''

  const packedInput = packContextSections([
    { heading: 'TASK', content: enhancerConfig.structuredPrompting.enabled ? enforceStructuredPrompt(task).promptText : task },
  ])

  let messages = [
    ...(isAnthropic ? [] : [{ role: 'system', content: systemPrompt }]),
    ...(conversationHistory?.length ? conversationHistory : []),
    { role: 'user', content: packedInput.text },
  ]
  const anthropicSystemField = isAnthropic ? systemPrompt : undefined

  const rollback = createRollbackHandler({ executeTool, onEvent, memoryGraphService })
  const loopMeta = { workflow: 'agent_loop', task: String(task || '').slice(0, 180) }

  const fsm = createReliabilityLoopFSM({
    task,
    memoryGraphService,
    onEvent: (event) => {
      if (event?.type === 'fsm_state') {
        setTraceLoopState({ ...loopMeta, phase: event.state, at: new Date().toISOString() })
      }
      onEvent?.(event)
    },
    handlers: {
      plan: async () => {
        const structured = enforceStructuredPrompt(task)
        return {
          goal: structured.contract.goal,
          constraints: structured.contract.constraints,
          requiredOutput: structured.contract.requiredOutput,
        }
      },
      execute: async () => {
        for (let turn = 1; turn <= AGENT_MAX_TURNS; turn++) {
          if (signal?.aborted) {
            finalText = 'Agent stopped.'
            return { finalText, filesChanged, mutationTrace: executionTrace.mutations, trace: executionTrace }
          }

          onEvent({ type: 'turn', turn })
          let response
          const turnStarted = Date.now()
          try {
            const modelCacheKey = {
              modelId: activeModelConfig.modelId,
              provider: activeModelConfig.provider || '',
              messages: messages.slice(-6),
            }
            const cachedResponse = semanticCacheService.get('model_response', modelCacheKey)
            if (cachedResponse) {
              response = cachedResponse
              onEvent({ type: 'cache', layer: 'model_response', hit: true })
            } else {
              const callModel = (cfg) => callWithToolsStreaming(cfg, messages, tools, signal, isAnthropic ? anthropicSystemField : undefined, (delta) => onEvent({ type: 'text_delta', delta }))

              if (orchCfg?.enabled && routing.strategy === 'ensemble') {
                const { result, modelsUsed, aggregationStrategy } = await router.callEnsemble(routing, callModel)
                response = result
                onEvent({ type: 'orchestration_ensemble', modelsUsed: modelsUsed.map(m => m.modelId || m.id), aggregationStrategy })
              } else if (orchCfg?.enabled && routing.strategy === 'fallback' && routing.fallbacks.length > 0) {
                const { result, modelUsed, fallbackIndex, usedFallback } = await router.callWithFallback(
                  routing,
                  callModel,
                  ({ fromModel, toModel, error, fallbackIndex: fi }) => {
                    onEvent({ type: 'orchestration_fallback', role: routing.role, fromModelId: fromModel.modelId || fromModel.id, toModelId: toModel.modelId || toModel.id, error: error.message, fallbackIndex: fi })
                    traceOrchestrationFallback({ role: routing.role, fromModelId: fromModel.modelId || fromModel.id || '', toModelId: toModel.modelId || toModel.id || '', error: error.message, fallbackIndex: fi })
                    if (usedFallback) {
                      activeModelConfig = modelUsed
                    }
                  }
                )
                response = result
                if (usedFallback) {
                  activeModelConfig = modelUsed
                  onEvent({ type: 'orchestration_fallback_used', role: routing.role, modelId: modelUsed.modelId || modelUsed.id, fallbackIndex })
                }
              } else {
                response = await callModel(activeModelConfig)
              }

              if (!response?.toolCalls?.length) semanticCacheService.set('model_response', modelCacheKey, response, 45000)
              onEvent({ type: 'cache', layer: 'model_response', hit: false })
            }
          } catch (err) {
            if (err.name === 'AbortError') {
              finalText = 'Agent stopped.'
              return { finalText, filesChanged, mutationTrace: executionTrace.mutations, trace: executionTrace }
            }
            onEvent({ type: 'error', message: err.message })
            finalText = `Agent error: ${err.message}`
            return { finalText, filesChanged, mutationTrace: executionTrace.mutations, trace: executionTrace }
          }

          if (response.usage?.input || response.usage?.output) onEvent({ type: 'usage', inputTokens: response.usage.input, outputTokens: response.usage.output })
          efficiencyMetricsService.record({
            taskId,
            stage: 'agent_turn',
            latencyMs: Date.now() - turnStarted,
            inputTokens: response.usage?.input || 0,
            outputTokens: response.usage?.output || 0,
            meta: { role: routing.role, modelId: activeModelConfig.modelId || activeModelConfig.id, strategy: routing.strategy },
          })
          if (response.text) diary.onModelText(response.text)

          if (response.isDone || response.toolCalls.length === 0) {
            finalText = response.text || 'Task completed.'
            return { finalText, filesChanged, mutationTrace: executionTrace.mutations, trace: executionTrace }
          }

          const toolCallIds = new Map()
          response.toolCalls.forEach(tc => {
            const id = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
            toolCallIds.set(tc, id)
            onEvent({ type: 'tool_start', id, name: tc.name, input: tc.input })
          })

          const settled = await Promise.allSettled(response.toolCalls.map(async tc => {
            const id = toolCallIds.get(tc)
            const cacheKey = `${tc.name}:${JSON.stringify(tc.input || {})}`
            try {
              if (CACHEABLE_TOOLS.has(tc.name)) {
                const cached = semanticCacheService.get('file_content', cacheKey)
                if (cached != null) {
                  onEvent({ type: 'tool_done', id, name: tc.name, result: cached, error: null, cached: true })
                  efficiencyMetricsService.record({ taskId, stage: `tool:${tc.name}`, cacheHit: true })
                  return cached
                }
              }

              let beforeContent = null
              let beforeExists = false
              if (MUTATING_TOOLS.has(tc.name) && tc.input?.path) {
                const snapshot = await executeTool('read_file', { path: tc.input.path })
                if (!String(snapshot).startsWith('File not found:')) {
                  beforeContent = stripReadWrapper(snapshot)
                  beforeExists = true
                }
              }

              const result = await executeTool(tc.name, tc.input)
              if (CACHEABLE_TOOLS.has(tc.name)) semanticCacheService.set('file_content', cacheKey, result)

              if (tc.name === 'run_command') executionTrace.commandRuns.push({ input: tc.input, result })

              if (MUTATING_TOOLS.has(tc.name)) {
                const path = tc.input.path
                if (!filesChanged.includes(path)) filesChanged.push(path)
                const action = tc.name === 'write_file' ? 'write' : tc.name === 'delete_file' ? 'delete' : 'edit'
                onEvent({ type: 'file_write', path, action })
                diary.onFileWrite(path, action)
                semanticCacheService.clearNamespace('file_content')

                let afterContent = null
                if (action !== 'delete') {
                  const post = await executeTool('read_file', { path })
                  if (!String(post).startsWith('File not found:')) afterContent = stripReadWrapper(post)
                }
                executionTrace.mutations.push({
                  path,
                  action,
                  tool: tc.name,
                  beforeExists,
                  beforeContent,
                  afterContent,
                  apiSignatureChanged: detectApiSignatureChange(beforeContent || '', afterContent || ''),
                })

                memoryGraphService.ingestFileChange({ path, action, content: String(result || '').slice(0, 500), source: 'agent_loop' })
              } else if (tc.name === 'read_file' || tc.name === 'read_many_files') {
                const paths = tc.name === 'read_many_files' ? (tc.input.paths || []) : [tc.input.path]
                paths.forEach(p => diary.onFileRead(p))
              }

              onEvent({ type: 'tool_done', id, name: tc.name, result, error: null })
              efficiencyMetricsService.record({ taskId, stage: `tool:${tc.name}`, cacheHit: false })
              return result
            } catch (err) {
              onEvent({ type: 'tool_done', id, name: tc.name, result: `ERROR: ${err.message}`, error: err.message })
              return `ERROR: ${err.message}`
            }
          }))

          const results = settled.map(r => r.status === 'fulfilled' ? r.value : `ERROR: ${r.reason}`)
          const nextMessages = buildToolResultMessages(response.toolCalls, results, isAnthropic, response._raw)
          messages = pruneMessages([...messages, ...nextMessages], diary, isAnthropic)

          const sig = toolSignature(response.toolCalls)
          recentSigs.push(sig)
          if (recentSigs.length > LOOP_WINDOW) recentSigs.shift()
          if (recentSigs.length === LOOP_WINDOW && recentSigs.every(s => s === sig)) {
            recentSigs.length = 0
            messages.push({ role: 'user', content: '⚠ You appear to be repeating the same tool calls. Try a different approach.' })
            onEvent({ type: 'text_delta', delta: '\n[Loop detected — injecting recovery prompt]\n' })
          }
        }

        finalText = `Reached maximum turn limit (${AGENT_MAX_TURNS}).`
        return { finalText, filesChanged, mutationTrace: executionTrace.mutations, trace: executionTrace }
      },
      verify: async ({ execution }) => {
        const verification = evaluateReliabilityGates({
          executionTrace: execution?.trace || executionTrace,
          draftText: execution?.finalText || finalText,
          critiqueConfig: enhancerConfig.critique,
          config: enhancerConfig.reliability || {},
        })
        onEvent({ type: 'critique', critique: verification.critique })
        const qualityFloor = enforceQualityFloor({
          text: execution?.finalText || finalText,
          minChars: enhancerConfig?.deepReasoning?.qualityFloorMinChars ?? 120,
        })
        if (!qualityFloor.passed) {
          verification.passed = false
          verification.failedGateIds = [...(verification.failedGateIds || []), 'quality_floor']
        }
        const benchmarkGate = evaluateBenchmarkRegressionGate({
          benchmarkReport: enhancerConfig?.reliability?.benchmarkReport || null,
          required: Boolean(enhancerConfig?.reliability?.requireBenchmarkPass),
        })
        verification.gates = [...(verification.gates || []), benchmarkGate]
        if (!benchmarkGate.passed) {
          verification.passed = false
          verification.failedGateIds = [...(verification.failedGateIds || []), benchmarkGate.id]
        }
        onEvent({ type: 'quality_floor', qualityFloor })
        onEvent({ type: 'verification', verification })
        return verification
      },
      rollback: async ({ trace, verification }) => rollback({
        trace,
        reason: `failed gates: ${(verification?.failedGateIds || []).join(', ') || 'unknown'}`,
      }),
    },
  })

  let run
  try {
    run = await fsm.run()
  } finally {
    setTraceLoopState(null)
  }
  const verification = run.context.verification

  if (verification?.passed) {
    onEvent({ type: 'done', text: finalText, filesChanged })
    return
  }

  const failedSummary = verification?.failedGateIds?.length
    ? `Reliability gates failed: ${verification.failedGateIds.join(', ')}`
    : 'Reliability verification failed.'
  const rollbackSummary = run.context.rollback?.rolledBack
    ? `Automatic rollback applied via ${run.context.rollback.strategy}.`
    : 'Rollback failed; repository may be partially modified.'

  onEvent({ type: 'done', text: `${finalText}\n\n[Autonomous Reliability Loop]\n${failedSummary}\n${rollbackSummary}`, filesChanged })
}
