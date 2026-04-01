// ─── Model Router ─────────────────────────────────────────────────────────────
// Dispatches subtasks to specialised model/provider configurations based on the
// classified agent role.  Supports four routing strategies:
//
//   single      — use the role's primary model, no fallback
//   fallback    — try primary; on API error walk the fallback chain
//   ensemble    — call multiple models in parallel, aggregate best result
//   cost_aware  — prefer cheapest model that can handle the task complexity

import { classifyTask } from './taskClassifier.js'

// ── Cost tier heuristics ─────────────────────────────────────────────────────
// Based on model name/id keywords; used only when costBudget.preferCheap=true.
const CHEAP_MODEL_KEYWORDS = ['mini', 'haiku', 'flash', 'small', 'nano', 'lite', 'fast', 'micro']

function isCheapModel(model) {
  const label = `${model?.name || ''} ${model?.modelId || ''}`.toLowerCase()
  return CHEAP_MODEL_KEYWORDS.some(k => label.includes(k))
}

/**
 * @typedef {object} RouterDecision
 * @property {'disabled'|'no_config'|'single'|'fallback'|'ensemble'|'cost_aware'} strategy
 * @property {string}  role
 * @property {number}  confidence
 * @property {object}  modelConfig       Primary model config to use
 * @property {object[]} fallbacks        Ordered fallback model configs
 * @property {string}  cost              'low'|'medium'|'high'
 * @property {string}  reasoning         Human-readable routing rationale
 * @property {Record<string,number>} scores  Per-role classification scores
 */

/**
 * Create a stateless model router bound to a fixed orchestration config and
 * model list.
 *
 * @param {object}   orchestrationConfig  enhancerConfig.orchestration
 * @param {object[]} availableModels      Full model list loaded from aiService
 * @returns {{
 *   route(classification: object, defaultModelConfig: object): RouterDecision,
 *   classifyAndRoute(task: string, defaultModelConfig: object): RouterDecision,
 *   callWithFallback(routing: RouterDecision, callFn: Function, onFallback?: Function): Promise<object>,
 *   callEnsemble(routing: RouterDecision, callFn: Function): Promise<object>,
 *   resolveModelForRole(role: string): {primary: object, fallbacks: object[], cost: string}|null,
 * }}
 */
export function createModelRouter(orchestrationConfig = {}, availableModels = []) {
  const cfg = orchestrationConfig

  // ── Model lookup ───────────────────────────────────────────────────────────
  function findModel(ref) {
    if (!ref) return null
    return availableModels.find(
      m => m.id === ref || m.modelId === ref || m.name === ref
    ) || null
  }

  function resolveModelForRole(role) {
    const roleCfg = cfg.roles?.[role]
    if (!roleCfg) return null
    const primary = findModel(roleCfg.primary)
    if (!primary) return null
    const fallbacks = (roleCfg.fallbacks || []).map(findModel).filter(Boolean)
    return { primary, fallbacks, cost: roleCfg.cost || 'medium' }
  }

  // ── Core route() ──────────────────────────────────────────────────────────
  /**
   * Decide which model config to use given a pre-computed classification.
   * @param {{ role: string, confidence: number, scores: Record<string,number> }} classification
   * @param {object} defaultModelConfig
   * @returns {RouterDecision}
   */
  function route(classification, defaultModelConfig) {
    const { role, confidence, scores = {} } = classification

    if (!cfg.enabled) {
      return {
        strategy: 'disabled',
        role,
        confidence,
        modelConfig: defaultModelConfig,
        fallbacks: [],
        cost: 'unknown',
        reasoning: 'Orchestration disabled — using default model',
        scores,
      }
    }

    const resolved = resolveModelForRole(role)
    if (!resolved?.primary) {
      return {
        strategy: 'no_config',
        role,
        confidence,
        modelConfig: defaultModelConfig,
        fallbacks: [],
        cost: 'unknown',
        reasoning: `No specialised model configured for role '${role}' — using default`,
        scores,
      }
    }

    const strategy = cfg.strategy || 'single'
    let chosenModel = resolved.primary
    let remainingFallbacks = resolved.fallbacks

    // Cost-aware: prefer a cheap model when budget flag is set
    if (strategy === 'cost_aware' && cfg.costBudget?.preferCheap) {
      const cheap = [resolved.primary, ...resolved.fallbacks].find(isCheapModel)
      if (cheap) {
        chosenModel = cheap
        remainingFallbacks = [resolved.primary, ...resolved.fallbacks].filter(m => m !== cheap)
      }
    }

    const modelLabel = chosenModel.name || chosenModel.modelId || 'unknown'
    return {
      strategy,
      role,
      confidence,
      modelConfig: chosenModel,
      fallbacks: remainingFallbacks,
      cost: resolved.cost,
      reasoning: `Role '${role}' (conf=${confidence.toFixed(2)}) → ${modelLabel} [strategy=${strategy}]`,
      scores,
    }
  }

  // ── Convenience: classify + route in one call ──────────────────────────────
  function classifyAndRoute(task, defaultModelConfig) {
    return route(classifyTask(task), defaultModelConfig)
  }

  // ── Fallback execution ─────────────────────────────────────────────────────
  /**
   * Calls callFn(modelConfig) starting with routing.modelConfig.
   * On any thrown error walks through routing.fallbacks.
   *
   * @param {RouterDecision}  routing
   * @param {Function}        callFn       async (modelConfig) => result
   * @param {Function}        [onFallback] called before each fallback attempt
   * @returns {Promise<{ result, modelUsed, fallbackIndex: number, usedFallback: boolean }>}
   */
  async function callWithFallback(routing, callFn, onFallback) {
    const chain = [routing.modelConfig, ...routing.fallbacks]
    let lastErr
    for (let idx = 0; idx < chain.length; idx++) {
      const model = chain[idx]
      try {
        const result = await callFn(model)
        return { result, modelUsed: model, fallbackIndex: idx, usedFallback: idx > 0 }
      } catch (err) {
        // Abort signals must propagate immediately
        if (err?.name === 'AbortError') throw err
        lastErr = err
        if (idx < chain.length - 1) {
          onFallback?.({
            fromModel: model,
            toModel: chain[idx + 1],
            error: err,
            fallbackIndex: idx,
          })
        }
      }
    }
    throw lastErr
  }

  // ── Ensemble execution ─────────────────────────────────────────────────────
  /**
   * Calls callFn across N models concurrently and picks the best result per
   * aggregationStrategy.
   *
   * @param {RouterDecision} routing
   * @param {Function}       callFn  async (modelConfig) => { text, ... }
   * @returns {Promise<{ result, modelsUsed, ensemble: boolean, aggregationStrategy: string }>}
   */
  async function callEnsemble(routing, callFn) {
    const minModels = cfg.ensemble?.minModels ?? 2
    const models = [routing.modelConfig, ...routing.fallbacks].slice(0, minModels)

    if (models.length < 2) {
      // Can't form ensemble; degrade to single call
      const result = await callFn(models[0])
      return { result, modelsUsed: [models[0]], ensemble: false, aggregationStrategy: 'single_fallback' }
    }

    const settled = await Promise.allSettled(models.map(m => callFn(m)))
    const successful = settled
      .map((r, i) => r.status === 'fulfilled' ? { result: r.value, model: models[i] } : null)
      .filter(Boolean)

    if (!successful.length) {
      const errors = settled.map(r => r.reason?.message || String(r.reason)).join('; ')
      throw new Error(`All ensemble models failed: ${errors}`)
    }

    const aggStrategy = cfg.ensemble?.aggregationStrategy || 'longest'
    let chosen

    if (aggStrategy === 'longest') {
      // Pick the response with the most output text — proxy for depth
      chosen = successful.reduce((a, b) =>
        (a.result?.text?.length || 0) >= (b.result?.text?.length || 0) ? a : b
      )
    } else if (aggStrategy === 'voted') {
      // Naive majority vote: return the result whose text is most similar
      // to the modal response (longest shared prefix heuristic)
      const texts = successful.map(s => s.result?.text || '')
      const scores = texts.map((t, i) =>
        texts.filter((_, j) => j !== i).reduce((sum, other) => sum + sharedPrefixLen(t, other), 0)
      )
      const bestIdx = scores.indexOf(Math.max(...scores))
      chosen = successful[bestIdx]
    } else {
      // 'fastest': Promise.allSettled preserves submission order; first success wins
      chosen = successful[0]
    }

    return {
      result: chosen.result,
      modelsUsed: successful.map(s => s.model),
      ensemble: true,
      aggregationStrategy: aggStrategy,
    }
  }

  return { route, classifyAndRoute, callWithFallback, callEnsemble, resolveModelForRole }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function sharedPrefixLen(a = '', b = '') {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}
