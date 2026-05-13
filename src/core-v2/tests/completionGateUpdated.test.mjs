import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCompletionGates, runSafetyGates } from '../completionGate.js';
import { createPlanContract, markDeliverableComplete } from '../planContract.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePlan(overrides = {}) {
  return createPlanContract({
    version: '2026.1',
    taskId: 'cg-updated-test',
    goal: 'Completion gate test',
    estimatedCycles: 1,
    deliverables: overrides.deliverables ?? [
      {
        id: 'd1', type: 'file', path: 'src/out.js',
        description: 'Create output', acceptanceCriteria: 'ok', completed: false,
      },
    ],
    dependencies: [],
    validationSteps: overrides.validationSteps ?? [],
    contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: false },
  });
}

function makeCycleWithWrite(path, content = 'const x = 1;', status = 'completed') {
  return {
    cycleNumber: 1,
    status,
    turnsUsed: 2,
    toolResults: [
      {
        toolName: 'write_file',
        input: { path, content },
        output: `wrote ${path}`,
        turnNumber: 1,
      },
      {
        toolName: 'read_file',
        input: { path: 'dummy.js' },
        output: '<CYCLE_COMPLETE>\nsummary: done\ndeliverables_addressed: d1\nnext_cycle_needed: false',
        turnNumber: 2,
      },
    ],
  };
}

function makePassingExecuteTool(files = {}) {
  return async (name, input) => {
    if (name === 'read_file') {
      const content = files[input.path];
      return content !== undefined ? content : `ERROR: not found`;
    }
    if (name === 'run_command') {
      return 'all tests passed';
    }
    return '';
  };
}

// ─── Validation layer included in completion gates ────────────────────────────

describe('runCompletionGates: validation layer', () => {
  it('includes a validation gate detail in results', async () => {
    let plan = makePlan({ validationSteps: [{ id: 'run-tests', description: 'Run tests', type: 'test' }] });
    plan = markDeliverableComplete(plan, 'd1', { passed: true });
    const cycle = makeCycleWithWrite('src/out.js');
    const executeTool = makePassingExecuteTool({ 'src/out.js': 'const x = 1;' });

    const result = await runCompletionGates(plan, [cycle], executeTool);
    assert.ok(result.details.some((d) => d.id === 'validation'), 'Expected validation detail in results');
  });

  it('validation failure does NOT block completion', async () => {
    let plan = makePlan({ validationSteps: [{ id: 'run-tests', description: 'Run tests', type: 'test' }] });
    plan = markDeliverableComplete(plan, 'd1', { passed: true });
    const cycle = makeCycleWithWrite('src/out.js');

    // executeTool returns a "failing" test output
    const executeTool = async (name, input) => {
      if (name === 'read_file') return 'const x = 1;';
      if (name === 'run_command') return '3 tests failed';
      return '';
    };

    const result = await runCompletionGates(plan, [cycle], executeTool);
    // Validation may fail but gate should still pass
    assert.equal(result.passed, true, 'Validation failure should not block completion');
  });

  it('completion gates return validationResults for use by quality signals', async () => {
    let plan = makePlan({ validationSteps: [{ id: 'run-tests', description: 'Run tests', type: 'test' }] });
    plan = markDeliverableComplete(plan, 'd1', { passed: true });
    const cycle = makeCycleWithWrite('src/out.js');
    const executeTool = makePassingExecuteTool({ 'src/out.js': 'ok' });

    const result = await runCompletionGates(plan, [cycle], executeTool);
    assert.ok(result.passed);
    assert.ok(Array.isArray(result.validationResults), 'validationResults should be an array');
  });
});

// ─── Safety gates still block ─────────────────────────────────────────────────

describe('runSafetyGates: still blocks on security issues', () => {
  it('blocks when hardcoded secret is found in written content', async () => {
    const plan = makePlan();
    const cycle = {
      cycleNumber: 1,
      status: 'completed',
      toolResults: [
        {
          toolName: 'write_file',
          input: { path: 'src/config.js', content: 'const api_key = "sk-hardcoded-secret-12345";' },
          output: 'wrote src/config.js',
          turnNumber: 1,
        },
      ],
    };

    const result = await runSafetyGates(plan, [cycle], async () => '');
    assert.equal(result.passed, false);
    assert.ok(result.blockedReason.toLowerCase().includes('secret') || result.blockedReason.toLowerCase().includes('api_key'));
  });

  it('passes on clean file writes', async () => {
    const plan = makePlan();
    const cycle = makeCycleWithWrite('src/out.js', 'export const result = 42;');
    const result = await runSafetyGates(plan, [cycle], async () => '');
    assert.equal(result.passed, true);
  });
});

// ─── No rollback triggered ────────────────────────────────────────────────────

describe('No automatic rollback on any failure', () => {
  it('runCompletionGates returns passed:false but never calls rollback', async () => {
    const plan = makePlan();
    // Plan not marked complete — will fail plan_coverage
    const cycle = makeCycleWithWrite('src/out.js');
    let rollbackCalled = false;
    const executeTool = async (name) => {
      if (name === 'rollback') rollbackCalled = true;
      return '';
    };

    const result = await runCompletionGates(plan, [cycle], executeTool);
    assert.equal(result.passed, false);
    assert.equal(rollbackCalled, false, 'rollback tool should never be called by completion gates');
  });

  it('runSafetyGates returns passed:false but never calls rollback', async () => {
    const plan = makePlan();
    const cycle = {
      cycleNumber: 1,
      status: 'completed',
      toolResults: [
        {
          toolName: 'write_file',
          input: { path: 'src/x.js', content: 'const password = "hunter2hunter2";' },
          output: 'wrote src/x.js',
          turnNumber: 1,
        },
      ],
    };
    let rollbackCalled = false;
    const executeTool = async (name) => {
      if (name === 'rollback') rollbackCalled = true;
      return '';
    };

    const result = await runSafetyGates(plan, [cycle], executeTool);
    assert.equal(result.passed, false);
    assert.equal(rollbackCalled, false);
  });
});

// ─── Quality signals run after completion ─────────────────────────────────────

describe('Quality signals run post-completion (via taskRunner)', () => {
  it('runCompletionGates returns validationResults usable for quality signals', async () => {
    let plan = makePlan({ validationSteps: [{ id: 'run-lint', description: 'Run linter', type: 'lint' }] });
    plan = markDeliverableComplete(plan, 'd1', { passed: true });
    const cycle = makeCycleWithWrite('src/out.js');
    const executeTool = makePassingExecuteTool({ 'src/out.js': 'const x = 1;' });

    const gateResult = await runCompletionGates(plan, [cycle], executeTool);
    assert.ok(gateResult.passed);
    assert.ok(Array.isArray(gateResult.validationResults));
    // validationResults can be empty if steps were skipped, or populated if run
    assert.equal(typeof gateResult.validationResults, 'object');
  });
});
