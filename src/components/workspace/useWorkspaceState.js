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

  // ── Generation helpers ────────────────────────────────────────────────────
  const setActivePhase = useCallback((phase) => {
    setPipelinePhase(phase)
    setPipelineSteps(createPipelineSteps(phase))
  }, [])

  const emitStreamEvent = useCallback((event) => {
    if (!event?.type) return
    if (event.type === 'status' && event.phase) setActivePhase(event.phase)
    if (event.type === 'plan' && Array.isArray(event.steps)) {
      setAssistantMessage(prev => applyStreamEvent(prev, event)); return
    }
    if (event.type === 'content' || event.type === 'code' || event.type === 'validation')
      setAssistantMessage(prev => applyStreamEvent(prev, event))
  }, [setActivePhase])

  const orderFilePlan = useCallback((plan) => {
    const graph   = shadowContext.getImportGraph() || {}
    const paths   = plan.map(p => p.path)
    const pathSet = new Set(paths)
    const depsMap = {}
    paths.forEach(p => { depsMap[p] = new Set() })
    paths.forEach(p => { (graph[p] || []).forEach(d => { if (pathSet.has(d)) depsMap[p].add(d) }) })
    const result = [], temp = new Set(), perm = new Set()
    const visit = (node) => {
      if (perm.has(node) || temp.has(node)) return
      temp.add(node)
      for (const dep of depsMap[node] || []) visit(dep)
      temp.delete(node); perm.add(node); result.push(node)
    }
    paths.forEach(p => visit(p))
    const ordered = result.map(p => plan.find(e => e.path === p)).filter(Boolean)
    plan.forEach(p => { if (!ordered.find(e => e.path === p.path)) ordered.push(p) })
    return ordered
  }, [])

  const runSandboxTest = useCallback((code, lang = 'javascript') => {
    return new Promise((resolve) => {
      const iframe = sandboxRef.current
      if (!iframe) { resolve(null); return }
      const isPython = lang === 'python'
      const timeoutMs = isPython ? 22000 : 7000
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg)
        resolve('[timeout] code did not complete within expected time')
      }, timeoutMs)
      const onMsg = (e) => {
        if (!e.data?.done) return
        clearTimeout(timer); window.removeEventListener('message', onMsg)
        const errors = (e.data.log || []).filter(l => l.level === 'error')
        resolve(errors.length ? errors.map(l => l.text).join('\n') : null)
      }
      window.addEventListener('message', onMsg)
      iframe.srcdoc = isPython ? buildPyodideSandboxHtml(code) : buildSandboxHtml(code, '')
    })
  }, [])

  const autoRemediate = useCallback(async (code, lang, model, signal, filePath = '', purpose = '') => {
    if (!REMEDIATABLE.has(lang)) return code
    const MAX_ATTEMPTS = 5
    let current = code
    const isJS     = lang === 'javascript' || lang === 'typescript'
    const isPython = lang === 'python'
    const hasSandbox = isJS || isPython
    const checklist  = LANG_CHECKLIST[lang] || null
    let hasEslint = false, hasTsNode = false
    if (isJS && bridgeAvailable) {
      const [eslintProbe, tsnodeProbe] = await Promise.all([
        callExecBridge('npx eslint --version', undefined, 5000),
        lang === 'typescript' ? callExecBridge('npx ts-node --version', undefined, 5000) : Promise.resolve({ exitCode: 1 }),
      ])
      hasEslint = eslintProbe.exitCode === 0
      hasTsNode = tsnodeProbe.exitCode === 0
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      setRemediationStatus(`Auto-remediating (${attempt}/${MAX_ATTEMPTS})…`)
      let errorHint = null
      if (isJS && hasEslint) {
        const ext  = lang === 'typescript' ? 'ts' : 'js'
        const lint = await callExecBridge(
          `npx eslint --stdin --stdin-filename=bluswan-check.${ext} --format=compact --rule '{"no-undef":"error","no-unused-vars":"warn"}'`,
          undefined, 15000, current)
        const lintOut = [lint.stdout, lint.stderr].filter(Boolean).join('\n').trim()
        if (lint.exitCode !== 0 && lintOut) {
          errorHint = lintOut.slice(0, 1500)
        } else if (lang === 'typescript' && hasTsNode) {
          const ts    = await callExecBridge('npx ts-node --transpile-only --stdin', undefined, 15000, current)
          const tsOut = [ts.stdout, ts.stderr].filter(Boolean).join('\n').trim()
          if (ts.exitCode !== 0 && tsOut) errorHint = tsOut.slice(0, 1500)
          else break
        } else { break }
      } else if (hasSandbox) {
        errorHint = await runSandboxTest(current, lang)
        if (!errorHint) break
      } else {
        errorHint = checklist || 'syntax review requested'
      }
      const fileCtx    = filePath ? ` in ${filePath}` : ''
      const purposeCtx = purpose  ? ` Purpose: ${purpose}.` : ''
      const fixCtx = [
        { role: 'user',      content: `You are a code repair assistant.${purposeCtx} Fix all syntax errors, undefined references, type errors, and obvious runtime bugs. Output ONLY the corrected ${lang} code — no fences, no explanations.` },
        { role: 'assistant', content: 'Corrected code:' },
      ]
      const fixMsg = hasSandbox
        ? `Fix this ${lang} code${fileCtx}. Error:\n\n${errorHint}\n\nOutput ONLY the corrected code:\n\n${current}`
        : checklist
          ? `Review this ${lang} code${fileCtx} against this checklist:\n${checklist}\n\nFix every issue. Output ONLY the corrected code:\n\n${current}`
          : `Review this ${lang} code${fileCtx} for syntax errors and fix them. Output ONLY the corrected code:\n\n${current}`
      try {
        const fixed = await runPromptWithRetry(model, fixMsg, fixCtx, null, signal)
        const newCode = extractCode(fixed)
        if (newCode && newCode !== current) current = newCode; else break
      } catch { break }
    }
    setRemediationStatus(null)
    return current
  }, [runSandboxTest, bridgeAvailable, callExecBridge])

  // ── handleGenerate ────────────────────────────────────────────────────────
  const handleGenerate = useCallback(async (userMsg = prompt, isRefinement = false) => {
    if (!userMsg.trim()) { setError('Enter a coding request first.'); return }
    const model = models?.find(m => m.id === activeModelId)
    if (!model)        { setError('Select a model.'); return }
    if (!model.apiKey) { setError(`No API key for "${model.name}". Open Admin Panel.`); return }

    const { command, content } = parsePromptCommand(userMsg)
    if (command === '/reset') {
      resetConversation(); setFilePlan([]); planRef.current = []
      setTurnCount(0); setValidationResults([]); setActivePhase('understanding'); return
    }
    const requestText = command ? content : userMsg
    if (!requestText.trim()) { setError(`Add details after ${command}.`); return }

    setError(''); setValidationResults([])
    setAssistantMessage(createAssistantMessage(`${Date.now()}`))
    emitStreamEvent(createStreamEvent('status', { phase: 'understanding' }))
    setAmplifierDecisions([]); setIsGenerating(true)
    setConversation(prev => [...prev, { role: 'user', content: requestText }])

    if (!isRefinement) {
      setGitStatus(null); setPrResult(null); setSandboxOutput([])
      clearActivity(); setActiveTab('code')
    }

    const ctrl = new AbortController()
    abortRef.current = ctrl
    const effectiveModel = {
      ...model,
      temperature: parseFloat((0.2 + (creativity / 100) * 0.8).toFixed(2)),
      ...(enableThinking ? { enableThinking: true, thinkingBudget } : {}),
    }

    try {
      let effectiveMsg = requestText
      if (!isRefinement && isVaguePrompt(requestText)) {
        setIsAmplifying(true)
        const ampId = logActivity('amplify', '◆ Analyzing intent…')
        const conv  = shadowContext.getConventions()
        const { enrichedPrompt, decisions } = await amplifyPrompt(
          requestText, conv, effectiveModel, ctrl.signal, conversation.slice(-6))
        setIsAmplifying(false)
        if (enrichedPrompt !== requestText) {
          effectiveMsg = enrichedPrompt; setAmplifierDecisions(decisions)
          updateActivity(ampId, { status: 'done', msg: `◆ Intent clarified — ${decisions.length} assumption${decisions.length !== 1 ? 's' : ''} made` })
        } else {
          updateActivity(ampId, { status: 'done', msg: '◆ Intent clear — proceeding as-is' })
        }
      }

      if (isRefinement) {
        const entry = planRef.current[activeFileIndex] ?? {}
        const lang  = detectLanguage(entry.path, entry.code || '')
        const mode  = entry.existingContent !== null ? 'patch' : 'replace'
        const refStyleExamples = shadowContext.getStyleExamples(effectiveMsg, STYLE_EXAMPLES_LIMIT)
        const sys   = buildFileSystemPrompt(entry.path, entry.existingContent, lang, repoOwner, repoName, false, shadowContext.getBluswanMd(), [], refStyleExamples)
        const refMsg = `Current code:\n${entry.code || ''}\n\nChange request: ${effectiveMsg}`
        const ctx   = [{ role: 'user', content: sys }, { role: 'assistant', content: 'Understood. I will output only the code.' }, ...conversation]
        emitStreamEvent(createStreamEvent('status', { phase: 'refining' }))
        const refId = logActivity('generate', `↺ Refining ${entry.path || 'file'}…`)
        let streaming = '', prevStreaming = ''
        const raw = await runPromptWithRetry(effectiveModel, refMsg, ctx, (partial) => {
          streaming = mode === 'patch' && entry.existingContent ? partial : extractCode(partial)
          updatePlanEntry(activeFileIndex, { code: streaming })
          const chunk = streaming.startsWith(prevStreaming) ? streaming.slice(prevStreaming.length) : streaming
          prevStreaming = streaming
          emitStreamEvent(createStreamEvent('code', { chunk }))
          updateActivity(refId, { detail: `${streaming.split('\n').length} lines…` })
        }, ctrl.signal)
        let finalCode = extractCode(raw)
        if (mode === 'patch' && entry.existingContent) {
          const { result, edits } = applyEditBlocks(entry.existingContent, raw)
          if (edits.length > 0) finalCode = result
        }
        updatePlanEntry(activeFileIndex, { code: finalCode, status: 'done' })
        emitStreamEvent(createStreamEvent('status', { phase: 'validating' }))
        updateActivity(refId, { status: 'done', msg: `↺ Refined ${entry.path || 'file'}`, detail: `${finalCode.split('\n').length} lines` })
        const refValidation = ['✓ Refinement applied to active file.', '✓ Output is ready for review.']
        setValidationResults(refValidation)
        emitStreamEvent(createStreamEvent('validation', { results: refValidation }))
        const refOut = formatStructuredOutput({
          summary: `Refined ${entry.path || 'active file'} based on follow-up request.`,
          plan: [`Apply requested changes to ${entry.path || 'active file'}`],
          code: finalCode, codeLang: lang,
          changes: [`Updated ${entry.path || 'active file'}`],
          validation: refValidation,
          notes: ['Further follow-ups will continue from this state.'],
        })
        setConversation(prev => [...prev, { role: 'assistant', content: refOut }])
        setTurnCount(t => t + 1); setRefinementPrompt(''); setActiveTab('code')
      } else {
        const recentFiles = filePlan.filter(e => e.status === 'done').map(e => e.path)
        emitStreamEvent(createStreamEvent('status', { phase: 'planning' }))
        const planId = logActivity('plan', '◆ Building file plan…')
        setIsPlanning(true)
        const rawPlan = await buildFilePlan(effectiveMsg, shadowContext._fileIndex || [], shadowContext.getConventions(), effectiveModel, ctrl.signal, recentFiles)
        setIsPlanning(false)
        updateActivity(planId, { status: 'done', msg: `◆ Plan — ${rawPlan.length} file${rawPlan.length !== 1 ? 's' : ''}`, detail: rawPlan.map(e => e.path.split('/').pop()).join(' · ') })
        const orderedRawPlan = orderFilePlan(rawPlan)
        emitStreamEvent(createStreamEvent('plan', { steps: orderedRawPlan.map(e => `${e.action === 'modify' ? 'Update' : 'Create'} ${e.path} — ${e.purpose}`) }))
        if (command === '/plan') {
          const planOnlyValidation = ['✓ Plan generated.', '✓ No code emitted in /plan mode.']
          setValidationResults(planOnlyValidation)
          setConversation(prev => [...prev, { role: 'assistant', content: formatStructuredOutput({ summary: `Created an execution plan for: ${requestText}`, plan: orderedRawPlan.map(e => `${e.action === 'modify' ? 'Update' : 'Create'} ${e.path} — ${e.purpose}`), code: '', changes: orderedRawPlan.map(e => `${e.action === 'modify' ? 'Will update' : 'Will add'} ${e.path}`), validation: planOnlyValidation, notes: ['Run /code to execute this plan.'] }) }])
          setTurnCount(t => t + 1); setActivePhase('complete'); return
        }
        const initialPlan = orderedRawPlan.map(e => ({ ...e, existingContent: null, _sha: null, code: '', testCode: '', patchEdits: [], diffText: '', status: 'pending', error: null }))
        planRef.current = initialPlan; setFilePlan([...initialPlan]); setActiveFileIndex(0)

        if (hasGithub) {
          for (let i = 0; i < planRef.current.length; i++) {
            if (ctrl.signal.aborted) break
            const ep = planRef.current[i]
            if (ep.action !== 'modify') continue
            updatePlanEntry(i, { status: 'fetching' })
            const fetchId = logActivity('fetch', `⬇ Reading ${ep.path}`)
            try {
              const file = await getFileContent(githubToken, repoOwner, repoName, ep.path, baseBranch)
              if (file?.content) {
                const c = decodeBase64(file.content)
                updatePlanEntry(i, { existingContent: c, _sha: file.sha, status: 'pending' })
                updateActivity(fetchId, { status: 'done', msg: `⬇ ${ep.path}`, detail: `${c.split('\n').length} lines` })
              } else {
                updatePlanEntry(i, { status: 'pending' })
                updateActivity(fetchId, { status: 'skip', msg: `⬇ ${ep.path} — not found, will create` })
              }
            } catch {
              updatePlanEntry(i, { status: 'pending' })
              updateActivity(fetchId, { status: 'skip', msg: `⬇ ${ep.path} — fetch failed, will create` })
            }
          }
        }

        const bluswanMd   = shadowContext.getBluswanMd()
        let ambientFiles  = []
        try { ambientFiles = await shadowContext.getContextContent(effectiveMsg, CONTEXT_FILES_LIMIT) }
        catch (ctxErr) { logActivity('warn', `⚠ Context index unavailable (${ctxErr.message})`) }
        let styleExamples = []
        try { styleExamples = shadowContext.getStyleExamples(effectiveMsg, STYLE_EXAMPLES_LIMIT) }
        catch { /* non-fatal */ }

        emitStreamEvent(createStreamEvent('status', { phase: 'coding' }))
        for (let i = 0; i < planRef.current.length; i++) {
          if (ctrl.signal.aborted) break
          setActiveFileIndex(i); currentFileRef.current = i
          const entry = planRef.current[i]
          const lang  = detectLanguage(entry.path, '')
          const mode  = entry.existingContent !== null ? 'patch' : 'replace'
          const contextFiles    = ambientFiles.filter(f => f.path !== entry.path)
          const fileStyleExamples = styleExamples.filter(s => s.path !== entry.path)
          const sys     = buildFileSystemPrompt(entry.path, entry.existingContent, lang, repoOwner, repoName, false, bluswanMd, contextFiles, fileStyleExamples)
          const fileTask = `${effectiveMsg}\n\nFor this file: ${entry.path} — ${entry.purpose}`
          updatePlanEntry(i, { status: 'generating' })
          const genId = logActivity('generate', `▶ Generating ${entry.path}`, `${mode} mode`)
          try {
            let streaming = '', prevStreaming = ''
            const raw = await runPromptWithRetry(effectiveModel, fileTask, [
              { role: 'user', content: sys }, { role: 'assistant', content: 'Understood. I will output only the code.' },
            ], (partial) => {
              streaming = mode === 'patch' && entry.existingContent ? partial : extractCode(partial)
              updatePlanEntry(i, { code: streaming })
              const chunk = streaming.startsWith(prevStreaming) ? streaming.slice(prevStreaming.length) : streaming
              prevStreaming = streaming
              emitStreamEvent(createStreamEvent('code', { chunk }))
              updateActivity(genId, { detail: `${streaming.split('\n').length} lines…` })
            }, ctrl.signal)
            let finalCode = extractCode(raw), newEdits = [], newDiff = ''
            if (mode === 'patch' && entry.existingContent) {
              const { result, edits } = applyEditBlocks(entry.existingContent, raw)
              if (edits.length > 0) {
                finalCode = result; newEdits = edits
                const old = entry.existingContent.split('\n').map((l, idx) => `- ${String(idx+1).padStart(3)}: ${l}`)
                const neo = result.split('\n').map((l, idx) => `+ ${String(idx+1).padStart(3)}: ${l}`)
                newDiff = `--- a/${entry.path}\n+++ b/${entry.path}\n\n${old.join('\n')}\n\n${neo.join('\n')}`
              }
            }
            if (!newDiff) newDiff = computeLineDiff(entry.existingContent || null, finalCode, entry.path)
            if (mode !== 'patch' && !isCodeComplete(finalCode, lang)) {
              const contCtx = [{ role: 'user', content: sys }, { role: 'assistant', content: 'Understood. I will output only the code.' }]
              for (let cont = 0; cont < 3; cont++) {
                if (ctrl.signal.aborted || isCodeComplete(finalCode, lang)) break
                const lineCount = finalCode.split('\n').length
                updateActivity(genId, { detail: `continuing… (${lineCount} lines, attempt ${cont+1}/3)` })
                const tail = finalCode.split('\n').slice(-30).join('\n')
                try {
                  const contRaw = await runPromptWithRetry(effectiveModel, `The previous code output for ${entry.path} was truncated at ${lineCount} lines. The last lines were:\n\n${tail}\n\nContinue writing ONLY the remaining code from exactly where the output ended. No fences, no explanations.`, contCtx, null, ctrl.signal)
                  const contChunk = extractCode(contRaw).trim()
                  if (contChunk) finalCode = finalCode.trimEnd() + '\n' + contChunk; else break
                } catch (contErr) { updateActivity(genId, { detail: `continuation failed (${contErr.message})` }); break }
              }
            }
            updateActivity(genId, { status: 'done', msg: `▶ ${entry.path}`, detail: `${finalCode.split('\n').length} lines` })
            emitStreamEvent(createStreamEvent('status', { phase: 'refining' }))
            updatePlanEntry(i, { status: 'remediating', code: finalCode })
            const remId = logActivity('remediate', `⊛ Testing ${entry.path}`)
            finalCode = await autoRemediate(finalCode, lang, effectiveModel, ctrl.signal, entry.path, entry.purpose)
            updateActivity(remId, { status: 'done', msg: `⊛ ${entry.path} — clean` })
            let builtTestCode = ''
            if (generateTests) {
              setIsGenTests(true)
              const testId = logActivity('test', `⊛ Writing tests for ${entry.path}`)
              try {
                const testSys = buildFileSystemPrompt(entry.path, null, lang, repoOwner, repoName, true)
                const testRaw = await runPromptWithRetry(effectiveModel, `Write tests for:\n${finalCode}`, [{ role: 'user', content: testSys }, { role: 'assistant', content: 'Understood. Test code only.' }], null, ctrl.signal)
                builtTestCode = extractCode(testRaw)
                updateActivity(testId, { status: 'done', msg: `⊛ Tests → ${testFilePath(entry.path)}`, detail: `${builtTestCode.split('\n').length} lines` })
              } catch (e) {
                if (e.name !== 'AbortError') updateActivity(testId, { status: 'error', msg: `⊛ Test gen failed: ${e.message}` })
              } finally { setIsGenTests(false) }
            }
            updatePlanEntry(i, { code: finalCode, testCode: builtTestCode, patchEdits: newEdits, diffText: newDiff, status: 'done' })
          } catch (err) {
            if (err.name !== 'AbortError') {
              updatePlanEntry(i, { status: 'error', error: err.message })
              updateActivity(genId, { status: 'error', msg: `✗ ${entry.path} — ${err.message}` })
            }
            setIsGenTests(false)
          }
        }

        if (!ctrl.signal.aborted && planRef.current.length > 0) {
          emitStreamEvent(createStreamEvent('status', { phase: 'validating' }))
          const doneCount = planRef.current.filter(e => e.status === 'done').length
          logActivity('done', `✓ Complete — ${doneCount}/${planRef.current.length} file${planRef.current.length !== 1 ? 's' : ''} generated`)
          const hasDiffs = planRef.current.some(e => e.diffText?.trim())
          setActiveTab(hasDiffs ? 'diff' : 'code')
          const he = { id: Date.now().toString(), prompt: requestText.slice(0, 100), filePath: planRef.current[0]?.path || '', timestamp: new Date().toISOString() }
          const planSteps = planRef.current.map(e => `${e.action === 'modify' ? 'Update' : 'Create'} ${e.path} — ${e.purpose}`)
          const primary = planRef.current[0] || {}
          const combinedDiff = planRef.current.map(e => e.diffText?.trim()).filter(Boolean).join('\n\n')
          const validation = [
            `✓ Generated ${doneCount}/${planRef.current.length} planned file(s).`,
            planRef.current.some(e => e.status === 'error') ? '⚠ Some files failed and may need retry.' : '✓ No file-level generation errors.',
            generateTests ? '✓ Test generation attempted for completed files.' : '⚠ Test generation disabled.',
          ]
          setValidationResults(validation)
          emitStreamEvent(createStreamEvent('validation', { results: validation }))
          const modeCode = command === '/diff' ? combinedDiff : (primary.code || '')
          const assistantText = formatStructuredOutput({
            summary: `Implemented: ${requestText}`,
            plan: planSteps, code: modeCode,
            codeLang: command === '/diff' ? 'diff' : detectLanguage(primary.path || '', primary.code || ''),
            changes: planRef.current.map(e => `${e.action === 'modify' ? 'Updated' : 'Added'} ${e.path}`),
            validation, notes: ['Use follow-up prompts to iteratively modify generated files.'],
          })
          setConversation(prev => [...prev, { role: 'assistant', content: assistantText }])
          setTurnCount(t => t + 1)
          const updated = [he, ...history]
          setHistory(updated); saveHistory(updated)
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') { setError(`Generation failed: ${err.message}`); logActivity('error', `✗ ${err.message}`) }
    } finally {
      setIsGenerating(false); setIsPlanning(false); setIsAmplifying(false); setIsGenTests(false)
      emitStreamEvent(createStreamEvent('status', { phase: 'complete' })); setPrompt('')
    }
  }, [
    prompt, models, activeModelId, conversation, filePlan, generateTests, creativity,
    enableThinking, thinkingBudget, repoOwner, repoName, baseBranch, githubToken, hasGithub,
    history, activeFileIndex, autoRemediate, updatePlanEntry, logActivity, updateActivity,
    setActivePhase, resetConversation, emitStreamEvent, orderFilePlan, clearActivity,
  ]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── handleRefine / handleRetryFile ───────────────────────────────────────
  const handleRefine = useCallback(() => {
    if (refinementPrompt.trim() && !isGenerating) handleGenerate(refinementPrompt, true)
  }, [refinementPrompt, isGenerating, handleGenerate])

  const handleRetryFile = useCallback(async (fileIndex) => {
    if (isGenerating) return
    const entry = planRef.current[fileIndex]
    if (!entry) return
    const model = models?.find(m => m.id === activeModelId)
    if (!model?.apiKey) { setError('Select a model with an API key.'); return }
    setIsGenerating(true)
    updatePlanEntry(fileIndex, { status: 'generating', error: undefined })
    const retryId = logActivity('generate', `↺ Retrying ${entry.path}`)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const lang = detectLanguage(entry.path, '')
      const bluswanMd = shadowContext.getBluswanMd()
      let retryContextFiles = []
      try {
        retryContextFiles = await shadowContext.getContextContent(`${prompt || entry.purpose || entry.path} ${entry.path}`, CONTEXT_FILES_LIMIT)
        retryContextFiles = retryContextFiles.filter(f => f.path !== entry.path)
      } catch {}
      const sys      = buildFileSystemPrompt(entry.path, entry.existingContent, lang, repoOwner, repoName, false, bluswanMd, retryContextFiles)
      const fileTask = `${prompt || 'Regenerate this file.'}\n\nFor this file: ${entry.path} — ${entry.purpose}`
      const mode     = entry.existingContent !== null ? 'patch' : 'replace'
      let streaming  = ''
      const raw = await runPromptWithRetry(model, fileTask, [
        { role: 'user', content: sys }, { role: 'assistant', content: 'Understood. I will output only the code.' },
      ], (partial) => {
        streaming = mode === 'patch' && entry.existingContent ? partial : extractCode(partial)
        updatePlanEntry(fileIndex, { code: streaming })
      }, ctrl.signal)
      let finalCode = extractCode(raw)
      if (mode === 'patch' && entry.existingContent) {
        const { result, edits } = applyEditBlocks(entry.existingContent, raw)
        if (edits.length > 0) finalCode = result
      }
      finalCode = await autoRemediate(finalCode, lang, model, ctrl.signal, entry.path, entry.purpose)
      const newDiff = computeLineDiff(entry.existingContent || null, finalCode, entry.path)
      updatePlanEntry(fileIndex, { code: finalCode, diffText: newDiff, status: 'done', error: undefined })
      updateActivity(retryId, { status: 'done', msg: `↺ ${entry.path} — retry succeeded`, detail: `${finalCode.split('\n').length} lines` })
    } catch (err) {
      if (err.name !== 'AbortError') {
        updatePlanEntry(fileIndex, { status: 'error', error: err.message })
        updateActivity(retryId, { status: 'error', msg: `↺ ${entry.path} — retry failed: ${err.message}` })
        setError(`Retry failed: ${err.message}`)
      }
    } finally { setIsGenerating(false) }
  }, [isGenerating, models, activeModelId, repoOwner, repoName, prompt, autoRemediate, updatePlanEntry, logActivity, updateActivity]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── BLUSWAN.md + post-push tests ──────────────────────────────────────────
  const handleSaveBluswanMd = useCallback(async () => {
    if (!hasGithub) { setError('GitHub required to save BLUSWAN.md.'); return }
    setIsSavingBluswanMd(true)
    try {
      const existing = await getFileContent(githubToken, repoOwner, repoName, 'BLUSWAN.md', baseBranch)
      await createOrUpdateFile(githubToken, repoOwner, repoName, 'BLUSWAN.md', bluswanMdDraft, 'docs: update BLUSWAN.md project instructions', baseBranch, existing?.sha || null)
      shadowContext.bluswanMd = bluswanMdDraft
      logActivity('done', '✓ BLUSWAN.md saved to repo')
    } catch (e) { setError(`Failed to save BLUSWAN.md: ${e.message}`) }
    finally { setIsSavingBluswanMd(false) }
  }, [hasGithub, githubToken, repoOwner, repoName, baseBranch, bluswanMdDraft, logActivity])

  const handleRunProjectTests = useCallback(async () => {
    if (!bridgeAvailable) return
    setIsRunningPostPushTests(true)
    logActivity('test', '⊛ Running project tests…')
    let out = ''
    await callExecBridgeStream('npm test -- --watchAll=false --passWithNoTests', undefined, (chunk) => { out += chunk }, 120000)
    setIsRunningPostPushTests(false)
    const passed = out.includes('Tests:') && !out.includes('failed')
    logActivity('test', passed ? '⊛ Tests passed' : '⊛ Tests failed — see output', out.slice(-300))
    setActiveTab('code')
  }, [bridgeAvailable, callExecBridgeStream, logActivity])

  // ── Reset / abort ─────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    resetConversation(); clearActivity(); setFilePlan([]); setActiveFileIndex(0)
    setIsPlanning(false); planRef.current = []; setRefinementPrompt(''); setSandboxOutput([])
    setPrResult(null); setGitStatus(null); setPrompt(''); setError(''); setAmplifierDecisions([])
    setRemediationStatus(null); setPlanApproval(null); setExecutedPlan(null)
    setLastBranchName(''); setAttachedFiles([]); setActiveTab('code')
  }, [resetConversation, clearActivity])

  const handleAbort = useCallback(() => {
    abortRef.current?.abort()
    agentSession.abort()
    setIsGenerating(false); setIsGenTests(false); setIsPushing(false); setPushStep('')
  }, [agentSession])

  // ── Repo picker ───────────────────────────────────────────────────────────
  const loadRepos = useCallback(async () => {
    if (!githubToken) return
    setRepoPickerLoading(true); setRepoPickerError(null)
    try {
      const repos = await listUserRepos(githubToken)
      setUserRepos(repos)
      if (repos.length === 0) setRepoPickerError('No repositories returned. Check token scopes (needs repo).')
    } catch (err) { setRepoPickerError(err.message || 'Failed to load repositories') }
    finally { setRepoPickerLoading(false) }
  }, [githubToken])

  const openRepoPicker = useCallback(async () => {
    setRepoPickerOpen(true); setRepoPickerSearch('')
    if (userRepos.length > 0) return
    await loadRepos()
  }, [userRepos.length, loadRepos])

  const handlePickRepo = useCallback((repo) => {
    setRepoOwner(repo.owner.login); setRepoName(repo.name)
    setBaseBranch(repo.default_branch || 'main'); setRepoPickerOpen(false); setLastBranchName('')
  }, [])

  const handleReindex = useCallback(async () => {
    if (!hasGithub) return
    setShadowStatus('reindexing…')
    try { await shadowContext.reindex(); setShadowStatus(shadowContext.statusSummary()) }
    catch { setShadowStatus('reindex failed') }
  }, [hasGithub])

  // ── GitHub Actions ────────────────────────────────────────────────────────
  const loadWorkflows = useCallback(async () => {
    if (!hasGithub) return
    try { const res = await listWorkflows(githubToken, repoOwner, repoName); setWorkflows(res?.workflows || []) }
    catch { setWorkflows([]) }
  }, [hasGithub, githubToken, repoOwner, repoName])

  const triggerWorkflow = useCallback(async () => {
    if (!hasGithub) return
    const wf = workflows.find(w => w.events?.includes('workflow_dispatch')) || workflows[0]
    if (!wf) return
    setIsPollingCI(true)
    const id = logActivity('ci', `⊙ Triggering workflow ${wf.name || wf.path}`)
    try {
      const dispatch = await dispatchWorkflow(githubToken, repoOwner, repoName, wf.id, baseBranch)
      if (!dispatch) { updateActivity(id, { status: 'error', msg: `⊙ Failed to trigger ${wf.name || wf.path}` }); return }
      updateActivity(id, { status: 'done', msg: `⊙ Workflow triggered: ${wf.name || wf.path}` })
      for (let i = 0; i < 18; i++) {
        await new Promise(r => setTimeout(r, 5000))
        const runs = await getWorkflowRuns(githubToken, repoOwner, repoName, baseBranch, 5, wf.id)
        const run  = runs?.workflow_runs?.find(r => r.workflow_id === wf.id)
        if (run && run.status !== 'queued' && run.status !== 'in_progress') {
          setWorkflowRuns([run])
          updateActivity(id, { status: run.conclusion === 'success' ? 'done' : 'error', msg: `⊙ Workflow ${run.name} ${run.conclusion || run.status}`, detail: run.html_url })
          break
        }
      }
    } catch (e) { updateActivity(id, { status: 'error', msg: `⊙ Workflow trigger failed: ${e.message}` }) }
    finally { setIsPollingCI(false) }
  }, [hasGithub, workflows, githubToken, repoOwner, repoName, baseBranch, logActivity, updateActivity])

  // ── handlePush ────────────────────────────────────────────────────────────
  const confirmAction = useCallback((description) => {
    if (permissionMode === 'auto') return true
    if (permissionMode === 'ask') return window.confirm(`BLUSWAN permission request\n\n${description}\n\nProceed?`)
    return window.confirm(`BLUSWAN — manual mode\n\n${description}\n\nThis action writes to GitHub. Confirm to continue.`)
  }, [permissionMode])

  const handlePush = useCallback(async () => {
    const filesToPush = filePlan.filter(e => e.code?.trim())
    if (filesToPush.length === 0) { setError('Generate code first.'); return }
    if (!githubToken) { setError('GitHub token required — open Settings.'); setSettingsOpen(true); return }
    if (!repoOwner || !repoName) { setError('Repo owner and name required — open Settings.'); setSettingsOpen(true); return }
    const promptSummary = (history[0]?.prompt || prompt || 'BLUSWAN generated code').slice(0, 80)
    if (!dryRun && !confirmAction(`Push ${filesToPush.length} file${filesToPush.length !== 1 ? 's' : ''} to ${repoOwner}/${repoName} on a new branch, then open a PR`)) return
    setError(''); setIsPushing(true); setPrResult(null); setActiveTab('code')
    const steps = []
    const log = (msg, ok = true) => { steps.push({ msg, ok }); setGitStatus([...steps]) }
    logActivity('push', `⬆ Pushing ${filesToPush.length} file${filesToPush.length !== 1 ? 's' : ''} to GitHub`)
    try {
      setPushStep('Verifying repository…')
      const repoId = logActivity('push', `⬆ Verifying ${repoOwner}/${repoName}`)
      const repo   = await getRepo(githubToken, repoOwner, repoName)
      log(`✓ ${repoOwner}/${repoName} — ${repo.private ? 'private' : 'public'}`)
      updateActivity(repoId, { status: 'done', msg: `⬆ ${repoOwner}/${repoName}` })
      setPushStep(`Fetching branch "${baseBranch}"…`)
      const branchId  = logActivity('push', `⬆ Resolving branch "${baseBranch}"`)
      const branchData = await getBranch(githubToken, repoOwner, repoName, baseBranch)
      const baseSha   = branchData.commit.sha
      log(`✓ Base "${baseBranch}" → ${baseSha.slice(0, 7)}`)
      updateActivity(branchId, { status: 'done', msg: `⬆ "${baseBranch}" @ ${baseSha.slice(0, 7)}` })
      const targetBranch = generateBranchName(promptSummary)
      setPushStep(`Creating branch "${targetBranch}"…`)
      const newBrId = logActivity('push', `⬆ Creating branch "${targetBranch}"`)
      if (!dryRun) await createBranch(githubToken, repoOwner, repoName, targetBranch, baseSha)
      log(`${dryRun ? '○' : '✓'} Branch "${targetBranch}"${dryRun ? ' (dry run)' : ''}`)
      updateActivity(newBrId, { status: 'done', msg: `⬆ Branch "${targetBranch}" ready${dryRun ? ' (dry run)' : ''}` })
      setLastBranchName(targetBranch)
      const modelName = models?.find(m => m.id === activeModelId)?.name || 'Unknown'
      async function pushWithRetry(path, code, commitMsg, branch, initialSha) {
        let sha = initialSha
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await createOrUpdateFile(githubToken, repoOwner, repoName, path, code, commitMsg, branch, sha); return }
          catch (err) {
            if (err.status === 409 && attempt < 2) { const fresh = await getFileContent(githubToken, repoOwner, repoName, path, branch); sha = fresh?.sha || null }
            else throw err
          }
        }
      }
      for (const entry of filesToPush) {
        setPushStep(`Pushing "${entry.path}"…`)
        const fileId    = logActivity('push', `⬆ ${entry.path}`)
        const existing  = await getFileContent(githubToken, repoOwner, repoName, entry.path, targetBranch)
        const existingSha = existing?.sha || entry._sha || null
        const action    = existingSha ? 'update' : 'add'
        const commitMsg = `feat(bluswan): ${action} ${entry.path}\n\nGenerated by BLUSWAN: "${promptSummary}"`
        if (!dryRun) await pushWithRetry(entry.path, entry.code, commitMsg, targetBranch, existingSha)
        log(`${dryRun ? '○' : '✓'} ${dryRun ? '[dry run] ' : ''}${action === 'update' ? 'Updated' : 'Created'} ${entry.path}`)
        updateActivity(fileId, { status: 'done', msg: `⬆ ${action === 'update' ? 'Updated' : 'Created'} ${entry.path}${dryRun ? ' (dry run)' : ''}` })
        if (entry.testCode) {
          const tp = testFilePath(entry.path)
          setPushStep(`Pushing tests "${tp}"…`)
          const testPushId = logActivity('push', `⬆ ${tp}`)
          const existingTest = await getFileContent(githubToken, repoOwner, repoName, tp, targetBranch)
          if (!dryRun) await pushWithRetry(tp, entry.testCode, `test(bluswan): add tests for ${entry.path}`, targetBranch, existingTest?.sha || null)
          log(`${dryRun ? '○' : '✓'} ${dryRun ? '[dry run] ' : ''}Tests: ${tp}`)
          updateActivity(testPushId, { status: 'done', msg: `⬆ Tests: ${tp}${dryRun ? ' (dry run)' : ''}` })
        }
      }
      setPushStep('Creating pull request…')
      const prId    = logActivity('push', '⬆ Creating pull request…')
      const fileList = filesToPush.map(e => `- \`${e.path}\`${e.purpose ? ` — ${e.purpose}` : ''}`).join('\n')
      const prBody  = [`## BLUSWAN AI Generated Code`, ``, `**Prompt:** ${promptSummary}`, `**Model:** ${modelName}`, `**Files changed (${filesToPush.length}):**`, fileList, turnCount > 1 ? `**Refinement turns:** ${turnCount}` : '', ``, `---`, `*Generated by BLUSWAN — WolfKrow AI Coding Assistant*`].filter(Boolean).join('\n')
      let pr = null
      if (!dryRun) pr = await createPullRequest(githubToken, repoOwner, repoName, `BLUSWAN: ${promptSummary}`, targetBranch, baseBranch, prBody)
      const prUrl = pr?.html_url || `https://github.com/${repoOwner}/${repoName}/compare/${targetBranch}`
      setPrResult({ url: prUrl, number: pr?.number })
      log(`${dryRun ? '○' : '✓'} PR ${dryRun ? 'preview' : 'created'}: ${prUrl}`)
      updateActivity(prId, { status: 'done', msg: `⬆ PR${pr?.number ? ` #${pr.number}` : ''} ${dryRun ? 'preview' : 'created'}`, detail: prUrl })
      log('── Complete ──')
      logActivity('done', `✓ Push complete — ${filesToPush.length} file${filesToPush.length !== 1 ? 's' : ''}`)
      if (!dryRun && hasGithub) {
        const ciId = logActivity('ci', '⊙ Waiting for CI…')
        await new Promise(r => setTimeout(r, 4000))
        try {
          const runsData = await getWorkflowRuns(githubToken, repoOwner, repoName, targetBranch, 1)
          const run = runsData?.workflow_runs?.[0]
          if (run) {
            updateActivity(ciId, { msg: `⊙ CI: ${run.name} — ${run.status}` })
            let pollRun = run
            for (let p = 0; p < 30 && pollRun.status !== 'completed'; p++) {
              await new Promise(r => setTimeout(r, 10000))
              const refreshed = await getWorkflowRun(githubToken, repoOwner, repoName, pollRun.id)
              if (refreshed) pollRun = refreshed
              updateActivity(ciId, { msg: `⊙ CI: ${pollRun.name} — ${pollRun.status}` })
            }
            const ciOk = pollRun.conclusion === 'success'
            updateActivity(ciId, { status: ciOk ? 'done' : 'error', msg: `⊙ CI: ${pollRun.name} — ${pollRun.conclusion || pollRun.status}`, detail: pollRun.html_url })
          } else { updateActivity(ciId, { status: 'skip', msg: '⊙ CI: no workflow runs found' }) }
        } catch { updateActivity(ciId, { status: 'skip', msg: '⊙ CI: monitoring unavailable' }) }
      }
    } catch (err) { log(`✗ ${err.message}`, false); logActivity('error', `✗ Push failed: ${err.message}`); setError(`Push failed: ${err.message}`) }
    finally { setIsPushing(false); setPushStep('') }
  }, [filePlan, githubToken, repoOwner, repoName, baseBranch, dryRun, history, prompt, models, activeModelId, turnCount, hasGithub, confirmAction, logActivity, updateActivity]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sandbox run handlers ──────────────────────────────────────────────────
  const handleRunInSandbox = useCallback(() => {
    if (!generatedCode) return
    const isPython = language === 'python'
    setIsRunning(true)
    setSandboxOutput([{ level: 'info', text: isPython ? '▶ Loading Python runtime (Pyodide)…' : '▶ Running in isolated sandbox…' }])
    const iframe = sandboxRef.current
    if (!iframe) { setIsRunning(false); return }
    const guardMs = isPython ? 25000 : 9000
    const onMessage = (e) => {
      if (e.data?.done) {
        setSandboxOutput(e.data.log?.length ? e.data.log : [{ level: 'info', text: '(no output)' }])
        setIsRunning(false); window.removeEventListener('message', onMessage)
      }
    }
    window.addEventListener('message', onMessage)
    setTimeout(() => { window.removeEventListener('message', onMessage); setIsRunning(false) }, guardMs)
    iframe.srcdoc = isPython ? buildPyodideSandboxHtml(generatedCode) : buildSandboxHtml(generatedCode, sandboxSetup)
  }, [generatedCode, sandboxSetup, language])

  const handleRunTests = useCallback(() => {
    if (!testCode) return
    const isPython = language === 'python'
    setIsRunningTests(true)
    setSandboxOutput([{ level: 'info', text: isPython ? '▶ Loading Python runtime (Pyodide)…' : '▶ Running tests in isolated sandbox…' }])
    const iframe = sandboxRef.current
    if (!iframe) { setIsRunningTests(false); return }
    const guardMs = isPython ? 25000 : 9000
    const onMessage = (e) => {
      if (e.data?.done) {
        setSandboxOutput(e.data.log?.length ? e.data.log : [{ level: 'info', text: '(no output)' }])
        setIsRunningTests(false); window.removeEventListener('message', onMessage)
      }
    }
    window.addEventListener('message', onMessage)
    setTimeout(() => { window.removeEventListener('message', onMessage); setIsRunningTests(false) }, guardMs)
    iframe.srcdoc = isPython ? buildPyodideSandboxHtml(testCode) : buildSandboxHtml(testCode, sandboxSetup)
  }, [testCode, sandboxSetup, language])

  // ── Terminal ──────────────────────────────────────────────────────────────
  const runTerminalCommand = useCallback((cmd) => {
    const trimmed = cmd.trim()
    if (!trimmed) return
    const ts = new Date().toLocaleTimeString()
    const pushEntry = (output, type = 'output') =>
      setTerminalLog(prev => [...prev, { cmd: trimmed, output, type, ts }])
    if (trimmed === 'clear') { setTerminalLog([]); return }
    if (trimmed === 'help') {
      pushEntry('Available commands:\n  JS/TS expressions  → executed in browser sandbox\n  python: <code>     → executed via Pyodide\n  clear / help', 'info'); return
    }
    if (/^python:/i.test(trimmed)) {
      const code = trimmed.slice(7).trim()
      setIsTerminalRunning(true)
      const iframe = sandboxRef.current
      if (!iframe) { pushEntry('Sandbox not available', 'error'); setIsTerminalRunning(false); return }
      const timer = setTimeout(() => { window.removeEventListener('message', onPyMsg); pushEntry('[timeout] 20 s limit reached', 'warn'); setIsTerminalRunning(false) }, 22000)
      const onPyMsg = (e) => {
        if (!e.data?.done) return
        clearTimeout(timer); window.removeEventListener('message', onPyMsg)
        const lines = e.data.log || []
        pushEntry(lines.length ? lines.map(l => l.text).join('\n') : '(no output)', lines.some(l => l.level === 'error') ? 'error' : 'output')
        setIsTerminalRunning(false)
      }
      window.addEventListener('message', onPyMsg)
      iframe.srcdoc = buildPyodideSandboxHtml(code); return
    }
    const isJsLike = /^(const |let |var |function |class |console\.|\/\/|import |export |async |await )/.test(trimmed) ||
      (/[+\-*/%=()[\]{}.`"']/.test(trimmed) && !/^[a-z]+ /.test(trimmed)) || /^\d/.test(trimmed)
    if (isJsLike) {
      setIsTerminalRunning(true)
      const iframe = sandboxRef.current
      if (!iframe) { pushEntry('Sandbox not available', 'error'); setIsTerminalRunning(false); return }
      const timer = setTimeout(() => { window.removeEventListener('message', onJsMsg); pushEntry('[timeout] 7 s limit reached', 'warn'); setIsTerminalRunning(false) }, 8000)
      const onJsMsg = (e) => {
        if (!e.data?.done) return
        clearTimeout(timer); window.removeEventListener('message', onJsMsg)
        const lines = e.data.log || []
        pushEntry(lines.length ? lines.map(l => l.text).join('\n') : '(no output)', lines.some(l => l.level === 'error') ? 'error' : 'output')
        setIsTerminalRunning(false)
      }
      window.addEventListener('message', onJsMsg)
      iframe.srcdoc = buildSandboxHtml(trimmed, ''); return
    }
    if (/^node( -v|--version)?$/.test(trimmed)) { pushEntry('v20.x (browser JS engine)', 'info'); return }
    if (/^python3?( --version|-V)?$/.test(trimmed)) { pushEntry('Python 3.12 (Pyodide) — use: python: print("hello")', 'info'); return }
    if (bridgeAvailable) {
      setIsTerminalRunning(true)
      let streamOut = ''
      const streamId = `stream-${Date.now()}`
      setTerminalLog(prev => [...prev, { cmd: trimmed, output: '', type: 'output', ts, streamId }])
      callExecBridgeStream(trimmed, undefined, (chunk) => {
        streamOut += chunk
        setTerminalLog(prev => prev.map(e => e.streamId === streamId ? { ...e, output: streamOut } : e))
      }).then(({ exitCode }) => {
        setTerminalLog(prev => prev.map(e => e.streamId === streamId ? { ...e, output: streamOut || '(no output)', type: exitCode === 0 ? 'output' : 'error', streamId: undefined } : e))
        setIsTerminalRunning(false)
      }); return
    }
    const shellCmds = ['npm','yarn','pnpm','git','npx','tsc','eslint','jest','vitest','cargo','go','pip']
    const base = trimmed.split(/\s+/)[0]
    if (shellCmds.includes(base)) {
      pushEntry(`ℹ "${trimmed}" requires the exec bridge (run via \`npm run dev\`).\nBridge not detected — start the Vite dev server to enable real shell execution.`, 'info'); return
    }
    pushEntry(`command not found: ${base}\nType "help" for available commands.`, 'error')
  }, [sandboxRef, bridgeAvailable, callExecBridge, callExecBridgeStream]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Conversational reply ──────────────────────────────────────────────────
  const isConversationalPrompt = useCallback((value) => {
    const text = String(value || '').trim().toLowerCase()
    if (!text) return false
    if (text.length < 80 && /^(hi|hello|hey|thanks|thank you|how are you|what can you do)/i.test(text)) return true
    const codingSignals = /(create|build|implement|fix|refactor|add|remove|update|generate|write|bug|error|test|repo|file|component|api|function|class|css|ui|database|deploy|pipeline|module|route)/i
    const chatSignals   = /(explain|what is|why|how does|compare|difference|ideas|brainstorm|summary|summarize|help me understand)/i
    if (codingSignals.test(text)) return false
    return chatSignals.test(text) || text.endsWith('?')
  }, [])

  const handleConversationalReply = useCallback(async (userMsg) => {
    const model = models?.find(m => m.id === activeModelId)
    if (!model)        { setError('Select a model.'); return }
    if (!model.apiKey) { setError(`No API key for "${model.name}". Open Admin Panel.`); return }
    const clean = userMsg.trim()
    if (!clean) return
    setError(''); setIsGenerating(true)
    try {
      const reply = await runPromptWithRetry(model, clean, [
        { role: 'system', content: 'You are BLUSWAN in chat mode. Reply directly and helpfully. Use markdown formatting when useful.' },
        ...conversation.slice(-10),
      ])
      setConversation(prev => [...prev, { role: 'user', content: clean }, { role: 'assistant', content: reply }])
      setTurnCount(t => t + 1); setPrompt('')
    } catch (err) { setError(`Chat response failed: ${err.message}`) }
    finally { setIsGenerating(false) }
  }, [models, activeModelId, conversation, setConversation, setTurnCount])

  // ── Long Request Mode ─────────────────────────────────────────────────────
  const handleLrmGeneratePlan = useCallback(async (userMsg) => {
    const model = models.find(m => m.id === activeModelId)
    if (!model) { setError('Select a model before using Long Request Mode.'); return }
    setLrmGeneratingPlan(true); setError('')
    try {
      let raw = ''
      await runPromptWithRetry(model, `Plan this task into phases:\n\n${userMsg}`,
        [{ role: 'user', content: PHASE_PLAN_SYSTEM }, { role: 'assistant', content: 'Here is the phase plan as a JSON array:\n[' }],
        chunk => { raw = chunk })
      const jsonStr = raw.includes('[') ? raw.slice(raw.indexOf('[')) : '[' + raw
      const phases  = JSON.parse(jsonStr.slice(0, jsonStr.lastIndexOf(']') + 1))
      if (!Array.isArray(phases) || phases.length === 0) throw new Error('Empty phase plan')
      setLrmPlan({ originalPrompt: userMsg, phases, currentIdx: 0, statuses: {}, verifyError: null })
    } catch (err) { setError(`LRM plan generation failed: ${err.message}`) }
    finally { setLrmGeneratingPlan(false) }
  }, [models, activeModelId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLrmStart = useCallback(() => {
    if (!lrmPlan) return
    const phase = lrmPlan.phases[0]
    setLrmPhasePushed(false); setLrmPhasePrUrl(null)
    setLrmPlan(p => ({ ...p, currentIdx: 0, statuses: { ...p.statuses, 0: 'active' } }))
    handleGenerate(`[Phase 1: ${phase.title}]\n${phase.instructions}\n\nOriginal request: ${lrmPlan.originalPrompt}`)
  }, [lrmPlan, handleGenerate])

  const handleLrmProceed = useCallback(async (fromIdx) => {
    if (!lrmPlan) return
    if (!lrmPhasePushed && hasGithub && !dryRun) {
      const phaseFiles = filePlan.filter(e => e.code?.trim())
      if (phaseFiles.length === 0) {
        setLrmPlan(p => ({ ...p, statuses: { ...p.statuses, [fromIdx]: 'blocked' }, verifyError: `Phase ${fromIdx + 1} hasn't generated any files yet.` })); return
      }
      setLrmPlan(p => ({ ...p, statuses: { ...p.statuses, [fromIdx]: 'verifying' } }))
      try {
        const phaseTitle = lrmPlan.phases[fromIdx]?.title || `Phase ${fromIdx + 1}`
        const branchData = await getBranch(githubToken, repoOwner, repoName, baseBranch)
        const phaseBranch = generateBranchName(`phase-${fromIdx + 1}-${phaseTitle}`)
        if (!dryRun) await createBranch(githubToken, repoOwner, repoName, phaseBranch, branchData.commit.sha)
        for (const entry of phaseFiles) {
          const existing = await getFileContent(githubToken, repoOwner, repoName, entry.path, phaseBranch).catch(() => null)
          await createOrUpdateFile(githubToken, repoOwner, repoName, entry.path, entry.code, `feat(phase-${fromIdx + 1}): ${phaseTitle}`, phaseBranch, existing?.sha || null)
        }
        const prBody = [`## BLUSWAN LRM — Phase ${fromIdx + 1} of ${lrmPlan.phases.length}: ${phaseTitle}`, ``, `**Original request:** ${lrmPlan.originalPrompt}`, ``, `**Files changed (${phaseFiles.length}):**`, phaseFiles.map(e => `- \`${e.path}\``).join('\n'), ``, `---`, `*Merge this PR before proceeding to Phase ${fromIdx + 2}.*`].filter(Boolean).join('\n')
        const pr = await createPullRequest(githubToken, repoOwner, repoName, `BLUSWAN Phase ${fromIdx + 1}: ${phaseTitle}`, phaseBranch, baseBranch, prBody)
        setLrmPhasePushed(true); setLrmPhasePrUrl(pr?.html_url || null)
        setLastBranchName(phaseBranch); setPrResult({ url: pr?.html_url, number: pr?.number })
        logActivity('push', `✓ Phase ${fromIdx + 1} PR #${pr?.number} opened — merge on GitHub then click Proceed`)
        setLrmPlan(p => ({ ...p, statuses: { ...p.statuses, [fromIdx]: 'blocked' }, verifyError: `Phase ${fromIdx + 1} PR opened. Merge it on GitHub, then click Proceed.` }))
      } catch (err) {
        setError(`Phase ${fromIdx + 1} push failed: ${err.message}`)
        setLrmPlan(p => ({ ...p, statuses: { ...p.statuses, [fromIdx]: 'active' }, verifyError: null }))
      }
      return
    }
    if (lrmPhasePushed && hasGithub && lrmPlan.phases[fromIdx]?.targets?.length > 0) {
      setLrmPlan(p => ({ ...p, statuses: { ...p.statuses, [fromIdx]: 'verifying' } }))
      try {
        const checks = await Promise.allSettled(lrmPlan.phases[fromIdx].targets.map(t => getFileContent(githubToken, repoOwner, repoName, t, baseBranch)))
        const anyFound = checks.some(c => c.status === 'fulfilled' && c.value !== null)
        if (!anyFound) {
          setLrmPlan(p => ({ ...p, statuses: { ...p.statuses, [fromIdx]: 'blocked' }, verifyError: `Phase ${fromIdx + 1} PR not merged yet. Merge on GitHub, then click Proceed.` })); return
        }
      } catch { /* network error — allow proceeding */ }
    }
    setLrmPhasePushed(false); setLrmPhasePrUrl(null)
    const nextIdx = fromIdx + 1
    if (nextIdx >= lrmPlan.phases.length) { setLrmPlan(p => ({ ...p, statuses: { ...p.statuses, [fromIdx]: 'complete' } })); return }
    const phase = lrmPlan.phases[nextIdx]
    setLrmPlan(p => ({ ...p, currentIdx: nextIdx, statuses: { ...p.statuses, [fromIdx]: 'complete', [nextIdx]: 'active' }, verifyError: null }))
    handleGenerate(`[Phase ${nextIdx + 1}: ${phase.title}]\n${phase.instructions}\n\nOriginal request: ${lrmPlan.originalPrompt}`)
  }, [lrmPlan, lrmPhasePushed, filePlan, hasGithub, dryRun, githubToken, repoOwner, repoName, baseBranch, handleGenerate, logActivity]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLrmOverride = useCallback((idx) => {
    setLrmPlan(p => ({ ...p, statuses: { ...p.statuses, [idx]: 'active' }, verifyError: null }))
  }, [])

  const handleLrmCancel = useCallback(() => { setLrmPlan(null); setLrmGeneratingPlan(false) }, [])

  // ── Submit + keyboard ─────────────────────────────────────────────────────
  const handleSubmitPrompt = useCallback(async () => {
    setHistoryOpen(false); setSettingsOpen(false)
    const userMsg = prompt.trim()
    if (!userMsg && attachedFiles.length === 0) return
    const fileContext = attachedFiles.length > 0 ? `\n\n[Attached files: ${attachedFiles.map(f => f.name).join(', ')}]` : ''
    const fullMsg = (userMsg + fileContext).trim()
    setPrompt(''); setAttachedFiles([])
    if (longRequestMode && !lrmPlan && !isConversationalPrompt(fullMsg)) { handleLrmGeneratePlan(fullMsg); return }
    if (isConversationalPrompt(fullMsg)) { handleConversationalReply(fullMsg); return }
    if (shouldUseAgent) {
      let branchOverride = null
      if (hasGithub && !dryRun) {
        try {
          const branchData = await getBranch(githubToken, repoOwner, repoName, baseBranch)
          const newBranch  = generateBranchName(fullMsg)
          await createBranch(githubToken, repoOwner, repoName, newBranch, branchData.commit.sha)
          branchOverride = newBranch; agentBranchRef.current = newBranch
        } catch (err) { setError(`Failed to create branch: ${err.message}`); return }
      }
      agentSession.run(fullMsg, conversation.slice(-10), { branchOverride })
    } else { handleGenerate(fullMsg) }
  }, [prompt, attachedFiles, longRequestMode, lrmPlan, isConversationalPrompt, handleConversationalReply, shouldUseAgent, hasGithub, dryRun, githubToken, repoOwner, repoName, baseBranch, agentSession, conversation, handleGenerate, handleLrmGeneratePlan]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleKeyDown = useCallback((e) => {
    const submitByEnter    = e.key === 'Enter' && !e.shiftKey && !e.isComposing
    const submitByModifier = (e.ctrlKey || e.metaKey) && e.key === 'Enter'
    if (submitByEnter || submitByModifier) {
      e.preventDefault()
      if (!isGenerating && !isPushing && !agentSession.isAgentRunning) {
        if (generatedCode && refinementPrompt.trim()) handleRefine()
        else handleSubmitPrompt()
      }
    }
  }, [isGenerating, isPushing, agentSession.isAgentRunning, generatedCode, refinementPrompt, handleRefine, handleSubmitPrompt])

  // ── Computed values ───────────────────────────────────────────────────────
  const busy             = isGenerating || isPushing
  const isModulesPage    = activeTab === 'modules'
  const hasOutputContent = Boolean(
    (assistantMessage.code || generatedCode || '').trim() || diffText?.trim() || testCode?.trim() ||
    terminalLog.length || sandboxOutput.length || isGenerating || isGenTests || isRunning ||
    isRunningTests || validationResults.length || (assistantMessage.plan && assistantMessage.plan.length)
  )
  const ft = { brightness: 130, contrast: 100, saturation: 125, highlight: 50, shadow: 50 }
  const ftFilter = [
    `brightness(${(ft.brightness / 100) * (0.85 + (ft.highlight / 100) * 0.30)})`,
    `contrast(${(ft.contrast / 100) * (0.85 + (ft.shadow / 100) * 0.30)})`,
    `saturate(${ft.saturation / 100})`,
  ].join(' ')

  // ── Return ────────────────────────────────────────────────────────────────
  return {
    // external props
    onClose, onLogout, userEmail, savedModelIds, onModelSaved, models, setModels, onModelChange,
    // config
    activeModelId, setActiveModelId, repoOwner, setRepoOwner, repoName, setRepoName,
    baseBranch, setBaseBranch, githubToken, setGithubToken, githubClientId, setGithubClientId,
    dryRun, setDryRun, hasGithub, shouldUseAgent,
    // layout
    fineTune: ft, headerLayout: { headerHeight: 44, titleSize: 11, titleOffsetX: 0, titleOffsetY: 0, toggleOffsetX: 0, toggleOffsetY: 0 },
    ftFilter,
    // input
    prompt, setPrompt, refinementPrompt, setRefinementPrompt, attachedFiles, setAttachedFiles, fileInputRef,
    // toggles
    generateTests, setGenerateTests, creativity, setCreativity, enableThinking, setEnableThinking,
    thinkingBudget, setThinkingBudget, hooksConfig, setHooksConfig, planMode,
    planApproval, setPlanApproval, executedPlan, setExecutedPlan, webSearchApiKey,
    // file plan
    filePlan, setFilePlan, activeFileIndex, setActiveFileIndex, isPlanning,
    activeFile, filePath, existingContent, editMode, generatedCode, testCode, patchEdits, diffText, language,
    // conversation
    conversation, setConversation, turnCount, setTurnCount, resetConversation,
    // output
    activeTab, setActiveTab, gitStatus, prResult, workflows, workflowRuns, isPollingCI,
    // sandbox
    sandboxOutput, sandboxSetup, setSandboxSetup, isRunning, isRunningTests, sandboxRef,
    // terminal
    terminalInput, setTerminalInput, terminalLog, setTerminalLog, isTerminalRunning,
    // permission
    permissionMode, setPermissionMode,
    // agent mode
    isRunningPostPushTests,
    // bluswan.md
    bluswanMdDraft, setBluswanMdDraft, isSavingBluswanMd,
    // repo picker
    repoPickerOpen, setRepoPickerOpen, repoPickerSearch, setRepoPickerSearch,
    userRepos, repoPickerLoading, repoPickerError, repoPickerRef,
    // ui state
    isGenerating, isGenTests, isPushing, pushStep, error, setError,
    settingsOpen, setSettingsOpen, historyOpen, setHistoryOpen,
    sourceOpen, setSourceOpen, mobileDrawerOpen, setMobileDrawerOpen,
    history, setHistory, busy, isModulesPage, hasOutputContent,
    // lrm
    longRequestMode, setLongRequestMode, lrmPlan, setLrmPlan,
    lrmGeneratingPlan, taskSidebarCollapsed, setTaskSidebarCollapsed,
    lrmPhasePushed, lrmPhasePrUrl,
    // shadow context
    shadowStatus,
    // pipeline
    pipelinePhase, pipelineSteps, validationResults, assistantMessage,
    // amplifier / remediation
    isAmplifying, amplifierDecisions, remediationStatus,
    // activity log
    activityLog, activityRef, logActivity, updateActivity, clearActivity, activityFeedRef,
    // exec bridge
    bridgeAvailable, callExecBridge, callExecBridgeStream,
    // agent session
    agentSession,
    // cost
    costEstimate,
    // handlers
    handleGenerate, handleRefine, handleRetryFile, updatePlanEntry,
    handleSaveBluswanMd, handleRunProjectTests,
    handleReset, handleAbort,
    loadRepos, openRepoPicker, handlePickRepo, handleReindex,
    loadWorkflows, triggerWorkflow,
    handleRunInSandbox, handleRunTests,
    runTerminalCommand, confirmAction, handlePush,
    handleConversationalReply, isConversationalPrompt,
    handleLrmGeneratePlan, handleLrmStart, handleLrmProceed, handleLrmOverride, handleLrmCancel,
    handleSubmitPrompt, handleKeyDown,
    setActivePhase, emitStreamEvent,
    lastBranchName, setLastBranchName,
  }
}
}
