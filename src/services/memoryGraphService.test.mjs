// ─── memoryGraphService unit tests ───────────────────────────────────────────
// Covers LRU eviction (_enforceNodeCap, _enforceEdgeCap), querySemantic, and
// upsertNode/upsertEdge merge behaviour.
//
// localStorage is not available in Node, but MemoryGraphService guards every
// access with `if (typeof localStorage === 'undefined') return`, so the module
// runs in pure in-memory mode during tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import { memoryGraphService as svc } from './memoryGraphService.js'
import { MEMORY_MAX_NODES, MEMORY_MAX_EDGES, MEMORY_VECTOR_DIM } from '../config/constants.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetService() {
  svc.nodes.clear()
  svc.edges.clear()
  svc._loaded = true      // skip localStorage load on next init()
  clearTimeout(svc._flushTimer)
  svc._dirty = false
}

function addNode(id, updatedAt = new Date().toISOString()) {
  svc.nodes.set(id, {
    id,
    type: 'module',
    title: id,
    path: null,
    summary: `summary for ${id}`,
    tags: [],
    evidence: [],
    metadata: {},
    createdAt: updatedAt,
    updatedAt,
    embedding: [],
  })
}

function addEdge(id, from, to, updatedAt = new Date().toISOString()) {
  svc.edges.set(id, { id, from, to, type: 'dependency', weight: 1, evidence: [], createdAt: updatedAt, updatedAt, metadata: {} })
}

// ── upsertNode ────────────────────────────────────────────────────────────────

test('upsertNode creates a node with merged tags and evidence', () => {
  resetService()
  svc.upsertNode({ id: 'n1', title: 'N1', summary: 'first', tags: ['a'], evidence: ['e1'] })
  svc.upsertNode({ id: 'n1', tags: ['b'], evidence: ['e2'] })
  const node = svc.nodes.get('n1')
  assert.ok(node.tags.includes('a'))
  assert.ok(node.tags.includes('b'))
  assert.ok(node.evidence.includes('e1'))
  assert.ok(node.evidence.includes('e2'))
})

test('upsertNode preserves createdAt on subsequent updates', () => {
  resetService()
  svc.upsertNode({ id: 'n2', title: 'N2', summary: 's' })
  const created = svc.nodes.get('n2').createdAt
  svc.upsertNode({ id: 'n2', summary: 'updated' })
  assert.equal(svc.nodes.get('n2').createdAt, created)
})

// ── _enforceNodeCap (LRU eviction) ───────────────────────────────────────────

test('_enforceNodeCap evicts oldest ~10% of nodes when cap exceeded', () => {
  resetService()

  const CAP = MEMORY_MAX_NODES

  // Add CAP + 10 nodes.  The first 10 get an old timestamp so they're evicted.
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
  for (let i = 0; i < 10; i++) addNode(`old-${i}`, oldDate)
  for (let i = 0; i < CAP; i++) addNode(`new-${i}`)   // fills up to CAP + 10 total

  svc._enforceNodeCap()

  assert.ok(svc.nodes.size <= CAP, `Expected ≤ ${CAP} nodes, got ${svc.nodes.size}`)
  // The old nodes should have been evicted first
  for (let i = 0; i < 10; i++) {
    assert.equal(svc.nodes.has(`old-${i}`), false, `old-${i} should have been evicted`)
  }
})

test('_enforceNodeCap is a no-op when under the cap', () => {
  resetService()
  addNode('n1')
  addNode('n2')
  svc._enforceNodeCap()
  assert.equal(svc.nodes.size, 2)
})

// ── _enforceEdgeCap (LRU eviction) ───────────────────────────────────────────

test('_enforceEdgeCap evicts oldest ~10% of edges when cap exceeded', () => {
  resetService()

  const CAP = MEMORY_MAX_EDGES

  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
  for (let i = 0; i < 10; i++) addEdge(`old-e${i}`, `a${i}`, `b${i}`, oldDate)
  for (let i = 0; i < CAP; i++) addEdge(`new-e${i}`, `x${i}`, `y${i}`)

  svc._enforceEdgeCap()

  assert.ok(svc.edges.size <= CAP, `Expected ≤ ${CAP} edges, got ${svc.edges.size}`)
  for (let i = 0; i < 10; i++) {
    assert.equal(svc.edges.has(`old-e${i}`), false, `old-e${i} should have been evicted`)
  }
})

// ── querySemantic ─────────────────────────────────────────────────────────────

test('querySemantic returns empty array for empty graph', () => {
  resetService()
  const results = svc.querySemantic({ query: 'auth middleware' })
  assert.deepEqual(results, [])
})

test('querySemantic returns empty for blank query', () => {
  resetService()
  svc.upsertNode({ id: 'x', title: 'auth', summary: 'handles authentication', tags: [] })
  const results = svc.querySemantic({ query: '   ' })
  assert.deepEqual(results, [])
})

test('querySemantic returns relevant nodes sorted by descending score', () => {
  resetService()
  svc.upsertNode({ id: 'auth',    title: 'auth middleware',     summary: 'authenticate and authorise users', tags: ['auth', 'security'] })
  svc.upsertNode({ id: 'logger',  title: 'logger utility',      summary: 'logs requests to stdout', tags: ['logging'] })
  svc.upsertNode({ id: 'router',  title: 'express router',      summary: 'handles HTTP route definitions', tags: ['routing'] })

  const results = svc.querySemantic({ query: 'authentication security' })
  assert.ok(results.length > 0)
  // Results must be in descending score order
  for (let i = 0; i < results.length - 1; i++) {
    assert.ok(results[i].score >= results[i + 1].score, 'Results should be sorted descending by score')
  }
  // The auth node should score highest
  assert.equal(results[0].id, 'auth')
})

test('querySemantic respects types filter', () => {
  resetService()
  svc.upsertNode({ id: 'api1',   title: 'api helper', summary: 'http api utils', tags: [], type: 'api' })
  svc.upsertNode({ id: 'mod1',   title: 'api module',  summary: 'http api calls', tags: [], type: 'module' })

  const results = svc.querySemantic({ query: 'api http', types: ['api'] })
  assert.ok(results.every(r => r.type === 'api'))
})

test('querySemantic respects limit parameter', () => {
  resetService()
  for (let i = 0; i < 20; i++) {
    svc.upsertNode({ id: `auth-${i}`, title: `auth module ${i}`, summary: 'authentication token validator', tags: ['auth'] })
  }
  const results = svc.querySemantic({ query: 'authentication', limit: 3 })
  assert.ok(results.length <= 3)
})

// ── embedText quality (dual-hash + bigrams + stopword penalty) ────────────────
// These tests exercise the embedding indirectly via querySemantic.
// They verify that the improved embedText produces meaningfully better rankings
// than a naive all-equal embedding would give us.

test('querySemantic ranks exact-phrase match above unrelated content', () => {
  resetService()
  svc.upsertNode({ id: 'target', title: 'agent loop orchestration', summary: 'runAgentLoop controls agent execution', tags: ['agent', 'loop'] })
  svc.upsertNode({ id: 'noise1', title: 'database migration', summary: 'alters postgres schema', tags: ['db'] })
  svc.upsertNode({ id: 'noise2', title: 'user interface panel', summary: 'renders the sidebar', tags: ['ui'] })

  const results = svc.querySemantic({ query: 'agent loop execution' })
  assert.ok(results.length > 0, 'should return at least one result')
  assert.equal(results[0].id, 'target', `expected target first, got ${results[0].id}`)
})

test('querySemantic bigram signal: "write_file" outscores unrelated entries', () => {
  resetService()
  svc.upsertNode({ id: 'file-writer', title: 'write_file tool',  summary: 'write file content to disk via executor', tags: ['write_file', 'tool'] })
  svc.upsertNode({ id: 'auth-mod',   title: 'authentication',    summary: 'validates jwt tokens and sessions', tags: ['auth'] })

  const results = svc.querySemantic({ query: 'write file disk' })
  assert.ok(results.length > 0)
  assert.equal(results[0].id, 'file-writer', `expected file-writer first, got ${results[0].id}`)
})

test('embedText: stop-word-heavy query still resolves correctly', () => {
  // "the is and for" are all stop words; the query should still work
  // by falling back to the non-stop-word token overlap score.
  resetService()
  svc.upsertNode({ id: 'useful',    title: 'memory graph service', summary: 'stores and queries semantic graph nodes', tags: ['memory'] })
  svc.upsertNode({ id: 'unrelated', title: 'static css bundle',    summary: 'minified stylesheet for production', tags: ['css'] })

  const results = svc.querySemantic({ query: 'the graph is for storing and querying nodes' })
  // Despite heavy stop words the semantic tokens (graph, storing, querying, nodes) should win
  assert.ok(results.length > 0)
  assert.equal(results[0].id, 'useful', `expected useful first, got ${results[0].id}`)
})

test('embedding vector has correct dimensionality', () => {
  resetService()
  svc.upsertNode({ id: 'dim-test', title: 'dimensionality check', summary: 'test node', tags: [] })
  const node = svc.nodes.get('dim-test')
  assert.equal(node.embedding.length, MEMORY_VECTOR_DIM, `expected ${MEMORY_VECTOR_DIM} dims`)
})

test('embedding vector is L2-normalised (magnitude ≈ 1)', () => {
  resetService()
  svc.upsertNode({ id: 'norm-test', title: 'normalisation check', summary: 'authentication session token jwt', tags: ['auth'] })
  const { embedding } = svc.nodes.get('norm-test')
  const mag = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0))
  // Allow ±0.01 floating-point tolerance
  assert.ok(Math.abs(mag - 1.0) < 0.01, `expected magnitude ≈ 1, got ${mag.toFixed(4)}`)
})
