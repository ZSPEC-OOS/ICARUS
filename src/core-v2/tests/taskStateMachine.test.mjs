import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaskState,
  transition,
  canTransition,
  getPhaseHistory,
  isTerminal,
  getDeliverablesStatus,
  InvalidPhaseTransitionError,
  TaskStateMachine,
  MaxCyclesExceededError,
} from '../taskStateMachine.js';
import { createPlanContract, markDeliverableComplete } from '../planContract.js';
import { createCycle } from '../cycleEngine.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePlan(deliverableCount = 1) {
  const deliverables = Array.from({ length: deliverableCount }, (_, i) => ({
    id: `deliv-${i + 1}`,
    type: 'file',
    description: `Deliverable ${i + 1}`,
    acceptanceCriteria: 'exists',
  }));
  return createPlanContract({
    version: '2026.1',
    taskId: 'task-test',
    goal: 'Test goal',
    estimatedCycles: Math.max(1, Math.ceil(deliverableCount / 3)),
    deliverables,
    dependencies: [],
    validationSteps: [],
    contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createTaskState', () => {
  it('initializes with phase idle, currentCycle: -1, maxCycles: 3', () => {
    const plan = makePlan();
    const state = createTaskState(plan);
    assert.equal(state.phase, 'idle');
    assert.equal(state.currentCycle, -1);
    assert.equal(state.maxCycles, 3);
    assert.deepEqual(state.cycles, []);
    assert.equal(state.phaseHistory.length, 1);
    assert.equal(state.phaseHistory[0].phase, 'idle');
  });
});

describe('transition — valid transitions', () => {
  it('idle → planning succeeds', () => {
    const plan = makePlan();
    const state = createTaskState(plan);
    const next = transition(state, 'planning');
    assert.equal(next.phase, 'planning');
  });

  it('planning → plan_review succeeds', () => {
    const plan = makePlan();
    let state = createTaskState(plan);
    state = transition(state, 'planning');
    state = transition(state, 'plan_review');
    assert.equal(state.phase, 'plan_review');
  });

  it('plan_review → cycle_prep succeeds', () => {
    const plan = makePlan();
    let state = createTaskState(plan);
    state = transition(state, 'planning');
    state = transition(state, 'plan_review');
    state = transition(state, 'cycle_prep');
    assert.equal(state.phase, 'cycle_prep');
  });

  it('cycle_prep → cycle_exec succeeds', () => {
    const plan = makePlan();
    let state = createTaskState(plan);
    state = transition(state, 'planning');
    state = transition(state, 'plan_review');
    state = transition(state, 'cycle_prep');
    state = transition(state, 'cycle_exec');
    assert.equal(state.phase, 'cycle_exec');
  });

  it('cycle_exec → cycle_validate succeeds', () => {
    const plan = makePlan();
    let state = createTaskState(plan);
    state = transition(state, 'planning');
    state = transition(state, 'plan_review');
    state = transition(state, 'cycle_prep');
    state = transition(state, 'cycle_exec');
    state = transition(state, 'cycle_validate');
    assert.equal(state.phase, 'cycle_validate');
  });

  it('cycle_validate → cycle_prep succeeds (next cycle)', () => {
    const plan = makePlan();
    let state = createTaskState(plan);
    state = transition(state, 'planning');
    state = transition(state, 'plan_review');
    state = transition(state, 'cycle_prep');
    state = transition(state, 'cycle_exec');
    state = transition(state, 'cycle_validate');
    state = transition(state, 'cycle_prep');
    assert.equal(state.phase, 'cycle_prep');
  });

  it('cycle_validate → completion_check succeeds (when done)', () => {
    const plan = makePlan();
    let state = createTaskState(plan);
    state = transition(state, 'planning');
    state = transition(state, 'plan_review');
    state = transition(state, 'cycle_prep');
    state = transition(state, 'cycle_exec');
    state = transition(state, 'cycle_validate');
    state = transition(state, 'completion_check');
    assert.equal(state.phase, 'completion_check');
  });

  it('completion_check → completion_confirm succeeds', () => {
    const plan = makePlan();
    let state = createTaskState(plan);
    state = transition(state, 'planning');
    state = transition(state, 'plan_review');
    state = transition(state, 'cycle_prep');
    state = transition(state, 'cycle_exec');
    state = transition(state, 'cycle_validate');
    state = transition(state, 'completion_check');
    state = transition(state, 'completion_confirm');
    assert.equal(state.phase, 'completion_confirm');
  });

  it('completion_confirm → done succeeds', () => {
    const plan = makePlan();
    let state = createTaskState(plan);
    state = transition(state, 'planning');
    state = transition(state, 'plan_review');
    state = transition(state, 'cycle_prep');
    state = transition(state, 'cycle_exec');
    state = transition(state, 'cycle_validate');
    state = transition(state, 'completion_check');
    state = transition(state, 'completion_confirm');
    state = transition(state, 'done');
    assert.equal(state.phase, 'done');
  });

  it('cycle_validate → failed succeeds (when no cycles left)', () => {
    const plan = makePlan();
    let state = createTaskState(plan);
    state = transition(state, 'planning');
    state = transition(state, 'plan_review');
    state = transition(state, 'cycle_prep');
    state = transition(state, 'cycle_exec');
    state = transition(state, 'cycle_validate');
    state = transition(state, 'failed');
    assert.equal(state.phase, 'failed');
  });
});

describe('transition — invalid transitions', () => {
  it('throws InvalidPhaseTransitionError for backward transition (cycle_exec → planning)', () => {
    const plan = makePlan();
    let state = createTaskState(plan);
    state = transition(state, 'planning');
    state = transition(state, 'plan_review');
    state = transition(state, 'cycle_prep');
    state = transition(state, 'cycle_exec');

    assert.throws(
      () => transition(state, 'planning'),
      (err) => {
        assert.ok(err instanceof InvalidPhaseTransitionError);
        assert.equal(err.from, 'cycle_exec');
        assert.equal(err.to, 'planning');
        return true;
      }
    );
  });
});

describe('TaskStateMachine.beginCycle', () => {
  it('throws MaxCyclesExceededError after 3 cycles', () => {
    const plan = makePlan(3);
    const machine = TaskStateMachine.create(plan, { maxCycles: 3 });
    machine.start(plan);

    const makeTestCycle = (n) =>
      createCycle(plan, n, [`deliv-${n}`]);

    machine.beginCycle(makeTestCycle(1));
    machine.endCycle({ status: 'completed' });
    machine.beginCycle(makeTestCycle(2));
    machine.endCycle({ status: 'completed' });
    machine.beginCycle(makeTestCycle(3));
    machine.endCycle({ status: 'completed' });

    // Now at cycle_validate, which can go to cycle_prep — but maxCycles would be exceeded
    assert.throws(
      () => machine.beginCycle(makeTestCycle(4)),
      (err) => {
        assert.ok(err instanceof MaxCyclesExceededError);
        assert.equal(err.maxCycles, 3);
        return true;
      }
    );
  });
});

describe('halt()', () => {
  it('transitions to halted from any non-terminal phase', () => {
    const plan = makePlan();
    let state = createTaskState(plan);
    state = transition(state, 'planning');

    const machine = new TaskStateMachine(state);
    machine.halt('user requested stop');
    assert.equal(machine.state.phase, 'halted');
    assert.equal(machine.state.haltReason, 'user requested stop');
  });
});

describe('isTerminal()', () => {
  it('returns true for done, failed, halted', () => {
    const plan = makePlan();

    for (const terminalPhase of ['done', 'failed', 'halted']) {
      const state = createTaskState(plan);
      // Force-set phase via transition chain won't work for all; directly build terminal state
      const terminalState = { ...state, phase: terminalPhase };
      assert.equal(isTerminal(terminalState), true, `Expected ${terminalPhase} to be terminal`);
    }
  });

  it('returns false for non-terminal phases', () => {
    const plan = makePlan();
    const state = createTaskState(plan);
    assert.equal(isTerminal(state), false);
  });
});

describe('plan immutability', () => {
  it('modifying returned plan does not affect state', () => {
    const plan = makePlan();
    const state = createTaskState(plan);
    const returnedPlan = state.plan;

    // Try to mutate (won't affect because Object.freeze in createPlanContract)
    try {
      returnedPlan.goal = 'hacked';
    } catch (_) {
      // Expected in strict mode due to Object.freeze
    }

    assert.equal(state.plan.goal, 'Test goal');
  });

  it('markDeliverableComplete does not mutate state plan', () => {
    const plan = makePlan();
    const state = createTaskState(plan);
    const updatedPlan = markDeliverableComplete(state.plan, 'deliv-1', { passed: true });

    assert.equal(state.plan.deliverables[0].completed, false);
    assert.equal(updatedPlan.deliverables[0].completed, true);
  });
});

describe('getPhaseHistory', () => {
  it('records all transitions', () => {
    const plan = makePlan();
    let state = createTaskState(plan);
    state = transition(state, 'planning');
    state = transition(state, 'plan_review');

    const history = getPhaseHistory(state);
    assert.equal(history.length, 3); // idle, planning, plan_review
    assert.equal(history[0].phase, 'idle');
    assert.equal(history[1].phase, 'planning');
    assert.equal(history[2].phase, 'plan_review');
    assert.ok(typeof history[0].at === 'string');
  });
});

describe('getDeliverablesStatus', () => {
  it('returns deliverable statuses with inCurrentCycle flag', () => {
    const plan = makePlan(2);
    const state = createTaskState(plan);
    const statuses = getDeliverablesStatus(state);
    assert.equal(statuses.length, 2);
    assert.equal(statuses[0].completed, false);
    assert.equal(statuses[0].inCurrentCycle, false);
  });
});
