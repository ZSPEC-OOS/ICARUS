import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Aurora from './Aurora'
import { runPromptWithRetry, loadSearchKey } from '../services/aiService'
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
} from '../services/githubService'
import { estimateCost, formatCost } from '../utils/tokenEstimator'
import { shadowContext } from '../services/shadowContext'
import { isVaguePrompt, amplifyPrompt } from '../services/intentAmplifier'
import { buildFilePlan } from '../services/planner'
import {
  createPipelineSteps,
  formatStructuredOutput,
  parsePromptCommand,
  createAssistantMessage,
  createStreamEvent,
  applyStreamEvent,
} from '../services/interactivePipeline'
import { useConversation }   from '../core/hooks/useConversation'
import { useExecBridge }     from '../core/hooks/useExecBridge'
import { useActivityLog }    from '../core/hooks/useActivityLog'
import { useAgentSession }   from '../core/hooks/useAgentSession'
import {
  detectLanguage, extractCode, highlightCode, applyEditBlocks,
  buildSandboxHtml, buildPyodideSandboxHtml, isCodeComplete,
  LANG_CHECKLIST, REMEDIATABLE, testFilePath, parseGitHubUrl,
} from '../utils/codeUtils'
import { computeLineDiff }   from '../utils/diff'
import { decodeBase64 }      from '../utils/base64.js'
import { pickDirectory }     from '../services/localFileService.js'
import {
  CONTEXT_FILES_LIMIT,
  FILE_CONTENT_CAP_CHARS,
  BLUSWAN_MD_CAP,
  STYLE_EXAMPLES_LIMIT,
} from '../config/constants'
import BluswanActivityFeed     from './bluswan/BluswanActivityFeed'
import BluswanCodePane         from './bluswan/BluswanCodePane'
import BluswanDiffViewer       from './bluswan/BluswanDiffViewer'
import BluswanDiffConfidence   from './bluswan/BluswanDiffConfidence'
import BluswanTerminal         from './bluswan/BluswanTerminal'
import BluswanToolsPane        from './bluswan/BluswanToolsPane'
import BluswanSettings         from './bluswan/BluswanSettings'
import BluswanModularTools     from './bluswan/BluswanModularTools'
import './Bluswan.css'

// ─── Persistence ────────────────────────────────────────────────────────────
const SETTINGS_KEY    = 'bluswan:settings'
const HISTORY_KEY     = 'bluswan:history'
const GHTOKEN_SS_KEY  = 'bluswan:ghtoken'
const GHTOKEN2_SS_KEY = 'bluswan:ghtoken2'

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}
    // Migration: move any token stored in localStorage to sessionStorage
    if (s.githubToken) {
      try { sessionStorage.setItem(GHTOKEN_SS_KEY, s.githubToken) } catch {}
      delete s.githubToken
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch {}
    }
    try { s.githubToken  = sessionStorage.getItem(GHTOKEN_SS_KEY)  || '' } catch {}
    return s
  } catch { return {} }
}
function saveSettings(s) {
  try {
    const { githubToken, ...rest } = s
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest))
    if (githubToken !== undefined) {
      try { sessionStorage.setItem(GHTOKEN_SS_KEY, githubToken || '') } catch {}
    }
  } catch {}
}
function loadHistory()  { try { return JSON.parse(localStorage.getItem(HISTORY_KEY))  || [] } catch { return [] } }
function saveHistory(h) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 60))) } catch {} }

function formatRelativeDate(ts) {
  const diff = Date.now() - ts
  if (diff < 60000)        return 'just now'
  if (diff < 3600000)      return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000)     return `${Math.floor(diff / 3600000)}h ago`
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}d ago`
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ─── Utilities imported from ../utils/codeUtils and ../utils/diff ────────────

// ─── Pure system-prompt builder (no hooks — safe to call inside async loops) ──
function buildFileSystemPrompt(path, existingContent, lang, repoOwner, repoName, forTests = false, bluswanMd = null, contextFiles = [], styleExamples = []) {
  const repoCtx  = repoOwner && repoName ? `\nRepository: ${repoOwner}/${repoName}.` : ''
  const editMode = existingContent !== null ? 'patch' : 'replace'
  // Suppress framework conventions for standalone file types (html, sh, yaml, etc.)
  const isStandalone = ['html', 'markdown', 'yaml', 'bash', 'json'].includes(lang)

  const conv = !isStandalone && shadowContext.getConventions()
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

  // BLUSWAN.md standing instructions
  const bluswanMdCtx = bluswanMd ? `\nPROJECT INSTRUCTIONS (from BLUSWAN.md — follow exactly):\n${bluswanMd.slice(0, BLUSWAN_MD_CAP)}` : ''

  // Style patterns: short excerpts from existing similar files — model should match this style
  const styleCtx = styleExamples.length > 0
    ? `\nCODE STYLE PATTERNS FROM THIS CODEBASE (study these and match the style precisely):\n` +
      styleExamples.map(s => `--- ${s.path} ---\n${s.excerpt}`).join('\n\n')
    : ''

  // Ambient context: relevant files from the repo
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
    convCtx,
    bluswanMdCtx,
    styleCtx,
    contextCtx,
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

// ════════════════════════════════════════════════════════════════════════════
export default function Bluswan({ onClose, models, setModels, selectedModelId, onModelChange, onSettingsChanged, onLogout, userEmail, savedModelIds, onModelSaved }) {
  const saved = loadSettings()

  // ── Config ─────────────────────────────────────────────────────────────
  const [activeModelId,  setActiveModelId]  = useState(selectedModelId || '')
  const [repoOwner,      setRepoOwner]      = useState(saved.repoOwner   || '')
  const [repoName,       setRepoName]       = useState(saved.repoName    || '')
  const [baseBranch,     setBaseBranch]     = useState(saved.baseBranch  || 'main')
  const [githubToken,    setGithubToken]    = useState(saved.githubToken || '')
  const [githubClientId, setGithubClientId] = useState(saved.githubClientId || '')
  const [doCreateBranch, setDoCreateBranch] = useState(saved.doCreateBranch ?? true)
  const [doCreatePR,     setDoCreatePR]     = useState(saved.doCreatePR     ?? true)
  const [dryRun,         setDryRun]         = useState(saved.dryRun         ?? false)

  // ── Theme + fine-tune ──────────────────────────────────────────────────
  const theme = 'bluswan'
  const fineTune = { brightness: 130, contrast: 100, saturation: 125, highlight: 50, shadow: 50 }
  const headerLayout = { headerHeight: 44, titleSize: 11, titleOffsetX: 0, titleOffsetY: 0, toggleOffsetX: 0, toggleOffsetY: 0 }

  // ── Input ──────────────────────────────────────────────────────────────
  const [prompt,           setPrompt]           = useState('')
  const [refinementPrompt, setRefinementPrompt] = useState('')

  // ── Enhancement toggles ────────────────────────────────────────────────
  const [generateTests,   setGenerateTests]   = useState(saved.generateTests ?? false)
  // creativity 0-100: maps to temperature 0.2–1.0 (0 = precise, 100 = creative)
  const [creativity,      setCreativity]      = useState(saved.creativity ?? 50)
  // enableThinking: Anthropic extended thinking (deeper reasoning, slower)
  const [enableThinking,  setEnableThinking]  = useState(saved.enableThinking ?? false)
  // planMode: always true — agent always plans first, implements only after user approval
  const planMode = true
  // planApproval: pending plan awaiting user approve/reject/modify
  const [planApproval,    setPlanApproval]    = useState(null) // null | { task, summary }
  const [executedPlan,    setExecutedPlan]    = useState(null) // plan kept visible during execution
  // localDirHandle: File System Access API handle for a locally attached repo folder
  const [localDirHandle,  setLocalDirHandle]  = useState(null)
  // webSearchApiKey: Tavily API key for agent web_search tool
  // loadSearchKey is async (AES-GCM decryption) so we seed state from useEffect.
  const [webSearchApiKey, setWebSearchApiKey] = useState('')
  useEffect(() => { loadSearchKey().then(setWebSearchApiKey).catch(() => {}) }, [])

  // ── Multi-file plan ────────────────────────────────────────────────────
  // Each entry: {path, action, purpose, existingContent, _sha, code, testCode,
  //              patchEdits, diffText, status, error}
  const [filePlan,         setFilePlan]         = useState([])
  const [activeFileIndex,  setActiveFileIndex]  = useState(0)
  const [isPlanning,       setIsPlanning]       = useState(false)
  const planRef            = useRef([])          // sync copy for use inside async loops
  const currentFileRef     = useRef(0)           // which file is streaming

  // ── Conversation — managed by hook ─────────────────────────────────────
  const { conversation, setConversation, turnCount, setTurnCount, reset: resetConversation } = useConversation()

  // ── Output ─────────────────────────────────────────────────────────────
  const [activeTab,  setActiveTab]  = useState('code')
  const [gitStatus,  setGitStatus]  = useState(null)
  const [prResult,   setPrResult]   = useState(null)
  const [workflows,  setWorkflows]  = useState([])
  const [workflowRuns, setWorkflowRuns] = useState([])
  const [isPollingCI, setIsPollingCI] = useState(false)

  // ── Aliases: expose active file's data to all downstream JSX unchanged ──
  const activeFile      = filePlan[activeFileIndex] ?? {}
  const filePath        = activeFile.path           ?? ''
  const existingContent = activeFile.existingContent ?? null
  const editMode        = existingContent !== null ? 'patch' : 'replace'
  const generatedCode   = activeFile.code           ?? ''
  const testCode        = activeFile.testCode        ?? ''
  const patchEdits      = activeFile.patchEdits      ?? []
  const diffText        = activeFile.diffText        ?? ''

  // ── Sandbox ────────────────────────────────────────────────────────────
  const [sandboxOutput, setSandboxOutput] = useState([])
  const [sandboxSetup,  setSandboxSetup]  = useState('')
  const [isRunning,     setIsRunning]     = useState(false)
  const [isRunningTests, setIsRunningTests] = useState(false)
  const sandboxRef = useRef(null)

  // ── Terminal ────────────────────────────────────────────────────────────
  const [terminalInput,    setTerminalInput]    = useState('')
  const [terminalLog,      setTerminalLog]      = useState([])   // [{cmd,output,type,timestamp}]
  const [isTerminalRunning,setIsTerminalRunning]= useState(false)

  // ── Permission mode ─────────────────────────────────────────────────────
  // 'auto'   — push immediately, no confirm
  // 'ask'    — confirm dialog before any GitHub write
  // 'manual' — user must click a second time (dry-run first, then confirm)
  const [permissionMode, setPermissionMode] = useState(
    () => localStorage.getItem('bluswan:permMode') || 'ask'
  )

  // ── Agent mode ─────────────────────────────────────────────────────────────
  const [isRunningPostPushTests, setIsRunningPostPushTests] = useState(false)
  const [bluswanMdDraft,    setBluswanMdDraft]    = useState('')
  const [isSavingBluswanMd, setIsSavingBluswanMd] = useState(false)

  // ── File attachments & branch tracking ────────────────────────────────
  const [attachedFiles, setAttachedFiles] = useState([])
  const [lastBranchName, setLastBranchName] = useState('')
  const fileInputRef = useRef(null)

  // ── Repo picker ────────────────────────────────────────────────────────
  const [repoPickerOpen,    setRepoPickerOpen]    = useState(false)
  const [repoPickerSearch,  setRepoPickerSearch]  = useState('')
  const [userRepos,         setUserRepos]         = useState([])
  const [repoPickerLoading, setRepoPickerLoading] = useState(false)
  const [repoPickerError,   setRepoPickerError]   = useState(null)
  const repoPickerRef = useRef(null)

  // ── UI state ───────────────────────────────────────────────────────────
  const [isGenerating, setIsGenerating] = useState(false)
  const [isGenTests,   setIsGenTests]   = useState(false)
  const [isPushing,    setIsPushing]    = useState(false)
  const [pushStep,     setPushStep]     = useState('')
  const [error,        setError]        = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen,  setHistoryOpen]  = useState(false)
  const [sourceOpen,   setSourceOpen]   = useState(false)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const [history,      setHistory]      = useState(loadHistory)
  // ── Long Request Mode (LRM) ───────────────────────────────────────────
  const [longRequestMode,  setLongRequestMode]  = useState(false)
  const [lrmPlan,          setLrmPlan]          = useState(null)   // null | phase plan object
  const [lrmGeneratingPlan, setLrmGeneratingPlan] = useState(false)
  const [taskSidebarCollapsed, setTaskSidebarCollapsed] = useState(false)

  // ── Phase 4: ShadowContext ─────────────────────────────────────────────
  const [shadowStatus,  setShadowStatus]  = useState(null)   // null | string

  // ── Interactive response pipeline ──────────────────────────────────────
  const [pipelinePhase, setPipelinePhase] = useState('understanding')
  const [pipelineSteps, setPipelineSteps] = useState(() => createPipelineSteps('understanding'))
  const [validationResults, setValidationResults] = useState([])
  const [assistantMessage, setAssistantMessage] = useState(() => createAssistantMessage())

  // ── Phase 2: IntentAmplifier ───────────────────────────────────────────
  const [isAmplifying,       setIsAmplifying]       = useState(false)
  const [amplifierDecisions, setAmplifierDecisions] = useState([])  // string[]

  // ── Phase 3: AutoRemediation ───────────────────────────────────────────
  const [remediationStatus, setRemediationStatus] = useState(null)  // null | string

  // ── Activity log — managed by hook ─────────────────────────────────────
  const activityFeedRef = useRef(null)
  const { activityLog, activityRef, logActivity, updateActivity, clearActivity } = useActivityLog(activityFeedRef)

  const abortRef = useRef(null)
  const language = detectLanguage(filePath, generatedCode)
  const hasGithub    = !!(githubToken && repoOwner && repoName)
  const hasLocalRepo = !!localDirHandle
  const shouldUseAgent = hasLocalRepo || hasGithub

  // ── Sync model from parent ──────────────────────────────────────────────
  useEffect(() => {
    if (selectedModelId && !activeModelId) setActiveModelId(selectedModelId)
  }, [selectedModelId, activeModelId])

  // ── Stable ref for the cloud-sync callback ────────────────────────────
  // Using a ref means the effect below doesn't re-run just because App.jsx
  // re-created the callback (e.g. after a model-key update).
  const onSettingsChangedRef = useRef(onSettingsChanged)
  useEffect(() => { onSettingsChangedRef.current = onSettingsChanged }, [onSettingsChanged])

  // ── Persist settings ───────────────────────────────────────────────────
  useEffect(() => {
    const s = {
      repoOwner, repoName, baseBranch, githubToken, githubClientId,
      creativity, enableThinking,
      webSearchApiKey,
      permissionMode,
      generateTests, doCreateBranch, doCreatePR, dryRun,
    }
    saveSettings(s)
    // Notify App.jsx so it can debounce-save to Firestore (cloud persistence)
    onSettingsChangedRef.current?.(s)
  }, [repoOwner, repoName, baseBranch, githubToken, githubClientId,
      creativity, enableThinking, webSearchApiKey, permissionMode,
      generateTests, doCreateBranch, doCreatePR, dryRun])

  // ── Phase 4: start ShadowContext indexing when credentials are ready ────
  useEffect(() => {
    if (!hasGithub) return
    shadowContext.startIndexing(githubToken, repoOwner, repoName, baseBranch, () => {
      setShadowStatus(shadowContext.statusSummary())
    })
  }, [hasGithub, githubToken, repoOwner, repoName, baseBranch])



  // ── State watchdog — detects and resets stuck busy flags ───────────────
  // If isGenerating has been true for >5 minutes (e.g. due to unhandled reject),
  // automatically reset it so the UI is never permanently locked.
  const generationStartRef = useRef(null)
  useEffect(() => {
    if (isGenerating) {
      generationStartRef.current = Date.now()
      const id = setTimeout(() => {
        const elapsed = Date.now() - (generationStartRef.current || 0)
        if (elapsed >= 5 * 60 * 1000) {
          setIsGenerating(false)
          setIsGenTests(false)
          setIsPlanning(false)
          setIsAmplifying(false)
          logActivity('warn', '⚠ Watchdog: generation timed out after 5 min — state reset')
        }
      }, 5 * 60 * 1000)
      return () => clearTimeout(id)
    } else {
      generationStartRef.current = null
    }
  }, [isGenerating]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Exec bridge — managed by hook ──────────────────────────────────────
  const { bridgeAvailable, callExecBridge, callExecBridgeStream } = useExecBridge()

  // ── Agent session — managed by hook ────────────────────────────────────
  const activeModel = models?.find(m => m.id === activeModelId) ?? models?.[0]
  // Memoize config objects so useAgentSession's run callback doesn't get a new
  // reference on every render (text-delta state updates fire many re-renders).
  const githubConfig = useMemo(
    () => ({ token: githubToken, owner: repoOwner, repo: repoName, branch: baseBranch }),
    [githubToken, repoOwner, repoName, baseBranch],
  )
  const onPromptClear = useCallback(() => setPrompt(''), [])
  const agentSession = useAgentSession({
    modelConfig:     activeModel,
    githubConfig,
    sourceRepoConfig: null,
    bridgeAvailable,
    webSearchApiKey,
    planMode,
    logActivity,
    updateActivity,
    clearActivity,
    activityRef,
    onSetActiveTab:  setActiveTab,
    onSetError:      setError,
    onPromptClear,
    onPlanDone:      (task, summary) => setPlanApproval({ task, summary }),
    onAgentStart:    (task) => setConversation(prev => [...prev, { role: 'user', content: task }]),
    onAgentComplete: (task, text) => { if (text?.trim()) setConversation(prev => [...prev, { role: 'assistant', content: text }]) },
    localDirHandle,
    availableModels: models || [],
  })

  // ── Cost estimate (memoized) ───────────────────────────────────────────
  const costEstimate = useMemo(() => {
    const text = prompt.trim()
    if (!text) return null
    const model = models?.find(m => m.id === activeModelId)
    return estimateCost(text, model?.modelId)
  }, [prompt, activeModelId, models])

  // ── Plan entry updater (syncs planRef + React state together) ─────────────
  const updatePlanEntry = useCallback((index, updates) => {
    planRef.current = planRef.current.map((e, i) => i === index ? { ...e, ...updates } : e)
    setFilePlan([...planRef.current])
  }, [])

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 3: AutoRemediation helpers
  // ─────────────────────────────────────────────────────────────────────────

  // Run code in the sandbox and return the first error string, or null if clean.
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
        clearTimeout(timer)
        window.removeEventListener('message', onMsg)
        const errors = (e.data.log || []).filter(l => l.level === 'error')
        resolve(errors.length ? errors.map(l => l.text).join('\n') : null)
      }
      window.addEventListener('message', onMsg)
      iframe.srcdoc = isPython ? buildPyodideSandboxHtml(code) : buildSandboxHtml(code, '')
    })
  }, [])

  // Order files so that dependencies appear before dependents (if import graph is available).
  const setActivePhase = useCallback((phase) => {
    setPipelinePhase(phase)
    setPipelineSteps(createPipelineSteps(phase))
  }, [])

  const emitStreamEvent = useCallback((event) => {
    if (!event?.type) return
    if (event.type === 'status' && event.phase) setActivePhase(event.phase)
    if (event.type === 'plan' && Array.isArray(event.steps)) {
      setAssistantMessage(prev => applyStreamEvent(prev, event))
      return
    }
    if (event.type === 'content' || event.type === 'code' || event.type === 'validation') {
      setAssistantMessage(prev => applyStreamEvent(prev, event))
    }
  }, [setActivePhase])

  const orderFilePlan = useCallback((plan) => {
    const graph = shadowContext.getImportGraph() || {}
    const paths = plan.map(p => p.path)
    const pathSet = new Set(paths)

    const depsMap = {}
    paths.forEach(p => { depsMap[p] = new Set() })
    paths.forEach(p => {
      const deps = graph[p] || []
      deps.forEach(d => { if (pathSet.has(d)) depsMap[p].add(d) })
    })

    const result = []
    const temp = new Set()
    const perm = new Set()

    const visit = (node) => {
      if (perm.has(node)) return
      if (temp.has(node)) return // cycle detected; break
      temp.add(node)
      for (const dep of depsMap[node] || []) {
        visit(dep)
      }
      temp.delete(node)
      perm.add(node)
      result.push(node)
    }

    paths.forEach(p => visit(p))
    // Preserve original order for any unknown entries
    const ordered = result
      .map(p => plan.find(e => e.path === p))
      .filter(Boolean)

    // Append any entries missing due to graph gaps
    plan.forEach(p => { if (!ordered.find(e => e.path === p.path)) ordered.push(p) })
    return ordered
  }, [])

  // Attempt to self-repair code using the AI.
  // JS/TS: runs in the sandbox and fixes real errors (up to 3 attempts).
  // Other supported langs: one AI static-analysis pass with a language checklist.
  // Unsupported langs (html, markdown, yaml, etc.): skipped immediately.
  // filePath and purpose are optional — used to give the AI richer context for fixes.
  const autoRemediate = useCallback(async (code, lang, model, signal, filePath = '', purpose = '') => {
    if (!REMEDIATABLE.has(lang)) return code  // skip html, markdown, yaml, etc.

    const MAX_ATTEMPTS = 5
    let current = code
    const isJS       = lang === 'javascript' || lang === 'typescript'
    const isPython   = lang === 'python'
    const hasSandbox = isJS || isPython
    const checklist  = LANG_CHECKLIST[lang] || null

    // Probe for available static-analysis tools (JS/TS + exec bridge)
    let hasEslint = false
    let hasTsNode = false
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
        // Pipe code directly to eslint via stdin — catches real parse + lint errors
        const ext = lang === 'typescript' ? 'ts' : 'js'
        const lint = await callExecBridge(
          `npx eslint --stdin --stdin-filename=bluswan-check.${ext} --format=compact --rule '{"no-undef":"error","no-unused-vars":"warn"}'`,
          undefined, 15000, current
        )
        const lintOut = [lint.stdout, lint.stderr].filter(Boolean).join('\n').trim()
        if (lint.exitCode !== 0 && lintOut) {
          errorHint = lintOut.slice(0, 1500)
        } else if (lang === 'typescript' && hasTsNode) {
          // Second pass: TypeScript type-check via ts-node --transpile-only reads stdin
          const ts = await callExecBridge('npx ts-node --transpile-only --stdin', undefined, 15000, current)
          const tsOut = [ts.stdout, ts.stderr].filter(Boolean).join('\n').trim()
          if (ts.exitCode !== 0 && tsOut) errorHint = tsOut.slice(0, 1500)
          else break  // both lint + tsc pass — done
        } else {
          break  // eslint passes, no tsc needed
        }
      } else if (hasSandbox) {
        errorHint = await runSandboxTest(current, lang)
        if (!errorHint) break  // passes sandbox — done
      } else {
        // Non-sandbox: run checklist pass; stop if code didn't change on 2nd attempt
        errorHint = checklist || 'syntax review requested'
      }

      const fileCtx  = filePath ? ` in ${filePath}` : ''
      const purposeCtx = purpose ? ` Purpose: ${purpose}.` : ''
      const fixCtx = [
        { role: 'user',      content: `You are a code repair assistant.${purposeCtx} Fix all syntax errors, undefined references, type errors, and obvious runtime bugs. Output ONLY the corrected ${lang} code — no fences, no explanations.` },
        { role: 'assistant', content: 'Corrected code:' },
      ]
      const fixMsg = hasSandbox
        ? `Fix this ${lang} code${fileCtx}. The following error was detected at runtime:\n\n${errorHint}\n\nRead the error carefully — trace it to its root cause before fixing. Output ONLY the corrected code:\n\n${current}`
        : checklist
          ? `Review this ${lang} code${fileCtx} against this checklist:\n${checklist}\n\nFix every issue found. Output ONLY the corrected code:\n\n${current}`
          : `Review this ${lang} code${fileCtx} for syntax errors and obvious bugs, and fix any you find. Output ONLY the corrected code:\n\n${current}`

      try {
        const fixed = await runPromptWithRetry(model, fixMsg, fixCtx, null, signal)
        const newCode = extractCode(fixed)
        if (newCode && newCode !== current) current = newCode
        else break
      } catch { break }
    }

    setRemediationStatus(null)
    return current
  }, [runSandboxTest, bridgeAvailable, callExecBridge])

  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // Core generation — Plan → Hydrate → Loop across files
  // ─────────────────────────────────────────────────────────────────────────
  const handleGenerate = useCallback(async (userMsg = prompt, isRefinement = false) => {
    if (!userMsg.trim()) { setError('Enter a coding request first.'); return }
    const model = models?.find(m => m.id === activeModelId)
    if (!model)        { setError('Select a model.'); return }
    if (!model.apiKey) { setError(`No API key for "${model.name}". Open Admin Panel.`); return }

    const { command, content } = parsePromptCommand(userMsg)
    if (command === '/reset') {
      resetConversation()
      setFilePlan([])
      planRef.current = []
      setTurnCount(0)
      setValidationResults([])
      setActivePhase('understanding')
      return
    }
    const requestText = command ? content : userMsg
    if (!requestText.trim()) {
      setError(`Add details after ${command}.`)
      return
    }

    setError('')
    setValidationResults([])
    const runAssistantMessage = createAssistantMessage(`${Date.now()}`)
    setAssistantMessage(runAssistantMessage)
    emitStreamEvent(createStreamEvent('status', { phase: 'understanding' }))
    setAmplifierDecisions([])
    setIsGenerating(true)
    // Add user message immediately so it appears in chat before generation completes
    setConversation(prev => [...prev, { role: 'user', content: requestText }])

    if (!isRefinement) {
      setGitStatus(null); setPrResult(null); setSandboxOutput([])
      // Fresh activity log for each new generation run
      clearActivity()
      setActiveTab('code')
    }

    const ctrl = new AbortController()
    abortRef.current = ctrl

    // Build an effective model config that carries the current creativity/thinking settings.
    // temperature = 0.2 + (creativity/100) * 0.8  →  creativity 0 = 0.2, 50 = 0.6, 100 = 1.0
    const effectiveModel = {
      ...model,
      temperature: parseFloat((0.2 + (creativity / 100) * 0.8).toFixed(2)),
      // enableThinking works for Anthropic (interleaved thinking) and Kimi K2.5 (enable_thinking)
      ...(enableThinking ? { enableThinking: true } : {}),
    }

    try {
      // ── Phase 2: IntentAmplifier ─────────────────────────────────────────
      let effectiveMsg = requestText
      if (!isRefinement && isVaguePrompt(requestText)) {
        setIsAmplifying(true)
        const ampId = logActivity('amplify', '◆ Analyzing intent…')
        const conv = shadowContext.getConventions()
        // Pass last 6 messages (3 turn pairs) for pronoun/reference resolution
        const { enrichedPrompt, decisions } = await amplifyPrompt(
          requestText, conv, effectiveModel, ctrl.signal, conversation.slice(-6)
        )
        setIsAmplifying(false)
        if (enrichedPrompt !== requestText) {
          effectiveMsg = enrichedPrompt
          setAmplifierDecisions(decisions)
          updateActivity(ampId, { status: 'done', msg: `◆ Intent clarified — ${decisions.length} assumption${decisions.length !== 1 ? 's' : ''} made` })
        } else {
          updateActivity(ampId, { status: 'done', msg: '◆ Intent clear — proceeding as-is' })
        }
      }

      if (isRefinement) {
        // ── Refinement: regenerate only the active file ──────────────────
        const entry  = planRef.current[activeFileIndex] ?? {}
        const lang   = detectLanguage(entry.path, entry.code || '')
        const mode   = entry.existingContent !== null ? 'patch' : 'replace'
        const refStyleExamples = shadowContext.getStyleExamples(effectiveMsg, STYLE_EXAMPLES_LIMIT)
        const sys    = buildFileSystemPrompt(entry.path, entry.existingContent, lang, repoOwner, repoName, false, shadowContext.getBluswanMd(), [], refStyleExamples)
        const refMsg = `Current code:\n${entry.code || ''}\n\nChange request: ${effectiveMsg}`
        const ctx    = [
          { role: 'user', content: sys },
          { role: 'assistant', content: 'Understood. I will output only the code.' },
          ...conversation,
        ]
        emitStreamEvent(createStreamEvent('status', { phase: 'refining' }))
        const refId = logActivity('generate', `↺ Refining ${entry.path || 'file'}…`)
        let streaming = ''
        let prevStreaming = ''
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
          code: finalCode,
          codeLang: lang,
          changes: [`Updated ${entry.path || 'active file'}`],
          validation: refValidation,
          notes: ['Further follow-ups will continue from this state.'],
        })
        setConversation(prev => [...prev, { role: 'assistant', content: refOut }])
        setTurnCount(t => t + 1)
        setRefinementPrompt('')
        setActiveTab('code')

      } else {
        // ── First-shot: plan → hydrate → generate each file ──────────────

        // Phase 4/Planner: determine which files to touch.
        // Pass files from the current plan (prior run) so the planner knows what was
        // recently generated and can build on or avoid redundancy.
        const recentFiles = filePlan.filter(e => e.status === 'done').map(e => e.path)
        emitStreamEvent(createStreamEvent('status', { phase: 'planning' }))
        const planId = logActivity('plan', '◆ Building file plan…')
        setIsPlanning(true)
        const rawPlan = await buildFilePlan(
          effectiveMsg,
          shadowContext._fileIndex || [],
          shadowContext.getConventions(),
          effectiveModel,
          ctrl.signal,
          recentFiles,
        )
        setIsPlanning(false)
        updateActivity(planId, {
          status: 'done',
          msg: `◆ Plan — ${rawPlan.length} file${rawPlan.length !== 1 ? 's' : ''}`,
          detail: rawPlan.map(e => e.path.split('/').pop()).join(' · '),
        })

        // Order plan entries based on imports (if available) so dependencies are generated first
        const orderedRawPlan = orderFilePlan(rawPlan)
        emitStreamEvent(createStreamEvent('plan', {
          steps: orderedRawPlan.map((e) => `${e.action === 'modify' ? 'Update' : 'Create'} ${e.path} — ${e.purpose}`),
        }))
        if (command === '/plan') {
          const planOnlyValidation = ['✓ Plan generated.', '✓ No code emitted in /plan mode.']
          setValidationResults(planOnlyValidation)
          const planOnlyText = formatStructuredOutput({
            summary: `Created an execution plan for: ${requestText}`,
            plan: orderedRawPlan.map((e) => `${e.action === 'modify' ? 'Update' : 'Create'} ${e.path} — ${e.purpose}`),
            code: '',
            changes: orderedRawPlan.map((e) => `${e.action === 'modify' ? 'Will update' : 'Will add'} ${e.path}`),
            validation: planOnlyValidation,
            notes: ['Run /code to execute this plan.'],
          })
          setConversation(prev => [...prev, { role: 'assistant', content: planOnlyText }])
          setTurnCount(t => t + 1)
          setActivePhase('complete')
          return
        }
        // Initialise plan
        const initialPlan = orderedRawPlan.map(e => ({
          ...e, existingContent: null, _sha: null,
          code: '', testCode: '', patchEdits: [], diffText: '',
          status: 'pending', error: null,
        }))
        planRef.current = initialPlan
        setFilePlan([...initialPlan])
        setActiveFileIndex(0)

        // Hydrate 'modify' files from GitHub
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
                const content = decodeBase64(file.content)
                updatePlanEntry(i, { existingContent: content, _sha: file.sha, status: 'pending' })
                updateActivity(fetchId, { status: 'done', msg: `⬇ ${ep.path}`, detail: `${content.split('\n').length} lines` })
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

        // Gather ambient context + BLUSWAN.md + style examples once before generation loop
        const bluswanMd = shadowContext.getBluswanMd()
        let ambientFiles = []
        try {
          ambientFiles = await shadowContext.getContextContent(effectiveMsg, CONTEXT_FILES_LIMIT)
        } catch (ctxErr) {
          logActivity('warn', `⚠ Context index unavailable — generating without repo context (${ctxErr.message})`)
        }
        // Style examples: short excerpts from similar files that set the style baseline
        let styleExamples = []
        try {
          styleExamples = shadowContext.getStyleExamples(effectiveMsg, STYLE_EXAMPLES_LIMIT)
        } catch { /* non-fatal — proceed without style injection */ }

        // Generate each file in the plan
        emitStreamEvent(createStreamEvent('status', { phase: 'coding' }))
        for (let i = 0; i < planRef.current.length; i++) {
          if (ctrl.signal.aborted) break
          setActiveFileIndex(i)
          currentFileRef.current = i

          const entry    = planRef.current[i]
          const lang     = detectLanguage(entry.path, '')
          const mode     = entry.existingContent !== null ? 'patch' : 'replace'
          // Exclude current file from context to avoid circular injection
          const contextFiles = ambientFiles.filter(f => f.path !== entry.path)
          // Exclude current file from style examples too
          const fileStyleExamples = styleExamples.filter(s => s.path !== entry.path)
          const sys      = buildFileSystemPrompt(entry.path, entry.existingContent, lang, repoOwner, repoName, false, bluswanMd, contextFiles, fileStyleExamples)
          const fileTask = `${effectiveMsg}\n\nFor this file: ${entry.path} — ${entry.purpose}`

          updatePlanEntry(i, { status: 'generating' })
          const genId = logActivity('generate', `▶ Generating ${entry.path}`, `${mode} mode`)

          try {
            let streaming = ''
            let prevStreaming = ''
            const raw = await runPromptWithRetry(effectiveModel, fileTask, [
              { role: 'user',      content: sys },
              { role: 'assistant', content: 'Understood. I will output only the code.' },
            ], (partial) => {
              streaming = mode === 'patch' && entry.existingContent ? partial : extractCode(partial)
              updatePlanEntry(i, { code: streaming })
              const chunk = streaming.startsWith(prevStreaming) ? streaming.slice(prevStreaming.length) : streaming
              prevStreaming = streaming
              emitStreamEvent(createStreamEvent('code', { chunk }))
              updateActivity(genId, { detail: `${streaming.split('\n').length} lines…` })
            }, ctrl.signal)

            let finalCode  = extractCode(raw)
            let newEdits   = []
            let newDiff    = ''
            if (mode === 'patch' && entry.existingContent) {
              const { result, edits } = applyEditBlocks(entry.existingContent, raw)
              if (edits.length > 0) {
                finalCode = result
                newEdits  = edits
                const old = entry.existingContent.split('\n').map((l, idx) => `- ${String(idx+1).padStart(3)}: ${l}`)
                const neo = result.split('\n').map((l, idx) => `+ ${String(idx+1).padStart(3)}: ${l}`)
                newDiff   = `--- a/${entry.path}\n+++ b/${entry.path}\n\n${old.join('\n')}\n\n${neo.join('\n')}`
              }
            }
            // Always compute a line diff: for full-replace modify files and for creates (all additions)
            if (!newDiff) {
              newDiff = computeLineDiff(entry.existingContent || null, finalCode, entry.path)
            }

            // ── Completeness check + continuation loop ─────────────────────
            // If the model truncated, request continuations (max 3 attempts)
            if (mode !== 'patch' && !isCodeComplete(finalCode, lang)) {
              const contCtx = [
                { role: 'user',      content: sys },
                { role: 'assistant', content: 'Understood. I will output only the code.' },
              ]
              for (let cont = 0; cont < 3; cont++) {
                if (ctrl.signal.aborted) break
                if (isCodeComplete(finalCode, lang)) break
                const lineCount = finalCode.split('\n').length
                updateActivity(genId, { detail: `continuing… (${lineCount} lines so far, attempt ${cont + 1}/3)` })
                // Show the last 30 lines so the model knows exactly where it left off
                const tail = finalCode.split('\n').slice(-30).join('\n')
                try {
                  const contRaw = await runPromptWithRetry(effectiveModel,
                    `The previous code output for ${entry.path} was truncated at ${lineCount} lines. The last lines generated were:\n\n${tail}\n\nContinue writing ONLY the remaining code from exactly where the output ended. Do not repeat any code already shown. Do not add fences or explanations. Write until the file is completely finished.`,
                    contCtx, null, ctrl.signal)
                  const contChunk = extractCode(contRaw).trim()
                  if (contChunk) finalCode = finalCode.trimEnd() + '\n' + contChunk
                  else break
                } catch (contErr) {
                  updateActivity(genId, { detail: `continuation failed (${contErr.message}) — using partial output` })
                  break
                }
              }
            }

            updateActivity(genId, { status: 'done', msg: `▶ ${entry.path}`, detail: `${finalCode.split('\n').length} lines` })

            // AutoRemediation
            emitStreamEvent(createStreamEvent('status', { phase: 'refining' }))
            updatePlanEntry(i, { status: 'remediating', code: finalCode })
            const remId = logActivity('remediate', `⊛ Testing ${entry.path}`)
            finalCode = await autoRemediate(finalCode, lang, effectiveModel, ctrl.signal, entry.path, entry.purpose)
            updateActivity(remId, { status: 'done', msg: `⊛ ${entry.path} — clean` })

            // Test generation
            let builtTestCode = ''
            if (generateTests) {
              setIsGenTests(true)
              const testId = logActivity('test', `⊛ Writing tests for ${entry.path}`)
              try {
                const testSys = buildFileSystemPrompt(entry.path, null, lang, repoOwner, repoName, true)
                const testRaw = await runPromptWithRetry(effectiveModel,
                  `Write tests for:\n${finalCode}`,
                  [{ role: 'user', content: testSys }, { role: 'assistant', content: 'Understood. Test code only.' }],
                  null, ctrl.signal)
                builtTestCode = extractCode(testRaw)
                updateActivity(testId, { status: 'done', msg: `⊛ Tests → ${testFilePath(entry.path)}`, detail: `${builtTestCode.split('\n').length} lines` })
              } catch (e) {
                if (e.name !== 'AbortError') {
                  console.warn('Test gen failed:', e.message)
                  updateActivity(testId, { status: 'error', msg: `⊛ Test gen failed: ${e.message}` })
                }
              } finally { setIsGenTests(false) }
            }

            updatePlanEntry(i, {
              code: finalCode, testCode: builtTestCode,
              patchEdits: newEdits, diffText: newDiff, status: 'done',
            })
          } catch (err) {
            if (err.name !== 'AbortError') {
              updatePlanEntry(i, { status: 'error', error: err.message })
              updateActivity(genId, { status: 'error', msg: `✗ ${entry.path} — ${err.message}` })
            }
            // Guarantee isGenTests is cleared even if error occurs before test finally block
            setIsGenTests(false)
          }
        }

        // Save to history + summary entry
        if (!ctrl.signal.aborted && planRef.current.length > 0) {
          emitStreamEvent(createStreamEvent('status', { phase: 'validating' }))
          const doneCount = planRef.current.filter(e => e.status === 'done').length
          logActivity('done', `✓ Complete — ${doneCount}/${planRef.current.length} file${planRef.current.length !== 1 ? 's' : ''} generated`)
          // Auto-switch to Diff tab when diffs are available (surface review naturally)
          const hasDiffs = planRef.current.some(e => e.diffText?.trim())
          setActiveTab(hasDiffs ? 'diff' : 'code')
          const he = { id: Date.now().toString(), prompt: requestText.slice(0, 100), filePath: planRef.current[0]?.path || '', timestamp: new Date().toISOString() }

          const planSteps = planRef.current.map((e) => `${e.action === 'modify' ? 'Update' : 'Create'} ${e.path} — ${e.purpose}`)
          const primary = planRef.current[0] || {}
          const combinedDiff = planRef.current.map((e) => e.diffText?.trim()).filter(Boolean).join('\n\n')
          const validation = [
            `✓ Generated ${doneCount}/${planRef.current.length} planned file(s).`,
            planRef.current.some((e) => e.status === 'error') ? '⚠ Some files failed and may need retry.' : '✓ No file-level generation errors.',
            generateTests ? '✓ Test generation attempted for completed files.' : '⚠ Test generation disabled.',
          ]
          setValidationResults(validation)
          emitStreamEvent(createStreamEvent('validation', { results: validation }))

          const modeCode = command === '/diff' ? combinedDiff : (primary.code || '')
          const assistantText = formatStructuredOutput({
            summary: `Implemented: ${requestText}`,
            plan: planSteps,
            code: modeCode,
            codeLang: command === '/diff' ? 'diff' : detectLanguage(primary.path || '', primary.code || ''),
            changes: planRef.current.map((e) => `${e.action === 'modify' ? 'Updated' : 'Added'} ${e.path}`),
            validation,
            notes: [
              command === '/plan' ? 'Plan-only mode requested.' : 'Use follow-up prompts to iteratively modify generated files.',
            ],
          })
          setConversation(prev => [...prev, { role: 'assistant', content: assistantText }])
          setTurnCount(t => t + 1)
          const updated = [he, ...history]
          setHistory(updated)
          saveHistory(updated)
        }
      }

    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(`Generation failed: ${err.message}`)
        logActivity('error', `✗ ${err.message}`)
      }
    } finally {
      setIsGenerating(false)
      setIsPlanning(false)
      setIsAmplifying(false)
      setIsGenTests(false)   // safety net — ensures it can never stay stuck
      emitStreamEvent(createStreamEvent('status', { phase: 'complete' }))
      setPrompt('')
    }
  }, [
    prompt, models, activeModelId, conversation, filePlan,
    generateTests, creativity, enableThinking,
    repoOwner, repoName, baseBranch, githubToken, hasGithub,
    history, activeFileIndex, autoRemediate, updatePlanEntry, logActivity, updateActivity, setActivePhase, resetConversation, emitStreamEvent,
  ])

  // ── Refinement shortcut ─────────────────────────────────────────────────
  const handleRefine = useCallback(() => {
    if (refinementPrompt.trim() && !isGenerating) handleGenerate(refinementPrompt, true)
  }, [refinementPrompt, isGenerating, handleGenerate])

  // ── Per-file retry — re-generates a single failed file without re-running the full plan
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
      const lang     = detectLanguage(entry.path, '')
      const bluswanMd  = shadowContext.getBluswanMd()
      // Fetch ambient context so the retry has the same repo awareness as first-shot generation
      let retryContextFiles = []
      try {
        retryContextFiles = await shadowContext.getContextContent(
          `${prompt || entry.purpose || entry.path} ${entry.path}`, CONTEXT_FILES_LIMIT
        )
        retryContextFiles = retryContextFiles.filter(f => f.path !== entry.path)
      } catch {}
      const sys      = buildFileSystemPrompt(entry.path, entry.existingContent, lang, repoOwner, repoName, false, bluswanMd, retryContextFiles)
      const fileTask = `${prompt || 'Regenerate this file.'}\n\nFor this file: ${entry.path} — ${entry.purpose}`
      const mode     = entry.existingContent !== null ? 'patch' : 'replace'

      let streaming = ''
      const raw = await runPromptWithRetry(model, fileTask, [
        { role: 'user',      content: sys },
        { role: 'assistant', content: 'Understood. I will output only the code.' },
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
    } finally {
      setIsGenerating(false)
    }
  }, [isGenerating, models, activeModelId, repoOwner, repoName, prompt, autoRemediate, updatePlanEntry, logActivity]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── BLUSWAN.md save ───────────────────────────────────────────────────────
  const handleSaveBluswanMd = useCallback(async () => {
    if (!hasGithub) { setError('GitHub required to save BLUSWAN.md.'); return }
    setIsSavingBluswanMd(true)
    try {
      const existing = await getFileContent(githubToken, repoOwner, repoName, 'BLUSWAN.md', baseBranch)
      const sha = existing?.sha || null
      await createOrUpdateFile(
        githubToken, repoOwner, repoName,
        'BLUSWAN.md', bluswanMdDraft,
        'docs: update BLUSWAN.md project instructions',
        baseBranch, sha,
      )
      shadowContext.bluswanMd = bluswanMdDraft
      logActivity('done', '✓ BLUSWAN.md saved to repo')
    } catch (e) {
      setError(`Failed to save BLUSWAN.md: ${e.message}`)
    } finally {
      setIsSavingBluswanMd(false)
    }
  }, [hasGithub, githubToken, repoOwner, repoName, baseBranch, bluswanMdDraft, logActivity])

  // ── Post-push test runner ───────────────────────────────────────────────
  // Runs npm test / pytest in streaming mode after a successful push.
  const handleRunProjectTests = useCallback(async () => {
    if (!bridgeAvailable) return
    setIsRunningPostPushTests(true)
    const testCmd = 'npm test -- --watchAll=false --passWithNoTests'
    logActivity('test', `⊛ Running project tests…`)
    let out = ''
    await callExecBridgeStream(testCmd, undefined, (chunk) => {
      out += chunk
    }, 120000)
    setIsRunningPostPushTests(false)
    const passed = out.includes('Tests:') && !out.includes('failed')
    logActivity('test', passed ? '⊛ Tests passed' : '⊛ Tests failed — see output', out.slice(-300))
    setActiveTab('code')
  }, [bridgeAvailable, callExecBridgeStream, logActivity])

  // ── Reset conversation ──────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    resetConversation()
    clearActivity()
    setFilePlan([])
    setActiveFileIndex(0)
    setIsPlanning(false)
    planRef.current = []
    setRefinementPrompt('')
    setSandboxOutput([])
    setPrResult(null)
    setGitStatus(null)
    setPrompt('')
    setError('')
    setAmplifierDecisions([])
    setRemediationStatus(null)
    setPlanApproval(null)
    setExecutedPlan(null)
    setLastBranchName('')
    setAttachedFiles([])
    setActiveTab('code')
  }, [resetConversation, clearActivity])

  // ── Abort ───────────────────────────────────────────────────────────────
  const handleAbort = () => {
    abortRef.current?.abort()
    agentSession.abort()
    setIsGenerating(false)
    setIsGenTests(false)
    setIsPushing(false)
    setPushStep('')
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Repo picker — fetch repos on first open, close on outside click
  const loadRepos = useCallback(async () => {
    if (!githubToken) return
    setRepoPickerLoading(true)
    setRepoPickerError(null)
    try {
      const repos = await listUserRepos(githubToken)
      setUserRepos(repos)
      if (repos.length === 0) setRepoPickerError('No repositories returned. Check token scopes (needs repo).')
    } catch (err) {
      console.error('[Bluswan] listUserRepos failed:', err)
      setRepoPickerError(err.message || 'Failed to load repositories')
    } finally {
      setRepoPickerLoading(false)
    }
  }, [githubToken])

  const openRepoPicker = useCallback(async () => {
    setRepoPickerOpen(true)
    setRepoPickerSearch('')
    if (userRepos.length > 0) return
    await loadRepos()
  }, [githubToken, userRepos.length, loadRepos])

  useEffect(() => {
    if (!repoPickerOpen) return
    const handler = e => {
      if (repoPickerRef.current && !repoPickerRef.current.contains(e.target)) {
        setRepoPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [repoPickerOpen])

  const handlePickRepo = useCallback(async (repo) => {
    setRepoOwner(repo.owner.login)
    setRepoName(repo.name)
    setBaseBranch(repo.default_branch || 'main')
    setRepoPickerOpen(false)
    setLastBranchName('')
  }, [])

  // ─────────────────────────────────────────────────────────────────────────
  // Reindex shadow context (clears cache and re-crawls the repo)
  const handleReindex = useCallback(async () => {
    if (!hasGithub) return
    setShadowStatus('reindexing…')
    try {
      await shadowContext.reindex()
      setShadowStatus(shadowContext.statusSummary())
    } catch {
      setShadowStatus('reindex failed')
    }
  }, [hasGithub])

  // ─────────────────────────────────────────────────────────────────────────
  // GitHub Actions: list workflows and trigger a run
  const loadWorkflows = useCallback(async () => {
    if (!hasGithub) return
    try {
      const res = await listWorkflows(githubToken, repoOwner, repoName)
      setWorkflows(res?.workflows || [])
    } catch {
      setWorkflows([])
    }
  }, [hasGithub, githubToken, repoOwner, repoName])

  const triggerWorkflow = useCallback(async () => {
    if (!hasGithub) return
    const wf = workflows.find(w => w.events?.includes('workflow_dispatch')) || workflows[0]
    if (!wf) return

    setIsPollingCI(true)
    const id = logActivity('ci', `⊙ Triggering workflow ${wf.name || wf.path}`)

    try {
      const dispatch = await dispatchWorkflow(githubToken, repoOwner, repoName, wf.id, baseBranch)
      if (!dispatch) {
        updateActivity(id, { status: 'error', msg: `⊙ Failed to trigger workflow ${wf.name || wf.path}` })
        return
      }
      updateActivity(id, { status: 'done', msg: `⊙ Workflow triggered: ${wf.name || wf.path}` })

      // Poll for a new run to appear
      for (let i = 0; i < 18; i++) {
        await new Promise(r => setTimeout(r, 5000))
        const runs = await getWorkflowRuns(githubToken, repoOwner, repoName, baseBranch, 5, wf.id)
        const run = runs?.workflow_runs?.find(r => r.workflow_id === wf.id)
        if (run && (run.status !== 'queued' && run.status !== 'in_progress')) {
          setWorkflowRuns([run])
          updateActivity(id, { status: run.conclusion === 'success' ? 'done' : 'error', msg: `⊙ Workflow ${run.name} ${run.conclusion || run.status}`, detail: run.html_url })
          break
        }
      }
    } catch (e) {
      updateActivity(id, { status: 'error', msg: `⊙ Workflow trigger failed: ${e.message}` })
    } finally {
      setIsPollingCI(false)
    }
  }, [hasGithub, workflows, githubToken, repoOwner, repoName, baseBranch, logActivity, updateActivity])

  // ─────────────────────────────────────────────────────────────────────────
  // ENHANCEMENT 7 — JS sandbox execution
  // ─────────────────────────────────────────────────────────────────────────
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
        setIsRunning(false)
        window.removeEventListener('message', onMessage)
      }
    }
    window.addEventListener('message', onMessage)
    // Fallback timeout — iframe should always postMessage, but just in case
    const guard = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      setIsRunning(false)
    }, guardMs)
    iframe._guard = guard
    iframe.srcdoc = isPython ? buildPyodideSandboxHtml(generatedCode) : buildSandboxHtml(generatedCode, sandboxSetup)
  }, [generatedCode, sandboxSetup, language])

  // ─────────────────────────────────────────────────────────────────────────
  // ENHANCEMENT — Run tests in sandbox
  // ─────────────────────────────────────────────────────────────────────────
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
        setIsRunningTests(false)
        window.removeEventListener('message', onMessage)
      }
    }
    window.addEventListener('message', onMessage)
    // Fallback timeout — iframe should always postMessage, but just in case
    const guard = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      setIsRunningTests(false)
    }, guardMs)
    iframe._guard = guard
    iframe.srcdoc = isPython ? buildPyodideSandboxHtml(testCode) : buildSandboxHtml(testCode, sandboxSetup)
  }, [testCode, sandboxSetup, language])

  // ─────────────────────────────────────────────────────────────────────────
  // Terminal: real JS/Python execution in the sandbox; honest msgs for shell cmds
  // ─────────────────────────────────────────────────────────────────────────
  const runTerminalCommand = useCallback((cmd) => {
    const trimmed = cmd.trim()
    if (!trimmed) return
    const ts = new Date().toLocaleTimeString()
    const pushEntry = (output, type = 'output') =>
      setTerminalLog(prev => [...prev, { cmd: trimmed, output, type, ts }])

    if (trimmed === 'clear') { setTerminalLog([]); return }
    if (trimmed === 'help') {
      pushEntry(
        'Available commands:\n' +
        '  JS/TS expressions  → executed in real browser sandbox\n' +
        '  python: <code>     → executed via Pyodide (real)\n' +
        '  clear              → clear terminal\n' +
        '  help               → this message\n' +
        '  npm / git / shell  → requires backend (shown as info)',
        'info'
      )
      return
    }

    // python: <snippet> → run in Pyodide sandbox
    if (/^python:/i.test(trimmed)) {
      const code = trimmed.slice(7).trim()
      setIsTerminalRunning(true)
      const iframe = sandboxRef.current
      if (!iframe) { pushEntry('Sandbox not available', 'error'); setIsTerminalRunning(false); return }
      const timer = setTimeout(() => {
        window.removeEventListener('message', onPyMsg)
        pushEntry('[timeout] 20 s limit reached', 'warn')
        setIsTerminalRunning(false)
      }, 22000)
      const onPyMsg = (e) => {
        if (!e.data?.done) return
        clearTimeout(timer)
        window.removeEventListener('message', onPyMsg)
        const lines = e.data.log || []
        pushEntry(lines.length ? lines.map(l => l.text).join('\n') : '(no output)',
          lines.some(l => l.level === 'error') ? 'error' : 'output')
        setIsTerminalRunning(false)
      }
      window.addEventListener('message', onPyMsg)
      iframe.srcdoc = buildPyodideSandboxHtml(code)
      return
    }

    // Looks like a JS expression or statement → run in JS sandbox
    const isJsLike = /^(const |let |var |function |class |console\.|\/\/|import |export |async |await )/.test(trimmed) ||
      (/[+\-*/%=()[\]{}.`"']/.test(trimmed) && !/^[a-z]+ /.test(trimmed)) ||
      /^\d/.test(trimmed)
    if (isJsLike) {
      setIsTerminalRunning(true)
      const iframe = sandboxRef.current
      if (!iframe) { pushEntry('Sandbox not available', 'error'); setIsTerminalRunning(false); return }
      const timer = setTimeout(() => {
        window.removeEventListener('message', onJsMsg)
        pushEntry('[timeout] 7 s limit reached', 'warn')
        setIsTerminalRunning(false)
      }, 8000)
      const onJsMsg = (e) => {
        if (!e.data?.done) return
        clearTimeout(timer)
        window.removeEventListener('message', onJsMsg)
        const lines = e.data.log || []
        pushEntry(lines.length ? lines.map(l => l.text).join('\n') : '(no output)',
          lines.some(l => l.level === 'error') ? 'error' : 'output')
        setIsTerminalRunning(false)
      }
      window.addEventListener('message', onJsMsg)
      iframe.srcdoc = buildSandboxHtml(trimmed, '')
      return
    }

    // Known version flags (fast local answers)
    if (/^node( -v|--version)?$/.test(trimmed)) { pushEntry('v20.x (browser JS engine)', 'info'); return }
    if (/^python3?( --version|-V)?$/.test(trimmed)) { pushEntry('Python 3.12 (Pyodide) — use: python: print("hello")', 'info'); return }

    // ── Bridge path: streaming real shell commands ─────────────────────────
    if (bridgeAvailable) {
      setIsTerminalRunning(true)
      let streamOut = ''
      // Add a placeholder entry that we'll update in place as output arrives
      const streamId = `stream-${Date.now()}`
      setTerminalLog(prev => [...prev, { cmd: trimmed, output: '', type: 'output', ts, streamId }])
      callExecBridgeStream(trimmed, undefined, (chunk) => {
        streamOut += chunk
        setTerminalLog(prev => prev.map(e =>
          e.streamId === streamId ? { ...e, output: streamOut } : e
        ))
      }).then(({ exitCode }) => {
        setTerminalLog(prev => prev.map(e =>
          e.streamId === streamId
            ? { ...e, output: streamOut || '(no output)', type: exitCode === 0 ? 'output' : 'error', streamId: undefined }
            : e
        ))
        setIsTerminalRunning(false)
      })
      return
    }

    // ── Fallback: bridge not available (production / no Vite dev server) ──
    const shellCmds = ['npm', 'yarn', 'pnpm', 'git', 'npx', 'tsc', 'eslint', 'jest', 'vitest', 'cargo', 'go', 'pip']
    const base = trimmed.split(/\s+/)[0]
    if (shellCmds.includes(base)) {
      pushEntry(
        `ℹ "${trimmed}" requires the exec bridge (run via \`npm run dev\`).\n` +
        `Bridge not detected — start the Vite dev server to enable real shell execution.\n` +
        `Tip: JS/TS runs in the sandbox without a bridge — try: console.log(42)`,
        'info'
      )
      return
    }

    pushEntry(`command not found: ${base}\nType "help" for available commands.`, 'error')
  }, [sandboxRef, bridgeAvailable, callExecBridge, callExecBridgeStream])

  // ─────────────────────────────────────────────────────────────────────────
  // Permission gate — respects permissionMode before any GitHub write
  // ─────────────────────────────────────────────────────────────────────────
  const confirmAction = useCallback((description) => {
    if (permissionMode === 'auto') return true
    if (permissionMode === 'ask') return window.confirm(`BLUSWAN permission request\n\n${description}\n\nProceed?`)
    // 'manual': same as 'ask' but with extra context
    return window.confirm(`BLUSWAN — manual mode\n\n${description}\n\nThis action writes to GitHub. Confirm to continue.`)
  }, [permissionMode])

  // ─────────────────────────────────────────────────────────────────────────
  // Push: commit all generated files to GitHub, optionally create branch + PR
  // ─────────────────────────────────────────────────────────────────────────
  const handlePush = async () => {
    const filesToPush = filePlan.filter(e => e.code?.trim())
    if (filesToPush.length === 0) { setError('Generate code first.'); return }
    if (!githubToken)             { setError('GitHub token required — open Settings.'); setSettingsOpen(true); return }
    if (!repoOwner || !repoName)  { setError('Repo owner and name required — open Settings.'); setSettingsOpen(true); return }

    const promptSummary = (history[0]?.prompt || prompt || 'BLUSWAN generated code').slice(0, 80)

    // Permission gate
    if (!dryRun && !confirmAction(
      `Push ${filesToPush.length} file${filesToPush.length !== 1 ? 's' : ''} to ${repoOwner}/${repoName}` +
      (doCreateBranch ? ' on a new branch' : ` on "${baseBranch}"`) +
      (doCreatePR ? ', then open a PR' : '')
    )) return

    setError('')
    setIsPushing(true)
    setPrResult(null)
    setActiveTab('code')

    const steps = []
    const log = (msg, ok = true) => { steps.push({ msg, ok }); setGitStatus([...steps]) }

    logActivity('push', `⬆ Pushing ${filesToPush.length} file${filesToPush.length !== 1 ? 's' : ''} to GitHub`)

    try {
      setPushStep('Verifying repository…')
      const repoId = logActivity('push', `⬆ Verifying ${repoOwner}/${repoName}`)
      const repo = await getRepo(githubToken, repoOwner, repoName)
      log(`✓ ${repoOwner}/${repoName} — ${repo.private ? 'private' : 'public'}`)
      updateActivity(repoId, { status: 'done', msg: `⬆ ${repoOwner}/${repoName} — ${repo.private ? 'private' : 'public'}` })

      setPushStep(`Fetching branch "${baseBranch}"…`)
      const branchId = logActivity('push', `⬆ Resolving branch "${baseBranch}"`)
      const branchData = await getBranch(githubToken, repoOwner, repoName, baseBranch)
      const baseSha    = branchData.commit.sha
      log(`✓ Base "${baseBranch}" → ${baseSha.slice(0, 7)}`)
      updateActivity(branchId, { status: 'done', msg: `⬆ "${baseBranch}" @ ${baseSha.slice(0, 7)}` })

      let targetBranch = baseBranch
      if (doCreateBranch) {
        targetBranch = generateBranchName(promptSummary)
        setPushStep(`Creating branch "${targetBranch}"…`)
        const newBrId = logActivity('push', `⬆ Creating branch "${targetBranch}"`)
        if (!dryRun) await createBranch(githubToken, repoOwner, repoName, targetBranch, baseSha)
        log(`${dryRun ? '○' : '✓'} Branch "${targetBranch}"${dryRun ? ' (dry run)' : ''}`)
        updateActivity(newBrId, { status: 'done', msg: `⬆ Branch "${targetBranch}" ready${dryRun ? ' (dry run)' : ''}` })
        setLastBranchName(targetBranch)
      }

      // Push each file in the plan
      const modelName = models?.find(m => m.id === activeModelId)?.name || 'Unknown'

      // Push a file with retry-on-conflict: if GitHub rejects with 409 (stale SHA),
      // re-fetch the latest SHA and retry up to 2 more times before giving up.
      async function pushWithRetry(path, code, commitMsg, branch, initialSha) {
        let sha = initialSha
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await createOrUpdateFile(githubToken, repoOwner, repoName, path, code, commitMsg, branch, sha)
            return
          } catch (err) {
            if (err.status === 409 && attempt < 2) {
              const fresh = await getFileContent(githubToken, repoOwner, repoName, path, branch)
              sha = fresh?.sha || null
            } else {
              throw err
            }
          }
        }
      }

      for (const entry of filesToPush) {
        setPushStep(`Pushing "${entry.path}"…`)
        const fileId = logActivity('push', `⬆ ${entry.path}`)
        const existing    = await getFileContent(githubToken, repoOwner, repoName, entry.path, targetBranch)
        const existingSha = existing?.sha || entry._sha || null
        const action      = existingSha ? 'update' : 'add'
        const commitMsg   = `feat(bluswan): ${action} ${entry.path}\n\nGenerated by BLUSWAN: "${promptSummary}"`
        if (!dryRun) await pushWithRetry(entry.path, entry.code, commitMsg, targetBranch, existingSha)
        log(`${dryRun ? '○' : '✓'} ${dryRun ? '[dry run] ' : ''}${action === 'update' ? 'Updated' : 'Created'} ${entry.path}`)
        updateActivity(fileId, { status: 'done', msg: `⬆ ${action === 'update' ? 'Updated' : 'Created'} ${entry.path}${dryRun ? ' (dry run)' : ''}` })

        // Co-commit test file if present
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

      let prUrl = null
      if (doCreateBranch && doCreatePR) {
        setPushStep('Creating pull request…')
        const prId = logActivity('push', '⬆ Creating pull request…')
        const fileList = filesToPush.map(e => `- \`${e.path}\`${e.purpose ? ` — ${e.purpose}` : ''}`).join('\n')
        const prBody = [
          `## BLUSWAN AI Generated Code`,
          ``,
          `**Prompt:** ${promptSummary}`,
          `**Model:** ${modelName}`,
          `**Files changed (${filesToPush.length}):**`,
          fileList,
          turnCount > 1 ? `**Refinement turns:** ${turnCount}` : '',
          ``,
          `---`,
          `*Generated by BLUSWAN — WolfKrow AI Coding Assistant*`,
        ].filter(Boolean).join('\n')

        let pr = null
        if (!dryRun) pr = await createPullRequest(githubToken, repoOwner, repoName, `BLUSWAN: ${promptSummary}`, targetBranch, baseBranch, prBody)
        prUrl = pr?.html_url || `https://github.com/${repoOwner}/${repoName}/compare/${targetBranch}`
        setPrResult({ url: prUrl, number: pr?.number })
        log(`${dryRun ? '○' : '✓'} PR ${dryRun ? 'preview' : 'created'}: ${prUrl}`)
        updateActivity(prId, { status: 'done', msg: `⬆ PR${pr?.number ? ` #${pr.number}` : ''} ${dryRun ? 'preview' : 'created'}`, detail: prUrl })
      }

      log('── Complete ──')
      logActivity('done', `✓ Push complete — ${filesToPush.length} file${filesToPush.length !== 1 ? 's' : ''}`)

      // ── CI monitoring: poll GitHub Actions after push ──────────────────
      if (!dryRun && hasGithub) {
        const ciId = logActivity('ci', '⊙ Waiting for CI…')
        // Short delay to let GitHub register the push
        await new Promise(r => setTimeout(r, 4000))
        try {
          const runsData = await getWorkflowRuns(githubToken, repoOwner, repoName, targetBranch, 1)
          const run = runsData?.workflow_runs?.[0]
          if (run) {
            updateActivity(ciId, { msg: `⊙ CI: ${run.name} — ${run.status}` })
            // Poll until completed (max 30 × 10s = 5 min)
            let pollRun = run
            for (let p = 0; p < 30 && pollRun.status !== 'completed'; p++) {
              await new Promise(r => setTimeout(r, 10000))
              const refreshed = await getWorkflowRun(githubToken, repoOwner, repoName, pollRun.id)
              if (refreshed) pollRun = refreshed
              updateActivity(ciId, { msg: `⊙ CI: ${pollRun.name} — ${pollRun.status}` })
            }
            const ciOk = pollRun.conclusion === 'success'
            updateActivity(ciId, {
              status: ciOk ? 'done' : 'error',
              msg: `⊙ CI: ${pollRun.name} — ${pollRun.conclusion || pollRun.status}`,
              detail: pollRun.html_url,
            })
          } else {
            updateActivity(ciId, { status: 'skip', msg: '⊙ CI: no workflow runs found' })
          }
        } catch {
          updateActivity(ciId, { status: 'skip', msg: '⊙ CI: monitoring unavailable' })
        }
      }
    } catch (err) {
      log(`✗ ${err.message}`, false)
      logActivity('error', `✗ Push failed: ${err.message}`)
      setError(`Push failed: ${err.message}`)
    } finally {
      setIsPushing(false)
      setPushStep('')
    }
  }

  const isConversationalPrompt = useCallback((value) => {
    const text = String(value || '').trim().toLowerCase()
    if (!text) return false
    if (text.length < 80 && /^(hi|hello|hey|thanks|thank you|how are you|what can you do)/i.test(text)) return true
    const codingSignals = /(create|build|implement|fix|refactor|add|remove|update|generate|write|bug|error|test|repo|file|component|api|function|class|css|ui|database|deploy|pipeline|module|route)/i
    const chatSignals = /(explain|what is|why|how does|compare|difference|ideas|brainstorm|summary|summarize|help me understand)/i
    if (codingSignals.test(text)) return false
    return chatSignals.test(text) || text.endsWith('?')
  }, [])

  const handleConversationalReply = useCallback(async (userMsg) => {
    const model = models?.find(m => m.id === activeModelId)
    if (!model) { setError('Select a model.'); return }
    if (!model.apiKey) { setError(`No API key for "${model.name}". Open Admin Panel.`); return }
    const clean = userMsg.trim()
    if (!clean) return
    setError('')
    setIsGenerating(true)
    try {
      const reply = await runPromptWithRetry(
        model,
        clean,
        [
          { role: 'system', content: 'You are BLUSWAN in chat mode. Reply directly and helpfully. Use markdown formatting when useful.' },
          ...conversation.slice(-10),
        ],
      )
      setConversation(prev => [...prev, { role: 'user', content: clean }, { role: 'assistant', content: reply }])
      setTurnCount(t => t + 1)
      setPrompt('')
    } catch (err) {
      setError(`Chat response failed: ${err.message}`)
    } finally {
      setIsGenerating(false)
    }
  }, [models, activeModelId, conversation, setConversation, setTurnCount])

  // ── Long Request Mode handlers ─────────────────────────────────────────
  const PHASE_PLAN_SYSTEM = `You are a software engineering planner for the BLUSWAN AI coding assistant.
The user has a complex request requiring multiple implementation steps.
Break it into 2-6 ordered, logically atomic phases. Each phase should be independently committable.
Return ONLY a valid JSON array — no markdown fences, no prose, no explanation before or after:
[{"id":1,"title":"Short title (5-8 words)","summary":"What this phase accomplishes in 1-2 sentences.","targets":["src/path/to/file.js"],"instructions":"Complete implementation instructions for this phase only."}]`

  const handleLrmGeneratePlan = useCallback(async (userMsg) => {
    const model = models.find(m => m.id === activeModelId)
    if (!model) { setError('Select a model before using Long Request Mode.'); return }
    setLrmGeneratingPlan(true)
    setError('')
    try {
      let raw = ''
      await runPromptWithRetry(
        model,
        `Plan this task into phases:\n\n${userMsg}`,
        [
          { role: 'user',      content: PHASE_PLAN_SYSTEM },
          { role: 'assistant', content: 'Here is the phase plan as a JSON array:\n[' },
        ],
        chunk => { raw = chunk },
      )
      const jsonStr = raw.includes('[') ? raw.slice(raw.indexOf('[')) : '[' + raw
      const phases = JSON.parse(jsonStr.slice(0, jsonStr.lastIndexOf(']') + 1))
      if (!Array.isArray(phases) || phases.length === 0) throw new Error('Empty phase plan')
      setLrmPlan({
        originalPrompt: userMsg,
        phases,
        currentIdx: 0,
        statuses: {},
        verifyError: null,
      })
    } catch (err) {
      setError(`LRM plan generation failed: ${err.message}`)
    } finally {
      setLrmGeneratingPlan(false)
    }
  }, [models, activeModelId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLrmStart = useCallback(() => {
    if (!lrmPlan) return
    const phase = lrmPlan.phases[0]
    setLrmPlan(p => ({ ...p, currentIdx: 0, statuses: { ...p.statuses, 0: 'active' } }))
    handleGenerate(`[Phase 1: ${phase.title}]\n${phase.instructions}\n\nOriginal request: ${lrmPlan.originalPrompt}`)
  }, [lrmPlan, handleGenerate])

  const handleLrmProceed = useCallback(async (fromIdx) => {
    if (!lrmPlan) return
    const nextIdx = fromIdx + 1

    // Simple verification: if GitHub connected, check that at least one target file exists
    if (hasGithub && lrmPlan.phases[fromIdx]?.targets?.length > 0) {
      setLrmPlan(p => ({ ...p, statuses: { ...p.statuses, [fromIdx]: 'verifying' } }))
      try {
        const targets = lrmPlan.phases[fromIdx].targets
        const { getFileContent } = await import('../services/githubService')
        const checks = await Promise.allSettled(
          targets.map(t => getFileContent(githubToken, repoOwner, repoName, t, baseBranch))
        )
        const anyFound = checks.some(c => c.status === 'fulfilled' && c.value !== null)
        if (!anyFound) {
          setLrmPlan(p => ({
            ...p,
            statuses: { ...p.statuses, [fromIdx]: 'blocked' },
            verifyError: `Target files not found in ${repoOwner}/${repoName}. Commit changes first.`,
          }))
          return
        }
      } catch {
        // Network/API error — allow manual override by falling through
      }
    }

    // Mark current phase complete, advance
    if (nextIdx >= lrmPlan.phases.length) {
      setLrmPlan(p => ({ ...p, statuses: { ...p.statuses, [fromIdx]: 'complete' } }))
      return
    }
    const phase = lrmPlan.phases[nextIdx]
    setLrmPlan(p => ({
      ...p,
      currentIdx: nextIdx,
      statuses: { ...p.statuses, [fromIdx]: 'complete', [nextIdx]: 'active' },
      verifyError: null,
    }))
    handleGenerate(`[Phase ${nextIdx + 1}: ${phase.title}]\n${phase.instructions}\n\nOriginal request: ${lrmPlan.originalPrompt}`)
  }, [lrmPlan, hasGithub, githubToken, repoOwner, repoName, baseBranch, handleGenerate])

  const handleLrmOverride = useCallback((idx) => {
    setLrmPlan(p => ({ ...p, statuses: { ...p.statuses, [idx]: 'active' }, verifyError: null }))
  }, [])

  const handleLrmCancel = useCallback(() => {
    setLrmPlan(null)
    setLrmGeneratingPlan(false)
  }, [])

  const handleSubmitPrompt = useCallback(() => {
    setHistoryOpen(false)
    setSettingsOpen(false)
    const userMsg = prompt.trim()
    if (!userMsg && attachedFiles.length === 0) return
    const fileContext = attachedFiles.length > 0
      ? `\n\n[Attached files: ${attachedFiles.map(f => f.name).join(', ')}]`
      : ''
    const fullMsg = (userMsg + fileContext).trim()
    setPrompt('')
    setAttachedFiles([])

    // Long Request Mode intercept — generate phase plan first
    if (longRequestMode && !lrmPlan && !isConversationalPrompt(fullMsg)) {
      handleLrmGeneratePlan(fullMsg)
      return
    }

    if (isConversationalPrompt(fullMsg)) {
      handleConversationalReply(fullMsg)
      return
    }
    if (shouldUseAgent) agentSession.run(fullMsg, conversation.slice(-10))
    else handleGenerate(fullMsg)
  }, [prompt, attachedFiles, longRequestMode, lrmPlan, isConversationalPrompt, handleConversationalReply, shouldUseAgent, agentSession, conversation, handleGenerate, handleLrmGeneratePlan])

  const handleKeyDown = useCallback((e) => {
    const submitByEnter = e.key === 'Enter' && !e.shiftKey && !e.isComposing
    const submitByModifier = (e.ctrlKey || e.metaKey) && e.key === 'Enter'
    if (submitByEnter || submitByModifier) {
      e.preventDefault()
      if (!isGenerating && !isPushing && !agentSession.isAgentRunning) {
        if (generatedCode && refinementPrompt.trim()) handleRefine()
        else handleSubmitPrompt()
      }
    }
  }, [isGenerating, isPushing, agentSession.isAgentRunning, generatedCode, refinementPrompt, handleRefine, handleSubmitPrompt])

  const busy = isGenerating || isPushing

  // ── Tab config ──────────────────────────────────────────────────────────
  const isModulesPage = activeTab === 'modules'
  const effectiveActiveTab = isModulesPage ? 'modules' : 'code'
  const hasOutputContent = Boolean(
    (assistantMessage.code || generatedCode || '').trim()
    || diffText?.trim()
    || testCode?.trim()
    || terminalLog.length
    || sandboxOutput.length
    || isGenerating
    || isGenTests
    || isRunning
    || isRunningTests
    || validationResults.length
    || (assistantMessage.plan && assistantMessage.plan.length)
  )

  // ══════════════════════════════════════════════════════════════════════════
  // ── Fine-tune filter string ────────────────────────────────────────────
  const ft = fineTune
  const ftFilter = [
    `brightness(${(ft.brightness / 100) * (0.85 + (ft.highlight / 100) * 0.30)})`,
    `contrast(${(ft.contrast / 100) * (0.85 + (ft.shadow / 100) * 0.30)})`,
    `saturate(${ft.saturation / 100})`,
  ].join(' ')

  return (
    <div
      className={`lk-root lk-theme-bluswan${conversation.length > 0 ? ' lk-root--chatting' : ''}`}
      style={{ filter: ftFilter }}
      onKeyDown={handleKeyDown}
    >
      {/* ── Aurora WebGL background — hidden after first message ── */}
      {conversation.length === 0 && (
        <Aurora
          colorStops={['#071630', '#3b8ef0', '#112252']}
          amplitude={1.0}
          blend={0.5}
          speed={1.0}
        />
      )}

      {/* ── Invisible sandbox iframe ──────────────────────────────────────── */}
      <iframe ref={sandboxRef} className="lk-sandbox-iframe" sandbox="allow-scripts allow-same-origin" title="BLUSWAN sandbox" aria-hidden="true" />

      {/* ══════════════════════════════════════════════════════════════════════
          LEFT SIDEBAR — icon column (like Claude Code's narrow left rail)
          ══════════════════════════════════════════════════════════════════════ */}
      <nav className={`lk-sidebar${mobileDrawerOpen ? ' lk-sidebar--open' : ''}`}>
        <button className="lk-sidebar-btn lk-sidebar-btn--back" onClick={onClose} title="Back">←</button>
        <div className="lk-sidebar-sep" />
        <button className={`lk-sidebar-btn${historyOpen ? ' lk-sidebar-btn--on' : ''}`}
          onClick={() => { setHistoryOpen(v => !v); setSettingsOpen(false) }} title="History">⧖</button>
        <button className={`lk-sidebar-btn${settingsOpen ? ' lk-sidebar-btn--on' : ''}`}
          onClick={() => {
            setSettingsOpen(v => !v)
            setHistoryOpen(false)
            setBluswanMdDraft(shadowContext.bluswanMd || '')
          }} title="Settings">⚙</button>
        <button
          className="lk-sidebar-btn"
          onClick={handleReset}
          title="New Chat"
        >＋</button>
        <div className="lk-sidebar-spacer" />
        {shadowStatus && (
          <div className={`lk-sidebar-shadow${shadowContext.isIndexing ? ' lk-sidebar-shadow--pulse' : ' lk-sidebar-shadow--ready'}`}
            title={shadowStatus} />
        )}

        {/* ── Mobile-only drawer nav (hidden on desktop via CSS) ──────────── */}
        <div className="lk-sidebar-mobile-nav">
          <div className="lk-sidebar-nav-brand">
            <img src="/bluswan-header-logo.jpg" alt="BLUSWAN" className="lk-bluswan-logo lk-bluswan-logo--drawer" />
            <button className="lk-sidebar-btn lk-sidebar-btn--new"
              onClick={() => { handleReset(); setMobileDrawerOpen(false) }} title="New session">＋</button>
          </div>
          <div className="lk-sidebar-nav-sep" />
          <div className="lk-sidebar-nav-section-hd">
            <span>Task History</span>
            {history.length > 0 && (
              <button className="lk-sidebar-nav-section-clear"
                onClick={() => { setHistory([]); saveHistory([]) }}>Clear</button>
            )}
          </div>
          {history.length === 0
            ? <span className="lk-sidebar-nav-empty">No tasks yet.</span>
            : <div className="lk-sidebar-nav-history">
                {history.slice(0, 20).map(e => (
                  <button key={e.id} className="lk-sidebar-nav-history-item"
                    onClick={() => { setPrompt(e.prompt); setMobileDrawerOpen(false) }}>
                    <div className="lk-sidebar-nav-history-icon">⚡</div>
                    <div className="lk-sidebar-nav-history-body">
                      <span className="lk-sidebar-nav-history-text">{e.prompt}</span>
                      {e.filePath && <span className="lk-sidebar-nav-history-file">{e.filePath.split('/').pop()}</span>}
                    </div>
                    <span className="lk-sidebar-nav-history-date">{formatRelativeDate(e.timestamp)}</span>
                  </button>
                ))}
              </div>
          }
          <div className="lk-sidebar-nav-sep" />
          <button
            className={`lk-sidebar-nav-btn${settingsOpen ? ' lk-sidebar-nav-btn--active' : ''}`}
            onClick={() => { setSettingsOpen(v => !v); setHistoryOpen(false); setBluswanMdDraft(shadowContext.bluswanMd || ''); setMobileDrawerOpen(false) }}
          ><span className="lk-sidebar-nav-icon">⚙</span> Settings</button>
          {shadowStatus && (
            <div className="lk-sidebar-nav-status">
              <div className={`lk-sidebar-shadow${shadowContext.isIndexing ? ' lk-sidebar-shadow--pulse' : ' lk-sidebar-shadow--ready'}`} />
              <span>{shadowStatus}</span>
            </div>
          )}
        </div>
      </nav>

      {/* Mobile drawer backdrop — closes drawer on tap */}
      {mobileDrawerOpen && (
        <div className="lk-mobile-backdrop" onClick={() => setMobileDrawerOpen(false)} />
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          MAIN COLUMN
          ══════════════════════════════════════════════════════════════════════ */}
      <div className="lk-main">

        {/* ── Thin top bar ──────────────────────────────────────────────────── */}
        <div className="lk-topbar" style={{ height: `${headerLayout.headerHeight}px` }}>
          {/* Mobile: hamburger + centered title (hidden on desktop via CSS) */}
          <button className="lk-hamburger" onClick={() => setMobileDrawerOpen(v => !v)} aria-label="Open navigation">≡</button>
          <span className="lk-topbar-mobile-title">
            <img src="/bluswan-header-logo.jpg" alt="BLUSWAN" className="lk-bluswan-logo" />
          </span>
          <>

              <img
                src="/bluswan-header-logo.jpg"
                alt="BLUSWAN"
                className="lk-bluswan-topbar-logo"
              />

              {/* ── Repo picker ───────────────────────────────────────────── */}
              {githubToken && (
                <div className="lk-repo-picker-wrap" ref={repoPickerRef}>
                  <button
                    className="lk-repo-picker-btn"
                    onClick={openRepoPicker}
                    title="Switch repository"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{flexShrink:0,opacity:0.7}}>
                      <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8V1.5Z"/>
                    </svg>
                    <span className="lk-repo-picker-label">
                      {repoOwner && repoName ? `${repoOwner}/${repoName}` : 'Select repo…'}
                    </span>
                    <svg width="9" height="9" viewBox="0 0 9 6" fill="currentColor" style={{flexShrink:0,opacity:0.5}}>
                      <path d="M0 0l4.5 6L9 0z"/>
                    </svg>
                  </button>

                  {repoPickerOpen && (
                    <div className="lk-repo-picker-dropdown">
                      <div className="lk-repo-picker-search-wrap">
                        <input
                          className="lk-repo-picker-search"
                          placeholder="Search repos…"
                          value={repoPickerSearch}
                          onChange={e => setRepoPickerSearch(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="lk-repo-picker-list">
                        {repoPickerLoading && (
                          <div className="lk-repo-picker-status">Loading repositories…</div>
                        )}
                        {!repoPickerLoading && repoPickerError && (
                          <div className="lk-repo-picker-error">
                            <span>{repoPickerError}</span>
                            <button className="lk-repo-picker-retry" onClick={loadRepos}>Retry</button>
                          </div>
                        )}
                        {!repoPickerLoading && !repoPickerError && userRepos.length === 0 && (
                          <div className="lk-repo-picker-status">No repositories found.</div>
                        )}
                        {!repoPickerLoading && userRepos
                          .filter(r => {
                            const q = repoPickerSearch.toLowerCase()
                            return !q || r.full_name.toLowerCase().includes(q)
                          })
                          .map(r => (
                            <button
                              key={r.id}
                              className={`lk-repo-picker-item${repoOwner === r.owner.login && repoName === r.name ? ' lk-repo-picker-item--active' : ''}`}
                              onClick={() => handlePickRepo(r)}
                            >
                              <span className="lk-repo-picker-item-name">{r.name}</span>
                              <span className="lk-repo-picker-item-branch">{r.default_branch}</span>
                            </button>
                          ))
                        }
                      </div>
                    </div>
                  )}
                </div>
              )}

              {turnCount > 0 && (
                <div className="lk-turn-badge">
                  {turnCount} {turnCount === 1 ? 'turn' : 'turns'}
                  {filePath && <span className="lk-turn-file"> · {filePath.split('/').pop()}</span>}
                </div>
              )}
              <div className="lk-topbar-spacer" />
              {shadowStatus && (
                <div className={`lk-shadow-badge${shadowContext.isIndexing ? ' lk-shadow-badge--indexing' : ''}`}
                  title="ShadowContext: background repo index">◆ {shadowStatus}</div>
              )}
          </>
          {/* Account / logout — shown when Firebase auth is active */}
          {onLogout && (
            <button
              className="lk-icon-btn"
              title={userEmail ? `Signed in as ${userEmail} — click to log out` : 'Log out'}
              onClick={onLogout}
              style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem', opacity: 0.7 }}
            >⏻</button>
          )}

        </div>

        {/* ── Drawers (overlay inside lk-main) ─────────────────────────────── */}
        {settingsOpen && (
          <BluswanSettings
            githubToken={githubToken}         setGithubToken={setGithubToken}
            githubClientId={githubClientId}   setGithubClientId={setGithubClientId}
            repoOwner={repoOwner}             setRepoOwner={setRepoOwner}
            repoName={repoName}               setRepoName={setRepoName}
            baseBranch={baseBranch}           setBaseBranch={setBaseBranch}
            hasGithub={hasGithub}
            onReindex={handleReindex}
            generateTests={generateTests}     setGenerateTests={setGenerateTests}
            creativity={creativity}           setCreativity={setCreativity}
            enableThinking={enableThinking}   setEnableThinking={setEnableThinking}
            webSearchApiKey={webSearchApiKey} setWebSearchApiKey={setWebSearchApiKey}
            doCreateBranch={doCreateBranch}   setDoCreateBranch={setDoCreateBranch}
            doCreatePR={doCreatePR}           setDoCreatePR={setDoCreatePR}
            dryRun={dryRun}                   setDryRun={setDryRun}
            permissionMode={permissionMode} setPermissionMode={setPermissionMode}
            bluswanMdDraft={bluswanMdDraft}     setBluswanMdDraft={setBluswanMdDraft}
            onSaveBluswanMd={handleSaveBluswanMd}
            isSavingBluswanMd={isSavingBluswanMd}
            models={models}                setModels={setModels}
            onLogout={onLogout}            userEmail={userEmail}
            savedModelIds={savedModelIds}  onModelSaved={onModelSaved}
          />
        )}

      {/* ── Task History drawer ────────────────────────────────────────────── */}
      {historyOpen && (
        <div className="lk-drawer lk-drawer--history">
          <div className="lk-drawer-hd">
            <span>Task History</span>
            {history.length > 0 && <button className="lk-drawer-clear" onClick={() => { setHistory([]); saveHistory([]) }}>Clear all</button>}
          </div>
          {history.length === 0
            ? <div className="lk-empty-note">No tasks yet.</div>
            : <div className="lk-task-history-list">
                {history.map(e => (
                  <button key={e.id} className="lk-task-history-item"
                    onClick={() => { setPrompt(e.prompt); setHistoryOpen(false) }}>
                    <div className="lk-task-history-icon">⚡</div>
                    <div className="lk-task-history-body">
                      <span className="lk-task-history-title">{e.prompt}</span>
                      {e.filePath && <span className="lk-task-history-file">{e.filePath.split('/').pop()}</span>}
                    </div>
                    <span className="lk-task-history-date">{formatRelativeDate(e.timestamp)}</span>
                  </button>
                ))}
              </div>
          }
        </div>
      )}

        {isModulesPage ? (
          <div className="lk-modules-shell">
            <div className="lk-modules-page">
              <div className="lk-modules-page-hd">
                <h2>Modules</h2>
                <button className="lk-btn lk-btn--small" onClick={() => setActiveTab('code')}>Back to Chat</button>
              </div>
              <BluswanModularTools />
            </div>
          </div>
        ) : (
        <>
        {/* ══════════════════════════════════════════════════════════════════
            FEED ROW — activity feed + right task sidebar
            ══════════════════════════════════════════════════════════════════ */}
        <div className="lk-feed-row">

        <div className="lk-feed">

          {/* ── Single evolving task stream ───────────────────────────────── */}
          <BluswanActivityFeed
            activityLog={activityLog}
            isAgentRunning={agentSession.isAgentRunning}
            agentStreamText={agentSession.agentStreamText}
            isGenerating={isGenerating}
            isPushing={isPushing}
            pushStep={pushStep}
            feedRef={activityFeedRef}
            conversation={conversation}
            agentIntent={agentSession.agentIntent}
            agentTask={agentSession.agentTask}
            agentPhase={agentSession.agentPhase}
            filePlan={filePlan}
            isAmplifying={isAmplifying}
            amplifierDecisions={amplifierDecisions}
            isPlanning={isPlanning}
            remediationStatus={remediationStatus}
            executedPlan={executedPlan}
            planApproval={planApproval}
            onApprovePlan={() => {
              const t = planApproval.task
              setExecutedPlan(planApproval)
              setPlanApproval(null)
              agentSession.run(t, conversation.slice(-10), { forceBuildMode: true, skipAgentStart: true })
            }}
            onCancelPlan={() => setPlanApproval(null)}
            lrmGeneratingPlan={longRequestMode && lrmGeneratingPlan}
            lrmPlan={longRequestMode ? lrmPlan : null}
            onLrmStart={handleLrmStart}
            onLrmProceed={handleLrmProceed}
            onLrmOverride={handleLrmOverride}
            onLrmCancel={handleLrmCancel}
          />
        </div>{/* end lk-feed */}

        {/* ── Right task sidebar ─────────────────────────────────────────── */}
        {conversation.length > 0 && (
          <div className={`lk-task-sidebar${taskSidebarCollapsed ? ' lk-task-sidebar--collapsed' : ''}`}>
            <button
              className="lk-task-sidebar-toggle"
              onClick={() => setTaskSidebarCollapsed(v => !v)}
              title={taskSidebarCollapsed ? 'Expand task panel' : 'Collapse task panel'}
              aria-label={taskSidebarCollapsed ? 'Expand task panel' : 'Collapse task panel'}
            >
              {taskSidebarCollapsed ? '‹' : '›'}
            </button>
            <div className="lk-task-sidebar-inner">
              <div className="lk-task-sidebar-hd">TASK</div>
              <div className="lk-task-sidebar-task">
                {(() => {
                  const firstUser = conversation.find(m => m.role === 'user')
                  const text = typeof firstUser?.content === 'string' ? firstUser.content : ''
                  return text.length > 300 ? `${text.slice(0, 297)}…` : text
                })()}
              </div>
              {agentSession.isAgentRunning && agentSession.agentPhase && (
                <div className="lk-task-sidebar-phase">
                  <span className="lk-task-sidebar-phase-dot" />
                  <span>{agentSession.agentPhase}</span>
                </div>
              )}
            </div>
          </div>
        )}

        </div>{/* end lk-feed-row */}

        <>{/* ══════════════════════════════════════════════════
            BOTTOM INPUT BAR — chat card layout
            ══════════════════════════════════════════════════════════════════ */}
        <div className="lk-input-bar">

          {/* Centered content wrapper */}
          <div className="lk-input-inner">

          {/* Status messages above the card */}
          {error && <div className="lk-error" role="alert">{error}</div>}
          {prResult && (
            <a className="lk-pr-badge" href={prResult.url} target="_blank" rel="noopener noreferrer">
              <span className="lk-pr-icon">↗</span>
              Pull Request {prResult.number ? `#${prResult.number}` : 'created'}
            </a>
          )}

          {/* Input card */}
          <div className="lk-input-card">

            {/* Branch row */}
            <div className="lk-input-branch-row">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style={{flexShrink:0,opacity:0.6}}>
                <path d="M5.559 8.855c.166 1.183 1.19 2.145 2.456 2.145a2.58 2.58 0 0 0 2.516-2H12a1 1 0 1 0 0-2h-1.47A2.58 2.58 0 0 0 8.015 5C6.749 5 5.725 5.962 5.559 7.145H4a1 1 0 1 0 0 2h1.559zM8.015 7a.58.58 0 1 1 0 1.16.58.58 0 0 1 0-1.16z"/>
                <path fillRule="evenodd" d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8zm7-6a6 6 0 1 0 0 12A6 6 0 0 0 8 2z"/>
              </svg>
              <span className="lk-branch-base">{baseBranch || 'main'}</span>
              {lastBranchName && (
                <>
                  <span className="lk-branch-arrow">←</span>
                  <span className="lk-branch-feature">{lastBranchName}</span>
                </>
              )}
            </div>

            {/* Hidden file input */}
            <input
              type="file"
              ref={fileInputRef}
              multiple
              accept="image/*,text/*,application/json,application/pdf,.md,.txt,.js,.ts,.jsx,.tsx,.py,.go,.rs,.java,.css,.html"
              style={{ display: 'none' }}
              onChange={e => {
                const files = Array.from(e.target.files || [])
                if (files.length) setAttachedFiles(prev => [...prev, ...files])
                e.target.value = ''
              }}
            />

            {/* Textarea */}
            <textarea
              className="lk-textarea"
              placeholder="Reply..."
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isGenerating || agentSession.isAgentRunning}
            />

            {/* Attached files chips */}
            {attachedFiles.length > 0 && (
              <div className="lk-attached-files-row">
                {attachedFiles.map((f, i) => (
                  <div key={i} className="lk-attached-chip">
                    <span className="lk-attached-chip-name" title={f.name}>{f.name}</span>
                    <button
                      className="lk-attached-chip-remove"
                      onClick={() => setAttachedFiles(prev => prev.filter((_, j) => j !== i))}
                      title="Remove attachment"
                    >✕</button>
                  </div>
                ))}
              </div>
            )}

            {/* Toolbar */}
            <div className="lk-input-toolbar">

              {/* Left: + attach button + folder icon + LRM toggle */}
              <div className="lk-input-toolbar-left">
                <button
                  className="lk-toolbar-btn lk-toolbar-btn--plus"
                  title="Attach files or photos"
                  onClick={() => fileInputRef.current?.click()}
                >+</button>
                <button
                  className={`lk-toolbar-btn--lrm${longRequestMode ? ' lk-toolbar-btn--lrm-on' : ''}`}
                  title={longRequestMode ? 'Long Request Mode ON — click to disable' : 'Enable Long Request Mode (phased execution for complex tasks)'}
                  onClick={() => { setLongRequestMode(v => !v); if (!longRequestMode) setLrmPlan(null) }}
                >⇥ LRM</button>
                {localDirHandle ? (
                  <div className="lk-local-badge lk-local-badge--compact">
                    <span className="lk-local-badge-icon" title={`Attached: ${localDirHandle.name}`}>
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3h3.982a2 2 0 0 1 1.992 2.181l-.637 7A2 2 0 0 1 13.174 14H2.826a2 2 0 0 1-1.991-1.819l-.637-7a2 2 0 0 1 .342-1.31z"/></svg>
                    </span>
                    <span className="lk-local-badge-name" title={localDirHandle.name}>{localDirHandle.name}</span>
                    <button className="lk-local-badge-detach" title="Detach folder" onClick={() => setLocalDirHandle(null)}>✕</button>
                  </div>
                ) : (
                  <button
                    className="lk-toolbar-btn"
                    title="Attach local repo folder"
                    onClick={async () => {
                      try { setLocalDirHandle(await pickDirectory()) }
                      catch (e) { if (e.name !== 'AbortError') setError(`Folder access denied: ${e.message}`) }
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3h3.982a2 2 0 0 1 1.992 2.181l-.637 7A2 2 0 0 1 13.174 14H2.826a2 2 0 0 1-1.991-1.819l-.637-7a2 2 0 0 1 .342-1.31z"/>
                    </svg>
                  </button>
                )}
              </div>

              {/* Right: push, run-tests, model selector, stop */}
              <div className="lk-input-toolbar-right">

                {/* Push button — contextual */}
                {hasGithub && filePlan.some(e => e.code?.trim()) && (() => {
                  const hasDiffs  = filePlan.some(e => e.diffText?.trim())
                  const fileCount = filePlan.filter(e => e.code?.trim()).length
                  const pushLabel = fileCount > 1 ? `${fileCount} files` : 'to GitHub'
                  return (
                    <button className={`lk-btn lk-btn--push${hasDiffs ? ' lk-btn--push-ready' : ''}`} onClick={handlePush}>
                      <span className="lk-btn-icon">⬆</span>Push {pushLabel}
                    </button>
                  )
                })()}

                {/* Run Tests — contextual */}
                {bridgeAvailable && prResult && (
                  <button className="lk-btn lk-btn--run" onClick={handleRunProjectTests} disabled={isRunningPostPushTests}>
                    <span className="lk-btn-icon">⊛</span>
                    {isRunningPostPushTests ? 'Running…' : 'Run Tests'}
                  </button>
                )}

                {/* Model selector — inline in toolbar */}
                <select
                  className="lk-toolbar-model-select"
                  value={activeModelId}
                  onChange={e => { setActiveModelId(e.target.value); onModelChange?.(e.target.value) }}
                  disabled={busy}
                >
                  <option value="">Model…</option>
                  {(models || []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>

                {/* Stop button — always visible, active when busy */}
                <button
                  className="lk-toolbar-btn lk-toolbar-btn--stop"
                  onClick={handleAbort}
                  disabled={!busy && !agentSession.isAgentRunning}
                  title={busy || agentSession.isAgentRunning ? 'Stop generation' : 'Nothing running'}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
                    <rect x="1.5" y="1.5" width="9" height="9" rx="2"/>
                  </svg>
                </button>

                {/* Send button */}
                <button
                  className="lk-toolbar-btn lk-toolbar-btn--send"
                  onClick={handleSubmitPrompt}
                  disabled={busy || agentSession.isAgentRunning || (!prompt.trim() && attachedFiles.length === 0)}
                  title="Send message"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M15.854.146a.5.5 0 0 1 .11.54l-5.819 14.547a.75.75 0 0 1-1.329.124l-3.178-4.995L.643 7.184a.75.75 0 0 1 .124-1.33L15.314.037a.5.5 0 0 1 .54.109z"/>
                  </svg>
                </button>

              </div>
            </div>{/* end lk-input-toolbar */}

          </div>{/* end lk-input-card */}

          </div>{/* end lk-input-inner */}

        </div>{/* end lk-input-bar */}
        </>
        </>
        )}

      </div>{/* end lk-main */}
    </div>
  )
}
