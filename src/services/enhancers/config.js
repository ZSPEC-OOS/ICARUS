// ─── enhancer config ─────────────────────────────────────────────────────────
// Central enable/disable switches and tuning knobs for optional advanced agent
// capabilities. Keep defaults backwards-compatible by disabling heavyweight
// enhancers unless explicitly opted in.
//
// orchestration block (4.1) — model routing for specialised agent roles.
// Role primary/fallback values are model IDs or names from the loaded model
// list (aiService loadModels).  Leave primary=null to fall back to default.

import { KEYS } from '../../shared/storageKeys.js'

const ENHANCER_CFG_KEY = KEYS.LS.ENHANCER_CONFIG

/** @typedef {'disabled'|'rule_based'|'llm'|'hybrid'} CritiqueMode */

/**
 * @typedef {'low'|'medium'|'high'} CostTier
 * @typedef {'single'|'fallback'|'ensemble'|'cost_aware'} RoutingStrategy
 *
 * @typedef {object} RoleConfig
 * @property {string|null} primary    Model id/name for this role (null = use default)
 * @property {string[]}    fallbacks  Ordered fallback model ids/names
 * @property {CostTier}    cost       Expected cost tier of this role's tasks
 *
 * @typedef {object} OrchestrationConfig
 * @property {boolean}          enabled
 * @property {RoutingStrategy}  strategy
 * @property {boolean}          logDecisions  Emit orchestration events + trace entries
 * @property {Record<string, RoleConfig>} roles
 * @property {{ preferCheap: boolean, maxCostPerTask: number|null }} costBudget
 * @property {{ minModels: number, aggregationStrategy: 'longest'|'fastest'|'voted' }} ensemble
 *
 * @typedef {object} EnhancerConfig
 * @property {{enabled:boolean,enforceOnAgentInput:boolean}} structuredPrompting
 * @property {{enabled:boolean,bm25Weight:number,vectorWeight:number,rerankTopK:number,injectTopK:number,minScore:number}} rag
 * @property {{enabled:boolean,complexityThreshold:{moderate:number,complex:number},parallelExecution:boolean,maxParallelSteps:number}} plannerExecutor
 * @property {{enabled:boolean,mode:CritiqueMode,checkGrounding:boolean,checkConstraints:boolean,checkCompleteness:boolean}} critique
 * @property {{enabled:boolean,emitVerboseTrace:boolean,summaryStyle:'concise_only'|'concise_plus_detailed'}} deepReasoning
 * @property {OrchestrationConfig} orchestration
 * @property {{enabled:boolean,complexityThreshold:number,maxSubtasks:number}} taskDecomposer
 * @property {{enabled:boolean,buildOnLoopStart:boolean,maxSymbolsPerFile:number}} codeIntelligence
 * @property {{enabled:boolean,fuzzyThreshold:number,syntaxCheck:boolean}} patchValidator
 * @property {{enabled:boolean,escalateOnError:boolean,escalateOnQualityFail:boolean,modelId:string|null}} model2Attachment
 * @property {{enabled:boolean}} crossSessionMemory
 * @property {{enabled:boolean,maxPagesPerSite:number,maxCharsPerPage:number}} docsCrawler
 */

/** @type {EnhancerConfig} */
export const DEFAULT_ENHANCER_CONFIG = {
  structuredPrompting: {
    enabled: true,
    enforceOnAgentInput: true,
  },
  rag: {
    // Enabled by default — degrades gracefully when shadowContext is not ready
    // (returns empty contexts and adds zero latency in that case).
    enabled: true,
    bm25Weight: 0.45,
    vectorWeight: 0.55,
    rerankTopK: 12,
    injectTopK: 6,
    minScore: 0.12,
  },
  plannerExecutor: {
    enabled: false,
    complexityThreshold: {
      moderate: 120,
      complex: 280,
    },
    parallelExecution: true,
    maxParallelSteps: 3,
  },
  critique: {
    enabled: true,
    mode: 'rule_based',
    checkGrounding: true,
    checkConstraints: true,
    checkCompleteness: true,
  },
  deepReasoning: {
    enabled: false,
    emitVerboseTrace: true,
    summaryStyle: 'concise_plus_detailed',
  },
  orchestration: {
    // Enabled with 'fallback' strategy: when no role-specific model is configured
    // the router gracefully returns strategy='no_config' and uses the default model,
    // so turning this on has zero cost for unconfigured setups.
    enabled: true,
    strategy: 'fallback',       // 'single' | 'fallback' | 'ensemble' | 'cost_aware'
    logDecisions: true,
    roles: {
      planner:        { primary: null, fallbacks: [], cost: 'high' },
      debugger:       { primary: null, fallbacks: [], cost: 'medium' },
      refactorer:     { primary: null, fallbacks: [], cost: 'medium' },
      'test-writer':  { primary: null, fallbacks: [], cost: 'low' },
      reviewer:       { primary: null, fallbacks: [], cost: 'low' },
    },
    costBudget: { preferCheap: false, maxCostPerTask: null },
    ensemble: { minModels: 2, aggregationStrategy: 'longest' },
  },

  // ── Phase 1 enhancer config blocks ────────────────────────────────────────
  // taskDecomposer: disabled by default (adds latency + token cost per task).
  // Enable via settings UI or saveEnhancerConfig({ plannerExecutor: { enabled: true } }).
  // Note: taskDecomposer activation is gated on plannerExecutor.enabled (reuses
  // the existing flag so no UI changes are needed for Phase 1).

  // codeIntelligence: always builds index on loop start when shadowContext is
  // ready — zero cost since buildIndex is a no-op when the index is fresh.
  codeIntelligence: {
    enabled:          true,     // index builds passively; tools available any time
    buildOnLoopStart: true,     // refresh index at the start of each agent loop
    maxSymbolsPerFile: 200,     // mirrors CODE_INTEL_MAX_SYMBOLS_PER_FILE constant
  },

  // patchValidator: always active; cannot be disabled since it only prevents
  // provably bad writes.  The syntaxCheck sub-feature can be turned off.
  patchValidator: {
    enabled:        true,
    fuzzyThreshold: 0.65,   // min Levenshtein similarity to surface a nearest-match hint
    syntaxCheck:    true,   // run bracket-balance check after a successful exact match
  },

  // model2Attachment: optional escalation model that takes over when Model 1
  // fails or produces a response that doesn't pass reliability gates.
  // modelId must match an id in the loaded model list (aiService loadModels).
  // escalateOnError     — triggers when the primary model API call throws (default on).
  // escalateOnQualityFail — triggers when reliability gates fail after a full run
  //                         (more expensive: the whole task runs twice).
  model2Attachment: {
    enabled:               false,
    escalateOnError:       true,
    escalateOnQualityFail: false,
    modelId:               null,
  },

  // crossSessionMemory: after each successful task that changes files, auto-append
  // a one-line session summary to BLUSWAN.md so future sessions see what was done.
  // Since BLUSWAN.md is already injected into every system prompt, this gives the
  // model institutional memory across sessions with zero extra tooling.
  crossSessionMemory: {
    enabled: false,
  },

  // docsCrawler: controls the on-demand documentation site crawler.
  // maxPagesPerSite caps browser-side fetch cost per crawl_docs call.
  // maxCharsPerPage truncates each page before chunking to limit memory graph growth.
  docsCrawler: {
    enabled:          true,
    maxPagesPerSite:  20,
    maxCharsPerPage:  8000,
  },
}

/**
 * Deep merge utility specialized for enhancer config shape.
 * @param {EnhancerConfig|Partial<EnhancerConfig>|null|undefined} overrides
 * @returns {EnhancerConfig}
 */
export function resolveEnhancerConfig(overrides) {
  const base = structuredClone(DEFAULT_ENHANCER_CONFIG)
  if (!overrides || typeof overrides !== 'object') return base

  for (const [key, val] of Object.entries(overrides)) {
    if (!(key in base) || val == null || typeof val !== 'object') continue
    if (key === 'orchestration') {
      // Deep-merge orchestration so individual role overrides don't wipe sibling roles
      base.orchestration = {
        ...base.orchestration,
        ...val,
        roles: { ...base.orchestration.roles, ...(val.roles || {}) },
        costBudget: { ...base.orchestration.costBudget, ...(val.costBudget || {}) },
        ensemble: { ...base.orchestration.ensemble, ...(val.ensemble || {}) },
      }
    } else {
      base[key] = { ...base[key], ...val }
    }
  }
  return base
}

/** @returns {EnhancerConfig} */
export function loadEnhancerConfig() {
  try {
    const raw = localStorage.getItem(ENHANCER_CFG_KEY)
    if (!raw) return resolveEnhancerConfig(null)
    return resolveEnhancerConfig(JSON.parse(raw))
  } catch {
    return resolveEnhancerConfig(null)
  }
}

/** @param {Partial<EnhancerConfig>} next */
export function saveEnhancerConfig(next) {
  const resolved = resolveEnhancerConfig(next)
  localStorage.setItem(ENHANCER_CFG_KEY, JSON.stringify(resolved))
  return resolved
}
