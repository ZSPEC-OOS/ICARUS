// ─── modelRouter unit tests ───────────────────────────────────────────────────
// Covers route(), callWithFallback(), callEnsemble(), and fallback preference
// persistence (with in-memory localStorage mock).

import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelRouter } from './modelRouter.js'

// ── localStorage mock ─────────────────────────────────────────────────────────

const _store = {}
global.localStorage = {
  getItem:    (k)    => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = v },
  removeItem: (k)    => { delete _store[k] },
  clear:      ()     => { Object.keys(_store).forEach(k => delete _store[k]) },
}

function clearLocalStorage() {
  Object.keys(_store).forEach(k => delete _store[k])
}

// ── Fixture models ─────────────────────────────────────────────────────────────

const modelA = { id: 'model-a', modelId: 'model-a', name: 'Model A', provider: 'openai', apiKey: 'k' }
const modelB = { id: 'model-b', modelId: 'model-b', name: 'Model B', provider: 'openai', apiKey: 'k' }
const modelC = { id: 'model-haiku', modelId: 'model-haiku', name: 'Haiku Fast', provider: 'anthropic', apiKey: 'k' }
const defaultModel = { id: 'default', modelId: 'default', name: 'Default', provider: 'openai', apiKey: 'k' }

const baseRoles = {
  debugger:     { primary: 'model-a', fallbacks: ['model-b'], cost: 'medium' },
  'test-writer': { primary: 'model-b', fallbacks: ['model-haiku'], cost: 'low' },
}

// ── route() — disabled ────────────────────────────────────────────────────────

test('route returns disabled strategy when orchestration is off', () => {
  const router = createModelRouter({ enabled: false }, [modelA, modelB])
  const decision = router.classifyAndRoute('fix the login bug', defaultModel)
  assert.equal(decision.strategy, 'disabled')
  assert.equal(decision.modelConfig, defaultModel)
})

// ── route() — no_config ───────────────────────────────────────────────────────

test('route returns no_config when role has no primary model match', () => {
  // Roles configured but primary IDs don't match available models
  const router = createModelRouter(
    { enabled: true, strategy: 'single', roles: { debugger: { primary: 'nonexistent-model', fallbacks: [], cost: 'medium' } } },
    [modelA]
  )
  const decision = router.route({ role: 'debugger', confidence: 0.9, scores: {} }, defaultModel)
  assert.equal(decision.strategy, 'no_config')
  assert.equal(decision.modelConfig, defaultModel)
})

// ── route() — single ──────────────────────────────────────────────────────────

test('route single strategy selects the configured primary model', () => {
  clearLocalStorage()
  const router = createModelRouter(
    { enabled: true, strategy: 'single', roles: baseRoles, logDecisions: false },
    [modelA, modelB, modelC]
  )
  const decision = router.route({ role: 'debugger', confidence: 0.85, scores: {} }, defaultModel)
  assert.equal(decision.strategy, 'single')
  assert.equal(decision.modelConfig.id, 'model-a')
  assert.equal(decision.role, 'debugger')
})

// ── route() — cost_aware ──────────────────────────────────────────────────────

test('route cost_aware with preferCheap selects cheapest model', () => {
  clearLocalStorage()
  const router = createModelRouter(
    {
      enabled: true,
      strategy: 'cost_aware',
      roles: { 'test-writer': { primary: 'model-b', fallbacks: ['model-haiku'], cost: 'low' } },
      costBudget: { preferCheap: true },
      logDecisions: false,
    },
    [modelA, modelB, modelC]
  )
  const decision = router.route({ role: 'test-writer', confidence: 0.7, scores: {} }, defaultModel)
  // 'model-haiku' contains keyword 'haiku' → isCheapModel → true
  assert.equal(decision.modelConfig.id, 'model-haiku')
})

// ── route() — persisted fallback preference ───────────────────────────────────

test('route prefers persisted fallback model over primary on next call', () => {
  clearLocalStorage()
  const router = createModelRouter(
    { enabled: true, strategy: 'fallback', roles: baseRoles, logDecisions: false },
    [modelA, modelB, modelC]
  )
  // Simulate a previous fallback success for the debugger role
  router.saveFallbackPref('debugger', 'model-b')

  const decision = router.route({ role: 'debugger', confidence: 0.9, scores: {} }, defaultModel)
  assert.equal(decision.modelConfig.id, 'model-b')
  assert.ok(decision.reasoning.includes('persisted-fallback-pref'))
})

test('route ignores expired fallback preferences (>24h old)', () => {
  clearLocalStorage()
  // Manually write a pref with an old timestamp
  const FALLBACK_PREFS_KEY = 'icarus:router:fallback-prefs'
  const oldAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  localStorage.setItem(FALLBACK_PREFS_KEY, JSON.stringify({
    debugger: { modelId: 'model-b', at: oldAt }
  }))

  const router = createModelRouter(
    { enabled: true, strategy: 'fallback', roles: baseRoles, logDecisions: false },
    [modelA, modelB, modelC]
  )
  const decision = router.route({ role: 'debugger', confidence: 0.9, scores: {} }, defaultModel)
  // Expired pref should be ignored; primary should be used
  assert.equal(decision.modelConfig.id, 'model-a')
  assert.ok(!decision.reasoning.includes('persisted-fallback-pref'))
})

// ── callWithFallback() ────────────────────────────────────────────────────────

test('callWithFallback returns result on first try without fallback', async () => {
  clearLocalStorage()
  const router = createModelRouter({ enabled: false }, [])
  const routing = { modelConfig: modelA, fallbacks: [modelB], strategy: 'fallback', role: 'debugger', confidence: 0.9, scores: {} }
  const { result, fallbackIndex, usedFallback } = await router.callWithFallback(
    routing,
    async (model) => ({ text: `response from ${model.id}` })
  )
  assert.equal(result.text, 'response from model-a')
  assert.equal(fallbackIndex, 0)
  assert.equal(usedFallback, false)
})

test('callWithFallback walks to next model on error', async () => {
  clearLocalStorage()
  const router = createModelRouter({ enabled: false }, [])
  const routing = { modelConfig: modelA, fallbacks: [modelB], strategy: 'fallback', role: 'debugger', confidence: 0.9, scores: {} }
  let fallbackFired = false

  const { result, fallbackIndex, usedFallback } = await router.callWithFallback(
    routing,
    async (model) => {
      if (model.id === 'model-a') throw new Error('primary failed')
      return { text: `fallback from ${model.id}` }
    },
    () => { fallbackFired = true }
  )

  assert.equal(result.text, 'fallback from model-b')
  assert.equal(fallbackIndex, 1)
  assert.equal(usedFallback, true)
  assert.equal(fallbackFired, true)
})

test('callWithFallback re-throws AbortError without trying fallbacks', async () => {
  clearLocalStorage()
  const router = createModelRouter({ enabled: false }, [])
  const routing = { modelConfig: modelA, fallbacks: [modelB], strategy: 'fallback', role: 'debugger', confidence: 0.9, scores: {} }
  let fallbackAttempted = false

  const abort = new DOMException('aborted', 'AbortError')
  await assert.rejects(
    () => router.callWithFallback(
      routing,
      async () => { throw abort },
      () => { fallbackAttempted = true }
    ),
    (err) => err.name === 'AbortError'
  )
  assert.equal(fallbackAttempted, false)
})

test('callWithFallback throws when all models fail', async () => {
  clearLocalStorage()
  const router = createModelRouter({ enabled: false }, [])
  const routing = { modelConfig: modelA, fallbacks: [modelB], strategy: 'fallback', role: 'debugger', confidence: 0.9, scores: {} }

  await assert.rejects(
    () => router.callWithFallback(routing, async () => { throw new Error('all broken') }),
    /all broken/
  )
})

// ── callEnsemble() ────────────────────────────────────────────────────────────

test('callEnsemble picks longest text by default', async () => {
  clearLocalStorage()
  const router = createModelRouter({ enabled: true, ensemble: { minModels: 2, aggregationStrategy: 'longest' } }, [])
  const routing = { modelConfig: modelA, fallbacks: [modelB], strategy: 'ensemble', role: 'debugger', confidence: 0.9, scores: {} }

  const { result, ensemble } = await router.callEnsemble(routing, async (model) => ({
    text: model.id === 'model-a' ? 'short' : 'a much longer response from model b'
  }))

  assert.equal(ensemble, true)
  assert.equal(result.text, 'a much longer response from model b')
})

test('callEnsemble degrades to single call when only one model available', async () => {
  clearLocalStorage()
  const router = createModelRouter({ enabled: true, ensemble: { minModels: 2, aggregationStrategy: 'longest' } }, [])
  const routing = { modelConfig: modelA, fallbacks: [], strategy: 'ensemble', role: 'debugger', confidence: 0.9, scores: {} }

  const { ensemble } = await router.callEnsemble(routing, async () => ({ text: 'single result' }))
  assert.equal(ensemble, false)
})
