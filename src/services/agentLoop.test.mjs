// ─── agentLoop unit tests ────────────────────────────────────────────────────
// Tests for the pure utility functions extracted from agentLoop.js.
// Uses Node's built-in test runner (no extra dependencies required).

import test from 'node:test'
import assert from 'node:assert/strict'

// agentLoop imports aiService / localStorage-based modules.  Mock the bare
// minimum so the module loads cleanly in a Node environment.
const store = {}
global.localStorage = {
  getItem:    (k)    => store[k] ?? null,
  setItem:    (k, v) => { store[k] = v },
  removeItem: (k)    => { delete store[k] },
  clear:      ()     => { Object.keys(store).forEach(k => delete store[k]) },
}
global.performance = global.performance ?? { now: () => Date.now() }
// globalThis.crypto is already available in Node 18+; no override needed

// Stub out the heavy imports agentLoop.js pulls in at module level.
// We only want to test the pure helper exports.
import { toolSignature, pruneMessages, makeSessionDiary } from './agentLoop.js'

// ── toolSignature ─────────────────────────────────────────────────────────────

test('toolSignature produces a stable sorted key', () => {
  const calls = [
    { name: 'read_file',   input: { path: 'src/app.js' } },
    { name: 'list_directory', input: { path: 'src' } },
  ]
  const sig = toolSignature(calls)
  assert.equal(typeof sig, 'string')
  // order should be lexicographic by name:result
  assert.ok(sig.startsWith('list_directory:'))
})

test('toolSignature is deterministic regardless of call order', () => {
  const a = [{ name: 'z_tool', input: {} }, { name: 'a_tool', input: {} }]
  const b = [{ name: 'a_tool', input: {} }, { name: 'z_tool', input: {} }]
  assert.equal(toolSignature(a), toolSignature(b))
})

test('toolSignature truncates long inputs at 100 chars', () => {
  const longVal = 'x'.repeat(200)
  const calls = [{ name: 'read_file', input: { path: longVal } }]
  const sig = toolSignature(calls)
  // The input portion of the signature should be at most 100 chars
  const inputPart = sig.split(':').slice(1).join(':')
  assert.ok(inputPart.length <= 100)
})

test('toolSignature with identical calls produces the same signature', () => {
  const calls = [{ name: 'grep', input: { pattern: 'foo' } }]
  assert.equal(toolSignature(calls), toolSignature(calls))
})

// ── pruneMessages ─────────────────────────────────────────────────────────────

function makeMsg(role, content = 'x') { return { role, content } }

// AGENT_KEEP_TURNS = 10, so keep = 20 tail messages.
// head = first 2 messages (system + first user).
const HEAD = [makeMsg('system', 'system'), makeMsg('user', 'task')]

test('pruneMessages returns unchanged when tail is within keep window', () => {
  const short = [...HEAD, makeMsg('assistant'), makeMsg('user')]
  assert.deepEqual(pruneMessages(short), short)
})

test('pruneMessages drops middle turns when tail exceeds keep window', () => {
  // Build 30 tail messages (> 20 keep window)
  const tail = Array.from({ length: 30 }, (_, i) => makeMsg(i % 2 === 0 ? 'assistant' : 'user', String(i)))
  const msgs = [...HEAD, ...tail]
  const pruned = pruneMessages(msgs)
  // Head preserved
  assert.deepEqual(pruned.slice(0, 2), HEAD)
  // Total length ≤ head(2) + keep(20)
  assert.ok(pruned.length <= 22)
})

test('pruneMessages injects diary digest when diary has content', () => {
  const diary = makeSessionDiary()
  diary.onFileRead('src/app.js')
  const tail = Array.from({ length: 30 }, (_, i) => makeMsg(i % 2 === 0 ? 'assistant' : 'user', String(i)))
  const msgs = [...HEAD, ...tail]
  const pruned = pruneMessages(msgs, diary)
  // Third message (after head[0], head[1]) should be the digest
  assert.equal(pruned[2].role, 'user')
  assert.ok(pruned[2].content.includes('SESSION DIGEST'))
})

test('pruneMessages skips leading tool messages for non-Anthropic format', () => {
  // In non-Anthropic (OpenAI) format, the pruned tail must not start with a
  // 'tool' role message, because tool messages must follow an assistant message.
  const tail = [
    makeMsg('tool', 'result-of-stale-tool'),   // would be orphaned
    makeMsg('assistant', 'got it'),
    ...Array.from({ length: 20 }, (_, i) => makeMsg(i % 2 === 0 ? 'user' : 'assistant', String(i))),
  ]
  const msgs = [...HEAD, ...tail]
  const pruned = pruneMessages(msgs, null, false /* isAnthropic=false */)
  // The first tail message in the result must not be 'tool'
  const firstTail = pruned.slice(2).find(m => m.role !== 'system' && m.role !== 'user' || pruned.indexOf(m) > 1)
  const tailSection = pruned.slice(2)
  assert.notEqual(tailSection[0]?.role, 'tool')
})

// ── makeSessionDiary ──────────────────────────────────────────────────────────

test('makeSessionDiary hasContent is false when empty', () => {
  const diary = makeSessionDiary()
  assert.equal(diary.hasContent(), false)
})

test('makeSessionDiary hasContent is true after file read', () => {
  const diary = makeSessionDiary()
  diary.onFileRead('README.md')
  assert.equal(diary.hasContent(), true)
})

test('makeSessionDiary buildDigest lists files read and changed', () => {
  const diary = makeSessionDiary()
  diary.onFileRead('src/a.js')
  diary.onFileWrite('src/b.js', 'edit')
  const digest = diary.buildDigest(3)
  assert.ok(digest.includes('SESSION DIGEST'))
  assert.ok(digest.includes('src/a.js'))
  assert.ok(digest.includes('src/b.js'))
  assert.ok(digest.includes('3 earlier turn'))
})

test('makeSessionDiary deduplicates files read', () => {
  const diary = makeSessionDiary()
  diary.onFileRead('src/a.js')
  diary.onFileRead('src/a.js')
  diary.onFileRead('src/a.js')
  const digest = diary.buildDigest(1)
  // 'src/a.js' should only appear once in the files-read line
  const readLine = digest.split('\n').find(l => l.startsWith('Files read:'))
  const count = (readLine?.match(/src\/a\.js/g) || []).length
  assert.equal(count, 1)
})
