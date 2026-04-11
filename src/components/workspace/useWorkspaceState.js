// ─── useWorkspaceState ────────────────────────────────────────────────────────
// Extracts all state, effects, and handlers from Bluswan.jsx into a single
// custom hook so that WorkspaceShell, PromptBar and other sub-components can
// consume a focused slice without prop-drilling through the monolith.
//
// Built in sequential branches:
//   p3/usestate-scaffold   — imports, module helpers, useState/useRef  ← this file
//   p3/usestate-effects    — useEffect, useMemo, sub-hooks
//   p3/usestate-generate   — autoRemediate, handleGenerate
//   p3/usestate-handlers   — handleRefine/Retry, GitHub, Push
//   p3/usestate-lrm-return — sandbox/terminal, LRM, submit, return {}

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { runPromptWithRetry, loadSearchKey } from '../../services/aiService'
import {
  getRepo,
  getBranch,
  createBranch,
  getFileContent,
  createOrUpdateFile,
  createPullRequest,
  generateBranchName,
  listWorkflows,
  dispatchWorkflow,
  getWorkflowRuns,
  getWorkflowRun,
  listUserRepos,
} from '../../services/githubService'
import { estimateCost } from '../../utils/tokenEstimator'
import { shadowContext } from '../../services/shadowContext'
import { isVaguePrompt, amplifyPrompt } from '../../services/intentAmplifier'
import { buildFilePlan } from '../../services/planner'
import {
  createPipelineSteps,
  formatStructuredOutput,
  parsePromptCommand,
  createAssistantMessage,
  createStreamEvent,
  applyStreamEvent,
} from '../../services/interactivePipeline'
import { useConversation }   from '../../core/hooks/useConversation'
import { useExecBridge }     from '../../core/hooks/useExecBridge'
import { useActivityLog }    from '../../core/hooks/useActivityLog'
import { useAgentSession }   from '../../core/hooks/useAgentSession'
import {
  detectLanguage, extractCode, applyEditBlocks,
  buildSandboxHtml, buildPyodideSandboxHtml, isCodeComplete,
  LANG_CHECKLIST, REMEDIATABLE, testFilePath,
} from '../../utils/codeUtils'
import { computeLineDiff }   from '../../utils/diff'
import { decodeBase64 }      from '../../utils/base64.js'
import {
  CONTEXT_FILES_LIMIT,
  FILE_CONTENT_CAP_CHARS,
  BLUSWAN_MD_CAP,
  STYLE_EXAMPLES_LIMIT,
} from '../../config/constants'
import { KEYS } from '../../shared/storageKeys.js'

// ─── Persistence helpers ──────────────────────────────────────────────────────
const SETTINGS_KEY    = KEYS.LS.SETTINGS
const HISTORY_KEY     = KEYS.LS.HISTORY
const GHTOKEN_SS_KEY  = KEYS.SS.GH_TOKEN

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}
    if (s.githubToken) {
      try { sessionStorage.setItem(GHTOKEN_SS_KEY, s.githubToken) } catch {}
      delete s.githubToken
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch {}
    }
    try { s.githubToken = sessionStorage.getItem(GHTOKEN_SS_KEY) || '' } catch {}
    return s
  } catch { return {} }
}
export function saveSettings(s) {
  try {
    const { githubToken, ...rest } = s
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest))
    if (githubToken !== undefined) {
      try { sessionStorage.setItem(GHTOKEN_SS_KEY, githubToken || '') } catch {}
    }
  } catch {}
}
export function loadHistory()  { try { return JSON.parse(localStorage.getItem(HISTORY_KEY))  || [] } catch { return [] } }
export function saveHistory(h) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 60))) } catch {} }
export function formatRelativeDate(ts) {
  const diff = Date.now() - ts
  if (diff < 60000)        return 'just now'
  if (diff < 3600000)      return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000)     return `${Math.floor(diff / 3600000)}h ago`
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}d ago`
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ─── Pure system-prompt builder ───────────────────────────────────────────────
export function buildFileSystemPrompt(path, existingContent, lang, repoOwner, repoName, forTests = false, bluswanMd = null, contextFiles = [], styleExamples = []) {
  const repoCtx  = repoOwner && repoName ? `\nRepository: ${repoOwner}/${repoName}.` : ''
  const editMode = existingContent !== null ? 'patch' : 'replace'
  const isStandalone = ['html', 'markdown', 'yaml', 'bash', 'json'].includes(lang)
  const conv    = !isStandalone && shadowContext.getConventions()
  const convCtx = conv && conv.framework !== 'unknown' ? [
    `\nDETECTED PROJECT CONVENTIONS (follow exactly — do not ask):`,
    `  Framework: ${conv.framework}`,
    `  Language: ${conv.language}`,
    `  Naming: ${conv.namingConvention}`,
    conv.testFramework !== 'unknown' ? `  Tests: ${conv.testFramework}` : '',
    conv.srcDir        ? `  Source root: ${conv.srcDir}/`              : '',
    conv.hooks?.length ? `  Existing hooks: ${conv.hooks.join(', ')}`  : '',
    conv.deps?.length  ? `  Key deps: ${conv.deps.slice(0, 10).join(', ')}` : '',
    conv.pathAliases && Object.keys(conv.pathAliases).length
      ? `  Import aliases: ${Object.entries(conv.pathAliases).map(([k, v]) => `${k}/ → ${v}/`).join(', ')}` : '',
  ].filter(Boolean).join('\n') : ''

  const bluswanMdCtx = bluswanMd ? `\nPROJECT INSTRUCTIONS (from BLUSWAN.md — follow exactly):\n${bluswanMd.slice(0, BLUSWAN_MD_CAP)}` : ''
  const styleCtx = styleExamples.length > 0
    ? `\nCODE STYLE PATTERNS FROM THIS CODEBASE (study these and match the style precisely):\n` +
      styleExamples.map(s => `--- ${s.path} ---\n${s.excerpt}`).join('\n\n')
    : ''
  const contextCtx = contextFiles.length > 0
    ? `\nRELEVANT EXISTING FILES (for reference — match patterns and style):\n` +
      contextFiles.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n')
    : ''

  if (forTests) {
    const tf = conv?.testFramework !== 'unknown' ? conv.testFramework : 'Jest/Vitest for JS/TS, pytest for Python'
    return [`You are BLUSWAN, an expert test-writing assistant.${repoCtx}`,
      `Generate a complete, production-ready test file for the provided ${lang} code.`,
      `Use ${tf}.`, convCtx, bluswanMdCtx,
      `Output ONLY the test code — no markdown fences, no explanations.`,
    ].filter(Boolean).join('\n')
  }

  const lines = [
    `You are BLUSWAN, an expert coding assistant. Generate clean, production-ready ${lang} code.${repoCtx}`,
    `Follow existing codebase conventions. Add comments only where logic is non-obvious.`,
    convCtx, bluswanMdCtx, styleCtx, contextCtx,
  ].filter(Boolean)

  if (editMode === 'patch' && existingContent) {
    lines.push(
      `\nThe existing file is provided. Return ONLY specific changes as EDIT blocks:`,
      `EDIT_START\nOLD:\n<exact text to replace verbatim>\nNEW:\n<replacement>\nEDIT_END`,
      `Repeat per change. If the whole file needs rewriting, output the complete file instead.`,
    )
  } else {
    lines.push(
      `Output ONLY the complete, production-ready code. Critical requirements:`,
      `- Include ALL code — never truncate, never write "// rest of implementation", never use TODO stubs`,
      `- If the file is long, output every line in full — do not abbreviate`,
      `- No markdown code fences, no explanations outside the code`,
    )
  }
  if (existingContent) lines.push(`\nEXISTING FILE (${path}):\n${existingContent.slice(0, FILE_CONTENT_CAP_CHARS)}`)
  return lines.join('\n')
}

// ─── LRM phase-plan system prompt (module-level — no hook dependency) ─────────
const PHASE_PLAN_SYSTEM = `You are a software engineering planner for the BLUSWAN AI coding assistant.
The user has a complex request requiring multiple implementation steps.
Break it into 2-6 ordered, logically atomic phases. Each phase should be independently committable.
Return ONLY a valid JSON array — no markdown fences, no prose, no explanation before or after:
[{"id":1,"title":"Short title (5-8 words)","summary":"What this phase accomplishes in 1-2 sentences.","targets":["src/path/to/file.js"],"instructions":"Complete implementation instructions for this phase only."}]`

// ═════════════════════════════════════════════════════════════════════════════
export function useWorkspaceState({
  onClose, models, setModels, selectedModelId, onModelChange,
  onSettingsChanged, onLogout, userEmail, savedModelIds, onModelSaved,
}) {
  const saved = loadSettings()

  // ── Config ──────────────────────────────────────────────────────────────
  const [activeModelId,  setActiveModelId]  = useState(selectedModelId || '')
  const [repoOwner,      setRepoOwner]      = useState(saved.repoOwner   || '')
  const [repoName,       setRepoName]       = useState(saved.repoName    || '')
  const [baseBranch,     setBaseBranch]     = useState(saved.baseBranch  || 'main')
  const [githubToken,    setGithubToken]    = useState(saved.githubToken || '')
  const [githubClientId, setGithubClientId] = useState(saved.githubClientId || '')
  const [dryRun,         setDryRun]         = useState(saved.dryRun ?? false)

  // ── Theme / layout (static) ──────────────────────────────────────────────
  const fineTune     = { brightness: 130, contrast: 100, saturation: 125, highlight: 50, shadow: 50 }
  const headerLayout = { headerHeight: 44, titleSize: 11, titleOffsetX: 0, titleOffsetY: 0, toggleOffsetX: 0, toggleOffsetY: 0 }

  // ── Input ────────────────────────────────────────────────────────────────
  const [prompt,           setPrompt]           = useState('')
  const [refinementPrompt, setRefinementPrompt] = useState('')

  // ── Enhancement toggles ──────────────────────────────────────────────────
  const [generateTests,  setGenerateTests]  = useState(saved.generateTests ?? false)
  const [creativity,     setCreativity]     = useState(saved.creativity    ?? 50)
  const [enableThinking, setEnableThinking] = useState(saved.enableThinking ?? false)
  const [thinkingBudget, setThinkingBudget] = useState(saved.thinkingBudget ?? 8000)
  const [hooksConfig,    setHooksConfig]    = useState({
    autoLintAfterWrite:     saved.hooksConfig?.autoLintAfterWrite     ?? false,
    autoTypeCheckAfterEdit: saved.hooksConfig?.autoTypeCheckAfterEdit ?? false,
  })
  const planMode = true
  const [planApproval,    setPlanApproval]    = useState(null)
  const [executedPlan,    setExecutedPlan]    = useState(null)
  const [webSearchApiKey, setWebSearchApiKey] = useState('')

  // ── Multi-file plan ──────────────────────────────────────────────────────
  const [filePlan,        setFilePlan]        = useState([])
  const [activeFileIndex, setActiveFileIndex] = useState(0)
  const [isPlanning,      setIsPlanning]      = useState(false)
  const planRef        = useRef([])
  const currentFileRef = useRef(0)

  // ── Output tabs ──────────────────────────────────────────────────────────
  const [activeTab,     setActiveTab]     = useState('code')
  const [gitStatus,     setGitStatus]     = useState(null)
  const [prResult,      setPrResult]      = useState(null)
  const [workflows,     setWorkflows]     = useState([])
  const [workflowRuns,  setWorkflowRuns]  = useState([])
  const [isPollingCI,   setIsPollingCI]   = useState(false)

  // ── Sandbox ──────────────────────────────────────────────────────────────
  const [sandboxOutput,   setSandboxOutput]   = useState([])
  const [sandboxSetup,    setSandboxSetup]    = useState('')
  const [isRunning,       setIsRunning]       = useState(false)
  const [isRunningTests,  setIsRunningTests]  = useState(false)
  const sandboxRef = useRef(null)

  // ── Terminal ─────────────────────────────────────────────────────────────
  const [terminalInput,     setTerminalInput]     = useState('')
  const [terminalLog,       setTerminalLog]       = useState([])
  const [isTerminalRunning, setIsTerminalRunning] = useState(false)

  // ── Permission mode ──────────────────────────────────────────────────────
  const [permissionMode, setPermissionMode] = useState(
    () => localStorage.getItem(KEYS.LS.PERM_MODE) || 'ask'
  )

  // ── Agent mode ───────────────────────────────────────────────────────────
  const [isRunningPostPushTests, setIsRunningPostPushTests] = useState(false)

  // ── BLUSWAN.md ───────────────────────────────────────────────────────────
  const [bluswanMdDraft,    setBluswanMdDraft]    = useState('')
  const [isSavingBluswanMd, setIsSavingBluswanMd] = useState(false)

  // ── File attachments + branch tracking ──────────────────────────────────
  const [attachedFiles,  setAttachedFiles]  = useState([])
  const [lastBranchName, setLastBranchName] = useState('')
  const fileInputRef = useRef(null)

  // ── Repo picker ──────────────────────────────────────────────────────────
  const [repoPickerOpen,    setRepoPickerOpen]    = useState(false)
  const [repoPickerSearch,  setRepoPickerSearch]  = useState('')
  const [userRepos,         setUserRepos]         = useState([])
  const [repoPickerLoading, setRepoPickerLoading] = useState(false)
  const [repoPickerError,   setRepoPickerError]   = useState(null)
  const repoPickerRef = useRef(null)

  // ── UI state ─────────────────────────────────────────────────────────────
  const [isGenerating,     setIsGenerating]     = useState(false)
  const [isGenTests,       setIsGenTests]       = useState(false)
  const [isPushing,        setIsPushing]        = useState(false)
  const [pushStep,         setPushStep]         = useState('')
  const [error,            setError]            = useState('')
  const [settingsOpen,     setSettingsOpen]     = useState(false)
  const [historyOpen,      setHistoryOpen]      = useState(false)
  const [sourceOpen,       setSourceOpen]       = useState(false)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const [history,          setHistory]          = useState(loadHistory)

  // ── Long Request Mode ────────────────────────────────────────────────────
  const [longRequestMode,    setLongRequestMode]    = useState(false)
  const [lrmPlan,            setLrmPlan]            = useState(null)
  const [lrmGeneratingPlan,  setLrmGeneratingPlan]  = useState(false)
  const [taskSidebarCollapsed, setTaskSidebarCollapsed] = useState(false)
  const [lrmPhasePushed,     setLrmPhasePushed]     = useState(false)
  const [lrmPhasePrUrl,      setLrmPhasePrUrl]      = useState(null)

  // ── ShadowContext ────────────────────────────────────────────────────────
  const [shadowStatus, setShadowStatus] = useState(null)

  // ── Interactive pipeline ──────────────────────────────────────────────────
  const [pipelinePhase,     setPipelinePhase]     = useState('understanding')
  const [pipelineSteps,     setPipelineSteps]     = useState(() => createPipelineSteps('understanding'))
  const [validationResults, setValidationResults] = useState([])
  const [assistantMessage,  setAssistantMessage]  = useState(() => createAssistantMessage())

  // ── IntentAmplifier ──────────────────────────────────────────────────────
  const [isAmplifying,       setIsAmplifying]       = useState(false)
  const [amplifierDecisions, setAmplifierDecisions] = useState([])

  // ── AutoRemediation ──────────────────────────────────────────────────────
  const [remediationStatus, setRemediationStatus] = useState(null)

  // ── Misc refs ────────────────────────────────────────────────────────────
  const abortRef            = useRef(null)
  const agentBranchRef      = useRef(null)
  const generationStartRef  = useRef(null)
  const onSettingsChangedRef = useRef(onSettingsChanged)
  const activityFeedRef      = useRef(null)

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => { loadSearchKey().then(setWebSearchApiKey).catch(() => {}) }, [])

  useEffect(() => { onSettingsChangedRef.current = onSettingsChanged }, [onSettingsChanged])

  useEffect(() => {
    const s = {
      repoOwner, repoName, baseBranch, githubToken, githubClientId,
      creativity, enableThinking, thinkingBudget, webSearchApiKey,
      permissionMode, generateTests, dryRun, hooksConfig,
    }
    saveSettings(s)
    onSettingsChangedRef.current?.(s)
  }, [repoOwner, repoName, baseBranch, githubToken, githubClientId,
      creativity, enableThinking, thinkingBudget, webSearchApiKey,
      permissionMode, generateTests, dryRun, hooksConfig]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hasGithub) return
    shadowContext.startIndexing(githubToken, repoOwner, repoName, baseBranch, () => {
      setShadowStatus(shadowContext.statusSummary())
    })
  }, [hasGithub, githubToken, repoOwner, repoName, baseBranch]) // eslint-disable-line react-hooks/exhaustive-deps

  // Watchdog — resets stuck busy flags after 5 min
  useEffect(() => {
    if (isGenerating) {
      generationStartRef.current = Date.now()
      const id = setTimeout(() => {
        const elapsed = Date.now() - (generationStartRef.current || 0)
        if (elapsed >= 5 * 60 * 1000) {
          setIsGenerating(false); setIsGenTests(false)
          setIsPlanning(false);   setIsAmplifying(false)
          logActivity('warn', '⚠ Watchdog: generation timed out after 5 min — state reset')
        }
      }, 5 * 60 * 1000)
      return () => clearTimeout(id)
    } else {
      generationStartRef.current = null
    }
  }, [isGenerating]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedModelId && !activeModelId) setActiveModelId(selectedModelId)
  }, [selectedModelId, activeModelId])

  // Repo picker outside-click handler
  useEffect(() => {
    if (!repoPickerOpen) return
    const handler = e => {
      if (repoPickerRef.current && !repoPickerRef.current.contains(e.target))
        setRepoPickerOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [repoPickerOpen])

  // ── Sub-hooks ─────────────────────────────────────────────────────────────
  const { conversation, setConversation, turnCount, setTurnCount, reset: resetConversation } = useConversation()
  const { bridgeAvailable, callExecBridge, callExecBridgeStream } = useExecBridge()
  const { activityLog, activityRef, logActivity, updateActivity, clearActivity } = useActivityLog(activityFeedRef)

  const activeModel   = models?.find(m => m.id === activeModelId) ?? models?.[0]
  const hasGithub     = !!(githubToken && repoOwner && repoName)
  const shouldUseAgent = hasGithub

  const githubConfig = useMemo(
    () => ({ token: githubToken, owner: repoOwner, repo: repoName, branch: baseBranch }),
    [githubToken, repoOwner, repoName, baseBranch],
  )

  const agentSession = useAgentSession({
    modelConfig:     activeModel,
    githubConfig,
    sourceRepoConfig: null,
    bridgeAvailable,
    webSearchApiKey,
    planMode,
    hooksConfig,
    logActivity,
    updateActivity,
    clearActivity,
    activityRef,
    onSetActiveTab:  setActiveTab,
    onSetError:      setError,
    onPromptClear:   useCallback(() => setPrompt(''), []),
    onPlanDone:      (task, summary) => setPlanApproval({ task, summary }),
    onAgentStart:    (task) => setConversation(prev => [...prev, { role: 'user', content: task }]),
    onAgentComplete: async (task, text) => {
      if (text?.trim()) setConversation(prev => [...prev, { role: 'assistant', content: text }])
      if (hasGithub && !dryRun && agentBranchRef.current && agentBranchRef.current !== baseBranch) {
        const branch = agentBranchRef.current
        agentBranchRef.current = null
        try {
          const prBody = [
            `## BLUSWAN AI Generated Code`, ``,
            `**Task:** ${task.slice(0, 200)}`, ``, `---`,
            `*Generated by BLUSWAN — WolfKrow AI Coding Assistant*`,
          ].join('\n')
          const pr = await createPullRequest(githubToken, repoOwner, repoName,
            `BLUSWAN: ${task.slice(0, 72)}`, branch, baseBranch, prBody)
          setPrResult({ url: pr?.html_url, number: pr?.number })
          setLastBranchName(branch)
          logActivity('push', `✓ PR #${pr?.number} opened — merge on GitHub to apply changes`)
        } catch (err) {
          logActivity('error', `✗ PR creation failed: ${err.message}`)
        }
      }
    },
    availableModels: models || [],
  })

  // ── Derived values ────────────────────────────────────────────────────────
  const activeFile      = filePlan[activeFileIndex] ?? {}
  const filePath        = activeFile.path            ?? ''
  const existingContent = activeFile.existingContent ?? null
  const editMode        = existingContent !== null ? 'patch' : 'replace'
  const generatedCode   = activeFile.code            ?? ''
  const testCode        = activeFile.testCode         ?? ''
  const patchEdits      = activeFile.patchEdits       ?? []
  const diffText        = activeFile.diffText         ?? ''
  const language        = detectLanguage(filePath, generatedCode)

  const costEstimate = useMemo(() => {
    const text = prompt.trim()
    if (!text) return null
    const model = models?.find(m => m.id === activeModelId)
    return estimateCost(text, model?.modelId)
  }, [prompt, activeModelId, models])

  const updatePlanEntry = useCallback((index, updates) => {
    planRef.current = planRef.current.map((e, i) => i === index ? { ...e, ...updates } : e)
    setFilePlan([...planRef.current])
  }, [])

  // ── Handlers ─────────────────────────────────────────────────────────────
  // (added in p3/usestate-generate, p3/usestate-handlers, p3/usestate-lrm-return)

  return {}
}
