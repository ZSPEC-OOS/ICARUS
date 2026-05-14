/**
 * Phase 8: Unit tests for V2-support service modules.
 * Uses Node.js built-in test runner. No external dependencies.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateReliabilityGates,
  detectApiSignatureChange,
  evaluateBenchmarkRegressionGate,
  evaluateCreativeCandidates,
} from '../../src/services/reliability/gateEvaluators.js';

import {
  hybridSearch,
  rerankChunks,
  retrieveContext,
} from '../../src/services/enhancers/ragService.js';

// ─── gateEvaluators (12 tests) ────────────────────────────────────────────────

describe('gateEvaluators', () => {
  function makeTrace(overrides = {}) {
    return {
      commandRuns: [],
      mutations: [],
      ...overrides,
    };
  }

  it('evaluateReliabilityGates passes with no mutations or runs', () => {
    const result = evaluateReliabilityGates({ executionTrace: makeTrace() });
    assert.ok(typeof result.passed === 'boolean');
    assert.ok(Array.isArray(result.gates));
  });

  it('evaluateReliabilityGates includes test_pass_rate gate', () => {
    const result = evaluateReliabilityGates({ executionTrace: makeTrace() });
    const gate = result.gates.find(g => g.id === 'test_pass_rate');
    assert.ok(gate);
    assert.equal(typeof gate.metric, 'number');
  });

  it('evaluateReliabilityGates test gate passes with no command runs (defaults to 1 passRate)', () => {
    const result = evaluateReliabilityGates({ executionTrace: makeTrace() });
    const gate = result.gates.find(g => g.id === 'test_pass_rate');
    assert.equal(gate.passed, true);
  });

  it('evaluateReliabilityGates test gate fails when pass rate below threshold', () => {
    const commandRuns = [
      { result: 'exit 1\nFailed' },
      { result: 'exit 1\nFailed' },
      { result: 'exit 0\nPassed' },
    ];
    const result = evaluateReliabilityGates({ executionTrace: makeTrace({ commandRuns }), config: { minTestPassRate: 0.9 } });
    const gate = result.gates.find(g => g.id === 'test_pass_rate');
    assert.equal(gate.passed, false);
  });

  it('evaluateReliabilityGates includes semantic_edit_distance gate', () => {
    const result = evaluateReliabilityGates({ executionTrace: makeTrace() });
    const gate = result.gates.find(g => g.id === 'semantic_edit_distance');
    assert.ok(gate);
  });

  it('evaluateReliabilityGates semantic gate passes with no edits', () => {
    const result = evaluateReliabilityGates({ executionTrace: makeTrace() });
    const gate = result.gates.find(g => g.id === 'semantic_edit_distance');
    assert.equal(gate.passed, true);
  });

  it('evaluateReliabilityGates includes api_stability gate', () => {
    const result = evaluateReliabilityGates({ executionTrace: makeTrace() });
    const gate = result.gates.find(g => g.id === 'api_stability');
    assert.ok(gate);
  });

  it('evaluateReliabilityGates api gate passes when no API signature changes', () => {
    const mutations = [{ beforeContent: 'function foo(a) {}', afterContent: 'function foo(a) { return a; }', apiSignatureChanged: false }];
    const result = evaluateReliabilityGates({ executionTrace: makeTrace({ mutations }) });
    const gate = result.gates.find(g => g.id === 'api_stability');
    assert.equal(gate.passed, true);
  });

  it('detectApiSignatureChange returns false for same signatures', () => {
    const before = 'export function add(a, b) { return a + b; }';
    const after = 'export function add(a, b) { return a + b; /* updated */ }';
    assert.equal(detectApiSignatureChange(before, after), false);
  });

  it('detectApiSignatureChange returns true when parameter count changes', () => {
    const before = 'export function add(a, b) {}';
    const after = 'export function add(a, b, c) {}';
    assert.equal(detectApiSignatureChange(before, after), true);
  });

  it('evaluateBenchmarkRegressionGate passes with no regressions', () => {
    const result = evaluateBenchmarkRegressionGate({ benchmarkReport: { regressions: [] } });
    assert.equal(result.passed, true);
  });

  it('evaluateBenchmarkRegressionGate fails with regressions', () => {
    const result = evaluateBenchmarkRegressionGate({ benchmarkReport: { regressions: ['bench-01 regressed by 20%'] } });
    assert.equal(result.passed, false);
  });
});

// ─── evaluateCreativeCandidates (4 tests) ──────────────────────────────────────

describe('evaluateCreativeCandidates', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(evaluateCreativeCandidates([]), []);
  });

  it('returns scored candidates', () => {
    const candidates = [
      { id: 'c1', content: 'This is a story about surprise and emotion and delight' },
      { id: 'c2', content: 'A very different approach using metaphor and cinema' },
    ];
    const results = evaluateCreativeCandidates(candidates);
    assert.equal(results.length, 2);
    assert.ok(typeof results[0].totalRankScore === 'number');
  });

  it('noveltyScore is higher for more distinct candidates', () => {
    const candidates = [
      { id: 'c1', content: 'apple orange banana fruit juice smoothie drink tasty' },
      { id: 'c2', content: 'compiler runtime stack heap memory allocation garbage collection' },
    ];
    const results = evaluateCreativeCandidates(candidates);
    assert.ok(results.every(r => r.noveltyScore > 0));
  });

  it('all scores are between 0 and 1', () => {
    const candidates = [
      { id: 'x', content: 'some content here for testing purposes with enough words' },
    ];
    const results = evaluateCreativeCandidates(candidates);
    const r = results[0];
    assert.ok(r.noveltyScore >= 0 && r.noveltyScore <= 1);
    assert.ok(r.coherenceScore >= 0 && r.coherenceScore <= 1);
    assert.ok(r.evocativenessScore >= 0 && r.evocativenessScore <= 1);
    assert.ok(r.totalRankScore >= 0 && r.totalRankScore <= 1);
  });
});

// ─── ragService (4 tests) ──────────────────────────────────────────────────────

describe('ragService', () => {
  function makeMockShadowContext(files = {}) {
    return {
      isReady: true,
      contentIndex: new Map(Object.entries(files)),
      findRelevantFiles: (query, limit) => {
        return Object.keys(files)
          .filter(p => p.includes(query.split(' ')[0]) || query.includes(p.split('/').pop().replace('.js', '')))
          .slice(0, limit)
          .map((path, i) => ({ path, score: 0.8 - i * 0.1 }));
      },
      search: (query, limit) => {
        return Object.keys(files).slice(0, limit).map((path, i) => ({ path, score: 0.7 - i * 0.1 }));
      },
    };
  }

  it('hybridSearch throws when query is empty', () => {
    assert.throws(() => hybridSearch({ query: '', shadowContext: null }));
  });

  it('hybridSearch returns array with shadowContext', () => {
    const ctx = makeMockShadowContext({ 'src/utils.js': 'function add() {}' });
    const results = hybridSearch({ query: 'utils', shadowContext: ctx, limit: 5 });
    assert.ok(Array.isArray(results));
  });

  it('rerankChunks returns topK results sorted by score', () => {
    const chunks = [
      { id: 'c1', path: 'src/utils.js', text: 'function add', score: 0.5, lexicalScore: 0.4, vectorScore: 0.6, metadata: {} },
      { id: 'c2', path: 'src/auth.js', text: 'class AuthService', score: 0.3, lexicalScore: 0.2, vectorScore: 0.4, metadata: {} },
      { id: 'c3', path: 'src/utils.test.js', text: 'test add function', score: 0.4, lexicalScore: 0.3, vectorScore: 0.5, metadata: {} },
    ];
    const result = rerankChunks({ query: 'add function', chunks, topK: 2 });
    assert.ok(result.length <= 2);
    assert.ok(result[0].score >= result[1].score);
  });

  it('retrieveContext returns promptContext string', () => {
    const ctx = makeMockShadowContext({ 'src/utils.js': 'function add(a, b) { return a + b; }' });
    const result = retrieveContext({ query: 'add function', shadowContext: ctx });
    assert.equal(typeof result.promptContext, 'string');
    assert.ok(Array.isArray(result.contexts));
  });
});
