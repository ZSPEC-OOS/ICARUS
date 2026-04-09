// ─── enhancer config ─────────────────────────────────────────────────────────
// Central enable/disable switches and tuning knobs for optional advanced agent
// capabilities. Keep defaults backwards-compatible by disabling heavyweight
// enhancers unless explicitly opted in.
//
// orchestration block (4.1) — model routing for specialised agent roles.
// Role primary/fallback values are model IDs or names from the loaded model
// list (aiService loadModels).  Leave primary=null to fall back to default.

const ENHANCER_CFG_KEY = 'bluswan:enhancers-config'

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
 */

/** @type {EnhancerConfig} */
export const DEFAULT_ENHANCER_CONFIG = {
  structuredPrompting: {
    enabled: true,
    enforceOnAgentInput: true,
  },
  rag: {
    enabled: false,
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
    enabled: false,
    strategy: 'single',         // 'single' | 'fallback' | 'ensemble' | 'cost_aware'
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
