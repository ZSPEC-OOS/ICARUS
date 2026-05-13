import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as CoreV2 from '../index.js';

// ─── Expected public exports ──────────────────────────────────────────────────

const EXPECTED_EXPORTS = [
  // taskRunner
  'runTask', 'groupDeliverables', 'getAllowedTools', 'parseToolCalls', 'updateDeliverablesFromCycle',
  // planContract
  'createPlanContract', 'validatePlanCoverage', 'markDeliverableComplete', 'PlanValidationError',
  // taskStateMachine
  'createTaskState', 'transition', 'canTransition', 'isTerminal',
  'getPhaseHistory', 'getDeliverablesStatus',
  'TaskStateMachine', 'InvalidPhaseTransitionError', 'MaxCyclesExceededError',
  // cycleEngine
  'createCycle', 'checkCycleCompletion', 'enforceToolRestriction', 'recordTurn', 'summarizeCycle', 'ToolNotAllowedError',
  // contextBudget
  'createContextBudget', 'allocateTier', 'enforceBudget', 'truncateToBudget',
  'summarizeToolResults', 'computeTokenEstimate', 'ContextBudgetError', 'ContextBudgetExceededError',
  // contextPacker
  'packCycleContext', 'packPlanReviewContext',
  // loopPrevention
  'createLoopGuard', 'checkToolSequence', 'checkFileRead', 'checkDeliverableProgress',
  'checkCommandRepeat', 'recordLoopTurn', 'getLoopReport', 'createTaskLoopGuard', 'checkDeliverableRetry',
  // errorClassifier
  'classifyError', 'formatErrorForLLM', 'formatErrorForUser', 'isFatal', 'getErrorRegistry',
  // completionGate
  'runSafetyGates', 'runCompletionGates',
];

describe('index.js exports', () => {
  it('all expected exports exist', () => {
    for (const name of EXPECTED_EXPORTS) {
      assert.ok(
        name in CoreV2,
        `Missing export: '${name}'`
      );
    }
  });

  it('exports are the correct types', () => {
    assert.equal(typeof CoreV2.runTask, 'function');
    assert.equal(typeof CoreV2.createPlanContract, 'function');
    assert.equal(typeof CoreV2.createTaskState, 'function');
    assert.equal(typeof CoreV2.createCycle, 'function');
    assert.equal(typeof CoreV2.createContextBudget, 'function');
    assert.equal(typeof CoreV2.packCycleContext, 'function');
    assert.equal(typeof CoreV2.createLoopGuard, 'function');
    assert.equal(typeof CoreV2.classifyError, 'function');
    assert.equal(typeof CoreV2.runSafetyGates, 'function');
    assert.equal(typeof CoreV2.runCompletionGates, 'function');
    assert.ok(typeof CoreV2.TaskStateMachine === 'function'); // class
    assert.ok(typeof CoreV2.PlanValidationError === 'function'); // class
  });
});

describe('index.js integration', () => {
  it('can create plan → state → cycle → context pipeline', () => {
    const plan = CoreV2.createPlanContract({
      version: '2026.1',
      taskId: 'integration-test',
      goal: 'Integration smoke test',
      estimatedCycles: 1,
      deliverables: [{
        id: 'deliv-1', type: 'file', path: 'src/smoke.js',
        description: 'Smoke test file', acceptanceCriteria: 'file exists', completed: false,
      }],
      dependencies: [], validationSteps: [],
      contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
    });
    assert.ok(plan.taskId === 'integration-test');

    const state = CoreV2.createTaskState(plan);
    assert.equal(state.phase, 'idle');

    let s = CoreV2.transition(state, 'planning');
    s = CoreV2.transition(s, 'plan_review');
    s = CoreV2.transition(s, 'cycle_prep');
    s = CoreV2.transition(s, 'cycle_exec');
    assert.equal(s.phase, 'cycle_exec');

    const cycle = CoreV2.createCycle(plan, 1, ['deliv-1']);
    assert.equal(cycle.maxTurns, 25);
    assert.equal(cycle.cycleNumber, 1);

    const budget = CoreV2.createContextBudget(128000);
    const packed = CoreV2.packCycleContext(budget, cycle, plan.deliverables, []);
    assert.ok(packed.messages.length >= 5);
    assert.ok(packed.metadata.includedTiers.includes('cycleContext'));
  });

  it('can run mock task end-to-end via runTask', async () => {
    const plan = CoreV2.createPlanContract({
      version: '2026.1', taskId: 'e2e', goal: 'End to end',
      estimatedCycles: 1,
      deliverables: [{
        id: 'deliv-1', type: 'file', path: 'src/e2e.js',
        description: 'E2E file', acceptanceCriteria: 'e2e', completed: false,
      }],
      dependencies: [], validationSteps: [],
      contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
    });

    const phases = [];
    const result = await CoreV2.runTask(
      { taskId: 'e2e', goal: 'End to end', plan, options: {} },
      {
        onPhaseChange: (p) => phases.push(p),
        onCycleStart: () => {},
        onCycleEnd: () => {},
        onPlanReview: async () => 'approve',
        onCompletionCheck: async () => 'accept',
        onEvent: () => {},
        onError: () => {},
        callLLM: async () => 'summary: done\ndeliverables_addressed: deliv-1\nnext_cycle_needed: no\n<CYCLE_COMPLETE>',
        executeTool: async (name) => {
          if (name === 'read_file') return 'e2e file exists';
          if (name === 'run_command') return 'Success: all tests passed';
          return `Success: ${name}`;
        },
      }
    );

    assert.ok(['done', 'failed', 'halted'].includes(result.phase));
    assert.ok(phases.includes('idle'));
    assert.ok(phases.includes('planning'));
    assert.ok(phases.length >= 3);
  });
});
