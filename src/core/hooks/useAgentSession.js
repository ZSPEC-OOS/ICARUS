// ─── useAgentSession ──────────────────────────────────────────────────────────
// Encapsulates all state and logic for running the agentic tool-use loop.
// Extracted from Bluswan.jsx to isolate agent concerns from generate/UI concerns.
//
// Intelligence layers wired in:
//   Layer 1 — detectIntent: classifies each task before the loop starts
//   Layer 2 — createTask: tracks lifecycle (active → completed/interrupted)
//   Layer 3 — toolToLogMessage + inferPhaseFromTool: descriptive activity log

import { useState, useRef, useCallback } from 'react'
import { runAgentLoop } from '../../services/agentLoop.js'
import { makeExecutor }  from '../../services/agentExecutor.js'
import { AGENT_TOOLS, buildAgentSystemPrompt } from '../../services/agentTools.js'
import { shadowContext } from '../../services/shadowContext.js'
import { loadEnhancerConfig } from '../../services/enhancers/config.js'
import {
  detectIntent,
  INTENT_LABELS,
  createTask,
  inferPhaseFromTool,
  toolToLogMessage,
} from '../../services/interactivePipeline.js'
import { applyLaneEvent } from '../../components/bluswan/BluswanTaskLanes.jsx'

// Read-only tools — used when planMode is active (no writes, no shell exec)
const PLAN_MODE_TOOLS = new Set([
  'read_file', 'list_directory', 'search_files',
  'grep', 'read_many_files', 'web_fetch', 'web_search',
  'read_source_file', 'list_source_directory',
  'lint_file', 'todo',
])

export function useAgentSession({
  modelConfig,       // {apiKey, baseUrl, modelId, …}
  githubConfig,      // {token, owner, repo, branch}
  sourceRepoConfig,  // {token, owner, repo, branch} | null — secondary (read-only) repo
  bridgeAvailable,   // bool
  webSearchApiKey,   // string | '' — Tavily API key (optional)
  planMode,          // bool — read-only analysis mode
  logActivity,       // (type, msg, detail?) => id
  updateActivity,    // (id, updates) => void
  clearActivity,     // () => void
  activityRef,       // ref to the activity entries array (for last-entry lookup)
  onFileWrite,       // (path, action) => void (optional)
  onSetActiveTab,    // (tabId) => void
  onSetError,        // (msg) => void
  onPromptClear,     // () => void
  onPlanDone,        // (task, summary) => void — called when plan mode agent finishes
  onAgentStart,       // (task) => void — fires immediately when agent begins (add user bubble)
  onAgentComplete,    // (task, text) => void — fires on every done (add assistant bubble)
  availableModels,    // object[] — full model list for orchestration router
}) {
  const [isAgentRunning,  setIsAgentRunning]  = useState(false)
  const [agentSummary,    setAgentSummary]    = useState('')
  const [agentFiles,      setAgentFiles]      = useState([])
  const [agentStreamText, setAgentStreamText] = useState('')
  // Layer 1+2: intent and task exposed so parent/UI can read them
  const [agentIntent,     setAgentIntent]     = useState(null)
  const [agentTask,       setAgentTask]       = useState(null)
  // Layer 3: current inferred phase (updates on each tool call)
  const [agentPhase,      setAgentPhase]      = useState('understanding')
  // 4.1 / 4.2: orchestration routing state
  const [orchLanes,       setOrchLanes]       = useState([])   // task lane cards
  const [orchDecision,    setOrchDecision]    = useState(null) // latest routing decision
  const [lastVerification,setLastVerification]= useState(null) // reliability gate result
  const [lastCritique,    setLastCritique]    = useState(null) // critique pass result

  // Narration thread — ordered mix of { kind:'text', text } and { kind:'tool', name, status }
  const [narrationThread, setNarrationThread] = useState([])
  const narrationRef = useRef([])  // sync copy for use inside async callbacks

  const streamTextRef   = useRef('')
  const abortRef        = useRef(null)
  const runningRef      = useRef(false)   // guard against concurrent runs
  const pendingToolsRef = useRef(new Map()) // Map<toolId, activityId> for matching tool_start/done

  const run = useCallback(async (task, conversationHistory = [], { forceBuildMode = false, skipAgentStart = false, branchOverride = null } = {}) => {
    if (!task?.trim()) { onSetError?.('Enter a task for the agent.'); return }
    if (!modelConfig)        { onSetError?.('Select a model.'); return }
    if (!modelConfig.apiKey) { onSetError?.(`No API key for "${modelConfig.name}". Open Admin Panel.`); return }
    if (runningRef.current)  return   // prevent concurrent invocations

    onSetError?.('')
    runningRef.current = true
    if (!skipAgentStart) onAgentStart?.(task)
    clearActivity()
    setIsAgentRunning(true)
    setAgentSummary('')
    setAgentFiles([])
    streamTextRef.current = ''
    setAgentStreamText('')
    narrationRef.current = []
    setNarrationThread([])

    // Layer 1: detect intent before the loop so the badge appears immediately
    const intent     = detectIntent(task)
    const intentLabel = INTENT_LABELS[intent] || intent
    setAgentIntent(intent)

    // Layer 2: create a Task object to track lifecycle
    const currentTask = createTask(task)
    setAgentTask({ ...currentTask })

    // Layer 3: reset phase indicator
    setAgentPhase('understanding')

    const ctrl = new AbortController()
    abortRef.current = ctrl

    const executor = makeExecutor({
      token:           githubConfig.token,
      owner:           githubConfig.owner,
      repo:            githubConfig.repo,
      branch:          branchOverride || githubConfig.branch,
      sourceRepoConfig,
      webSearchApiKey: webSearchApiKey || '',
      bridgeAvailable: !!bridgeAvailable,
      modelConfig,
      availableModels: availableModels || [],
      onFileWrite: (path, action) => {
        setAgentFiles(prev => prev.includes(path) ? prev : [...prev, path])
        onFileWrite?.(path, action)
      },
    })

    // In plan mode only include read-only tools so the model can't accidentally
    // write files even if it tries to call a mutating tool.
    const tools = (planMode && !forceBuildMode)
      ? AGENT_TOOLS.filter(t => PLAN_MODE_TOOLS.has(t.name))
      : AGENT_TOOLS

    const systemPrompt = buildAgentSystemPrompt(
      shadowContext.getConventions(),
      shadowContext.getBluswanMd(),
      githubConfig.owner || 'unknown',
      githubConfig.repo  || 'unknown',
      bridgeAvailable,
      sourceRepoConfig,
      planMode,
      !!webSearchApiKey,
      shadowContext.buildRepoMap(3000),   // Aider-style symbol map ranked by centrality
    )

    // Layer 1: show intent badge in the first activity entry
    const startId = logActivity('agent', `⚡ [${intentLabel}] "${task.slice(0, 60)}"`)
    onSetActiveTab?.('activity')

    // Reset orchestration state for this run
    setOrchLanes([])
    setOrchDecision(null)
    setLastVerification(null)
    setLastCritique(null)

    try { await runAgentLoop({
      task,
      systemPrompt,
      tools,
      executeTool: executor,
      modelConfig,
      availableModels: availableModels || [],
      enhancerConfig: loadEnhancerConfig(),
      signal:      ctrl.signal,
      conversationHistory,
      onEvent: (ev) => {
        if (ctrl.signal.aborted) return
        switch (ev.type) {
          case 'turn': {
            // Archive any streamed narration from the previous turn
            const prev = streamTextRef.current.trim()
            if (prev) {
              logActivity('agent', `💬 ${prev}`)
              narrationRef.current = [...narrationRef.current, { kind: 'text', text: prev }]
              setNarrationThread([...narrationRef.current])
              streamTextRef.current = ''
              setAgentStreamText('')
            }
            updateActivity(startId, { msg: `⚡ Agent — turn ${ev.turn}` })
            break
          }

          case 'text_delta':
            streamTextRef.current += ev.delta
            setAgentStreamText(streamTextRef.current)
            break

          case 'tool_start': {
            // Flush any streaming narration before the tool line
            const narration = streamTextRef.current.trim()
            if (narration) {
              logActivity('agent', `💬 ${narration}`)
              narrationRef.current = [...narrationRef.current, { kind: 'text', text: narration }]
              setNarrationThread([...narrationRef.current])
              streamTextRef.current = ''
              setAgentStreamText('')
            }
            // Layer 3: descriptive message instead of raw JSON
            const logMsg = toolToLogMessage(ev.name, ev.input || {})
            // Layer 3: infer phase from tool and update phase indicator
            const inferredPhase = inferPhaseFromTool(ev.name)
            setAgentPhase(inferredPhase)
            // Layer 2: update task currentStep when a todo tool fires
            if (ev.name === 'todo' && ev.input?.action === 'in_progress') {
              setAgentTask(prev => prev ? { ...prev, steps: [...(prev.steps || []), ev.input.task || ''] } : prev)
            }
            // Add tool chip to narration thread
            narrationRef.current = [...narrationRef.current, { kind: 'tool', id: ev.id, name: ev.name, logMsg, status: 'active' }]
            setNarrationThread([...narrationRef.current])
            logActivity('tool', `● ${logMsg}`)
            break
          }

          case 'tool_done': {
            // Update tool chip status in narration thread
            narrationRef.current = narrationRef.current.map(e =>
              e.kind === 'tool' && e.id === ev.id
                ? { ...e, status: ev.error ? 'error' : 'done' }
                : e
            )
            setNarrationThread([...narrationRef.current])
            // Update the last entry in the activity log (which is the tool_start we just added)
            const last = activityRef?.current?.[activityRef.current.length - 1]
            if (last) {
              updateActivity(last.id, {
                status: ev.error ? 'error' : 'done',
                detail: String(ev.result).slice(0, 120),
              })
            }
            break
          }

          case 'usage': {
            // Claude Code-style per-turn token accounting (↑ input  ↓ output)
            const fmt = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
            if (ev.inputTokens || ev.outputTokens)
              logActivity('agent', `↑ ${fmt(ev.inputTokens)} in  ↓ ${fmt(ev.outputTokens)} out`)
            break
          }

          case 'file_write':
            logActivity('write', `✏ ${ev.action}: ${ev.path}`)
            break

          case 'done': {
            const final = streamTextRef.current.trim()
            if (final) {
              logActivity('agent', `💬 ${final}`)
              narrationRef.current = [...narrationRef.current, { kind: 'text', text: final }]
              setNarrationThread([...narrationRef.current])
              streamTextRef.current = ''
              setAgentStreamText('')
            }
            setAgentSummary(ev.text || '')
            setAgentFiles(ev.filesChanged || [])
            // Layer 2: mark task completed
            setAgentTask(prev => prev ? { ...prev, status: 'completed' } : prev)
            setAgentPhase('complete')
            setOrchLanes(prev => applyLaneEvent(prev, ev))
            updateActivity(startId, {
              status: 'done',
              msg: `⚡ Agent done — ${ev.filesChanged?.length || 0} file(s) changed`,
            })
            logActivity('done', `✓ Agent complete`)
            onSetActiveTab?.('activity')
            onAgentComplete?.(task, ev.text || '')
            if (planMode && !forceBuildMode) onPlanDone?.(task, ev.text || '')
            break
          }

          case 'error':
            // Layer 2: mark task interrupted
            setAgentTask(prev => prev ? { ...prev, status: 'interrupted' } : prev)
            setOrchLanes(prev => applyLaneEvent(prev, ev))
            logActivity('error', `✗ Agent error: ${ev.message}`)
            updateActivity(startId, { status: 'error', msg: `⚡ Agent failed — ${ev.message}` })
            break

          // ── 4.1 / 4.2: Orchestration events ─────────────────────────────
          case 'orchestration': {
            setOrchDecision({
              role:       ev.role,
              confidence: ev.confidence,
              strategy:   ev.strategy,
              modelId:    ev.modelId,
              reasoning:  ev.reasoning,
              scores:     ev.scores,
            })
            setOrchLanes(prev => applyLaneEvent(prev, ev))
            const confPct = Math.round((ev.confidence ?? 0) * 100)
            logActivity('agent', `◈ ${ev.role} → ${ev.modelId || '—'} (${confPct}% conf)`)
            break
          }

          case 'orchestration_fallback':
            setOrchLanes(prev => applyLaneEvent(prev, ev))
            logActivity('warn', `⚠ fallback: ${ev.fromModelId} → ${ev.toModelId}`)
            break

          case 'orchestration_fallback_used':
            setOrchLanes(prev => applyLaneEvent(prev, ev))
            break

          case 'orchestration_ensemble':
            setOrchLanes(prev => applyLaneEvent(prev, ev))
            logActivity('agent', `≡ ensemble: [${(ev.modelsUsed || []).join(', ')}]`)
            break

          case 'rag_inject':
            logActivity('agent', `◎ RAG: injected ${ev.count} context chunk${ev.count !== 1 ? 's' : ''} (${ev.totalCandidates} candidates)`)
            break

          case 'verification':
            setLastVerification(ev.verification || null)
            break

          case 'critique':
            setLastCritique(ev.critique || null)
            break

          default: break
        }
      },
    }) } catch (unexpectedErr) {
      // runAgentLoop should never throw (emits error events instead), but catch here
      // as an absolute safety net so isAgentRunning is always cleared
      logActivity('error', `✗ Agent crashed: ${unexpectedErr.message}`)
      updateActivity(startId, { status: 'error', msg: `⚡ Agent crashed — ${unexpectedErr.message}` })
      onSetError?.(`Agent crashed: ${unexpectedErr.message}`)
    } finally {
      runningRef.current = false
      streamTextRef.current = ''
      setAgentStreamText('')
      setIsAgentRunning(false)
      onPromptClear?.()
    }
  }, [modelConfig, githubConfig, sourceRepoConfig, bridgeAvailable, webSearchApiKey, planMode,
      logActivity, updateActivity, clearActivity, activityRef, onFileWrite, onSetActiveTab, onSetError, onPromptClear,
      onPlanDone, onAgentStart, onAgentComplete, availableModels])

  const abort = useCallback(() => {
    abortRef.current?.abort()
    setAgentTask(prev => prev ? { ...prev, status: 'interrupted' } : prev)
    setIsAgentRunning(false)
  }, [])

  return {
    isAgentRunning, agentSummary, agentFiles, agentStreamText,
    narrationThread,
    // Layer 1+2+3 new exports
    agentIntent, agentTask, agentPhase,
    // 4.1 / 4.2: orchestration exports
    orchLanes, orchDecision, lastVerification, lastCritique,
    abortRef, run, abort,
  }
}
