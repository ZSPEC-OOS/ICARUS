import { runCritiquePass } from '../enhancers/critiqueMiddleware.js'

function toLineSet(text = '') {
  return new Set(String(text).split('\n').map(l => l.trim()).filter(Boolean))
}

function lineSimilarity(a = '', b = '') {
  const aSet = toLineSet(a)
  const bSet = toLineSet(b)
  const union = new Set([...aSet, ...bSet])
  if (union.size === 0) return 1
  let overlap = 0
  for (const line of aSet) if (bSet.has(line)) overlap += 1
  return overlap / union.size
}

function extractRunCommandMetrics(toolRuns = []) {
  let passed = 0
  let failed = 0

  for (const run of toolRuns) {
    const payload = String(run?.result || '')
    const exitMatch = payload.match(/exit\s+(-?\d+)/i)
    if (exitMatch) {
      if (Number(exitMatch[1]) === 0) passed += 1
      else failed += 1
      continue
    }
    if (/\b(pass|passed|no lint errors|ok)\b/i.test(payload)) passed += 1
    if (/\b(fail|failed|error|exception)\b/i.test(payload)) failed += 1
  }

  const total = passed + failed
  return {
    passed,
    failed,
    total,
    passRate: total ? passed / total : 1,
  }
}

export function evaluateReliabilityGates({
  executionTrace = {},
  draftText = '',
  critiqueConfig = {},
  config = {},
}) {
  const testMetrics = extractRunCommandMetrics(executionTrace.commandRuns || [])
  const minTestPassRate = config.minTestPassRate ?? 0.8
  const testGate = {
    id: 'test_pass_rate',
    metric: Number(testMetrics.passRate.toFixed(3)),
    threshold: minTestPassRate,
    passed: testMetrics.passRate >= minTestPassRate,
    detail: `pass ${testMetrics.passed}/${Math.max(1, testMetrics.total)} command checks`,
  }

  const edits = executionTrace.mutations || []
  const similarities = edits
    .filter(m => typeof m.beforeContent === 'string' && typeof m.afterContent === 'string')
    .map(m => lineSimilarity(m.beforeContent, m.afterContent))

  const avgSimilarity = similarities.length
    ? similarities.reduce((sum, n) => sum + n, 0) / similarities.length
    : 1

  const minSimilarity = config.minSemanticSimilarity ?? 0.15
  const maxSimilarity = config.maxSemanticSimilarity ?? 0.98
  const semanticGate = {
    id: 'semantic_edit_distance',
    metric: Number(avgSimilarity.toFixed(3)),
    min: minSimilarity,
    max: maxSimilarity,
    passed: avgSimilarity >= minSimilarity && avgSimilarity <= maxSimilarity,
    detail: similarities.length
      ? `average AST-aware proxy similarity across ${similarities.length} edits`
      : 'no code edits detected',
  }

  const breakingChanges = edits.filter(m => m.apiSignatureChanged === true).length
  const maxBreakingChanges = config.maxBreakingChanges ?? 0
  const apiGate = {
    id: 'api_stability',
    metric: breakingChanges,
    threshold: maxBreakingChanges,
    passed: breakingChanges <= maxBreakingChanges,
    detail: `${breakingChanges} potential public API signature changes`,
  }

  const critique = runCritiquePass({ draftText, config: critiqueConfig })
  const critiqueGate = {
    id: 'critique',
    metric: critique.passed ? 1 : 0,
    threshold: 1,
    passed: critique.passed,
    detail: critique.summary,
    critique,
  }

  const gates = [testGate, semanticGate, apiGate, critiqueGate]
  const failed = gates.filter(g => !g.passed)

  return {
    passed: failed.length === 0,
    gates,
    failedGateIds: failed.map(g => g.id),
    critique,
  }
}

export function detectApiSignatureChange(beforeContent = '', afterContent = '') {
  const sigPattern = /export\s+(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)|export\s+const\s+([\w$]+)\s*=\s*\(([^)]*)\)\s*=>/g
  const serialize = (text) => {
    const out = []
    let match
    while ((match = sigPattern.exec(String(text)))) {
      const name = match[1] || match[3]
      const params = (match[2] || match[4] || '').replace(/\s+/g, '')
      out.push(`${name}(${params})`)
    }
    return out.sort().join('|')
  }
  return serialize(beforeContent) !== serialize(afterContent)
}
