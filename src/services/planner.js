// ─── Planner — Multi-file execution plan builder ────────────────────────────
// Given a task description + codebase context, returns a plan:
//   [{path, action, purpose}]
// where action is 'create' or 'modify'.
//
// Never asks the user anything. Makes smart decisions from context.

import { runPrompt } from './aiService.js'
import { PLAN_MAX_FILES as MAX_PLAN_FILES } from '../config/constants.js'
import { memoryGraphService } from './memoryGraphService.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('Planner')
import { enforceStructuredPrompt } from './enhancers/structuredPrompting.js'
import { retrieveContext } from './enhancers/ragService.js'
import { runCritiquePass } from './enhancers/critiqueMiddleware.js'
import { createReliabilityLoopFSM } from './reliability/fsm.js'
import { setTraceLoopState } from './toolTraceStore.js'

// ─── Main entry point ─────────────────────────────────────────────────────────
// recentFiles — paths of files generated in prior conversation turns.
// Lets the planner avoid redundant recreations and build on existing work.
export async function buildFilePlan(task, fileIndex, conventions, model, signal, recentFiles = []) {
  memoryGraphService.init()
  if (!model?.apiKey) return fallbackPlan(task, conventions)

  let structured = null
  let retrieval = { contexts: [], promptContext: '' }
  let planOutput = null

  // Give the planner a condensed snapshot of what exists (up to 400 paths)
  const existing = (fileIndex || []).slice(0, 400).map(f => f.path).join('\n')

  const convSummary = conventions ? [
    `Framework: ${conventions.framework}`,
    `Language: ${conventions.language}`,
    `Naming convention: ${conventions.namingConvention}`,
    `Source root: ${conventions.srcDir || 'src'}/`,
    conventions.testFramework !== 'unknown' ? `Test framework: ${conventions.testFramework}` : '',
    conventions.hooks?.length  ? `Existing hooks: ${conventions.hooks.join(', ')}` : '',
    conventions.deps?.length   ? `Key dependencies: ${conventions.deps.slice(0, 20).join(', ')}` : '',
    conventions.totalFiles     ? `Total repo files: ${conventions.totalFiles}` : '',
    conventions.pathAliases && Object.keys(conventions.pathAliases).length
      ? `Import aliases: ${Object.entries(conventions.pathAliases).map(([k, v]) => `${k}/ → ${v}/`).join(', ')}` : '',
  ].filter(Boolean).join('\n') : 'No project context available.'

  const recentCtx = recentFiles.length > 0
    ? `\nFiles created or modified in prior conversation turns (you may reference or extend these):\n${recentFiles.join('\n')}`
    : ''
  const memoryPlanContext = memoryGraphService.queryForPlanning(task, 8)
  const memoryCtx = memoryPlanContext.summary
    ? `\nMemory graph hits:\n${memoryPlanContext.summary}`
    : ''

  const standalone = isStandaloneTask(task)
  const systemMsg = [
    'You are a senior developer building a precise file-level execution plan for a coding task.',
    `Determine which files must be created or modified to fully and correctly complete the task.`,
    `Maximum ${MAX_PLAN_FILES} files. Be surgical — only include files that are directly required.`,
    `Think about the full dependency chain: if a new component needs a hook, include the hook. If a hook needs a service, include the service.`,
    standalone
      ? 'IMPORTANT: This task is standalone/self-contained — do NOT use a framework source directory. Use the root folder and appropriate extension (e.g. index.html, game.html, script.js).'
      : 'Use the EXACT naming conventions and source root from the project context. Do not invent new directories that do not match the existing structure.',
    'For "modify": the file path MUST exist verbatim in the existing files list below.',
    'For "create": choose a path that precisely fits the project conventions and directory structure.',
    'Order the array so that dependencies appear before the files that depend on them.',
    'Output a JSON array ONLY — no markdown fences, no extra text:',
    '[{"path":"src/hooks/useAuth.js","action":"create","purpose":"JWT auth hook"},...]',
    '"action" must be exactly "create" or "modify".',
    '"purpose" is a concise (≤12 word) description of this specific file\'s role in the task.',
  ].join('\n')

  const context = [
    { role: 'user',      content: systemMsg },
    { role: 'assistant', content: 'I will output only a valid JSON array for the plan.' },
  ]

  const fsm = createReliabilityLoopFSM({
    task,
    memoryGraphService,
    handlers: {
      plan: async () => {
        structured = enforceStructuredPrompt(task)
        retrieval = retrieveContext({
          query: structured.contract.goal || task,
          shadowContext: { isReady: false },
          config: { injectTopK: 0 },
        })
        return {
          structured,
          retrieval,
          prompt: `Project context:\n${convSummary}\n\nExisting files:\n${existing || '(none indexed yet)'}${recentCtx}${memoryCtx}\n\nTask: ${structured.contract.goal || task}`,
        }
      },
      execute: async ({ prompt }) => {
        const raw = await runPrompt(model, prompt, context, null, signal)
        planOutput = parsePlanJson(raw)
        return { raw, plan: planOutput }
      },
      verify: async ({ execution }) => {
        const critique = runCritiquePass({
          draftText: JSON.stringify(execution?.plan || []),
          contract: structured?.contract,
          ragContext: retrieval?.contexts || [],
          config: { minWords: 8 },
        })
        const hasPlan = Array.isArray(execution?.plan) && execution.plan.length > 0
        return {
          passed: critique.passed && hasPlan,
          failedGateIds: [...(!hasPlan ? ['plan_non_empty'] : []), ...(!critique.passed ? ['critique'] : [])],
          gates: [
            { id: 'plan_non_empty', passed: hasPlan },
            { id: 'critique', passed: critique.passed },
          ],
          critique,
        }
      },
      rollback: async () => ({ rolledBack: false, strategy: 'fallback_plan' }),
    },
    onEvent: (event) => {
      if (event?.type === 'fsm_state') {
        setTraceLoopState({
          workflow: 'planner',
          phase: event.state,
          at: new Date().toISOString(),
        })
      }
    },
  })

  try {
    const run = await fsm.run()
    const passed = run.context?.verification?.passed
    if (passed && Array.isArray(planOutput) && planOutput.length) return planOutput
  } catch (e) {
    log.warn('failed', e.message)
  } finally {
    setTraceLoopState(null)
  }

  return fallbackPlan(structured?.contract?.goal || task, conventions)
}

function parsePlanJson(raw = '') {
  const jsonMatch = String(raw).match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []
  const plan = JSON.parse(jsonMatch[0])
  if (!Array.isArray(plan) || plan.length === 0) return []
  return plan
    .filter(e => e.path && (e.action === 'create' || e.action === 'modify'))
    .slice(0, MAX_PLAN_FILES)
    .map(e => ({ path: e.path.trim(), action: e.action, purpose: e.purpose || '' }))
}

// ─── Detect if task is standalone (don't force framework conventions on it) ───
function isStandaloneTask(task) {
  return /\b(html|standalone|single.?file|no.?framework|vanilla|plain|static)\b/i.test(task)
      || /\b(game|demo|prototype|landing|page)\b/i.test(task)
}

// ─── Fallback when AI call fails or no API key ────────────────────────────────
function fallbackPlan(task, conventions) {
  const standalone = isStandaloneTask(task)
  const name = extractName(task)

  // Standalone HTML tasks: always put in root, use .html
  if (standalone || /\bhtml\b/i.test(task)) {
    return [{ path: `${name}.html`, action: 'create', purpose: task.slice(0, 60) }]
  }

  const ext  = !conventions || standalone          ? '.js'
             : conventions.framework === 'react'   ? (conventions.language?.includes('TypeScript') ? '.tsx' : '.jsx')
             : conventions.language?.includes('TypeScript') ? '.ts'
             : conventions.language?.includes('Python')     ? '.py'
             : '.js'
  const base = conventions?.srcDir || 'src'
  return [{ path: `${base}/${name}${ext}`, action: 'create', purpose: task.slice(0, 60) }]
}

function extractName(task) {
  const m = task.match(/\b(?:add|create|build|make|write|implement)\s+(?:a\s+)?(?:new\s+)?(\w+)/i)
  if (m) return m[1].toLowerCase()
  return task.trim().split(/\s+/).slice(0, 2).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'generated'
}
