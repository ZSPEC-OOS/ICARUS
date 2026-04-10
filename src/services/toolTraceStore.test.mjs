// ─── toolTraceStore unit tests ────────────────────────────────────────────────
// Verifies beginToolTrace / endToolTrace / getTraceById lifecycle, the age-based
// pruning gate (pruneByAge is internal; tested via the write cycle), and
// traceOrchestrationDecision.

import test from 'node:test'
import assert from 'node:assert/strict'

// ── localStorage mock ─────────────────────────────────────────────────────────

const _store = {}
global.localStorage = {
  getItem:    (k)    => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = v },
  removeItem: (k)    => { delete _store[k] },
  clear:      ()     => { Object.keys(_store).forEach(k => delete _store[k]) },
}
global.performance = global.performance ?? { now: () => Date.now() }

function clearStore() {
  Object.keys(_store).forEach(k => delete _store[k])
}

import {
  beginToolTrace,
  endToolTrace,
  setTraceLoopState,
  getTraceById,
  traceOrchestrationDecision,
} from './toolTraceStore.js'
import { KEYS } from '../shared/storageKeys.js'

const TRACE_KEY = KEYS.LS.TOOL_TRACES

// ── beginToolTrace / endToolTrace / getTraceById lifecycle ────────────────────

test('beginToolTrace creates a started entry and returns a traceId', () => {
  clearStore()
  const { traceId } = beginToolTrace('read_file', { path: 'src/app.js' })
  assert.ok(typeof traceId === 'string')
  assert.ok(traceId.startsWith('trace_'))

  const raw = localStorage.getItem(TRACE_KEY) || ''
  const lines = raw.split('\n').filter(Boolean)
  const entry = JSON.parse(lines[lines.length - 1])
  assert.equal(entry.traceId, traceId)
  assert.equal(entry.toolName, 'read_file')
  assert.equal(entry.status, 'started')
  assert.equal(entry.input.path, 'src/app.js')
})

test('endToolTrace records result with duration and ok status', () => {
  clearStore()
  const { traceId, startedAt } = beginToolTrace('grep', { pattern: 'useState' })
  endToolTrace({ traceId, toolName: 'grep', input: { pattern: 'useState' }, output: 'line 42: useState', error: null, startedAt })

  const completed = getTraceById(traceId)
  assert.equal(completed.status, 'ok')
  assert.equal(completed.toolName, 'grep')
  assert.ok(typeof completed.durationMs === 'number')
  assert.ok(completed.durationMs >= 0)
})

test('endToolTrace records error status when error is provided', () => {
  clearStore()
  const { traceId, startedAt } = beginToolTrace('write_file', { path: 'broken.js' })
  endToolTrace({ traceId, toolName: 'write_file', input: { path: 'broken.js' }, output: null, error: 'permission denied', startedAt })

  const completed = getTraceById(traceId)
  assert.equal(completed.status, 'error')
  assert.equal(completed.error, 'permission denied')
})

test('getTraceById returns null for unknown traceId', () => {
  clearStore()
  const result = getTraceById('trace_nonexistent_xyz')
  assert.equal(result, null)
})

// ── setTraceLoopState ─────────────────────────────────────────────────────────

test('setTraceLoopState attaches loop state to subsequent trace entries', () => {
  clearStore()
  setTraceLoopState({ turn: 3, phase: 'execute' })
  const { traceId } = beginToolTrace('list_directory', { path: 'src' })
  setTraceLoopState(null)   // reset so later tests are clean

  const raw = localStorage.getItem(TRACE_KEY) || ''
  const lines = raw.split('\n').filter(Boolean)
  const entry = JSON.parse(lines[lines.length - 1])
  assert.equal(entry.traceId, traceId)
  assert.equal(entry.loopState?.turn, 3)
  assert.equal(entry.loopState?.phase, 'execute')
})

// ── Age-based pruning (pruneByAge called inside writeLines) ───────────────────

test('old entries are pruned when new entries are written', () => {
  clearStore()

  // Manually insert JSONL entries with timestamps older than TRACE_MAX_AGE_DAYS
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
  const staleEntry = JSON.stringify({
    traceId: 'trace_stale_001',
    type: 'tool_call',
    toolName: 'read_file',
    input: {},
    status: 'ok',
    timestamp: oldTimestamp,
  })
  localStorage.setItem(TRACE_KEY, staleEntry)

  // Trigger a write by recording a new trace — this calls writeLines → pruneByAge
  beginToolTrace('list_directory', { path: '.' })

  const raw = localStorage.getItem(TRACE_KEY) || ''
  const lines = raw.split('\n').filter(Boolean)
  const traceIds = lines.map(l => { try { return JSON.parse(l).traceId } catch { return null } }).filter(Boolean)

  assert.ok(!traceIds.includes('trace_stale_001'), 'Stale entry should have been pruned')
})

test('entries without timestamps are kept during age pruning', () => {
  clearStore()

  // An entry with no timestamp field — should be preserved
  const noTsEntry = JSON.stringify({ traceId: 'trace_no_ts', toolName: 'grep', status: 'ok' })
  localStorage.setItem(TRACE_KEY, noTsEntry)

  beginToolTrace('read_file', { path: 'src/app.js' })

  const raw = localStorage.getItem(TRACE_KEY) || ''
  const traceIds = raw.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l).traceId } catch { return null } })
    .filter(Boolean)

  assert.ok(traceIds.includes('trace_no_ts'), 'Entry without timestamp should be kept')
})

test('malformed JSONL lines are dropped during write', () => {
  clearStore()

  const malformed = 'not valid json at all\n' + JSON.stringify({ traceId: 'trace_valid', status: 'ok' })
  localStorage.setItem(TRACE_KEY, malformed)

  // Writing triggers pruneByAge which drops malformed lines
  beginToolTrace('grep', { pattern: 'foo' })

  const raw = localStorage.getItem(TRACE_KEY) || ''
  const lines = raw.split('\n').filter(Boolean)
  // The 'not valid json' line should be gone
  assert.ok(!lines.some(l => l.startsWith('not valid')))
})

// ── traceOrchestrationDecision ────────────────────────────────────────────────

test('traceOrchestrationDecision records a decision entry with correct type', () => {
  clearStore()
  const traceId = traceOrchestrationDecision({
    taskSnippet: 'Fix the login bug',
    role: 'debugger',
    confidence: 0.88,
    strategy: 'fallback',
    modelId: 'model-a',
    reasoning: 'High debugger confidence',
    scores: { debugger: 0.88, planner: 0.3 },
    durationMs: 42,
  })

  assert.ok(typeof traceId === 'string')

  const raw = localStorage.getItem(TRACE_KEY) || ''
  const lines = raw.split('\n').filter(Boolean)
  const entry = JSON.parse(lines[lines.length - 1])
  assert.equal(entry.type, 'orchestration_decision')
  assert.equal(entry.role, 'debugger')
  assert.equal(entry.modelId, 'model-a')
  assert.equal(entry.durationMs, 42)
})
