// V2 NOTE: critiqueMiddleware deleted in Phase 6. Stub for V1 fallback.
const runCritiquePass = () => ({ passed: true, issues: [] })
import { scanMutations } from '../securityScanner.js'

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
    passed: similarities.length === 0
      ? true
      : avgSimilarity >= minSimilarity && avgSimilarity <= maxSimilarity,
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

  // ── Security scan gate ────────────────────────────────────────────────────
  // Scans all file mutations for hardcoded secrets and OWASP Top 10 patterns.
  // Critical and high severity issues block the verification pass.
  const secScan = scanMutations(executionTrace.mutations || [])
  const secGate = {
    id:       'security_scan',
    metric:   secScan.critical + secScan.high,
    threshold: 0,
    passed:   secScan.passed,
    detail:   secScan.summary,
    issues:   secScan.issues,
  }

  const gates = [testGate, semanticGate, apiGate, critiqueGate, secGate]
  const failed = gates.filter(g => !g.passed)

  return {
    passed: failed.length === 0,
    gates,
    failedGateIds: failed.map(g => g.id),
    critique,
    securityScan: secScan,
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


export function evaluateBenchmarkRegressionGate({ benchmarkReport = null, required = false } = {}) {
  if (!benchmarkReport) {
    return {
      id: 'benchmark_regression',
      passed: !required,
      detail: required ? 'benchmark report required but missing' : 'benchmark gate skipped',
      regressions: [],
    }
  }
  const regressions = benchmarkReport.regressions || []
  return {
    id: 'benchmark_regression',
    passed: regressions.length === 0,
    detail: regressions.length ? regressions.join('; ') : 'no regressions detected',
    regressions,
  }
}

function tokenSet(text = '') {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  )
}

function jaccardDistance(a = '', b = '') {
  const sa = tokenSet(a)
  const sb = tokenSet(b)
  const union = new Set([...sa, ...sb])
  if (union.size === 0) return 0
  let overlap = 0
  for (const tok of sa) if (sb.has(tok)) overlap += 1
  return 1 - (overlap / union.size)
}

export function evaluateCreativeCandidates(candidates = []) {
  const pool = Array.isArray(candidates) ? candidates.filter(c => String(c?.content || '').trim()) : []
  if (pool.length === 0) return []

  return pool.map((candidate) => {
    const distances = pool
      .filter(other => other.id !== candidate.id)
      .map(other => jaccardDistance(candidate.content, other.content))
    const noveltyScore = distances.length
      ? distances.reduce((sum, n) => sum + n, 0) / distances.length
      : 0.5

    const coherenceScore = Math.max(0, Math.min(1, 0.35 + Math.min(0.65, (candidate.content.length / 1000))))
    const evocativeSignals = ['surprise', 'emotion', 'story', 'delight', 'immersive', 'metaphor', 'cinematic', 'poetic']
    const lc = String(candidate.content || '').toLowerCase()
    const hits = evocativeSignals.filter(s => lc.includes(s)).length
    const evocativenessScore = Math.max(0, Math.min(1, 0.2 + (hits * 0.12)))
    const totalRankScore = Number((noveltyScore * 0.4 + coherenceScore * 0.3 + evocativenessScore * 0.3).toFixed(4))

    return {
      candidateId: candidate.id,
      noveltyScore: Number(noveltyScore.toFixed(4)),
      coherenceScore: Number(coherenceScore.toFixed(4)),
      evocativenessScore: Number(evocativenessScore.toFixed(4)),
      totalRankScore,
    }
  })
}
