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
import { AGENT_SESSION_TIMEOUT_MS } from '../../config/constants.js'
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
import { getAllTools } from '../../services/toolLoader.js'
import { generateBranchName, createBranch, getBranch } from '../../services/githubService.js'

// Read-only tools — used when planMode is active (no writes, no shell exec)
const PLAN_MODE_TOOLS = new Set([
  'read_file', 'list_directory', 'search_files',
  'grep', 'read_many_files', 'web_fetch', 'web_search',
  'read_source_file', 'list_source_directory',
  'lint_file', 'todo', 'get_diff', 'git_log', 'check_ci_status',
  'list_github_issues', 'get_github_issue',
  'hybrid_search', 'retrieve_context',
])

export function useAgentSession({
  modelConfig,       // {apiKey, baseUrl, modelId, …}
  githubConfig,      // {token, owner, repo, branch}
  sourceRepoConfig,  // {token, owner, repo, branch} | null — secondary (read-only) repo
  bridgeAvailable,   // bool
  webSearchApiKey,   // string | '' — Tavily API key (optional)
  planMode,          // bool — read-only analysis mode
  hooksConfig,       // { autoLintAfterWrite, autoTypeCheckAfterEdit } | null
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
  const [escalatedModelId,setEscalatedModelId]= useState(null) // set when model2 escalation fires
  const [failedAtPhase,   setFailedAtPhase]   = useState(null) // FSM phase name at point of error
  const [sessionBranch,   setSessionBranch]   = useState(null) // auto-created branch for this task

  // Narration thread — ordered mix of { kind:'text', text } and { kind:'tool', name, status }
  const [narrationThread, setNarrationThread] = useState([])
  const narrationRef = useRef([])  // sync copy for use inside async callbacks

  const streamTextRef         = useRef('')
  const streamUpdatePendingRef = useRef(false)  // RAF debounce guard for text_delta
  const sessionBranchRef      = useRef(null)    // sync copy of sessionBranch for async callbacks
  const abortRef              = useRef(null)
  const runningRef      = useRef(false)   // guard against concurrent runs
  const pendingToolsRef = useRef(new Map()) // Map<toolId, activityId> for matching tool_start/done

  const run = useCallback(async (task, conversationHistory = [], { forceBuildMode = false, skipAgentStart = false, branchOverride = null, executionMode = 'default', modularToolId = null } = {}) => {
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
    setEscalatedModelId(null)
    setFailedAtPhase(null)

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
    const sessionTimeoutId = setTimeout(() => ctrl.abort(), AGENT_SESSION_TIMEOUT_MS)

    // ── Auto-branch (Claude Code style): fresh branch per task ────────────────
    // New conversation → create bluswan/<slug>-<id> from the configured base branch.
    // Follow-up turns in the same conversation → reuse the branch from turn 1.
    // An explicit branchOverride always wins.
    let effectiveBranch = branchOverride || githubConfig.branch
    if (!branchOverride && githubConfig.token && githubConfig.owner && githubConfig.repo) {
      if (conversationHistory.length === 0) {
        sessionBranchRef.current = null
        setSessionBranch(null)
        try {
          const base = await getBranch(githubConfig.token, githubConfig.owner, githubConfig.repo, githubConfig.branch)
          const baseSha = base?.commit?.sha
          if (baseSha) {
            const newBranch = generateBranchName(task)
            await createBranch(githubConfig.token, githubConfig.owner, githubConfig.repo, newBranch, baseSha)
            effectiveBranch = newBranch
            sessionBranchRef.current = newBranch
            setSessionBranch(newBranch)
          }
        } catch { /* branch creation failed — fall back to configured branch silently */ }
      } else if (sessionBranchRef.current) {
        effectiveBranch = sessionBranchRef.current
      }
    }

    // Inject a modular tool if requested via loadworkflow_
    let modularTool = null
    if (modularToolId) {
      modularTool = getAllTools().find(t => t.id === modularToolId) || null
    }

    const executor = makeExecutor({
      token:           githubConfig.token,
      owner:           githubConfig.owner,
      repo:            githubConfig.repo,
      branch:          effectiveBranch,
      sourceRepoConfig,
      webSearchApiKey: webSearchApiKey || '',
      bridgeAvailable: !!bridgeAvailable,
      modelConfig,
      availableModels: availableModels || [],
      hooksConfig:     hooksConfig || null,
      modularTools:    modularTool ? [modularTool] : [],
      signal:          ctrl.signal,
      onFileWrite: (path, action) => {
        setAgentFiles(prev => prev.includes(path) ? prev : [...prev, path])
        onFileWrite?.(path, action)
      },
    })

    // In plan mode only include read-only tools so the model can't accidentally
    // write files even if it tries to call a mutating tool.
    let tools = (planMode && !forceBuildMode)
      ? AGENT_TOOLS.filter(t => PLAN_MODE_TOOLS.has(t.name))
      : AGENT_TOOLS
    if (modularTool) {
      tools = [...tools, {
        name: `modular_${modularToolId}`,
        description: `[Modular Tool: ${modularTool.name}] ${modularTool.description || ''} Use this when the task requires ${modularTool.name} functionality.`,
        input_schema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Input to pass to the tool' },
          },
          required: ['input'],
        },
      }]
    }

    const systemPrompt = buildAgentSystemPrompt(
      shadowContext.getConventions(),
      shadowContext.getBluswanMd(),
      githubConfig.owner || 'unknown',
      githubConfig.repo  || 'unknown',
      bridgeAvailable,
      sourceRepoConfig,
      planMode,
      !!webSearchApiKey,
      shadowContext.buildRepoMap(3000),
      '',
      executionMode,
    )

    // Layer 1: show intent badge in the first activity entry
    const startId = logActivity('agent', `⚡ [${intentLabel}] "${task.slice(0, 60)}"`)
    onSetActiveTab?.('activity')

    // Reset orchestration state for this run
    setOrchLanes([])
    setOrchDecision(null)
    setLastVerification(null)
    setLastCritique(null)

    // Append entry, capping the thread at 250 to prevent O(n²) spread cost on long runs
    const pushNarration = (entry) => {
      const next = [...narrationRef.current, entry]
      narrationRef.current = next.length > 250 ? next.slice(-250) : next
      setNarrationThread([...narrationRef.current])
    }

    try { await runAgentLoop({
      task,
      systemPrompt,
      tools,
      executeTool: executor,
      modelConfig,
      availableModels: availableModels || [],
      enhancerConfig: loadEnhancerConfig(),
      executionMode,
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
              pushNarration({ kind: 'text', text: prev })
              streamTextRef.current = ''
              setAgentStreamText('')
            }
            updateActivity(startId, { msg: `⚡ Agent — turn ${ev.turn}` })
            break
          }

          case 'text_delta':
            streamTextRef.current += ev.delta
            // Debounce: batch rapid deltas into one React state update per animation frame
            // to avoid 500+ re-renders per long response causing UI freeze.
            if (!streamUpdatePendingRef.current) {
              streamUpdatePendingRef.current = true
              requestAnimationFrame(() => {
                streamUpdatePendingRef.current = false
                setAgentStreamText(streamTextRef.current)
              })
            }
            break

          case 'tool_start': {
            // Flush any streaming narration before the tool line
            const narration = streamTextRef.current.trim()
            if (narration) {
              logActivity('agent', `💬 ${narration}`)
              pushNarration({ kind: 'text', text: narration })
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
            pushNarration({ kind: 'tool', id: ev.id, name: ev.name, logMsg, status: 'active' })
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
              pushNarration({ kind: 'text', text: final })
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
            if (sessionBranchRef.current) logActivity('agent', `⎇ Branch: ${sessionBranchRef.current}`)
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
            if (ev.fsmState) setFailedAtPhase(ev.fsmState)
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

          case 'model2_escalation': {
            const reasonLabel = ev.reason === 'quality_gates' ? 'quality gates failed' : 'primary model error'
            logActivity('warn', `⬆ Model 2 escalation triggered (${reasonLabel}) — retrying with ${ev.model2Id || 'backup model'}`)
            updateActivity(startId, { msg: `⚡ Escalating to backup model…` })
            if (ev.model2Id) setEscalatedModelId(ev.model2Id)
            break
          }

          case 'orchestration_ensemble':
            setOrchLanes(prev => applyLaneEvent(prev, ev))
            logActivity('agent', `≡ ensemble: [${(ev.modelsUsed || []).join(', ')}]`)
            break

          case 'rag_inject':
            logActivity('agent', `◎ RAG: injected ${ev.count} context chunk${ev.count !== 1 ? 's' : ''} (${ev.totalCandidates} candidates)`)
            break

          case 'library_context':
            logActivity('agent', `◎ Library docs: fetched ${ev.count} package${ev.count !== 1 ? 's' : ''} (${(ev.packages || []).join(', ')})`)
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
      setFailedAtPhase('crashed')
      onSetError?.(`Agent crashed: ${unexpectedErr.message}`)
    } finally {
      clearTimeout(sessionTimeoutId)
      runningRef.current = false
      streamTextRef.current = ''
      setAgentStreamText('')
      setIsAgentRunning(false)
      onPromptClear?.()
    }
  }, [modelConfig, githubConfig, sourceRepoConfig, bridgeAvailable, webSearchApiKey, planMode,
      logActivity, updateActivity, clearActivity, activityRef, onFileWrite, onSetActiveTab, onSetError, onPromptClear,
      onPlanDone, onAgentStart, onAgentComplete, availableModels, hooksConfig])

  const abort = useCallback(() => {
    abortRef.current?.abort()
    runningRef.current = false
    setAgentTask(prev => prev ? { ...prev, status: 'interrupted' } : prev)
    setIsAgentRunning(false)
  }, [])

  return {
    isAgentRunning, agentSummary, agentFiles, agentStreamText,
    narrationThread,
    sessionBranch,
    // Layer 1+2+3 new exports
    agentIntent, agentTask, agentPhase, failedAtPhase,
    // 4.1 / 4.2: orchestration exports
    orchLanes, orchDecision, lastVerification, lastCritique, escalatedModelId,
    abortRef, run, abort,
  }
}
