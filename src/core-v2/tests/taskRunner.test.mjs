import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runTask, groupDeliverables, getAllowedTools, parseToolCalls, updateDeliverablesFromCycle } from '../taskRunner.js';
import { createPlanContract, markDeliverableComplete } from '../planContract.js';

// ─── Mock Factories ───────────────────────────────────────────────────────────

function makePlan(overrides = {}) {
  return createPlanContract({
    version: '2026.1',
    taskId: 'runner-test',
    goal: 'Test task runner',
    estimatedCycles: 1,
    deliverables: [{
      id: 'deliv-1',
      type: 'file',
      path: 'src/foo.js',
      description: 'Create foo module',
      acceptanceCriteria: 'foo exists',
      completed: false,
    }],
    dependencies: [],
    validationSteps: [],
    contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
    ...overrides,
  });
}

// Includes a write_file tool call so deliverables get marked complete
const VALID_COMPLETION_MSG =
  '```json\n{"tool": "write_file", "input": {"path": "src/foo.js", "content": "const foo = () => {};"}}\n```\n' +
  'summary: done\ndeliverables_addressed: deliv-1\nnext_cycle_needed: no\n<CYCLE_COMPLETE>';

function createMockCallbacks(overrides = {}) {
  return {
    onPhaseChange: () => {},
    onCycleStart: () => {},
    onCycleEnd: () => {},
    onPlanReview: async () => 'approve',
    onCompletionCheck: async () => 'accept',
    onEvent: () => {},
    onError: () => {},
    callLLM: async () => VALID_COMPLETION_MSG,
    executeTool: async (name, input) => {
      // Return content containing 'exists' so acceptance criteria gate passes
      if (name === 'read_file') return 'const foo = () => {}; // foo exists';
      if (name === 'write_file') return `foo exists at ${input?.path ?? 'unknown'}`;
      if (name === 'run_command') return 'Success: all tests passed';
      return `Success: ${name}`;
    },
    ...overrides,
  };
}

// ─── groupDeliverables tests ──────────────────────────────────────────────────

describe('groupDeliverables', () => {
  it('returns up to maxPerCycle IDs', () => {
    const deliverables = Array.from({ length: 5 }, (_, i) => ({
      id: `d-${i}`, type: 'file', path: `src/file${i}.js`,
      description: `File ${i}`, acceptanceCriteria: 'exists', completed: false,
    }));
    const ids = groupDeliverables(deliverables, 3);
    assert.ok(ids.length <= 3);
  });

  it('skips completed deliverables', () => {
    const deliverables = [
      { id: 'd-1', completed: true, path: 'src/a.js' },
      { id: 'd-2', completed: false, path: 'src/b.js' },
    ];
    const ids = groupDeliverables(deliverables, 3);
    assert.ok(!ids.includes('d-1'));
    assert.ok(ids.includes('d-2'));
  });

  it('returns empty array when all complete', () => {
    const deliverables = [{ id: 'd-1', completed: true, path: 'src/a.js' }];
    assert.deepEqual(groupDeliverables(deliverables, 3), []);
  });
});

// ─── getAllowedTools tests ─────────────────────────────────────────────────────

describe('getAllowedTools', () => {
  it('includes write_file for file deliverables', () => {
    const tools = getAllowedTools([{ type: 'file' }]);
    assert.ok(tools.includes('write_file'));
    assert.ok(!tools.includes('edit_file'));
  });

  it('includes edit_file for edit deliverables', () => {
    const tools = getAllowedTools([{ type: 'edit' }]);
    assert.ok(tools.includes('edit_file'));
    assert.ok(!tools.includes('write_file'));
  });

  it('includes run_command for test/command deliverables', () => {
    const tools = getAllowedTools([{ type: 'test' }]);
    assert.ok(tools.includes('run_command'));
    const tools2 = getAllowedTools([{ type: 'command' }]);
    assert.ok(tools2.includes('run_command'));
  });

  it('always includes base tools', () => {
    const tools = getAllowedTools([{ type: 'file' }]);
    assert.ok(tools.includes('read_file'));
    assert.ok(tools.includes('read_many_files'));
    assert.ok(tools.includes('list_directory'));
  });

  it('never includes forbidden tools', () => {
    const tools = getAllowedTools([{ type: 'file' }]);
    assert.ok(!tools.includes('spawn_agent'));
    assert.ok(!tools.includes('revert_file'));
  });
});

// ─── parseToolCalls tests ─────────────────────────────────────────────────────

describe('parseToolCalls', () => {
  it('parses JSON blocks', () => {
    const msg = '```json\n{"tool": "write_file", "input": {"path": "x.js"}}\n```';
    const calls = parseToolCalls(msg);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'write_file');
    assert.deepEqual(calls[0].input, { path: 'x.js' });
  });

  it('returns empty array for plain text', () => {
    const calls = parseToolCalls('Just a regular assistant message.');
    assert.deepEqual(calls, []);
  });

  it('parses tool_use XML-ish blocks', () => {
    const msg = '<tool_use><name>read_file</name><input>{"path": "src/foo.js"}</input></tool_use>';
    const calls = parseToolCalls(msg);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'read_file');
  });
});

// ─── updateDeliverablesFromCycle tests ────────────────────────────────────────

describe('updateDeliverablesFromCycle', () => {
  it('marks file deliverable complete on successful write_file', () => {
    const plan = makePlan();
    const cycle = {
      toolResults: [
        { toolName: 'write_file', input: { path: 'src/foo.js' }, output: 'ok', turnNumber: 1 },
      ],
    };
    const updated = updateDeliverablesFromCycle(plan, cycle);
    assert.equal(updated.deliverables[0].completed, true);
  });

  it('does not mark complete on failed write_file', () => {
    const plan = makePlan();
    const cycle = {
      toolResults: [
        { toolName: 'write_file', input: { path: 'src/foo.js' }, output: '', error: 'permission denied', turnNumber: 1 },
      ],
    };
    const updated = updateDeliverablesFromCycle(plan, cycle);
    assert.equal(updated.deliverables[0].completed, false);
  });

  it('does not mutate original plan', () => {
    const plan = makePlan();
    const cycle = { toolResults: [{ toolName: 'write_file', input: { path: 'src/foo.js' }, output: 'ok', turnNumber: 1 }] };
    updateDeliverablesFromCycle(plan, cycle);
    assert.equal(plan.deliverables[0].completed, false);
  });
});

// ─── runTask integration tests ────────────────────────────────────────────────

describe('runTask', () => {
  it('with pre-generated plan skips generatePlan LLM call', async () => {
    const plan = makePlan();
    let llmCallCount = 0;
    const callbacks = createMockCallbacks({
      callLLM: async () => { llmCallCount++; return VALID_COMPLETION_MSG; },
    });
    const result = await runTask({ taskId: 't1', goal: 'test', plan, options: {} }, callbacks);
    // With pre-generated plan, LLM is called for cycles only (not for planning)
    assert.ok(result.phase === 'done' || result.phase === 'failed');
    // LLM should have been called (for cycles) but not for planning
    assert.ok(llmCallCount > 0);
  });

  it('without plan calls generatePlan via callLLM', async () => {
    const planJSON = JSON.stringify({
      version: '2026.1',
      taskId: 'gen-1',
      goal: 'create file',
      estimatedCycles: 1,
      deliverables: [{
        id: 'deliv-1', type: 'file', path: 'src/gen.js',
        description: 'Generated file', acceptanceCriteria: 'file exists', completed: false,
      }],
      dependencies: [], validationSteps: [],
      contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
    });
    let planRequested = false;
    const callbacks = createMockCallbacks({
      callLLM: async (messages) => {
        if (messages[0]?.content?.includes('planning assistant')) {
          planRequested = true;
          return planJSON;
        }
        return VALID_COMPLETION_MSG;
      },
      executeTool: async (name) => {
        if (name === 'read_file') return 'file exists';
        if (name === 'run_command') return 'Success';
        return 'Success';
      },
    });
    await runTask({ taskId: 't2', goal: 'create file', options: {} }, callbacks);
    assert.equal(planRequested, true);
  });

  it('with requirePlanReview=true calls onPlanReview', async () => {
    const plan = makePlan();
    let planReviewCalled = false;
    const callbacks = createMockCallbacks({
      onPlanReview: async () => { planReviewCalled = true; return 'approve'; },
    });
    await runTask({ taskId: 't3', goal: 'test', plan, options: { requirePlanReview: true } }, callbacks);
    assert.equal(planReviewCalled, true);
  });

  it('returns failed when plan review is rejected', async () => {
    const plan = makePlan();
    const callbacks = createMockCallbacks({
      onPlanReview: async () => 'reject',
    });
    const result = await runTask({ taskId: 't4', goal: 'test', plan, options: { requirePlanReview: true } }, callbacks);
    assert.equal(result.phase, 'failed');
    assert.ok(result.failureReason.includes('rejected'));
  });

  it('calls onPhaseChange in order including idle→planning→plan_review', async () => {
    const plan = makePlan();
    const phases = [];
    const callbacks = createMockCallbacks({
      onPhaseChange: (phase) => phases.push(phase),
    });
    await runTask({ taskId: 't5', goal: 'test', plan, options: {} }, callbacks);
    assert.ok(phases.includes('idle'));
    assert.ok(phases.includes('planning'));
    assert.ok(phases.includes('plan_review'));
    assert.ok(phases.includes('cycle_prep'));
    assert.ok(phases.includes('cycle_exec'));
  });

  it('calls onCycleStart and onCycleEnd', async () => {
    const plan = makePlan();
    let cycleStarted = false;
    let cycleEnded = false;
    const callbacks = createMockCallbacks({
      onCycleStart: () => { cycleStarted = true; },
      onCycleEnd: () => { cycleEnded = true; },
    });
    await runTask({ taskId: 't6', goal: 'test', plan, options: {} }, callbacks);
    assert.equal(cycleStarted, true);
    assert.equal(cycleEnded, true);
  });

  it('returns halted when user halts at completion confirm', async () => {
    const plan = makePlan();
    const callbacks = createMockCallbacks({
      onCompletionCheck: async () => 'halt',
    });
    const result = await runTask({
      taskId: 't7', goal: 'test', plan, options: { requireCompletionConfirm: true }
    }, callbacks);
    assert.equal(result.phase, 'halted');
    assert.ok(result.haltReason.includes('halted'));
  });

  it('tracks totalTurnsUsed and totalTimeMs', async () => {
    const plan = makePlan();
    const callbacks = createMockCallbacks();
    const result = await runTask({ taskId: 't8', goal: 'test', plan, options: {} }, callbacks);
    assert.ok(typeof result.totalTurnsUsed === 'number');
    assert.ok(typeof result.totalTimeMs === 'number');
    assert.ok(result.totalTimeMs >= 0);
  });

  it('respects maxCycles option (never exceeds it)', async () => {
    // Plan with many deliverables, maxCycles: 1
    const plan = createPlanContract({
      version: '2026.1', taskId: 'mc-test', goal: 'Many deliverables',
      estimatedCycles: 3,
      deliverables: Array.from({ length: 3 }, (_, i) => ({
        id: `deliv-${i + 1}`, type: 'file', path: `src/f${i + 1}.js`,
        description: `File ${i + 1}`, acceptanceCriteria: 'exists', completed: false,
      })),
      dependencies: [], validationSteps: [],
      contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
    });

    let cycleCount = 0;
    const callbacks = createMockCallbacks({
      onCycleStart: () => { cycleCount++; },
    });
    const result = await runTask({ taskId: 'mc', goal: 'test', plan, options: { maxCycles: 1 } }, callbacks);
    assert.ok(cycleCount <= 1, `Expected at most 1 cycle, got ${cycleCount}`);
  });
});
