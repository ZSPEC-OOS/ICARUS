import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
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
  LOGIK_MD_CAP,
  STYLE_EXAMPLES_LIMIT,
} from '../config/constants'
import LogikActivityFeed from './logik/LogikActivityFeed'
import LogikCodePane     from './logik/LogikCodePane'
import LogikDiffViewer   from './logik/LogikDiffViewer'
import LogikTerminal     from './logik/LogikTerminal'
import LogikToolsPane    from './logik/LogikToolsPane'
import LogikSettings     from './logik/LogikSettings'
import LogikModularTools from './logik/LogikModularTools'
import logikLogo         from '../../LOGIKlogo.png'
import './Logik.css'

// âââ Persistence ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const SETTINGS_KEY    = 'logik:settings'
const HISTORY_KEY     = 'logik:history'
const GHTOKEN_SS_KEY  = 'logik:ghtoken'
const GHTOKEN2_SS_KEY = 'logik:ghtoken2'

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

// âââ Utilities imported from ../utils/codeUtils and ../utils/diff ââââââââââââ

// âââ Pure system-prompt builder (no hooks â safe to call inside async loops) ââ
function buildFileSystemPrompt(path, existingContent, lang, repoOwner, repoName, forTests = false, logikMd = null, contextFiles = [], styleExamples = []) {
  const repoCtx  = repoOwner && repoName ? `\nRepository: ${repoOwner}/${repoName}.` : ''
  const editMode = existingContent !== null ? 'patch' : 'replace'
  // Suppress framework conventions for standalone file types (html, sh, yaml, etc.)
  const isStandalone = ['html', 'markdown', 'yaml', 'bash', 'json'].includes(lang)

  const conv = !isStandalone && shadowContext.getConventions()
  const convCtx = conv && conv.framework !== 'unknown' ? [
    `\nDETECTED PROJECT CONVENTIONS (follow exactly â do not ask):`,
    `  Framework: ${conv.framework}`,
    `  Language: ${conv.language}`,
    `  Naming: ${conv.namingConvention}`,
    conv.testFramework !== 'unknown' ? `  Tests: ${conv.testFramework}` : '',
    conv.srcDir        ? `  Source root: ${conv.srcDir}/`              : '',
    conv.hooks?.length ? `  Existing hooks: ${conv.hooks.join(', ')}`  : '',
    conv.deps?.length  ? `  Key deps: ${conv.deps.slice(0, 10).join(', ')}` : '',
    conv.pathAliases && Object.keys(conv.pathAliases).length
      ? `  Import aliases: ${Object.entries(conv.pathAliases).map(([k, v]) => `${k}/ â ${v}/`).join(', ')}` : '',
  ].filter(Boolean).join('\n') : ''

  // LOGIK.md standing instructions
  const logikMdCtx = logikMd ? `\nPROJECT INSTRUCTIONS (from LOGIK.md â follow exactly):\n${logikMd.slice(0, LOGIK_MD_CAP)}` : ''

  // Style patterns: short excerpts from existing similar files â model should match this style
  const styleCtx = styleExamples.length > 0
    ? `\nCODE STYLE PATTERNS FROM THIS CODEBASE (study these and match the style precisely):\n` +
      styleExamples.map(s => `--- ${s.path} ---\n${s.excerpt}`).join('\n\n')
    : ''

  // Ambient context: relevant files from the repo
  const contextCtx = contextFiles.length > 0
    ? `\nRELEVANT EXISTING FILES (for reference â match patterns and style):\n` +
      contextFiles.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n')
    : ''

  if (forTests) {
    const tf = conv?.testFramework !== 'unknown' ? conv.testFramework : 'Jest/Vitest for JS/TS, pytest for Python'
    return [`You are LOGIK, an expert test-writing assistant.${repoCtx}`,
      `Generate a complete, production-ready test file for the provided ${lang} code.`,
      `Use ${tf}.`, convCtx, logikMdCtx,
      `Output ONLY the test code â no markdown fences, no explanations.`,
    ].filter(Boolean).join('\n')
  }

  const lines = [
    `You are LOGIK, an expert coding assistant. Generate clean, production-ready ${lang} code.${repoCtx}`,
    `Follow existing codebase conventions. Add comments only where logic is non-obvious.`,
    convCtx,
    logikMdCtx,
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
      `- Include ALL code â never truncate, never write "// rest of implementation", never use TODO stubs`,
      `- If the file is long, output every line in full â do not abbreviate`,
      `- No markdown code fences, no explanations outside the code`,
    )
  }

  if (existingContent) lines.push(`\nEXISTING FILE (${path}):\n${existingContent.slice(0, FILE_CONTENT_CAP_CHARS)}`)
  return lines.join('\n')
}

// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
export default function Logik({ onClose, models, setModels, selectedModelId, onModelChange, onSettingsChanged, onLogout, userEmail }) {
  const saved = loadSettings()

  // ââ Config âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const [activeModelId,  setActiveModelId]  = useState(selectedModelId || '')
  const [repoOwner,      setRepoOwner]      = useState(saved.repoOwner   || '')
  const [repoName,       setRepoName]       = useState(saved.repoName    || '')
  const [baseBranch,     setBaseBranch]     = useState(saved.baseBranch  || 'main')
  const [githubToken,    setGithubToken]    = useState(saved.githubToken || '')
  const [doCreateBranch, setDoCreateBranch] = useState(true)
  const [doCreatePR,     setDoCreatePR]     = useState(true)
  const [dryRun,         setDryRun]         = useState(false)

  // ââ Theme + fine-tune ââââââââââââââââââââââââââââââââââââââââââââââââââ
  const [theme, setTheme] = useState(saved.theme || 'graphite')
  const DEFAULT_FT = { brightness: 100, contrast: 100, saturation: 100, highlight: 50, shadow: 50 }
  const [fineTune, setFineTune] = useState({
    brightness: saved.ftBrightness ?? 100,
    contrast:   saved.ftContrast   ?? 100,
    saturation: saved.ftSaturation ?? 100,
    highlight:  saved.ftHighlight  ?? 50,
    shadow:     saved.ftShadow     ?? 50,
  })
  const DEFAULT_HEADER_LAYOUT = useMemo(() => ({
    headerHeight: 44,
    titleSize: 11,
    logoSize: 18,
    logoOffsetX: 0,
    logoOffsetY: 0,
    titleOffsetX: 0,
    titleOffsetY: 0,
    toggleOffsetX: 0,
    toggleOffsetY: 0,
  }), [])
  const [headerLayout, setHeaderLayout] = useState({
    headerHeight: saved.headerHeight ?? 44,
    titleSize:    saved.titleSize    ?? 11,
    logoSize:     saved.logoSize     ?? 18,
    logoOffsetX:  saved.logoOffsetX  ?? 0,
    logoOffsetY:  saved.logoOffsetY  ?? 0,
    titleOffsetX: saved.titleOffsetX ?? 0,
    titleOffsetY: saved.titleOffsetY ?? 0,
    toggleOffsetX:saved.toggleOffsetX ?? 0,
    toggleOffsetY:saved.toggleOffsetY ?? 0,
  })

  // ââ Input ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const [prompt,           setPrompt]           = useState('')
  const [refinementPrompt, setRefinementPrompt] = useState('')

  // ââ Enhancement toggles ââââââââââââââââââââââââââââââââââââââââââââââââ
  const [generateTests,   setGenerateTests]   = useState(false)
  // creativity 0-100: maps to temperature 0.2â1.0 (0 = precise, 100 = creative)
  const [creativity,      setCreativity]      = useState(saved.creativity ?? 50)
  // enableThinking: Anthropic extended thinking (deeper reasoning, slower)
  const [enableThinking,  setEnableThinking]  = useState(saved.enableThinking ?? false)
  // planMode: agent reads only â no file writes; useful for analysis and review
  const [planMode,        setPlanMode]        = useState(false)
  // planApproval: pending plan awaiting user approve/reject/modify
  const [planApproval,    setPlanApproval]    = useState(null) // null | { task, summary }
  // localDirHandle: File System Access API handle for a locally attached repo folder
  const [localDirHandle,  setLocalDirHandle]  = useState(null)
  // webSearchApiKey: Tavily API key for agent web_search tool
  const [webSearchApiKey, setWebSearchApiKey] = useState(() => loadSearchKey())

  // ââ Multi-file plan ââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Each entry: {path, action, purpose, existingContent, _sha, code, testCode,
  //              patchEdits, diffText, status, error}
  const [filePlan,         setFilePlan]         = useState([])
  const [activeFileIndex,  setActiveFileIndex]  = useState(0)
  const [isPlanning,       setIsPlanning]       = useState(false)
  const planRef            = useRef([])          // sync copy for use inside async loops
  const currentFileRef     = useRef(0)           // which file is streaming

  // ââ Conversation â managed by hook âââââââââââââââââââââââââââââââââââââ
  const { conversation, setConversation, turnCount, setTurnCount, reset: resetConversation } = useConversation()

  // ââ Output âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const [activeTab,  setActiveTab]  = useState('code')
  const [gitStatus,  setGitStatus]  = useState(null)
  const [prResult,   setPrResult]   = useState(null)
  const [workflows,  setWorkflows]  = useState([])
  const [workflowRuns, setWorkflowRuns] = useState([])
  const [isPollingCI, setIsPollingCI] = useState(false)

  // ââ Aliases: expose active file's data to all downstream JSX unchanged ââ
  const activeFile      = filePlan[activeFileIndex] ?? {}
  const filePath        = activeFile.path           ?? ''
  const existingContent = activeFile.existingContent ?? null
  const editMode        = existingContent !== null ? 'patch' : 'replace'
  const generatedCode   = activeFile.code           ?? ''
  const testCode        = activeFile.testCode        ?? ''
  const patchEdits      = activeFile.patchEdits      ?? []
  const diffText        = activeFile.diffText        ?? ''

  // ââ Sandbox ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const [sandboxOutput, setSandboxOutput] = useState([])
  const [sandboxSetup,  setSandboxSetup]  = useState('')
  const [isRunning,     setIsRunning]     = useState(false)
  const [isRunningTests, setIsRunningTests] = useState(false)
  const sandboxRef = useRef(null)

  // ââ Terminal ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const [terminalInput,    setTerminalInput]    = useState('')
  const [terminalLog,      setTerminalLog]      = useState([])   // [{cmd,output,type,timestamp}]
  const [isTerminalRunning,setIsTerminalRunning]= useState(false)

  // ââ Permission mode âââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // 'auto'   â push immediately, no confirm
  // 'ask'    â confirm dialog before any GitHub write
  // 'manual' â user must click a second time (dry-run first, then confirm)
  const [permissionMode, setPermissionMode] = useState(
    () => localStorage.getItem('logik:permMode') || 'ask'
  )

  // ââ Agent mode âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const [isRunningPostPushTests, setIsRunningPostPushTests] = useState(false)
  const [logikMdDraft,    setLogikMdDraft]    = useState('')
  const [isSavingLogikMd, setIsSavingLogikMd] = useState(false)

  // ââ UI state âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const [isGenerating, setIsGenerating] = useState(false)
  const [isGenTests,   setIsGenTests]   = useState(false)
  const [isPushing,    setIsPushing]    = useState(false)
  const [pushStep,     setPushStep]     = useState('')
  const [error,        setError]        = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen,  setHistoryOpen]  = useState(false)
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false)
  const [modulesOpen, setModulesOpen] = useState(false)
  const [sourceOpen,   setSourceOpen]   = useState(false)
  const [history,      setHistory]      = useState(loadHistory)
  // ââ Phase 4: ShadowContext âââââââââââââââââââââââââââââââââââââââââââââ
  const [shadowStatus,  setShadowStatus]  = useState(null)   // null | string

  // ââ Interactive response pipeline ââââââââââââââââââââââââââââââââââââââ
  const [pipelinePhase, setPipelinePhase] = useState('understanding')
  const [pipelineSteps, setPipelineSteps] = useState(() => createPipelineSteps('understanding'))
  const [validationResults, setValidationResults] = useState([])
  const [assistantMessage, setAssistantMessage] = useState(() => createAssistantMessage())

  // ââ Phase 2: IntentAmplifier âââââââââââââââââââââââââââââââââââââââââââ
  const [isAmplifying,       setIsAmplifying]       = useState(false)
  const [amplifierDecisions, setAmplifierDecisions] = useState([])  // string[]

  // ââ Phase 3: AutoRemediation âââââââââââââââââââââââââââââââââââââââââââ
  const [remediationStatus, setRemediationStatus] = useState(null)  // null | string

  // ââ Activity log â managed by hook âââââââââââââââââââââââââââââââââââââ
  const activityFeedRef = useRef(null)
  const { activityLog, activityRef, logActivity, updateActivity, clearActivity } = useActivityLog(activityFeedRef)

  const abortRef = useRef(null)
  const language = detectLanguage(filePath, generatedCode)
  const hasGithub    = !!(githubToken && repoOwner && repoName)

  // ââ Sync model from parent ââââââââââââââââââââââââââââââââââââââââââââââ
  useEffect(() => {
    if (selectedModelId && !activeModelId) setActiveModelId(selectedModelId)
  }, [selectedModelId, activeModelId])

  // ââ Stable ref for the cloud-sync callback ââââââââââââââââââââââââââââ
  // Using a ref means the effect below doesn't re-run just because App.jsx
  // re-created the callback (e.g. after a model-key update).
  const onSettingsChangedRef = useRef(onSettingsChanged)
  useEffect(() => { onSettingsChangedRef.current = onSettingsChanged }, [onSettingsChanged])

  // ââ Persist settings âââââââââââââââââââââââââââââââââââââââââââââââââââ
  // fineTune is decomposed into primitives so React can compare by value,
  // not by object reference (which would fire this effect on every render).
  const { brightness, contrast, saturation, highlight, shadow } = fineTune
  const {
    headerHeight, titleSize, logoSize,
    logoOffsetX, logoOffsetY, titleOffsetX, titleOffsetY,
    toggleOffsetX, toggleOffsetY,
  } = headerLayout
  useEffect(() => {
    const s = {
      repoOwner, repoName, baseBranch, githubToken,
      theme,
      ftBrightness: brightness, ftContrast: contrast,
      ftSaturation: saturation, ftHighlight: highlight,
      ftShadow: shadow,
      headerHeight, titleSize, logoSize,
      logoOffsetX, logoOffsetY, titleOffsetX, titleOffsetY,
      toggleOffsetX, toggleOffsetY,
      creativity, enableThinking,
      webSearchApiKey,
      permissionMode,
    }
    saveSettings(s)
    // Notify App.jsx so it can debounce-save to Firestore (cloud persistence)
    onSettingsChangedRef.current?.(s)
  }, [repoOwner, repoName, baseBranch, githubToken,
      theme, brightness, contrast, saturation, highlight, shadow,
      headerHeight, titleSize, logoSize,
      logoOffsetX, logoOffsetY, titleOffsetX, titleOffsetY,
      toggleOffsetX, toggleOffsetY,
      creativity, enableThinking, webSearchApiKey, permissionMode])

  // ââ Phase 4: start ShadowContext indexing when credentials are ready ââââ
  useEffect(() => {
    if (!hasGithub) return
    shadowContext.startIndexing(githubToken, repoOwner, repoName, baseBranch, () => {
      setShadowStatus(shadowContext.statusSummary())
    })
  }, [hasGithub, githubToken, repoOwner, repoName, baseBranch])



  // ââ State watchdog â detects and resets stuck busy flags âââââââââââââââ
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
          logActivity('warn', 'â  Watchdog: generation timed out after 5 min â state reset')
        }
      }, 5 * 60 * 1000)
      return () => clearTimeout(id)
    } else {
      generationStartRef.current = null
    }
  }, [isGenerating]) // eslint-disable-line react-hooks/exhaustive-deps

  // ââ Exec bridge â managed by hook ââââââââââââââââââââââââââââââââââââââ
  const { bridgeAvailable, callExecBridge, callExecBridgeStream } = useExecBridge()

  // ââ Agent session â managed by hook ââââââââââââââââââââââââââââââââââââ
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
  })

  // ââ Cost estimate (memoized) âââââââââââââââââââââââââââââââââââââââââââ
  const costEstimate = useMemo(() => {
    const text = prompt.trim()
    if (!text) return null
    const model = models?.find(m => m.id === activeModelId)
    return estimateCost(text, model?.modelId)
  }, [prompt, activeModelId, models])

  // ââ Plan entry updater (syncs planRef + React state together) âââââââââââââ
  const updatePlanEntry = useCallback((index, updates) => {
    planRef.current = planRef.current.map((e, i) => i === index ? { ...e, ...updates } : e)
    setFilePlan([...planRef.current])
  }, [])

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Phase 3: AutoRemediation helpers
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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
  // filePath and purpose are optional â used to give the AI richer context for fixes.
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
      setRemediationStatus(`Auto-remediating (${attempt}/${MAX_ATTEMPTS})â¦`)

      let errorHint = null

      if (isJS && hasEslint) {
        // Pipe code directly to eslint via stdin â catches real parse + lint errors
        const ext = lang === 'typescript' ? 'ts' : 'js'
        const lint = await callExecBridge(
          `npx eslint --stdin --stdin-filename=logik-check.${ext} --format=compact --rule '{"no-undef":"error","no-unused-vars":"warn"}'`,
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
          else break  // both lint + tsc pass â done
        } else {
          break  // eslint passes, no tsc needed
        }
      } else if (hasSandbox) {
        errorHint = await runSandboxTest(current, lang)
        if (!errorHint) break  // passes sandbox â done
      } else {
        // Non-sandbox: run checklist pass; stop if code didn't change on 2nd attempt
        errorHint = checklist || 'syntax review requested'
      }

      const fileCtx  = filePath ? ` in ${filePath}` : ''
      const purposeCtx = purpose ? ` Purpose: ${purpose}.` : ''
      const fixCtx = [
        { role: 'user',      content: `You are a code repair assistant.${purposeCtx} Fix all syntax errors, undefined references, type errors, and obvious runtime bugs. Output ONLY the corrected ${lang} code â no fences, no explanations.` },
        { role: 'assistant', content: 'Corrected code:' },
      ]
      const fixMsg = hasSandbox
        ? `Fix this ${lang} code${fileCtx}. The following error was detected at runtime:\n\n${errorHint}\n\nRead the error carefully â trace it to its root cause before fixing. Output ONLY the corrected code:\n\n${current}`
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

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Core generation â Plan â Hydrate â Loop across files
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

    if (!isRefinement) {
      setGitStatus(null); setPrResult(null); setSandboxOutput([])
      // Fresh activity log for each new generation run
      clearActivity()
      setActiveTab('code')
    }

    const ctrl = new AbortController()
    abortRef.current = ctrl

    // Build an effective model config that carries the current creativity/thinking settings.
    // temperature = 0.2 + (creativity/100) * 0.8  â  creativity 0 = 0.2, 50 = 0.6, 100 = 1.0
    const effectiveModel = {
      ...model,
      temperature: parseFloat((0.2 + (creativity / 100) * 0.8).toFixed(2)),
      // enableThinking works for Anthropic (interleaved thinking) and Kimi K2.5 (enable_thinking)
      ...(enableThinking ? { enableThinking: true } : {}),
    }

    try {
      // ââ Phase 2: IntentAmplifier âââââââââââââââââââââââââââââââââââââââââ
      let effectiveMsg = requestText
      if (!isRefinement && isVaguePrompt(requestText)) {
        setIsAmplifying(true)
        const ampId = logActivity('amplify', 'â Analyzing intentâ¦')
        const conv = shadowContext.getConventions()
        // Pass last 6 messages (3 turn pairs) for pronoun/reference resolution
        const { enrichedPrompt, decisions } = await amplifyPrompt(
          requestText, conv, effectiveModel, ctrl.signal, conversation.slice(-6)
        )
        setIsAmplifying(false)
        if (enrichedPrompt !== requestText) {
          effectiveMsg = enrichedPrompt
          setAmplifierDecisions(decisions)
          updateActivity(ampId, { status: 'done', msg: `â Intent clarified â ${decisions.length} assumption${decisions.length !== 1 ? 's' : ''} made` })
        } else {
          updateActivity(ampId, { status: 'done', msg: 'â Intent clear â proceeding as-is' })
        }
      }

      if (isRefinement) {
        // ââ Refinement: regenerate only the active file ââââââââââââââââââ
        const entry  = planRef.current[activeFileIndex] ?? {}
        const lang   = detectLanguage(entry.path, entry.code || '')
        const mode   = entry.existingContent !== null ? 'patch' : 'replace'
        const refStyleExamples = shadowContext.getStyleExamples(effectiveMsg, STYLE_EXAMPLES_LIMIT)
        const sys    = buildFileSystemPrompt(entry.path, entry.existingContent, lang, repoOwner, repoName, false, shadowContext.getLogikMd(), [], refStyleExamples)
        const refMsg = `Current code:\n${entry.code || ''}\n\nChange request: ${effectiveMsg}`
        const ctx    = [
          { role: 'user', content: sys },
          { role: 'assistant', content: 'Understood. I will output only the code.' },
          ...conversation,
        ]
        emitStreamEvent(createStreamEvent('status', { phase: 'refining' }))
        const refId = logActivity('generate', `âº Refining ${entry.path || 'file'}â¦`)
        let streaming = ''
        let prevStreaming = ''
        const raw = await runPromptWithRetry(effectiveModel, refMsg, ctx, (partial) => {
          streaming = mode === 'patch' && entry.existingContent ? partial : extractCode(partial)
          updatePlanEntry(activeFileIndex, { code: streaming })
          const chunk = streaming.startsWith(prevStreaming) ? streaming.slice(prevStreaming.length) : streaming
          prevStreaming = streaming
          emitStreamEvent(createStreamEvent('code', { chunk }))
          updateActivity(refId, { detail: `${streaming.split('\n').length} linesâ¦` })
        }, ctrl.signal)
        let finalCode = extractCode(raw)
        if (mode === 'patch' && entry.existingContent) {
          const { result, edits } = applyEditBlocks(entry.existingContent, raw)
          if (edits.length > 0) finalCode = result
        }
        updatePlanEntry(activeFileIndex, { code: finalCode, status: 'done' })
        emitStreamEvent(createStreamEvent('status', { phase: 'validating' }))
        updateActivity(refId, { status: 'done', msg: `âº Refined ${entry.path || 'file'}`, detail: `${finalCode.split('\n').length} lines` })
        const refValidation = ['â Refinement applied to active file.', 'â Output is ready for review.']
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
        setConversation(prev => [...prev, { role: 'user', content: effectiveMsg }, { role: 'assistant', content: refOut }])
        setTurnCount(t => t + 1)
        setRefinementPrompt('')
        setActiveTab('code')

      } else {
        // ââ First-shot: plan â hydrate â generate each file ââââââââââââââ

        // Phase 4/Planner: determine which files to touch.
        // Pass files from the current plan (prior run) so the planner knows what was
        // recently generated and can build on or avoid redundancy.
        const recentFiles = filePlan.filter(e => e.status === 'done').map(e => e.path)
        emitStreamEvent(createStreamEvent('status', { phase: 'planning' }))
        const planId = logActivity('plan', 'â Building file planâ¦')
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
          msg: `â Plan â ${rawPlan.length} file${rawPlan.length !== 1 ? 's' : ''}`,
          detail: rawPlan.map(e => e.path.split('/').pop()).join(' Â· '),
        })

        // Order plan entries based on imports (if available) so dependencies are generated first
        const orderedRawPlan = orderFilePlan(rawPlan)
        emitStreamEvent(createStreamEvent('plan', {
          steps: orderedRawPlan.map((e) => `${e.action === 'modify' ? 'Update' : 'Create'} ${e.path} â ${e.purpose}`),
        }))
        if (command === '/plan') {
          const planOnlyValidation = ['â Plan generated.', 'â No code emitted in /plan mode.']
          setValidationResults(planOnlyValidation)
          const planOnlyText = formatStructuredOutput({
            summary: `Created an execution plan for: ${requestText}`,
            plan: orderedRawPlan.map((e) => `${e.action === 'modify' ? 'Update' : 'Create'} ${e.path} â ${e.purpose}`),
            code: '',
            changes: orderedRawPlan.map((e) => `${e.action === 'modify' ? 'Will update' : 'Will add'} ${e.path}`),
            validation: planOnlyValidation,
            notes: ['Run /code to execute this plan.'],
          })
          setConversation(prev => [...prev, { role: 'user', content: requestText }, { role: 'assistant', content: planOnlyText }])
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
            const fetchId = logActivity('fetch', `â¬ Reading ${ep.path}`)
            try {
              const file = await getFileContent(githubToken, repoOwner, repoName, ep.path, baseBranch)
              if (file?.content) {
                const content = decodeBase64(file.content)
                updatePlanEntry(i, { existingContent: content, _sha: file.sha, status: 'pending' })
                updateActivity(fetchId, { status: 'done', msg: `â¬ ${ep.path}`, detail: `${content.split('\n').length} lines` })
              } else {
                updatePlanEntry(i, { status: 'pending' })
                updateActivity(fetchId, { status: 'skip', msg: `â¬ ${ep.path} â not found, will create` })
              }
            } catch {
              updatePlanEntry(i, { status: 'pending' })
              updateActivity(fetchId, { status: 'skip', msg: `â¬ ${ep.path} â fetch failed, will create` })
            }
          }
        }

        // Gather ambient context + LOGIK.md + style examples once before generation loop
        const logikMd = shadowContext.getLogikMd()
        let ambientFiles = []
        try {
          ambientFiles = await shadowContext.getContextContent(effectiveMsg, CONTEXT_FILES_LIMIT)
        } catch (ctxErr) {
          logActivity('warn', `â  Context index unavailable â generating without repo context (${ctxErr.message})`)
        }
        // Style examples: short excerpts from similar files that set the style baseline
        let styleExamples = []
        try {
          styleExamples = shadowContext.getStyleExamples(effectiveMsg, STYLE_EXAMPLES_LIMIT)
        } catch { /* non-fatal â proceed without style injection */ }

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
          const sys      = buildFileSystemPrompt(entry.path, entry.existingContent, lang, repoOwner, repoName, false, logikMd, contextFiles, fileStyleExamples)
          const fileTask = `${effectiveMsg}\n\nFor this file: ${entry.path} â ${entry.purpose}`

          updatePlanEntry(i, { status: 'generating' })
          const genId = logActivity('generate', `â¶ Generating ${entry.path}`, `${mode} mode`)

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
              updateActivity(genId, { detail: `${streaming.split('\n').length} linesâ¦` })
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

            // ââ Completeness check + continuation loop âââââââââââââââââââââ
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
                updateActivity(genId, { detail: `continuingâ¦ (${lineCount} lines so far, attempt ${cont + 1}/3)` })
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
                  updateActivity(genId, { detail: `continuation failed (${contErr.message}) â using partial output` })
                  break
                }
              }
            }

            updateActivity(genId, { status: 'done', msg: `â¶ ${entry.path}`, detail: `${finalCode.split('\n').length} lines` })

            // AutoRemediation
            emitStreamEvent(createStreamEvent('status', { phase: 'refining' }))
            updatePlanEntry(i, { status: 'remediating', code: finalCode })
            const remId = logActivity('remediate', `â Testing ${entry.path}`)
            finalCode = await autoRemediate(finalCode, lang, effectiveModel, ctrl.signal, entry.path, entry.purpose)
            updateActivity(remId, { status: 'done', msg: `â ${entry.path} â clean` })

            // Test generation
            let builtTestCode = ''
            if (generateTests) {
              setIsGenTests(true)
              const testId = logActivity('test', `â Writing tests for ${entry.path}`)
              try {
                const testSys = buildFileSystemPrompt(entry.path, null, lang, repoOwner, repoName, true)
                const testRaw = await runPromptWithRetry(effectiveModel,
                  `Write tests for:\n${finalCode}`,
                  [{ role: 'user', content: testSys }, { role: 'assistant', content: 'Understood. Test code only.' }],
                  null, ctrl.signal)
                builtTestCode = extractCode(testRaw)
                updateActivity(testId, { status: 'done', msg: `â Tests â ${testFilePath(entry.path)}`, detail: `${builtTestCode.split('\n').length} lines` })
              } catch (e) {
                if (e.name !== 'AbortError') {
                  console.warn('Test gen failed:', e.message)
                  updateActivity(testId, { status: 'error', msg: `â Test gen failed: ${e.message}` })
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
              updateActivity(genId, { status: 'error', msg: `â ${entry.path} â ${err.message}` })
            }
            // Guarantee isGenTests is cleared even if error occurs before test finally block
            setIsGenTests(false)
          }
        }

        // Save to history + summary entry
        if (!ctrl.signal.aborted && planRef.current.length > 0) {
          emitStreamEvent(createStreamEvent('status', { phase: 'validating' }))
          const doneCount = planRef.current.filter(e => e.status === 'done').length
          logActivity('done', `â Complete â ${doneCount}/${planRef.current.length} file${planRef.current.length !== 1 ? 's' : ''} generated`)
          // Auto-switch to Diff tab when diffs are available (surface review naturally)
          const hasDiffs = planRef.current.some(e => e.diffText?.trim())
          setActiveTab(hasDiffs ? 'diff' : 'code')
          const he = { id: Date.now().toString(), prompt: requestText.slice(0, 100), filePath: planRef.current[0]?.path || '', timestamp: new Date().toISOString() }

          const planSteps = planRef.current.map((e) => `${e.action === 'modify' ? 'Update' : 'Create'} ${e.path} â ${e.purpose}`)
          const primary = planRef.current[0] || {}
          const combinedDiff = planRef.current.map((e) => e.diffText?.trim()).filter(Boolean).join('\n\n')
          const validation = [
            `â Generated ${doneCount}/${planRef.current.length} planned file(s).`,
            planRef.current.some((e) => e.status === 'error') ? 'â  Some files failed and may need retry.' : 'â No file-level generation errors.',
            generateTests ? 'â Test generation attempted for completed files.' : 'â  Test generation disabled.',
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
          setConversation(prev => [...prev, { role: 'user', content: requestText }, { role: 'assistant', content: assistantText }])
          setTurnCount(t => t + 1)
          const updated = [he, ...history]
          setHistory(updated)
          saveHistory(updated)
        }
      }

    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(`Generation failed: ${err.message}`)
        logActivity('error', `â ${err.message}`)
      }
    } finally {
      setIsGenerating(false)
      setIsPlanning(false)
      setIsAmplifying(false)
      setIsGenTests(false)   // safety net â ensures it can never stay stuck
      emitStreamEvent(createStreamEvent('status', { phase: 'complete' }))
      setPrompt('')
    }
  }, [
    prompt, models, activeModelId, conversation, filePlan,
    generateTests, creativity, enableThinking,
    repoOwner, repoName, baseBranch, githubToken, hasGithub,
    history, activeFileIndex, autoRemediate, updatePlanEntry, logActivity, updateActivity, setActivePhase, resetConversation, emitStreamEvent,
  ])

  // ââ Refinement shortcut âââââââââââââââââââââââââââââââââââââââââââââââââ
  const handleRefine = useCallback(() => {
    if (refinementPrompt.trim() && !isGenerating) handleGenerate(refinementPrompt, true)
  }, [refinementPrompt, isGenerating, handleGenerate])

  // ââ Per-file retry â re-generates a single failed file without re-running the full plan
  const handleRetryFile = useCallback(async (fileIndex) => {
    if (isGenerating) return
    const entry = planRef.current[fileIndex]
    if (!entry) return
    const model = models?.find(m => m.id === activeModelId)
    if (!model?.apiKey) { setError('Select a model with an API key.'); return }

    setIsGenerating(true)
    updatePlanEntry(fileIndex, { status: 'generating', error: undefined })
    const retryId = logActivity('generate', `âº Retrying ${entry.path}`)
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const lang     = detectLanguage(entry.path, '')
      const logikMd  = shadowContext.getLogikMd()
      // Fetch ambient context so the retry has the same repo awareness as first-shot generation
      let retryContextFiles = []
      try {
        retryContextFiles = await shadowContext.getContextContent(
          `${prompt || entry.purpose || entry.path} ${entry.path}`, CONTEXT_FILES_LIMIT
        )
        retryContextFiles = retryContextFiles.filter(f => f.path !== entry.path)
      } catch {}
      const sys      = buildFileSystemPrompt(entry.path, entry.existingContent, lang, repoOwner, repoName, false, logikMd, retryContextFiles)
      const fileTask = `${prompt || 'Regenerate this file.'}\n\nFor this file: ${entry.path} â ${entry.purpose}`
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
      updateActivity(retryId, { status: 'done', msg: `âº ${entry.path} â retry succeeded`, detail: `${finalCode.split('\n').length} lines` })
    } catch (err) {
      if (err.name !== 'AbortError') {
        updatePlanEntry(fileIndex, { status: 'error', error: err.message })
        updateActivity(retryId, { status: 'error', msg: `âº ${entry.path} â retry failed: ${err.message}` })
        setError(`Retry failed: ${err.message}`)
      }
    } finally {
      setIsGenerating(false)
    }
  }, [isGenerating, models, activeModelId, repoOwner, repoName, prompt, autoRemediate, updatePlanEntry, logActivity]) // eslint-disable-line react-hooks/exhaustive-deps

  // ââ LOGIK.md save âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const handleSaveLogikMd = useCallback(async () => {
    if (!hasGithub) { setError('GitHub required to save LOGIK.md.'); return }
    setIsSavingLogikMd(true)
    try {
      const existing = await import('../services/githubService').then(m =>
        m.getFileContent(githubToken, repoOwner, repoName, 'LOGIK.md', baseBranch)
      )
      const sha = existing?.sha || null
      await import('../services/githubService').then(m =>
        m.createOrUpdateFile(githubToken, repoOwner, repoName, 'LOGIK.md', logikMdDraft, 'docs: update LOGIK.md project instructions', baseBranch, sha)
      )
      shadowContext.logikMd = logikMdDraft
      logActivity('done', 'â LOGIK.md saved to repo')
    } catch (e) {
      setError(`Failed to save LOGIK.md: ${e.message}`)
    } finally {
      setIsSavingLogikMd(false)
    }
  }, [hasGithub, githubToken, repoOwner, repoName, baseBranch, logikMdDraft, logActivity])

  // ââ Post-push test runner âââââââââââââââââââââââââââââââââââââââââââââââ
  // Runs npm test / pytest in streaming mode after a successful push.
  const handleRunProjectTests = useCallback(async () => {
    if (!bridgeAvailable) return
    setIsRunningPostPushTests(true)
    const testCmd = 'npm test -- --watchAll=false --passWithNoTests'
    logActivity('test', `â Running project testsâ¦`)
    let out = ''
    await callExecBridgeStream(testCmd, undefined, (chunk) => {
      out += chunk
    }, 120000)
    setIsRunningPostPushTests(false)
    const passed = out.includes('Tests:') && !out.includes('failed')
    logActivity('test', passed ? 'â Tests passed' : 'â Tests failed â see output', out.slice(-300))
    setActiveTab('code')
  }, [bridgeAvailable, callExecBridgeStream, logActivity])

  // ââ Reset conversation ââââââââââââââââââââââââââââââââââââââââââââââââââ
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
    setActiveTab('code')
  }, [resetConversation, clearActivity])

  // ââ Abort âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const handleAbort = () => {
    abortRef.current?.abort()
    agentSession.abort()
    setIsGenerating(false)
    setIsGenTests(false)
    setIsPushing(false)
    setPushStep('')
  }

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Reindex shadow context (clears cache and re-crawls the repo)
  const handleReindex = useCallback(async () => {
    if (!hasGithub) return
    setShadowStatus('reindexingâ¦')
    try {
      await shadowContext.reindex()
      setShadowStatus(shadowContext.statusSummary())
    } catch {
      setShadowStatus('reindex failed')
    }
  }, [hasGithub])

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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
    const id = logActivity('ci', `â Triggering workflow ${wf.name || wf.path}`)

    try {
      const dispatch = await dispatchWorkflow(githubToken, repoOwner, repoName, wf.id, baseBranch)
      if (!dispatch) {
        updateActivity(id, { status: 'error', msg: `â Failed to trigger workflow ${wf.name || wf.path}` })
        return
      }
      updateActivity(id, { status: 'done', msg: `â Workflow triggered: ${wf.name || wf.path}` })

      // Poll for a new run to appear
      for (let i = 0; i < 18; i++) {
        await new Promise(r => setTimeout(r, 5000))
        const runs = await getWorkflowRuns(githubToken, repoOwner, repoName, baseBranch, 5, wf.id)
        const run = runs?.workflow_runs?.find(r => r.workflow_id === wf.id)
        if (run && (run.status !== 'queued' && run.status !== 'in_progress')) {
          setWorkflowRuns([run])
          updateActivity(id, { status: run.conclusion === 'success' ? 'done' : 'error', msg: `â Workflow ${run.name} ${run.conclusion || run.status}`, detail: run.html_url })
          break
        }
      }
    } catch (e) {
      updateActivity(id, { status: 'error', msg: `â Workflow trigger failed: ${e.message}` })
    } finally {
      setIsPollingCI(false)
    }
  }, [hasGithub, workflows, githubToken, repoOwner, repoName, baseBranch, logActivity, updateActivity])

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // ENHANCEMENT 7 â JS sandbox execution
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const handleRunInSandbox = useCallback(() => {
    if (!generatedCode) return
    const isPython = language === 'python'
    setIsRunning(true)
    setSandboxOutput([{ level: 'info', text: isPython ? 'â¶ Loading Python runtime (Pyodide)â¦' : 'â¶ Running in isolated sandboxâ¦' }])

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
    // Fallback timeout â iframe should always postMessage, but just in case
    const guard = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      setIsRunning(false)
    }, guardMs)
    iframe._guard = guard
    iframe.srcdoc = isPython ? buildPyodideSandboxHtml(generatedCode) : buildSandboxHtml(generatedCode, sandboxSetup)
  }, [generatedCode, sandboxSetup, language])

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // ENHANCEMENT â Run tests in sandbox
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const handleRunTests = useCallback(() => {
    if (!testCode) return
    const isPython = language === 'python'
    setIsRunningTests(true)
    setSandboxOutput([{ level: 'info', text: isPython ? 'â¶ Loading Python runtime (Pyodide)â¦' : 'â¶ Running tests in isolated sandboxâ¦' }])

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
    // Fallback timeout â iframe should always postMessage, but just in case
    const guard = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      setIsRunningTests(false)
    }, guardMs)
    iframe._guard = guard
    iframe.srcdoc = isPython ? buildPyodideSandboxHtml(testCode) : buildSandboxHtml(testCode, sandboxSetup)
  }, [testCode, sandboxSetup, language])

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Terminal: real JS/Python execution in the sandbox; honest msgs for shell cmds
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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
        '  JS/TS expressions  â executed in real browser sandbox\n' +
        '  python: <code>     â executed via Pyodide (real)\n' +
        '  clear              â clear terminal\n' +
        '  help               â this message\n' +
        '  npm / git / shell  â requires backend (shown as info)',
        'info'
      )
      return
    }

    // python: <snippet> â run in Pyodide sandbox
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

    // Looks like a JS expression or statement â run in JS sandbox
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
    if (/^python3?( --version|-V)?$/.test(trimmed)) { pushEntry('Python 3.12 (Pyodide) â use: python: print("hello")', 'info'); return }

    // ââ Bridge path: streaming real shell commands âââââââââââââââââââââââââ
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

    // ââ Fallback: bridge not available (production / no Vite dev server) ââ
    const shellCmds = ['npm', 'yarn', 'pnpm', 'git', 'npx', 'tsc', 'eslint', 'jest', 'vitest', 'cargo', 'go', 'pip']
    const base = trimmed.split(/\s+/)[0]
    if (shellCmds.includes(base)) {
      pushEntry(
        `â¹ "${trimmed}" requires the exec bridge (run via \`npm run dev\`).\n` +
        `Bridge not detected â start the Vite dev server to enable real shell execution.\n` +
        `Tip: JS/TS runs in the sandbox without a bridge â try: console.log(42)`,
        'info'
      )
      return
    }

    pushEntry(`command not found: ${base}\nType "help" for available commands.`, 'error')
  }, [sandboxRef, bridgeAvailable, callExecBridge, callExecBridgeStream])

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Permission gate â respects permissionMode before any GitHub write
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const confirmAction = useCallback((description) => {
    if (permissionMode === 'auto') return true
    if (permissionMode === 'ask') return window.confirm(`LOGIK permission request\n\n${description}\n\nProceed?`)
    // 'manual': same as 'ask' but with extra context
    return window.confirm(`LOGIK â manual mode\n\n${description}\n\nThis action writes to GitHub. Confirm to continue.`)
  }, [permissionMode])

  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Push: commit all generated files to GitHub, optionally create branch + PR
  // âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const handlePush = async () => {
    const filesToPush = filePlan.filter(e => e.code?.trim())
    if (filesToPush.length === 0) { setError('Generate code first.'); return }
    if (!githubToken)             { setError('GitHub token required â open Settings.'); setSettingsOpen(true); return }
    if (!repoOwner || !repoName)  { setError('Repo owner and name required â open Settings.'); setSettingsOpen(true); return }

    const promptSummary = (history[0]?.prompt || prompt || 'LOGIK generated code').slice(0, 80)

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

    logActivity('push', `â¬ Pushing ${filesToPush.length} file${filesToPush.length !== 1 ? 's' : ''} to GitHub`)

    try {
      setPushStep('Verifying repositoryâ¦')
      const repoId = logActivity('push', `â¬ Verifying ${repoOwner}/${repoName}`)
      const repo = await getRepo(githubToken, repoOwner, repoName)
      log(`â ${repoOwner}/${repoName} â ${repo.private ? 'private' : 'public'}`)
      updateActivity(repoId, { status: 'done', msg: `â¬ ${repoOwner}/${repoName} â ${repo.private ? 'private' : 'public'}` })

      setPushStep(`Fetching branch "${baseBranch}"â¦`)
      const branchId = logActivity('push', `â¬ Resolving branch "${baseBranch}"`)
      const branchData = await getBranch(githubToken, repoOwner, repoName, baseBranch)
      const baseSha    = branchData.commit.sha
      log(`â Base "${baseBranch}" â ${baseSha.slice(0, 7)}`)
      updateActivity(branchId, { status: 'done', msg: `â¬ "${baseBranch}" @ ${baseSha.slice(0, 7)}` })

      let targetBranch = baseBranch
      if (doCreateBranch) {
        targetBranch = generateBranchName(promptSummary)
        setPushStep(`Creating branch "${targetBranch}"â¦`)
        const newBrId = logActivity('push', `â¬ Creating branch "${targetBranch}"`)
        if (!dryRun) await createBranch(githubToken, repoOwner, repoName, targetBranch, baseSha)
        log(`${dryRun ? 'â' : 'â'} Branch "${targetBranch}"${dryRun ? ' (dry run)' : ''}`)
        updateActivity(newBrId, { status: 'done', msg: `â¬ Branch "${targetBranch}" ready${dryRun ? ' (dry run)' : ''}` })
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
        setPushStep(`Pushing "${entry.path}"â¦`)
        const fileId = logActivity('push', `â¬ ${entry.path}`)
        const existing    = await getFileContent(githubToken, repoOwner, repoName, entry.path, targetBranch)
        const existingSha = existing?.sha || entry._sha || null
        const action      = existingSha ? 'update' : 'add'
        const commitMsg   = `feat(logik): ${action} ${entry.path}\n\nGenerated by LOGIK: "${promptSummary}"`
        if (!dryRun) await pushWithRetry(entry.path, entry.code, commitMsg, targetBranch, existingSha)
        log(`${dryRun ? 'â' : 'â'} ${dryRun ? '[dry run] ' : ''}${action === 'update' ? 'Updated' : 'Created'} ${entry.path}`)
        updateActivity(fileId, { status: 'done', msg: `â¬ ${action === 'update' ? 'Updated' : 'Created'} ${entry.path}${dryRun ? ' (dry run)' : ''}` })

        // Co-commit test file if present
        if (entry.testCode) {
          const tp = testFilePath(entry.path)
          setPushStep(`Pushing tests "${tp}"â¦`)
          const testPushId = logActivity('push', `â¬ ${tp}`)
          const existingTest = await getFileContent(githubToken, repoOwner, repoName, tp, targetBranch)
          if (!dryRun) await pushWithRetry(tp, entry.testCode, `test(logik): add tests for ${entry.path}`, targetBranch, existingTest?.sha || null)
          log(`${dryRun ? 'â' : 'â'} ${dryRun ? '[dry run] ' : ''}Tests: ${tp}`)
          updateActivity(testPushId, { status: 'done', msg: `â¬ Tests: ${tp}${dryRun ? ' (dry run)' : ''}` })
        }
      }

      let prUrl = null
      if (doCreateBranch && doCreatePR) {
        setPushStep('Creating pull requestâ¦')
        const prId = logActivity('push', 'â¬ Creating pull requestâ¦')
        const fileList = filesToPush.map(e => `- \`${e.path}\`${e.purpose ? ` â ${e.purpose}` : ''}`).join('\n')
        const prBody = [
          `## LOGIK AI Generated Code`,
          ``,
          `**Prompt:** ${promptSummary}`,
          `**Model:** ${modelName}`,
          `**Files changed (${filesToPush.length}):**`,
          fileList,
          turnCount > 1 ? `**Refinement turns:** ${turnCount}` : '',
          ``,
          `---`,
          `*Generated by LOGIK â WolfKrow AI Coding Assistant*`,
        ].filter(Boolean).join('\n')

        let pr = null
        if (!dryRun) pr = await createPullRequest(githubToken, repoOwner, repoName, `LOGIK: ${promptSummary}`, targetBranch, baseBranch, prBody)
        prUrl = pr?.html_url || `https://github.com/${repoOwner}/${repoName}/compare/${targetBranch}`
        setPrResult({ url: prUrl, number: pr?.number })
        log(`${dryRun ? 'â' : 'â'} PR ${dryRun ? 'preview' : 'created'}: ${prUrl}`)
        updateActivity(prId, { status: 'done', msg: `â¬ PR${pr?.number ? ` #${pr.number}` : ''} ${dryRun ? 'preview' : 'created'}`, detail: prUrl })
      }

      log('ââ Complete ââ')
      logActivity('done', `â Push complete â ${filesToPush.length} file${filesToPush.length !== 1 ? 's' : ''}`)

      // ââ CI monitoring: poll GitHub Actions after push ââââââââââââââââââ
      if (!dryRun && hasGithub) {
        const ciId = logActivity('ci', 'â Waiting for CIâ¦')
        // Short delay to let GitHub register the push
        await new Promise(r => setTimeout(r, 4000))
        try {
          const runsData = await getWorkflowRuns(githubToken, repoOwner, repoName, targetBranch, 1)
          const run = runsData?.workflow_runs?.[0]
          if (run) {
            updateActivity(ciId, { msg: `â CI: ${run.name} â ${run.status}` })
            // Poll until completed (max 30 Ã 10s = 5 min)
            let pollRun = run
            for (let p = 0; p < 30 && pollRun.status !== 'completed'; p++) {
              await new Promise(r => setTimeout(r, 10000))
              const refreshed = await getWorkflowRun(githubToken, repoOwner, repoName, pollRun.id)
              if (refreshed) pollRun = refreshed
              updateActivity(ciId, { msg: `â CI: ${pollRun.name} â ${pollRun.status}` })
            }
            const ciOk = pollRun.conclusion === 'success'
            updateActivity(ciId, {
              status: ciOk ? 'done' : 'error',
              msg: `â CI: ${pollRun.name} â ${pollRun.conclusion || pollRun.status}`,
              detail: pollRun.html_url,
            })
          } else {
            updateActivity(ciId, { status: 'skip', msg: 'â CI: no workflow runs found' })
          }
        } catch {
          updateActivity(ciId, { status: 'skip', msg: 'â CI: monitoring unavailable' })
        }
      }
    } catch (err) {
      log(`â ${err.message}`, false)
      logActivity('error', `â Push failed: ${err.message}`)
      setError(`Push failed: ${err.message}`)
    } finally {
      setIsPushing(false)
      setPushStep('')
    }
  }

  const handleKeyDown = e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!isGenerating && !isPushing && !agentSession.isAgentRunning) {
        if (generatedCode && refinementPrompt.trim()) handleRefine()
        else if (hasGithub) agentSession.run(prompt, conversation.slice(-10))
        else handleGenerate()
      }
    }
  }

  const busy = isGenerating || isPushing

  // ââ Tab config ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const effectiveActiveTab = 'code'

  // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // ââ Fine-tune filter string ââââââââââââââââââââââââââââââââââââââââââââ
  const ft = fineTune
  const ftFilter = [
    `brightness(${(ft.brightness / 100) * (0.85 + (ft.highlight / 100) * 0.30)})`,
    `contrast(${(ft.contrast / 100) * (0.85 + (ft.shadow / 100) * 0.30)})`,
    `saturate(${ft.saturation / 100})`,
  ].join(' ')

  return (
    <div
      className={`lk-root${theme !== 'graphite' ? ` lk-theme-${theme}` : ''}`}
      style={{ filter: ftFilter }}
      onKeyDown={handleKeyDown}
    >
      {/* ââ Invisible sandbox iframe ââââââââââââââââââââââââââââââââââââââââ */}
      <iframe ref={sandboxRef} className="lk-sandbox-iframe" sandbox="allow-scripts allow-same-origin" title="LOGIK sandbox" aria-hidden="true" />

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
          LEFT SIDEBAR â icon column (like Claude Code's narrow left rail)
          ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      <nav className="lk-sidebar">
        <button className="lk-sidebar-btn lk-sidebar-btn--back" onClick={onClose} title="Back">â</button>
        <div className="lk-sidebar-sep" />
        <button className={`lk-sidebar-btn${historyOpen ? ' lk-sidebar-btn--on' : ''}`}
          onClick={() => { setHistoryOpen(v => !v); setSettingsOpen(false) }} title="History">â§</button>
        <button className={`lk-sidebar-btn${settingsOpen ? ' lk-sidebar-btn--on' : ''}`}
          onClick={() => {
            setSettingsOpen(v => !v)
            setHistoryOpen(false)
            setLogikMdDraft(shadowContext.logikMd || '')
          }} title="Settings">â</button>
        <button
          className="lk-sidebar-btn"
          onClick={handleReset}
          title="New Chat"
        >ï¼</button>
        <button
          className={`lk-sidebar-btn${chatHistoryOpen ? ' lk-sidebar-btn--on' : ''}`}
          onClick={() => setChatHistoryOpen(v => !v)}
          title="Chat History"
        >ð¬</button>
        <div className="lk-sidebar-spacer" />
        {shadowStatus && (
          <div className={`lk-sidebar-shadow${shadowContext.isIndexing ? ' lk-sidebar-shadow--pulse' : ' lk-sidebar-shadow--ready'}`}
            title={shadowStatus} />
        )}
      </nav>

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
          MAIN COLUMN
          ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      <div className="lk-main">

        {/* ââ Thin top bar ââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
        <div className="lk-topbar" style={{ height: `${headerLayout.headerHeight}px` }}>
          <>

              <img
                className="lk-brand-logo"
                src={logikLogo}
                alt="LOGIK"
                style={{
                  height: `${logoSize}px`,
                  transform: `translate(${logoOffsetX}px, ${logoOffsetY}px)`,
                }}
              />
              <span
                className="lk-brand-sub"
                style={{
                  fontSize: `${titleSize}px`,
                  transform: `translate(${titleOffsetX}px, ${titleOffsetY}px)`,
                }}
              >AI Coding Assistant</span>

              <div
                className="lk-view-toggle"
                role="group"
                aria-label="Execution mode"
                style={{ transform: `translate(${toggleOffsetX}px, ${toggleOffsetY}px)` }}
              >
                <button
                  className={`lk-view-toggle-btn${planMode ? ' lk-view-toggle-btn--active' : ''}`}
                  onClick={() => setPlanMode(true)}
                  title="Plan mode: creates a plan and asks for approval before implementing."
                >Plan</button>
                <button
                  className={`lk-view-toggle-btn${!planMode ? ' lk-view-toggle-btn--active' : ''}`}
                  onClick={() => setPlanMode(false)}
                  title="Code mode: runs straight through implementation."
                >Code</button>
              </div>

              {turnCount > 0 && (
                <div className="lk-turn-badge">
                  {turnCount} {turnCount === 1 ? 'turn' : 'turns'}
                  {filePath && <span className="lk-turn-file"> Â· {filePath.split('/').pop()}</span>}
                </div>
              )}
              <div className="lk-topbar-spacer" />
              {shadowStatus && (
                <div className={`lk-shadow-badge${shadowContext.isIndexing ? ' lk-shadow-badge--indexing' : ''}`}
                  title="ShadowContext: background repo index">â {shadowStatus}</div>
              )}
          </>
          <select className="lk-model-select" value={activeModelId}
            onChange={e => { setActiveModelId(e.target.value); onModelChange?.(e.target.value) }} disabled={busy}>
            <option value="">Modelâ¦</option>
            {(models || []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>

          {/* Account / logout â shown when Firebase auth is active */}
          {onLogout && (
            <button
              className="lk-icon-btn"
              title={userEmail ? `Signed in as ${userEmail} â click to log out` : 'Log out'}
              onClick={onLogout}
              style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem', opacity: 0.7 }}
            >â»</button>
          )}

        </div>

        {/* ââ Drawers (overlay inside lk-main) âââââââââââââââââââââââââââââââ */}
        {settingsOpen && (
          <LogikSettings
            githubToken={githubToken}     setGithubToken={setGithubToken}
            repoOwner={repoOwner}         setRepoOwner={setRepoOwner}
            repoName={repoName}           setRepoName={setRepoName}
            baseBranch={baseBranch}       setBaseBranch={setBaseBranch}
            hasGithub={hasGithub}
            onReindex={handleReindex}
            generateTests={generateTests}     setGenerateTests={setGenerateTests}
            creativity={creativity}           setCreativity={setCreativity}
            enableThinking={enableThinking}   setEnableThinking={setEnableThinking}
            webSearchApiKey={webSearchApiKey} setWebSearchApiKey={setWebSearchApiKey}
            doCreateBranch={doCreateBranch}   setDoCreateBranch={setDoCreateBranch}
            doCreatePR={doCreatePR}           setDoCreatePR={setDoCreatePR}
            dryRun={dryRun}                   setDryRun={setDryRun}
            theme={theme}                   setTheme={setTheme}
            fineTune={fineTune}             setFineTune={setFineTune}
            DEFAULT_FT={DEFAULT_FT}
            headerLayout={headerLayout}     setHeaderLayout={setHeaderLayout}
            DEFAULT_HEADER_LAYOUT={DEFAULT_HEADER_LAYOUT}
            permissionMode={permissionMode} setPermissionMode={setPermissionMode}
            logikMdDraft={logikMdDraft}     setLogikMdDraft={setLogikMdDraft}
            onSaveLogikMd={handleSaveLogikMd}
            isSavingLogikMd={isSavingLogikMd}
            models={models}                setModels={setModels}
            onLogout={onLogout}            userEmail={userEmail}
          />
        )}

      {/* ââ History drawer âââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {historyOpen && (
        <div className="lk-drawer lk-drawer--history">
          <div className="lk-drawer-hd">
            <span>Recent requests</span>
            {history.length > 0 && <button className="lk-drawer-clear" onClick={() => { setHistory([]); saveHistory([]) }}>Clear all</button>}
          </div>
          {history.length === 0
            ? <div className="lk-empty-note">No history yet.</div>
            : <div className="lk-history-list">
                {history.map(e => (
                  <button key={e.id} className="lk-history-item"
                    onClick={() => { setPrompt(e.prompt); setHistoryOpen(false) }}>
                    <span className="lk-history-prompt">{e.prompt}</span>
                    {e.filePath && <span className="lk-history-file">{e.filePath}</span>}
                    <span className="lk-history-date">{new Date(e.timestamp).toLocaleDateString()}</span>
                  </button>
                ))}
              </div>
          }
        </div>
      )}

        {/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
            MAIN FEED â full-height scrollable output area
            ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
        <div className="lk-feed">

          {/* ââ Plan approval gate ââââââââââââââââââââââââââââââââââââââââââ */}
          {planApproval && (
            <div className="lk-plan-approval">
              <div className="lk-plan-approval-hd">ð Plan ready â approve to execute, modify to revise, or reject to cancel</div>
              {planApproval.summary && (
                <div className="lk-plan-approval-summary">{planApproval.summary.slice(0, 600)}{planApproval.summary.length > 600 ? 'â¦' : ''}</div>
              )}
              <div className="lk-plan-approval-actions">
                <button className="lk-btn lk-btn--success" onClick={() => {
                  const t = planApproval.task
                  setPlanApproval(null)
                  agentSession.run(t, conversation.slice(-10), { forceBuildMode: true })
                }}>â Approve &amp; Execute</button>
                <button className="lk-btn" onClick={() => {
                  setPrompt(planApproval.task)
                  setPlanApproval(null)
                }}>â Modify</button>
                <button className="lk-btn lk-btn--danger" onClick={() => setPlanApproval(null)}>â Reject</button>
              </div>
            </div>
          )}

          {/* ââ Feed status strip: plan, amplifier, remediation ââââââââââââ */}
          {(isAmplifying || amplifierDecisions.length > 0 || remediationStatus || isPlanning || filePlan.length > 0) && (
            <div className="lk-feed-status">
              {isAmplifying && <div className="lk-feed-pill"><span className="lk-spinner" /> Amplifying intentâ¦</div>}
              {amplifierDecisions.length > 0 && (
                <div className="lk-amplifier-panel">
                  <div className="lk-amplifier-hd">â LOGIK decided:</div>
                  {amplifierDecisions.map((d, i) => <div key={i} className="lk-amplifier-item">Â· {d}</div>)}
                </div>
              )}
              {remediationStatus && <div className="lk-feed-pill"><span className="lk-spinner" /> {remediationStatus}</div>}
              {isPlanning && <div className="lk-feed-pill"><span className="lk-spinner" /> Planning across repoâ¦</div>}
              {filePlan.length > 0 && (
                <div className="lk-plan-panel">
                  <div className="lk-plan-hd">â Plan â {filePlan.length} file{filePlan.length !== 1 ? 's' : ''}</div>
                  {filePlan.map((entry, i) => (
                    <button key={entry.path}
                      className={`lk-plan-card${i === activeFileIndex ? ' lk-plan-card--active' : ''} lk-plan-card--${entry.status}`}
                      onClick={() => setActiveFileIndex(i)}>
                      <span className="lk-plan-card-icon">
                        {entry.status === 'done'       ? 'â' :
                         entry.status === 'error'      ? 'â' :
                         entry.status === 'generating' || entry.status === 'remediating' ? 'â¦' :
                         entry.status === 'fetching'   ? 'â¬' : 'Â·'}
                      </span>
                      <span className="lk-plan-card-path">{entry.path}</span>
                      <span className="lk-plan-card-action">{entry.action === 'modify' ? 'edit' : 'new'}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ââ File tabs (multiple files in plan) âââââââââââââââââââââââââ */}
          {filePlan.length > 1 && (
            <div className="lk-file-tabs">
              {filePlan.map((entry, i) => (
                <div key={entry.path} className={`lk-file-tab-wrap${entry.status === 'error' ? ' lk-file-tab-wrap--error' : ''}`}>
                  <button
                    className={`lk-file-tab${i === activeFileIndex ? ' lk-file-tab--active' : ''} lk-file-tab--${entry.status}`}
                    onClick={() => setActiveFileIndex(i)} title={entry.path}>
                    <span className="lk-file-tab-status">
                      {entry.status === 'done' ? 'â' : entry.status === 'error' ? 'â' :
                       entry.status === 'generating' || entry.status === 'remediating' ? 'â¦' : 'Â·'}
                    </span>
                    {entry.path.split('/').pop()}
                  </button>
                  {entry.status === 'error' && !isGenerating && (
                    <button
                      className="lk-file-retry-btn"
                      onClick={e => { e.stopPropagation(); handleRetryFile(i) }}
                      title={`Retry ${entry.path}${entry.error ? ': ' + entry.error : ''}`}
                    >âº</button>
                  )}
                </div>
              ))}
            </div>
          )}

          {chatHistoryOpen && (
            <div className="lk-inline-chat-history">
              <div className="lk-inline-chat-history-hd">Chat History</div>
              {conversation.length === 0 ? (
                <div className="lk-empty-note">No chat messages yet.</div>
              ) : (
                conversation.slice(-8).map((msg, idx) => (
                  <div key={`${msg.role}-${idx}`} className="lk-inline-chat-item">
                    <span className="lk-inline-chat-role">{msg.role === 'user' ? 'You' : 'LOGIK'}</span>
                    <span className="lk-inline-chat-text">{msg.content}</span>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ââ Agent activity feed â shown when agent is running or has output ââ */}
          {(agentSession.isAgentRunning || activityLog.length > 0) && (
            <LogikActivityFeed
              activityLog={activityLog}
              isAgentRunning={agentSession.isAgentRunning}
              agentStreamText={agentSession.agentStreamText}
              isGenerating={isGenerating}
              isPushing={isPushing}
              feedRef={activityFeedRef}
              onViewCode={() => {}}
              conversation={conversation}
              agentIntent={agentSession.agentIntent}
              agentTask={agentSession.agentTask}
              agentPhase={agentSession.agentPhase}
            />
          )}

          {/* ââ Output area ââââââââââââââââââââââââââââââââââââââââââââââ */}
          <div className="lk-feed-output">

          {/* ââ Code tab ââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
          {effectiveActiveTab === 'code' && (
            <LogikCodePane
              generatedCode={assistantMessage.code || generatedCode}
              isGenerating={isGenerating}
              language={language}
              hasGithub={hasGithub}
              filePath={filePath}
              refinementPrompt={refinementPrompt}
              onRefinementChange={setRefinementPrompt}
              onRefine={handleRefine}
              onReset={handleReset}
              turnCount={turnCount}
              pipelinePhase={pipelinePhase}
              pipelineSteps={pipelineSteps}
              validationResults={validationResults}
              livePlan={assistantMessage.plan}
            />
          )}

          {/* ââ Tests tab ââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
          <div className="lk-output" style={{ display: effectiveActiveTab === 'tests' ? 'flex' : 'none', flexDirection: 'column' }}>
            <div className="lk-code-scroll" style={{ flex: 1 }}>
              {isGenTests ? (
                <div className="lk-generating"><span className="lk-spinner" /> Generating testsâ¦</div>
              ) : testCode ? (
                <pre className="lk-pre">
                  <code dangerouslySetInnerHTML={{ __html: highlightCode(testCode, language) }} />
                </pre>
              ) : (
                <div className="lk-placeholder">
                  <div className="lk-placeholder-glyph">â</div>
                  <p className="lk-placeholder-body">
                    {generateTests
                      ? 'Generate code first â test file will be auto-generated.'
                      : 'Enable "Generate test file" in options, then generate code.'}
                  </p>
                  {filePath && <p className="lk-placeholder-tip">Tests will be saved to: <code>{testFilePath(filePath)}</code></p>}
                </div>
              )}
            </div>

            {/* ââ Run Tests bar ââââââââââââââââââââââââââââââââââââââââââââââ */}
            {testCode && !isGenTests && (
              <div className="lk-run-bar">
                <button className="lk-btn lk-btn--run" onClick={handleRunTests} disabled={isRunningTests}>
                  {isRunningTests ? 'Running Testsâ¦' : 'Run Tests'}
                </button>
              </div>
            )}
          </div>

          {effectiveActiveTab === 'diff' && (
            <LogikDiffViewer diffText={diffText} patchEdits={patchEdits} />
          )}


          {/* ââ ENHANCEMENT 7 â Run tab (JS sandbox) ââââââââââââââââââââââââ */}
          <div className="lk-output" style={{ display: effectiveActiveTab === 'run' ? 'flex' : 'none', flexDirection: 'column' }}>
            <div className="lk-sandbox-controls">
              <div className="lk-sandbox-warn">
                â  Isolated sandbox Â· JS (7 s) Â· Python via Pyodide (20 s) Â· No filesystem access
              </div>
              <div className="lk-sandbox-setup-row">
                <input
                  className="lk-input lk-sandbox-setup-input"
                  placeholder="Setup / mock code (runs before main code)"
                  value={sandboxSetup}
                  onChange={e => setSandboxSetup(e.target.value)}
                />
                <button
                  className="lk-btn lk-btn--run"
                  onClick={handleRunInSandbox}
                  disabled={!generatedCode || isRunning}
                >
                  {isRunning ? <><span className="lk-spinner" /> Runningâ¦</> : 'â¶ Run'}
                </button>
              </div>
            </div>
            <div className="lk-sandbox-output">
              {sandboxOutput.length === 0 ? (
                <div className="lk-sandbox-empty">Click â¶ Run to execute the generated code in a sandboxed environment.</div>
              ) : (
                sandboxOutput.map((line, i) => (
                  <div key={i} className={`lk-sandbox-line lk-sandbox-line--${line.level}`}>
                    <span className="lk-sandbox-level">{line.level}</span>
                    <span className="lk-sandbox-text">{line.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {effectiveActiveTab === 'terminal' && (
            <LogikTerminal
              terminalLog={terminalLog}
              terminalInput={terminalInput}
              onInputChange={e => setTerminalInput(e.target.value)}
              isTerminalRunning={isTerminalRunning}
              onRunCommand={runTerminalCommand}
              onClearLog={() => setTerminalLog([])}
            />
          )}

          {effectiveActiveTab === 'tools' && (
            <LogikToolsPane
              bridgeAvailable={bridgeAvailable}
              callExecBridge={callExecBridge}
              onSetActiveTab={setActiveTab}
            />
          )}

          {modulesOpen && (
            <div className="lk-modules-inline">
              <div className="lk-modules-inline-hd">
                <span>Modules</span>
                <button className="lk-btn lk-btn--small" onClick={() => setModulesOpen(false)}>Close</button>
              </div>
              <LogikModularTools />
            </div>
          )}

          </div>{/* end lk-feed-output */}
        </div>{/* end lk-feed */}

        <>{/* ââââââââââââââââââââââââââââââââââââââââââââââââââ
            BOTTOM INPUT BAR â prompt + controls (Claude Code style)
            ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
        <div className="lk-input-bar">

          {/* Inline status: error, push progress, PR link, repo badge */}
          {error && <div className="lk-error" role="alert">{error}</div>}
          {isPushing && pushStep && (
            <div className="lk-push-status"><span className="lk-spinner" /> {pushStep}</div>
          )}
          {prResult && (
            <a className="lk-pr-badge" href={prResult.url} target="_blank" rel="noopener noreferrer">
              <span className="lk-pr-icon">â</span>
              Pull Request {prResult.number ? `#${prResult.number}` : 'created'}
            </a>
          )}

          {/* Prompt textarea */}
          <textarea
            className="lk-textarea"
            placeholder={"Describe what you needâ¦\ne.g. 'Build a snake game in HTML/JS' or 'Add auth to the API'"}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isGenerating || agentSession.isAgentRunning}
          />

          {/* Actions row */}
          <div className="lk-input-actions">

            {/* Left: meta info */}
            <div className="lk-input-left">
              {costEstimate && (
                <span className="lk-cost-row">
                  <span className="lk-cost-tokens">~{costEstimate.inputTokens.toLocaleString()}</span>
                  <span className="lk-cost-sep">Â·</span>
                  <span className="lk-cost-usd">{formatCost(costEstimate.totalUSD)}</span>
                </span>
              )}
              {(repoOwner || repoName) && (
                <div className="lk-repo-badge">
                  <span className="lk-repo-dot" />
                  <span>{repoOwner && repoName ? `${repoOwner}/${repoName}` : repoOwner || repoName}</span>
                  {githubToken ? <span className="lk-repo-auth">â auth</span> : <span className="lk-repo-noauth">â no token</span>}
                </div>
              )}
              {/* Local folder attachment */}
              {localDirHandle ? (
                <div className="lk-local-badge">
                  <span className="lk-local-badge-icon">ð</span>
                  <span className="lk-local-badge-name" title="Local folder attached">{localDirHandle.name}</span>
                  <button className="lk-local-badge-detach" title="Detach local folder" onClick={() => setLocalDirHandle(null)}>â</button>
                </div>
              ) : (
                <button
                  className="lk-btn lk-btn--small lk-btn--attach"
                  title="Attach a local repo folder â agent will read/write files directly on disk"
                  onClick={async () => {
                    try { setLocalDirHandle(await pickDirectory()) }
                    catch (e) { if (e.name !== 'AbortError') setError(`Folder access denied: ${e.message}`) }
                  }}
                >ð Attach folder</button>
              )}
              <button
                className={`lk-btn lk-btn--small lk-btn--attach${modulesOpen ? ' lk-btn--active' : ''}`}
                onClick={() => setModulesOpen(v => !v)}
                title="Open modules"
              >â Modules</button>
            </div>

            {/* Right: action buttons */}
            <div className="lk-input-right">
              <>

                  {/* Push button â only when there's generated code to push */}
                  {hasGithub && filePlan.some(e => e.code?.trim()) && (() => {
                    const hasDiffs  = filePlan.some(e => e.diffText?.trim())
                    const fileCount = filePlan.filter(e => e.code?.trim()).length
                    const pushLabel = fileCount > 1 ? `${fileCount} files` : 'to GitHub'
                    return (
                      <>
                        <button className={`lk-btn lk-btn--push${hasDiffs ? ' lk-btn--push-ready' : ''}`} onClick={handlePush}>
                          <span className="lk-btn-icon">â¬</span>Push {pushLabel}
                        </button>
                      </>
                    )
                  })()}

                  {/* Run Tests â after a successful push with bridge available */}
                  {bridgeAvailable && prResult && (
                    <button className="lk-btn lk-btn--run" onClick={handleRunProjectTests} disabled={isRunningPostPushTests}>
                      <span className="lk-btn-icon">â</span>
                      {isRunningPostPushTests ? 'Runningâ¦' : 'Run Tests'}
                    </button>
                  )}

                  {/* Single Send button â agent when GitHub connected, generate otherwise */}
                  <button
                    className="lk-btn lk-btn--send"
                    onClick={() => hasGithub ? agentSession.run(prompt, conversation.slice(-10)) : handleGenerate()}
                    disabled={!prompt.trim() || agentSession.isAgentRunning || isGenerating}
                  >
                    <span className="lk-btn-icon">â¶</span>
                    {agentSession.isAgentRunning ? 'Workingâ¦' : isGenerating || isPlanning || isAmplifying ? 'Thinkingâ¦' : 'Send'}
                  </button>

                  {/* Terminate â always visible next to Send when running */}
                  {busy && (
                    <button className="lk-btn lk-btn--abort lk-btn--abort-inline" onClick={handleAbort} title="Terminate process">
                      Terminate Process
                    </button>
                  )}

                  {/* Persistent ready/status summary */}
                  {(hasGithub || localDirHandle || agentSession.agentSummary) && (
                    <div className="lk-agent-summary">
                      {agentSession.agentSummary ? (
                        <>
                          <span className="lk-agent-summary-icon">â</span>
                          <span>{agentSession.agentSummary.slice(0, 120)}</span>
                          {agentSession.agentFiles.length > 0 && (
                            <span className="lk-agent-files"> Â· {agentSession.agentFiles.length} file{agentSession.agentFiles.length !== 1 ? 's' : ''} changed</span>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="lk-agent-summary-icon">â</span>
                          <span>
                            {localDirHandle
                              ? `Ready to work in local folder ${localDirHandle.name}`
                              : `Ready to work in ${repoOwner}/${repoName}`}
                          </span>
                        </>
                      )}
                    </div>
                  )}
              </>
            </div>
          </div>{/* end lk-input-actions */}
        </div>{/* end lk-input-bar */}
        </>

      </div>{/* end lk-main */}
    </div>
  )
}
