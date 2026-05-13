import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createValidationSuite, runValidation, summarizeValidation } from '../validator.js';
import { createPlanContract } from '../planContract.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePlan(overrides = {}) {
  return createPlanContract({
    version: '2026.1',
    taskId: 'val-test',
    goal: 'Validator test',
    estimatedCycles: 1,
    deliverables: overrides.deliverables ?? [
      { id: 'd1', type: 'file', path: 'src/index.js', description: 'Create index', acceptanceCriteria: 'file exists', completed: false },
    ],
    dependencies: [],
    validationSteps: overrides.validationSteps ?? [],
    contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: false },
  });
}

// ─── createValidationSuite ────────────────────────────────────────────────────

describe('createValidationSuite', () => {
  it('uses explicit plan validationSteps when provided', () => {
    // planContract.ValidationStep schema: { id, description, type }
    const plan = makePlan({
      validationSteps: [
        { id: 'run-tests', description: 'Run the test suite', type: 'test' },
      ],
    });
    const suite = createValidationSuite(plan);
    assert.equal(suite.steps.length, 1);
    assert.ok(suite.steps[0].command.includes('test'));
    assert.equal(suite.steps[0].label, 'Run the test suite');
  });

  it('adds default build step for JS/TS deliverables when no steps specified', () => {
    const plan = makePlan(); // has src/index.js (.js)
    const suite = createValidationSuite(plan);
    assert.ok(suite.steps.length > 0, 'Expected default steps for JS deliverables');
    assert.ok(suite.steps.some((s) => s.id === 'build' || s.command.includes('build')));
  });

  it('adds test step when plan has test-type deliverables', () => {
    const plan = makePlan({
      deliverables: [
        { id: 'd1', type: 'test', path: 'src/index.test.js', description: 'tests', acceptanceCriteria: 'pass', completed: false },
      ],
    });
    const suite = createValidationSuite(plan);
    assert.ok(suite.steps.some((s) => s.id === 'tests' || s.command.includes('test')));
  });

  it('returns empty steps for plans with no JS deliverables and no validationSteps', () => {
    const plan = makePlan({
      deliverables: [
        { id: 'd1', type: 'command', path: '', description: 'Run script', acceptanceCriteria: 'done', completed: false },
      ],
    });
    const suite = createValidationSuite(plan);
    assert.equal(suite.steps.length, 0);
  });

  it('returned suite has stopOnFirstFailure and maxOutputLength', () => {
    const plan = makePlan();
    const suite = createValidationSuite(plan);
    assert.equal(typeof suite.stopOnFirstFailure, 'boolean');
    assert.ok(suite.maxOutputLength > 0);
  });
});

// ─── runValidation ────────────────────────────────────────────────────────────

describe('runValidation', () => {
  it('runs all steps and returns results array', async () => {
    const suite = {
      steps: [
        { id: 'step1', label: 'Step 1', command: 'echo pass' },
        { id: 'step2', label: 'Step 2', command: 'echo pass' },
      ],
      stopOnFirstFailure: false,
      maxOutputLength: 2000,
    };
    const executeTool = async (name, input) => `output of ${input.command}`;
    const { results, allPassed } = await runValidation(suite, executeTool);
    assert.equal(results.length, 2);
    assert.equal(allPassed, true);
  });

  it('returns allPassed: false if any step fails', async () => {
    const suite = {
      steps: [
        { id: 'good', label: 'Good', command: 'echo ok' },
        { id: 'bad', label: 'Bad', command: 'echo "1 failed"' },
      ],
      stopOnFirstFailure: false,
      maxOutputLength: 2000,
    };
    const executeTool = async (name, input) => {
      if (input.command.includes('1 failed')) return '1 test failed';
      return 'ok';
    };
    const { results, allPassed } = await runValidation(suite, executeTool);
    assert.equal(allPassed, false);
    const failedResult = results.find((r) => !r.passed);
    assert.ok(failedResult);
  });

  it('caps output per step at maxOutputLength', async () => {
    const suite = {
      steps: [{ id: 's', label: 'Big', command: 'cmd' }],
      stopOnFirstFailure: false,
      maxOutputLength: 50,
    };
    const executeTool = async () => 'x'.repeat(200);
    const { results } = await runValidation(suite, executeTool);
    assert.ok(results[0].output.length <= 100, 'Output should be capped');
    assert.ok(results[0].output.includes('[...truncated'));
  });

  it('captures durationMs for each result', async () => {
    const suite = {
      steps: [{ id: 's', label: 'Timed', command: 'cmd' }],
      stopOnFirstFailure: false,
      maxOutputLength: 2000,
    };
    const executeTool = async () => 'done';
    const { results } = await runValidation(suite, executeTool);
    assert.ok(typeof results[0].durationMs === 'number');
    assert.ok(results[0].durationMs >= 0);
  });

  it('never throws — executeTool errors become failed results', async () => {
    const suite = {
      steps: [{ id: 'bad', label: 'Bad', command: 'cmd' }],
      stopOnFirstFailure: false,
      maxOutputLength: 2000,
    };
    const executeTool = async () => { throw new Error('command failed'); };
    let threw = false;
    let result;
    try {
      result = await runValidation(suite, executeTool);
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
    assert.equal(result.allPassed, false);
    assert.ok(result.results[0].error);
  });
});

// ─── summarizeValidation ──────────────────────────────────────────────────────

describe('summarizeValidation', () => {
  it('returns formatted string with pass/fail counts', () => {
    const results = [
      { id: 'build', label: 'Build', passed: true, command: 'cmd', output: '', durationMs: 2300 },
      { id: 'tests', label: 'Tests', passed: false, command: 'cmd', output: 'expected 5, got 3', durationMs: 1200 },
    ];
    const summary = summarizeValidation(results);
    assert.ok(summary.includes('Build'));
    assert.ok(summary.includes('Tests'));
    assert.ok(summary.includes('1/2'));
  });

  it('shows failed steps before passed steps', () => {
    const results = [
      { id: 'a', label: 'A', passed: true, command: 'c', output: '', durationMs: 100 },
      { id: 'b', label: 'B', passed: false, command: 'c', output: 'error here', durationMs: 100 },
    ];
    const summary = summarizeValidation(results);
    const bPos = summary.indexOf('B');
    const aPos = summary.indexOf('A');
    assert.ok(bPos < aPos, 'Failed step B should appear before passed step A');
  });

  it('returns "No validation steps ran." for empty results', () => {
    assert.equal(summarizeValidation([]), 'No validation steps ran.');
  });

  it('caps summary at 1000 chars', () => {
    const results = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`, label: `Step ${i}`, passed: false, command: 'cmd',
      output: 'x'.repeat(200), durationMs: 100,
    }));
    const summary = summarizeValidation(results);
    assert.ok(summary.length <= 1000, `Summary length ${summary.length} exceeds 1000 chars`);
  });
});
