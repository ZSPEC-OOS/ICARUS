import { callWithToolsStreaming } from './aiService.js'
import { AGENT_MAX_TURNS, AGENT_KEEP_TURNS, AGENT_LOOP_WINDOW } from '../config/constants.js'
import { resolveEnhancerConfig } from './enhancers/config.js'
import { enforceStructuredPrompt } from './enhancers/structuredPrompting.js'
import { runCritiquePass } from './enhancers/critiqueMiddleware.js'
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
import { createTaskDecomposer } from './orchestration/taskDecomposer.js'
import { retrieveContext } from './enhancers/ragService.js'
import { shadowContext } from './shadowContext.js'
import { codeIntelligence } from './codeIntelligence.js'
import { createContextCompressor } from './contextCompressor.js'
import { promptRegistry } from './promptRegistry.js'
import { runDrctPipeline } from './creative/drctPipeline.js'
import { fetchLibraryContext } from './libraryContextService.js'

export function makeSessionDiary() {
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

const CACHEABLE_TOOLS = new Set(['analyze_codebase', 'read_file', 'read_many_files', 'list_directory', 'search_files', 'grep'])
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'revert_file'])

export function toolSignature(toolCalls) {
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

export function pruneMessages(messages, diary = null, isAnthropic = false) {
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
  executionMode = 'default',
  _escalated = false,   // internal guard — prevents infinite escalation chain
}) {
  const enhancerConfig = resolveEnhancerConfig(enhancerConfigOverrides)
  memoryGraphService.init()

  // ── Model 2 Attachment: resolve escalation model from enhancer config ─────
  // Resolved once at loop start.  If _escalated is true we are already running
  // as the backup model, so set model2Config to null to prevent re-escalation.
  const m2Cfg = enhancerConfig.model2Attachment
  const model2Config = (!_escalated && m2Cfg?.enabled && m2Cfg?.modelId)
    ? ((availableModels || []).find(m => m.id === m2Cfg.modelId && m.apiKey) ?? null)
    : null

  // Mutable flag set by the execute FSM handler when escalation should fire
  // after the FSM completes (avoids returning from inside a nested async handler).
  let needsModel2Escalation = false

  // ── Code Intelligence: build / refresh symbol index from shadow context ───
  // Zero-cost when the index is current (TTL + size guard in buildIndex).
  if (shadowContext?.isReady) {
    try { codeIntelligence.buildIndex(shadowContext) } catch { /* non-fatal */ }
  }

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
  const compressor = createContextCompressor({ memoryGraphService })
  const recentSigs = []
  // Track which prompt registry variants are active this session
  const _registryVariants = {}
  const taskId = `agent-${Date.now()}`
  try {
    const identityV  = promptRegistry.get('agent.identity',     taskId)
    const narrationV = promptRegistry.get('agent.narration',    taskId)
    const verifyV    = promptRegistry.get('agent.verification', taskId)
    if (identityV)  _registryVariants['agent.identity']     = identityV.id
    if (narrationV) _registryVariants['agent.narration']    = narrationV.id
    if (verifyV)    _registryVariants['agent.verification'] = verifyV.id
  } catch { /* non-fatal */ }
  const executionTrace = { mutations: [], commandRuns: [] }
  let finalText = ''

  if (executionMode === 'drct') {
    try {
      const drct = await runDrctPipeline({
        task,
        modelConfig: activeModelConfig,
        enhancerConfig,
        signal,
        onEvent,
      })
      onEvent?.({
        type: 'done',
        text: drct.text,
        filesChanged: [],
        mode: 'drct',
        workflow: drct.workflow,
      })
      return
    } catch (err) {
      onEvent?.({ type: 'error', message: `DRCT mode failed: ${err.message}` })
      onEvent?.({ type: 'done', text: 'DRCT mode failed; no output produced.', filesChanged: [], mode: 'drct' })
      return
    }
  }

  // ── Proactive RAG injection ───────────────────────────────────────────────
  // When RAG is enabled and the shadow index is ready, retrieve the top-K most
  // relevant file chunks for the task and prepend them to the first user message.
  // This gives the model grounded context before tool calls begin, reducing the
  // number of turns needed to locate relevant files.
  let ragContextBlock = ''
  if (enhancerConfig.rag?.enabled && shadowContext?.isReady) {
    try {
      const ragResult = retrieveContext({
        query: task,
        shadowContext,
        config: enhancerConfig.rag,
      })
      if (ragResult.contexts.length > 0) {
        ragContextBlock = ragResult.promptContext
        if (enhancerConfig.orchestration?.logDecisions) {
          onEvent?.({ type: 'rag_inject', count: ragResult.contexts.length, totalCandidates: ragResult.totalCandidates })
        }
      }
    } catch {
      // RAG failures must never block the agent loop
    }
  }

  // ── Library Context: auto-fetch docs for detected packages ───────────────
  // Scans the task text for npm/pip package references and injects a concise
  // README + API summary so the model has accurate signatures before writing code.
  // Failures are silently ignored — zero impact on the main loop.
  let libraryContextBlock = ''
  try {
    const libResult = await fetchLibraryContext(task, { maxPackages: 4 })
    if (libResult.contextBlock) {
      libraryContextBlock = libResult.contextBlock
      if (orchCfg?.logDecisions) {
        onEvent?.({ type: 'library_context', packages: libResult.packages, count: libResult.packages.length })
      }
    }
  } catch { /* non-fatal */ }

  // ── Task Decomposer: parallel multi-role pre-analysis ─────────────────────
  // When plannerExecutor is enabled, complex compound tasks trigger lightweight
  // parallel model calls for each specialist role before the main loop starts.
  // The merged analyses are injected as structured context, giving the model a
  // head start on multi-faceted tasks without recursive sub-agent loops.
  let decompositionBlock = ''
  if (enhancerConfig.plannerExecutor?.enabled) {
    try {
      const decomposer  = createTaskDecomposer({ onEvent })
      const decomp      = decomposer.decomposeTask(task)
      if (decomp.complex && decomp.subtasks.length >= 2) {
        onEvent?.({ type: 'decompose_triggered', complexity: decomp.complexity, subtasks: decomp.subtasks.length })
        decompositionBlock = await decomposer.runDecomposition(decomp.subtasks, {
          modelConfig: activeModelConfig,
          signal,
        })
      }
    } catch {
      // Decomposition failures must never block the main loop
    }
  }

  const taskText = enhancerConfig.structuredPrompting.enabled ? enforceStructuredPrompt(task).promptText : task

  const contextSections = [
    ragContextBlock      ? { heading: 'RELEVANT CONTEXT (auto-retrieved)',  content: ragContextBlock }      : null,
    libraryContextBlock  ? { heading: 'LIBRARY DOCS (auto-fetched)',        content: libraryContextBlock }  : null,
    decompositionBlock   ? { heading: 'MULTI-ROLE PRE-ANALYSIS',            content: decompositionBlock }   : null,
    { heading: 'TASK', content: taskText },
  ].filter(Boolean)

  const packedInput = packContextSections(contextSections)

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
                  router.saveFallbackPref(routing.role, modelUsed.modelId || modelUsed.id)
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
            // Model 2 Attachment — escalate to backup model on primary error
            if (model2Config && m2Cfg?.escalateOnError !== false) {
              needsModel2Escalation = true
              onEvent?.({ type: 'model2_escalation', reason: 'primary_error', error: err.message, model2Id: model2Config.modelId || model2Config.id })
              finalText = `Primary model error: ${err.message}. Escalating to backup model…`
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
          if (response.text) compressor.onModelText(response.text)

          // Per-turn critique: run mid-session when the model produces substantial
          // narration before tool calls.  Only emits an event when issues are found
          // (avoids noise on clean turns).  The full critique still runs in verify.
          if (enhancerConfig.critique?.enabled && response.text?.trim().length > 60 && response.toolCalls.length > 0) {
            const turnCritique = runCritiquePass({ draftText: response.text, config: enhancerConfig.critique })
            if (!turnCritique.passed) {
              onEvent({ type: 'critique_turn', turn, critique: turnCritique })
            }
          }

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

          // Per-batch in-flight map: if two identical cacheable tool calls arrive in
          // the same turn, the second awaits the first's Promise instead of executing
          // a redundant duplicate request.
          const inFlight = new Map()

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
                // Coalesce duplicate in-flight calls — await the existing Promise
                if (inFlight.has(cacheKey)) {
                  const result = await inFlight.get(cacheKey)
                  onEvent({ type: 'tool_done', id, name: tc.name, result, error: null, cached: true })
                  efficiencyMetricsService.record({ taskId, stage: `tool:${tc.name}`, cacheHit: true })
                  return result
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

              const execPromise = executeTool(tc.name, tc.input)
              if (CACHEABLE_TOOLS.has(tc.name)) inFlight.set(cacheKey, execPromise)
              const result = await execPromise
              if (CACHEABLE_TOOLS.has(tc.name)) {
                semanticCacheService.set('file_content', cacheKey, result)
                inFlight.delete(cacheKey)
              }

              if (tc.name === 'run_command') executionTrace.commandRuns.push({ input: tc.input, result })

              if (MUTATING_TOOLS.has(tc.name)) {
                const path = tc.input.path
                if (!filesChanged.includes(path)) filesChanged.push(path)
                const action = tc.name === 'write_file' ? 'write' : tc.name === 'delete_file' ? 'delete' : 'edit'
                onEvent({ type: 'file_write', path, action })
                compressor.onFileWrite(path, action)
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
                paths.forEach(p => compressor.onFileRead(p))
              }

              onEvent({ type: 'tool_done', id, name: tc.name, result, error: null })
              compressor.onToolResult(tc.name, result)
              efficiencyMetricsService.record({ taskId, stage: `tool:${tc.name}`, cacheHit: false })
              return result
            } catch (err) {
              if (CACHEABLE_TOOLS.has(tc.name)) inFlight.delete(`${tc.name}:${JSON.stringify(tc.input || {})}`)
              onEvent({ type: 'tool_done', id, name: tc.name, result: `ERROR: ${err.message}`, error: err.message })
              compressor.onToolResult(tc.name, `ERROR: ${err.message}`)
              return `ERROR: ${err.message}`
            }
          }))

          const results = settled.map(r => r.status === 'fulfilled' ? r.value : `ERROR: ${r.reason}`)
          const nextMessages = buildToolResultMessages(response.toolCalls, results, isAnthropic, response._raw)
          messages = pruneMessages([...messages, ...nextMessages], compressor, isAnthropic)

          const sig = toolSignature(response.toolCalls)
          recentSigs.push(sig)
          if (recentSigs.length > AGENT_LOOP_WINDOW) recentSigs.shift()
          if (recentSigs.length === AGENT_LOOP_WINDOW && recentSigs.every(s => s === sig)) {
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

  // ── Model 2 Attachment: fire escalation if primary model errored ──────────
  if (needsModel2Escalation && model2Config) {
    return await runAgentLoop({
      task, systemPrompt, tools, executeTool,
      modelConfig: model2Config,
      onEvent, signal, conversationHistory,
      enhancerConfig: enhancerConfigOverrides,
      availableModels, executionMode,
      _escalated: true,
    })
  }

  if (verification?.passed) {
    // Cross-session memory: auto-log this task + changed files to BLUSWAN.md so
    // future sessions can see what was done (only when files were actually changed).
    if (enhancerConfig.crossSessionMemory?.enabled && filesChanged.length > 0 && !_escalated) {
      try {
        const today      = new Date().toISOString().slice(0, 10)
        const taskSnip   = String(task || '').slice(0, 110)
        const fileList   = filesChanged.slice(0, 8).join(', ')
        await executeTool('update_memory', {
          note: `[Auto ${today}] ${taskSnip} | Changed: ${fileList}`,
        })
      } catch { /* non-fatal — never block the done event */ }
    }
    // Record prompt registry outcomes for all active variants (success)
    try {
      for (const [name, variantId] of Object.entries(_registryVariants)) {
        promptRegistry.recordOutcome(name, variantId, true)
      }
    } catch { /* non-fatal */ }
    onEvent({ type: 'done', text: finalText, filesChanged })
    return
  }

  // Record prompt registry outcomes (failure)
  try {
    for (const [name, variantId] of Object.entries(_registryVariants)) {
      promptRegistry.recordOutcome(name, variantId, false)
    }
  } catch { /* non-fatal */ }

  const failedSummary = verification?.failedGateIds?.length
    ? `Reliability gates failed: ${verification.failedGateIds.join(', ')}`
    : 'Reliability verification failed.'

  // ── Model 2 Attachment: escalate on quality-gate failure (opt-in) ─────────
  if (model2Config && m2Cfg?.escalateOnQualityFail) {
    onEvent?.({ type: 'model2_escalation', reason: 'quality_gates', failedGates: verification?.failedGateIds, model2Id: model2Config.modelId || model2Config.id })
    return await runAgentLoop({
      task, systemPrompt, tools, executeTool,
      modelConfig: model2Config,
      onEvent, signal, conversationHistory,
      enhancerConfig: enhancerConfigOverrides,
      availableModels, executionMode,
      _escalated: true,
    })
  }

  const rollbackResult = run.context.rollback
  const rollbackSucceeded = !!rollbackResult?.rolledBack

  if (!rollbackSucceeded) {
    // Rollback failed — the repo may be in a partially-modified state.
    // Emit a dedicated event so the UI can surface a prominent warning
    // rather than letting it silently blend into the 'done' message.
    onEvent({
      type: 'rollback_failed',
      strategy: rollbackResult?.strategy || 'unknown',
      errors: rollbackResult?.errors || [],
      filesAffected: filesChanged,
    })
  }

  const rollbackSummary = rollbackSucceeded
    ? `Automatic rollback applied via ${rollbackResult.strategy}.`
    : `⚠ Rollback failed (strategy: ${rollbackResult?.strategy || 'unknown'})${rollbackResult?.errors?.length ? ` — ${rollbackResult.errors.join('; ')}` : ''}. Repository may be partially modified — manual review required.`

  onEvent({ type: 'done', text: `${finalText}\n\n[Autonomous Reliability Loop]\n${failedSummary}\n${rollbackSummary}`, filesChanged })
}
