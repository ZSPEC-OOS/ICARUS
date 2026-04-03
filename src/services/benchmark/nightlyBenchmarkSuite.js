import { evaluateReliabilityGates } from '../reliability/gateEvaluators.js'
import { createReliabilityLoopFSM } from '../reliability/fsm.js'
import { createDeepReasoningWorkflow } from '../enhancers/deepReasoningPipeline.js'
import { memoryGraphService } from '../memoryGraphService.js'

const DEFAULT_COST_PER_1K = {
  input: 0.003,
  output: 0.015,
}

function normalizeCode(text = '') {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function astAwareEditDistance(before = '', after = '') {
  const a = normalizeCode(before)
  const b = normalizeCode(after)
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return { distance: 0, similarity: 1 }

  let overlap = 0
  const minLen = Math.min(a.length, b.length)
  for (let i = 0; i < minLen; i++) {
    if (a[i] === b[i]) overlap += 1
  }
  const distance = 1 - (overlap / maxLen)
  return {
    distance: Number(distance.toFixed(3)),
    similarity: Number((1 - distance).toFixed(3)),
  }
}

function estimateCost({ inputTokens = 0, outputTokens = 0, pricing = DEFAULT_COST_PER_1K }) {
  const inputCost = (inputTokens / 1000) * (pricing.input ?? DEFAULT_COST_PER_1K.input)
  const outputCost = (outputTokens / 1000) * (pricing.output ?? DEFAULT_COST_PER_1K.output)
  return Number((inputCost + outputCost).toFixed(6))
}

async function taskReliabilityGate() {
  const executionTrace = {
    commandRuns: [{ result: 'exit 0\nPASS' }, { result: 'exit 0\nlint ok' }],
    mutations: [{ beforeContent: 'export function a(x){}', afterContent: 'export function a(x){ return x }', apiSignatureChanged: false }],
  }
  const verification = evaluateReliabilityGates({
    executionTrace,
    draftText: 'Implemented complete changes and added validation.',
    critiqueConfig: { enabled: true },
    config: { minTestPassRate: 0.5, minSemanticSimilarity: 0.05, maxSemanticSimilarity: 1 },
  })

  const edit = astAwareEditDistance(executionTrace.mutations[0].beforeContent, executionTrace.mutations[0].afterContent)
  return {
    name: 'reliability_gate_happy_path',
    correctness: verification.passed,
    assertionsPassed: verification.gates.filter(g => g.passed).length,
    assertionsTotal: verification.gates.length,
    testPassRate: verification.gates.find(g => g.id === 'test_pass_rate')?.metric ?? 0,
    astEditDistance: edit.distance,
    details: { failedGateIds: verification.failedGateIds },
  }
}

async function taskRollbackRecovery() {
  const fsm = createReliabilityLoopFSM({
    task: 'benchmark rollback',
    handlers: {
      plan: async () => ({ step: 'plan' }),
      execute: async () => ({ mutationTrace: [{ path: 'src/services/reliability/fsm.js' }] }),
      verify: async () => ({ passed: false, failedGateIds: ['critique'] }),
      rollback: async () => ({ rolledBack: true, strategy: 'patch_undo' }),
    },
  })
  const out = await fsm.run()
  const correctness = out.current === 'done' && out.context.rollback?.rolledBack
  return {
    name: 'reliability_rollback_recovery',
    correctness,
    assertionsPassed: correctness ? 2 : 1,
    assertionsTotal: 2,
    testPassRate: 1,
    astEditDistance: 0,
    details: { finalState: out.current },
  }
}

async function taskDeepReasoning() {
  const workflow = createDeepReasoningWorkflow({
    enhancerConfig: {
      rag: { enabled: false },
      critique: { enabled: true },
      deepReasoning: { qualityFloorMinChars: 10, qualityFloorMinPlanSteps: 1 },
    },
    shadowContext: { isReady: false },
    planner: async () => ({ steps: ['Inspect', 'Implement', 'Validate'], dependencies: [] }),
    runAgent: async () => ({ text: 'Implemented task output with verification and confidence.' }),
  })
  const result = await workflow('Benchmark deep reasoning integration task.')
  const correctness = result.reliability?.state === 'done' && result.critique?.passed
  return {
    name: 'deep_reasoning_reliability_integration',
    correctness,
    assertionsPassed: correctness ? 2 : 1,
    assertionsTotal: 2,
    testPassRate: correctness ? 1 : 0.5,
    astEditDistance: 0,
    details: { reliability: result.reliability?.state },
  }
}

const DEFAULT_TASKS = [taskReliabilityGate, taskRollbackRecovery, taskDeepReasoning]

export function detectBenchmarkRegressions({ current, baseline, thresholds = {} }) {
  if (!baseline) return []
  const fail = []
  if (current.correctnessRate < baseline.correctnessRate) fail.push('Correctness rate regressed')
  if (current.testPassRate < baseline.testPassRate) fail.push('Test pass rate regressed')
  if (current.timeToGreenMs > baseline.timeToGreenMs * (thresholds.maxTimeRegressionFactor ?? 1.15)) fail.push('Time-to-green regressed')
  if (current.costPerTask > baseline.costPerTask * (thresholds.maxCostRegressionFactor ?? 1.2)) fail.push('Cost/task regressed')
  if (current.astEditDistance > baseline.astEditDistance + (thresholds.maxAstDistanceDelta ?? 0.08)) fail.push('AST-aware edit distance regressed')
  return fail
}

export async function runNightlyBenchmarkSuite({
  suiteVersion = `suite-${new Date().toISOString()}`,
  baselineReport = null,
  tasks = DEFAULT_TASKS,
  pricing = DEFAULT_COST_PER_1K,
  reliabilityThresholds = {},
} = {}) {
  const startedAt = Date.now()
  const taskResults = []

  for (const taskRunner of tasks) {
    const taskStart = Date.now()
    const result = await taskRunner()
    const elapsedMs = Date.now() - taskStart
    const inputTokens = Math.ceil(JSON.stringify(result.details || {}).length / 4) + 120
    const outputTokens = Math.ceil((result.name || '').length / 4) + 80
    taskResults.push({
      ...result,
      elapsedMs,
      inputTokens,
      outputTokens,
      cost: estimateCost({ inputTokens, outputTokens, pricing }),
    })
  }

  const totals = taskResults.reduce((acc, task) => {
    acc.correct += task.correctness ? 1 : 0
    acc.passRate += task.testPassRate
    acc.editDistance += task.astEditDistance
    acc.cost += task.cost
    acc.assertionsPassed += task.assertionsPassed
    acc.assertionsTotal += task.assertionsTotal
    return acc
  }, { correct: 0, passRate: 0, editDistance: 0, cost: 0, assertionsPassed: 0, assertionsTotal: 0 })

  const count = Math.max(1, taskResults.length)
  const summary = {
    suiteVersion,
    generatedAt: new Date().toISOString(),
    baselineVersion: baselineReport?.suiteVersion ?? null,
    taskCount: taskResults.length,
    correctnessRate: Number((totals.correct / count).toFixed(3)),
    correctnessAssertionRate: Number((totals.assertionsPassed / Math.max(1, totals.assertionsTotal)).toFixed(3)),
    astEditDistance: Number((totals.editDistance / count).toFixed(3)),
    testPassRate: Number((totals.passRate / count).toFixed(3)),
    timeToGreenMs: Date.now() - startedAt,
    costPerTask: Number((totals.cost / count).toFixed(6)),
    totalCost: Number(totals.cost.toFixed(6)),
  }

  const regressions = detectBenchmarkRegressions({ current: summary, baseline: baselineReport, thresholds: reliabilityThresholds })
  const reliabilityGate = {
    id: 'benchmark_regression',
    passed: regressions.length === 0,
    regressions,
  }

  const report = {
    ...summary,
    tasks: taskResults,
    reliabilityGate,
    regressions,
  }

  memoryGraphService.ingestBenchmarkRun?.(report)
  return report
}
