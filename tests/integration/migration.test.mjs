/**
 * tests/integration/migration.test.mjs
 * Integration tests for V1/V2 routing and fallback behavior.
 *
 * These tests verify the migration routing logic — which engine path executes,
 * when fallback triggers, and how flags compose — using the actual V2 engine
 * with mock callbacks (no real LLM or filesystem I/O).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Browser Global Setup ─────────────────────────────────────────────────────

class MockStorage {
  constructor() { this._store = {}; }
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._store, k) ? this._store[k] : null; }
  setItem(k, v) { this._store[k] = String(v); }
  removeItem(k) { delete this._store[k]; }
}

global.window = { location: { href: 'http://localhost/' } };
global.localStorage = new MockStorage();

// ─── Module Imports ───────────────────────────────────────────────────────────

const { getFeatureFlags, getMigrationStatus } = await import('../../src/config/featureFlags.js');
const { runTask } = await import('../../src/core-v2/taskRunner.js');
const { createMockCallbacks, createMockExecutor, createMockFileSystem, createScriptedLLM } =
  await import('../benchmarks/benchmarkRunner.mjs');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePlan(taskId = 'int-test', deliverables = null) {
  return {
    version: '2026.1',
    taskId,
    goal: 'Create src/output.js',
    deliverables: deliverables ?? [
      { id: 'd1', type: 'file', path: 'src/output.js', description: 'Output module', acceptanceCriteria: 'ok' },
    ],
    dependencies: [],
    validationSteps: [],
    estimatedCycles: 1,
    contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
  };
}

function makeTaskSpec(taskId, plan, opts = {}) {
  return {
    taskId,
    goal: plan.goal,
    plan,
    options: {
      maxCycles: 2,
      maxTurnsPerCycle: 10,
      contextWindow: 32000,
      requirePlanReview: false,
      requireCompletionConfirm: false,
      ...opts,
    },
  };
}

const CYCLE_DONE = `## summary\nDone.\n\n## deliverables_addressed\n- src/output.js: written\n\n## next_cycle_needed\nNo.\n\n<CYCLE_COMPLETE>`;

// ─── Test 1: V1 Path (flag-level check) ───────────────────────────────────────

describe('V1 path: flag resolution', () => {
  beforeEach(() => {
    global.window = { location: { href: 'http://localhost/' } };
    global.localStorage = new MockStorage();
  });

  it('returns v1_only when all flags are default', () => {
    assert.equal(getMigrationStatus(), 'v1_only');
    const f = getFeatureFlags();
    assert.equal(f.useV2Engine, false);
    assert.equal(f.useV2UI, false);
  });
});

// ─── Test 2: V2 Engine Path ───────────────────────────────────────────────────

describe('V2 path: engine executes and completes', () => {
  it('runTask completes with phase=done for a scripted single-cycle task', async () => {
    const plan = makePlan('int-v2-complete');
    const taskSpec = makeTaskSpec('int-v2-complete', plan);
    const mockFs = createMockFileSystem({});
    const executeTool = createMockExecutor(mockFs);
    const callLLM = createScriptedLLM([
      `\`\`\`json\n${JSON.stringify({ tool: 'write_file', input: { path: 'src/output.js', content: 'export const x = 1;' } })}\n\`\`\``,
      CYCLE_DONE,
    ]);
    const callbacks = createMockCallbacks(callLLM, executeTool);
    const result = await runTask(taskSpec, callbacks);
    assert.equal(result.phase, 'done');
    assert.ok(result.cycles.length >= 1);
  });
});

// ─── Test 3: V2 UI flag ───────────────────────────────────────────────────────

describe('V2 UI: flag resolution', () => {
  beforeEach(() => {
    global.window = { location: { href: 'http://localhost/?v2ui=true' } };
    global.localStorage = new MockStorage();
  });

  it('useV2UI becomes true with ?v2ui=true URL param', () => {
    const f = getFeatureFlags();
    assert.equal(f.useV2UI, true);
  });
});

// ─── Test 4: Fallback — V2 error causes failure phase ────────────────────────

describe('Fallback: V2 engine failure phase', () => {
  it('runTask returns phase=failed when callLLM always throws', async () => {
    const plan = makePlan('int-fallback');
    const taskSpec = makeTaskSpec('int-fallback', plan, { maxTurnsPerCycle: 2 });
    const mockFs = createMockFileSystem({});
    const executeTool = createMockExecutor(mockFs);
    const callLLM = async () => { throw new Error('LLM bridge not connected'); };
    const callbacks = createMockCallbacks(callLLM, executeTool);
    const result = await runTask(taskSpec, callbacks);
    // api errors are classified — task should fail cleanly (not throw)
    assert.ok(['failed', 'halted'].includes(result.phase), `Unexpected phase: ${result.phase}`);
  });
});

// ─── Test 5: Mixed mode ───────────────────────────────────────────────────────

describe('Mixed mode: V2 engine + V1 UI flags', () => {
  beforeEach(() => {
    global.window = { location: { href: 'http://localhost/?v2=true' } };
    global.localStorage = new MockStorage();
  });

  it('useV2Engine=true but useV2UI=false — returns v2_partial status', () => {
    const f = getFeatureFlags();
    assert.equal(f.useV2Engine, true);
    assert.equal(f.useV2UI, false);
    assert.equal(getMigrationStatus(), 'v2_partial');
  });

  it('V2 engine still runs task correctly in mixed mode', async () => {
    const plan = makePlan('int-mixed');
    const taskSpec = makeTaskSpec('int-mixed', plan);
    const mockFs = createMockFileSystem({});
    const executeTool = createMockExecutor(mockFs);
    const callLLM = createScriptedLLM([
      `\`\`\`json\n${JSON.stringify({ tool: 'write_file', input: { path: 'src/output.js', content: 'ok' } })}\n\`\`\``,
      CYCLE_DONE,
    ]);
    const callbacks = createMockCallbacks(callLLM, executeTool);
    const result = await runTask(taskSpec, callbacks);
    assert.equal(result.phase, 'done');
  });
});

// ─── Test 6: FeatureFlagPanel source existence ────────────────────────────────

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('FeatureFlagPanel: dev-only guard', () => {
  it('source file exists and exports a default function component', () => {
    // Cannot import .jsx in Node.js without a transpiler.
    // Verify the file exists and contains the expected export shape.
    const src = readFileSync(
      resolve('/home/user/BLUSWAN/src/components-v2/FeatureFlagPanel.jsx'),
      'utf8'
    );
    assert.ok(src.includes('export default function FeatureFlagPanel'), 'Should export default function');
    assert.ok(src.includes("import.meta.env.DEV"), 'Should guard with DEV flag');
  });
});
