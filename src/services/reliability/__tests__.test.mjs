import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateReliabilityGates, detectApiSignatureChange, evaluateCreativeCandidates } from './gateEvaluators.js'
import { createReliabilityLoopFSM, RELIABILITY_STATES } from './fsm.js'

test('detectApiSignatureChange detects export signature mutations', () => {
  const before = 'export function run(a, b) { return a + b }'
  const after = 'export function run(a, b, c) { return a + b + c }'
  assert.equal(detectApiSignatureChange(before, after), true)
})

test('evaluateReliabilityGates passes for strong metrics', () => {
  const report = evaluateReliabilityGates({
    executionTrace: {
      commandRuns: [{ result: 'exit 0\nall good' }],
      mutations: [{ beforeContent: 'export function a(x){}', afterContent: 'export function a(x){ return x }', apiSignatureChanged: false }],
    },
    draftText: 'Implemented task with complete output.',
    critiqueConfig: { enabled: true },
    config: { minTestPassRate: 0.5, minSemanticSimilarity: 0, maxSemanticSimilarity: 1 },
  })
  assert.equal(report.passed, true)
})

test('fsm executes rollback path on verify failure', async () => {
  const transitions = []
  const fsm = createReliabilityLoopFSM({
    task: 'demo',
    onEvent: (ev) => { if (ev.type === 'fsm_state') transitions.push(ev.state) },
    handlers: {
      plan: async () => ({ ok: true }),
      execute: async () => ({ mutationTrace: [{ path: 'a.js' }] }),
      verify: async () => ({ passed: false, failedGateIds: ['critique'] }),
      rollback: async () => ({ rolledBack: true, strategy: 'patch_undo' }),
    },
  })
  const out = await fsm.run()
  assert.equal(out.current, RELIABILITY_STATES.DONE)
  assert.deepEqual(transitions, ['plan', 'execute', 'verify', 'rollback', 'done'])
})

test('evaluateReliabilityGates passes for zero-edit (read-only) tasks', () => {
  const report = evaluateReliabilityGates({
    executionTrace: { commandRuns: [], mutations: [] },
    draftText: 'Analysis complete, no files changed.',
    critiqueConfig: { enabled: true },
    config: {},
  })
  const semanticGate = report.gates.find(g => g.id === 'semantic_edit_distance')
  assert.equal(semanticGate.passed, true, 'semantic gate should pass when no edits')
  assert.equal(semanticGate.detail, 'no code edits detected')
})

test('evaluateCreativeCandidates ranks candidates with expected shape', () => {
  const ranked = evaluateCreativeCandidates([
    { id: 'a', content: 'A cinematic immersive story with metaphor and surprise.' },
    { id: 'b', content: 'A minimal dashboard layout with strict utility.' },
  ])
  assert.equal(ranked.length, 2)
  assert.equal(typeof ranked[0].noveltyScore, 'number')
  assert.equal(typeof ranked[0].coherenceScore, 'number')
  assert.equal(typeof ranked[0].evocativenessScore, 'number')
  assert.equal(typeof ranked[0].totalRankScore, 'number')
})
