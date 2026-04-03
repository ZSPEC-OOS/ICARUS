import test from 'node:test'
import assert from 'node:assert/strict'

import { astAwareEditDistance, detectBenchmarkRegressions, runNightlyBenchmarkSuite } from './nightlyBenchmarkSuite.js'
import { buildBenchmarkDashboardView } from './dashboardViews.js'
import { evaluateBenchmarkRegressionGate } from '../reliability/gateEvaluators.js'

test('astAwareEditDistance returns stable normalized distance', () => {
  const out = astAwareEditDistance('export function a() {\n // c\n return 1\n}', 'export function a(){return 1}')
  assert.equal(typeof out.distance, 'number')
  assert.equal(out.distance <= 0.5, true)
})

test('detectBenchmarkRegressions flags key metric regressions', () => {
  const regressions = detectBenchmarkRegressions({
    current: { correctnessRate: 0.5, testPassRate: 0.5, timeToGreenMs: 2000, costPerTask: 0.5, astEditDistance: 0.5 },
    baseline: { correctnessRate: 1, testPassRate: 1, timeToGreenMs: 1000, costPerTask: 0.1, astEditDistance: 0.1 },
  })
  assert.equal(regressions.length >= 4, true)
})

test('nightly suite returns full metric payload and dashboard view', async () => {
  const report = await runNightlyBenchmarkSuite({ suiteVersion: 'test-suite' })
  assert.equal(report.suiteVersion, 'test-suite')
  assert.equal(report.taskCount >= 3, true)
  assert.equal(typeof report.correctnessRate, 'number')
  assert.equal(typeof report.costPerTask, 'number')

  const view = buildBenchmarkDashboardView(report)
  assert.equal(view.kpis.length >= 5, true)
  assert.equal(Array.isArray(view.taskRows), true)
})

test('benchmark regression gate fails when report includes regressions', () => {
  const gate = evaluateBenchmarkRegressionGate({ benchmarkReport: { regressions: ['Cost/task regressed'] }, required: true })
  assert.equal(gate.passed, false)
  assert.equal(gate.id, 'benchmark_regression')
})
