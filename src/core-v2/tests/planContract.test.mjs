import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlanContract,
  validatePlanCoverage,
  markDeliverableComplete,
  PlanValidationError,
} from '../planContract.js';

// ─── Fixture ──────────────────────────────────────────────────────────────────

function validPlan(overrides = {}) {
  return {
    version: '2026.1',
    taskId: 'task-001',
    goal: 'Implement the state machine',
    estimatedCycles: 1,
    deliverables: [
      {
        id: 'deliv-1',
        type: 'file',
        path: 'src/foo.js',
        description: 'Create foo module',
        acceptanceCriteria: 'File exists and exports foo()',
        completed: false,
      },
    ],
    dependencies: [],
    validationSteps: [],
    contextStrategy: {
      maxTokensPerCycle: 80000,
      includeRepoMap: true,
    },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createPlanContract', () => {
  it('validates a correct plan', () => {
    const plan = createPlanContract(validPlan());
    assert.equal(plan.version, '2026.1');
    assert.equal(plan.taskId, 'task-001');
    assert.equal(plan.deliverables.length, 1);
  });

  it('throws on empty deliverables', () => {
    assert.throws(
      () => createPlanContract(validPlan({ deliverables: [] })),
      (err) => {
        assert.ok(err instanceof PlanValidationError);
        assert.ok(err.details.some((d) => d.includes('deliverables')));
        return true;
      }
    );
  });

  it('throws on duplicate deliverable IDs', () => {
    const dupeDeliverables = [
      { id: 'deliv-1', type: 'file', description: 'First', acceptanceCriteria: 'exists' },
      { id: 'deliv-1', type: 'edit', description: 'Second', acceptanceCriteria: 'exists' },
    ];
    assert.throws(
      () => createPlanContract(validPlan({ deliverables: dupeDeliverables, estimatedCycles: 1 })),
      (err) => {
        assert.ok(err instanceof PlanValidationError);
        assert.ok(err.details.some((d) => d.includes('duplicate')));
        return true;
      }
    );
  });

  it('throws on estimatedCycles > 3', () => {
    assert.throws(
      () => createPlanContract(validPlan({ estimatedCycles: 4 })),
      (err) => {
        assert.ok(err instanceof PlanValidationError);
        assert.ok(err.details.some((d) => d.includes('estimatedCycles')));
        return true;
      }
    );
  });

  it('throws on estimatedCycles < Math.ceil(deliverables.length / 3)', () => {
    // 7 deliverables → min cycles = ceil(7/3) = 3; estimatedCycles=1 is too optimistic
    const manyDeliverables = Array.from({ length: 7 }, (_, i) => ({
      id: `deliv-${i + 1}`,
      type: 'file',
      description: `Deliverable ${i + 1}`,
      acceptanceCriteria: 'exists',
    }));
    assert.throws(
      () => createPlanContract(validPlan({ deliverables: manyDeliverables, estimatedCycles: 1 })),
      (err) => {
        assert.ok(err instanceof PlanValidationError);
        assert.ok(err.details.some((d) => d.includes('too optimistic')));
        return true;
      }
    );
  });

  it('throws on missing required fields (no goal)', () => {
    const raw = validPlan();
    delete raw.goal;
    assert.throws(
      () => createPlanContract(raw),
      (err) => {
        assert.ok(err instanceof PlanValidationError);
        assert.ok(err.details.some((d) => d.includes('goal')));
        return true;
      }
    );
  });

  it('throws on wrong version', () => {
    assert.throws(
      () => createPlanContract(validPlan({ version: '1.0' })),
      (err) => {
        assert.ok(err instanceof PlanValidationError);
        assert.ok(err.details.some((d) => d.includes('version')));
        return true;
      }
    );
  });

  it('throws on duplicate dependency paths', () => {
    const dupeDeps = [
      { path: 'src/foo.js', reason: 'need it' },
      { path: 'src/foo.js', reason: 'need it again' },
    ];
    assert.throws(
      () => createPlanContract(validPlan({ dependencies: dupeDeps })),
      (err) => {
        assert.ok(err instanceof PlanValidationError);
        assert.ok(err.details.some((d) => d.includes('duplicate dependency')));
        return true;
      }
    );
  });
});

describe('validatePlanCoverage', () => {
  it('returns complete: true when all deliverables done', () => {
    const plan = createPlanContract(validPlan());
    const donePlan = markDeliverableComplete(plan, 'deliv-1', { passed: true });
    const result = validatePlanCoverage(donePlan);
    assert.equal(result.complete, true);
    assert.deepEqual(result.missing, []);
  });

  it('returns missing IDs when incomplete', () => {
    const plan = createPlanContract(validPlan());
    const result = validatePlanCoverage(plan);
    assert.equal(result.complete, false);
    assert.ok(result.missing.includes('deliv-1'));
  });
});

describe('markDeliverableComplete', () => {
  it('returns new object, does not mutate original', () => {
    const plan = createPlanContract(validPlan());
    const original = plan.deliverables[0].completed;
    const updated = markDeliverableComplete(plan, 'deliv-1', { passed: true });

    // original unchanged
    assert.equal(plan.deliverables[0].completed, original);
    // new plan updated
    assert.equal(updated.deliverables[0].completed, true);
    assert.equal(updated.deliverables[0].verificationResult.passed, true);
    // different reference
    assert.notEqual(plan, updated);
  });
});
