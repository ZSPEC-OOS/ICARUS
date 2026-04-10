// ─── rationaleService unit tests ─────────────────────────────────────────────
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseDiffHunks,
  computeOverallConfidence,
  computeDiffRationale,
  confidenceClass,
  formatConfidence,
} from './rationaleService.js'

// ── parseDiffHunks ────────────────────────────────────────────────────────────

const SAMPLE_DIFF = `@@ -1,3 +1,4 @@
 unchanged
-old line
+new line a
+new line b
 context
@@ -10,2 +11,2 @@
-removed
+replaced`

test('parseDiffHunks returns one hunk per @@ header', () => {
  const hunks = parseDiffHunks(SAMPLE_DIFF)
  assert.equal(hunks.length, 2)
})

test('parseDiffHunks counts additions and deletions correctly', () => {
  const hunks = parseDiffHunks(SAMPLE_DIFF)
  // First hunk: 2 additions, 1 deletion
  assert.equal(hunks[0].addCount, 2)
  assert.equal(hunks[0].delCount, 1)
  // Second hunk: 1 addition, 1 deletion
  assert.equal(hunks[1].addCount, 1)
  assert.equal(hunks[1].delCount, 1)
})

test('parseDiffHunks returns empty array for empty input', () => {
  assert.deepEqual(parseDiffHunks(''), [])
  assert.deepEqual(parseDiffHunks(), [])
})

test('parseDiffHunks preserves hunk header lines', () => {
  const hunks = parseDiffHunks(SAMPLE_DIFF)
  assert.ok(hunks[0].header.startsWith('@@'))
})

test('parseDiffHunks does not count +++ or --- as content lines', () => {
  const diff = `--- a/foo.js\n+++ b/foo.js\n@@ -1,1 +1,1 @@\n-old\n+new`
  const [hunk] = parseDiffHunks(diff)
  assert.equal(hunk.addCount, 1)
  assert.equal(hunk.delCount, 1)
})

// ── computeOverallConfidence ──────────────────────────────────────────────────

test('computeOverallConfidence returns orchestration confidence as baseline', () => {
  const score = computeOverallConfidence({ orchestration: { confidence: 0.9 } })
  assert.ok(score <= 1.0 && score > 0)
  // No penalties — should be close to 0.9
  assert.ok(score >= 0.85)
})

test('computeOverallConfidence penalises failed reliability gates', () => {
  const clean = computeOverallConfidence({ orchestration: { confidence: 0.8 } })
  const gated = computeOverallConfidence({
    orchestration: { confidence: 0.8 },
    verification: { gates: [{ id: 'g1', passed: false }, { id: 'g2', passed: false }] },
  })
  assert.ok(gated < clean)
})

test('computeOverallConfidence penalises failed critique', () => {
  const clean  = computeOverallConfidence({ orchestration: { confidence: 0.8 } })
  const withCritique = computeOverallConfidence({
    orchestration: { confidence: 0.8 },
    critique: { passed: false, issues: ['incomplete output'] },
  })
  assert.ok(withCritique < clean)
})

test('computeOverallConfidence penalises fallback model usage', () => {
  const primary  = computeOverallConfidence({ orchestration: { confidence: 0.8 } })
  const fallback = computeOverallConfidence({ orchestration: { confidence: 0.8 }, usedFallback: true })
  assert.ok(fallback < primary)
})

test('computeOverallConfidence never returns below 0.05 or above 1.0', () => {
  const worst = computeOverallConfidence({
    orchestration: { confidence: 0.0 },
    verification: { gates: [{ passed: false }, { passed: false }, { passed: false }] },
    critique: { passed: false, issues: ['a', 'b', 'c', 'd'] },
    usedFallback: true,
  })
  assert.ok(worst >= 0.05, `score ${worst} below floor`)
  assert.ok(worst <= 1.0)
})

// ── computeDiffRationale ─────────────────────────────────────────────────────

test('computeDiffRationale returns overallConfidence, hunks, and summary', () => {
  const result = computeDiffRationale({
    diffText: SAMPLE_DIFF,
    orchestration: { role: 'refactorer', confidence: 0.85, strategy: 'fallback', modelId: 'claude-3-haiku' },
  })
  assert.ok(typeof result.overallConfidence === 'number')
  assert.ok(Array.isArray(result.hunks))
  assert.equal(result.hunks.length, 2)
  assert.ok(typeof result.summary === 'string')
})

test('computeDiffRationale annotates each hunk with confidence and rationale', () => {
  const result = computeDiffRationale({ diffText: SAMPLE_DIFF })
  for (const hunk of result.hunks) {
    assert.ok(typeof hunk.confidence === 'number', 'hunk.confidence missing')
    assert.ok(typeof hunk.rationale  === 'string',  'hunk.rationale missing')
    assert.ok(hunk.confidence >= 0.05 && hunk.confidence <= 1.0)
  }
})

test('computeDiffRationale summary includes role label when orchestration present', () => {
  const { summary } = computeDiffRationale({
    diffText: SAMPLE_DIFF,
    orchestration: { role: 'debugger', confidence: 0.7, strategy: 'single' },
  })
  assert.ok(summary.toLowerCase().includes('debugger'))
})

test('computeDiffRationale summary flags failed gates', () => {
  const { summary } = computeDiffRationale({
    diffText: SAMPLE_DIFF,
    verification: { failedGateIds: ['quality_floor'], gates: [{ id: 'quality_floor', passed: false }] },
  })
  assert.ok(summary.includes('quality_floor'))
})

test('computeDiffRationale summary flags critique issues', () => {
  const { summary } = computeDiffRationale({
    diffText: SAMPLE_DIFF,
    critique: { passed: false, issues: ['missing error handling'] },
  })
  assert.ok(summary.includes('critique'))
})

test('computeDiffRationale hunk rationale includes memory hits', () => {
  const { hunks } = computeDiffRationale({
    diffText: SAMPLE_DIFF,
    memoryHits: [{ title: 'authService', type: 'module', score: 0.9, path: 'src/authService.js' }],
  })
  assert.ok(hunks[0].rationale.includes('authService'))
})

test('computeDiffRationale handles empty diff gracefully', () => {
  const result = computeDiffRationale({ diffText: '' })
  assert.deepEqual(result.hunks, [])
  assert.ok(typeof result.overallConfidence === 'number')
})

// ── confidenceClass ───────────────────────────────────────────────────────────

test('confidenceClass returns conf-high for ≥0.75', () => {
  assert.equal(confidenceClass(0.75), 'conf-high')
  assert.equal(confidenceClass(1.00), 'conf-high')
})

test('confidenceClass returns conf-med for 0.50–0.74', () => {
  assert.equal(confidenceClass(0.50), 'conf-med')
  assert.equal(confidenceClass(0.74), 'conf-med')
})

test('confidenceClass returns conf-low below 0.50', () => {
  assert.equal(confidenceClass(0.0),  'conf-low')
  assert.equal(confidenceClass(0.49), 'conf-low')
})

// ── formatConfidence ──────────────────────────────────────────────────────────

test('formatConfidence rounds to nearest percent', () => {
  assert.equal(formatConfidence(0.856), '86%')
  assert.equal(formatConfidence(0.0),   '0%')
  assert.equal(formatConfidence(1.0),   '100%')
})
