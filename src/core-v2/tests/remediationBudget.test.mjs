import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRemediationBudget,
  spend,
  canAfford,
  getSpentByCategory,
  getAuditReport,
  COST_TABLE,
  RemediationBudgetExhaustedError,
} from '../remediationBudget.js';

// ─── COST_TABLE tests ─────────────────────────────────────────────────────────

describe('COST_TABLE', () => {
  it('has all expected actions', () => {
    const expected = [
      'tool_retry', 'file_re_read', 'test_re_run', 'lint_re_run',
      'model_re_call', 'rollback_attempt', 'error_recovery', 'context_repack',
    ];
    for (const key of expected) {
      assert.ok(key in COST_TABLE, `Missing COST_TABLE key: ${key}`);
      assert.ok(typeof COST_TABLE[key] === 'number' && COST_TABLE[key] > 0);
    }
  });

  it('is frozen (immutable)', () => {
    assert.ok(Object.isFrozen(COST_TABLE));
  });

  it('has correct values', () => {
    assert.equal(COST_TABLE.tool_retry, 5);
    assert.equal(COST_TABLE.file_re_read, 2);
    assert.equal(COST_TABLE.test_re_run, 10);
    assert.equal(COST_TABLE.lint_re_run, 5);
    assert.equal(COST_TABLE.model_re_call, 20);
    assert.equal(COST_TABLE.rollback_attempt, 50);
    assert.equal(COST_TABLE.error_recovery, 8);
    assert.equal(COST_TABLE.context_repack, 15);
  });
});

// ─── createRemediationBudget tests ───────────────────────────────────────────

describe('createRemediationBudget', () => {
  it('creates budget with default total of 100', () => {
    const b = createRemediationBudget();
    assert.equal(b.total, 100);
    assert.equal(b.spent, 0);
    assert.equal(b.remaining, 100);
    assert.deepEqual(b.auditTrail, []);
  });

  it('creates budget with custom total', () => {
    const b = createRemediationBudget(200);
    assert.equal(b.total, 200);
    assert.equal(b.remaining, 200);
  });

  it('throws on non-positive total', () => {
    assert.throws(() => createRemediationBudget(0), RangeError);
    assert.throws(() => createRemediationBudget(-10), RangeError);
  });
});

// ─── spend tests ─────────────────────────────────────────────────────────────

describe('spend', () => {
  it('deducts cost from remaining', () => {
    const b = createRemediationBudget(100);
    const b2 = spend(b, 'tool_retry', 'retry after timeout', 1, 1);
    assert.equal(b2.spent, COST_TABLE.tool_retry);
    assert.equal(b2.remaining, 100 - COST_TABLE.tool_retry);
  });

  it('records audit trail entry', () => {
    const b = createRemediationBudget(100);
    const b2 = spend(b, 'error_recovery', 'caught network error', 2, 1);
    assert.equal(b2.auditTrail.length, 1);
    const entry = b2.auditTrail[0];
    assert.equal(entry.action, 'error_recovery');
    assert.equal(entry.cost, COST_TABLE.error_recovery);
    assert.equal(entry.reason, 'caught network error');
    assert.equal(entry.turnNumber, 2);
    assert.equal(entry.cycleNumber, 1);
    assert.ok(typeof entry.timestamp === 'number');
  });

  it('does not mutate original budget', () => {
    const b = createRemediationBudget(100);
    spend(b, 'tool_retry', 'test', 1, 1);
    assert.equal(b.spent, 0);
    assert.equal(b.remaining, 100);
    assert.equal(b.auditTrail.length, 0);
  });

  it('accumulates multiple spends correctly', () => {
    let b = createRemediationBudget(100);
    b = spend(b, 'tool_retry', 'r1', 1, 1);
    b = spend(b, 'file_re_read', 'r2', 2, 1);
    b = spend(b, 'error_recovery', 'r3', 3, 1);
    const expected = COST_TABLE.tool_retry + COST_TABLE.file_re_read + COST_TABLE.error_recovery;
    assert.equal(b.spent, expected);
    assert.equal(b.remaining, 100 - expected);
    assert.equal(b.auditTrail.length, 3);
  });

  it('throws RemediationBudgetExhaustedError when insufficient funds', () => {
    const b = createRemediationBudget(10);
    assert.throws(
      () => spend(b, 'rollback_attempt', 'test', 1, 1),
      RemediationBudgetExhaustedError
    );
  });

  it('throws RemediationBudgetExhaustedError with correct properties', () => {
    const b = createRemediationBudget(10);
    try {
      spend(b, 'rollback_attempt', 'test', 1, 1);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof RemediationBudgetExhaustedError);
      assert.equal(err.action, 'rollback_attempt');
      assert.equal(err.cost, COST_TABLE.rollback_attempt);
      assert.equal(err.remaining, 10);
    }
  });

  it('throws RangeError for unknown action', () => {
    const b = createRemediationBudget(100);
    assert.throws(() => spend(b, 'unknown_action', 'test', 1, 1), RangeError);
  });

  it('allows exact spend to zero', () => {
    const b = createRemediationBudget(COST_TABLE.tool_retry);
    const b2 = spend(b, 'tool_retry', 'exact', 1, 1);
    assert.equal(b2.remaining, 0);
    assert.equal(b2.spent, COST_TABLE.tool_retry);
  });
});

// ─── canAfford tests ──────────────────────────────────────────────────────────

describe('canAfford', () => {
  it('returns true when budget is sufficient', () => {
    const b = createRemediationBudget(100);
    assert.equal(canAfford(b, 'tool_retry'), true);
    assert.equal(canAfford(b, 'rollback_attempt'), true);
  });

  it('returns false when budget is insufficient', () => {
    const b = createRemediationBudget(10);
    assert.equal(canAfford(b, 'rollback_attempt'), false);
  });

  it('returns false for unknown action', () => {
    const b = createRemediationBudget(100);
    assert.equal(canAfford(b, 'nonexistent'), false);
  });

  it('returns true when remaining equals exact cost', () => {
    const b = createRemediationBudget(COST_TABLE.model_re_call);
    assert.equal(canAfford(b, 'model_re_call'), true);
  });

  it('returns false when remaining is one less than cost', () => {
    const b = createRemediationBudget(COST_TABLE.model_re_call - 1);
    assert.equal(canAfford(b, 'model_re_call'), false);
  });
});

// ─── getSpentByCategory tests ─────────────────────────────────────────────────

describe('getSpentByCategory', () => {
  it('returns empty object for fresh budget', () => {
    const b = createRemediationBudget(100);
    assert.deepEqual(getSpentByCategory(b), {});
  });

  it('aggregates spend for repeated actions', () => {
    let b = createRemediationBudget(100);
    b = spend(b, 'tool_retry', 'r1', 1, 1);
    b = spend(b, 'tool_retry', 'r2', 2, 1);
    b = spend(b, 'error_recovery', 'r3', 3, 1);
    const cats = getSpentByCategory(b);
    assert.equal(cats.tool_retry, COST_TABLE.tool_retry * 2);
    assert.equal(cats.error_recovery, COST_TABLE.error_recovery);
  });

  it('does not include unspent categories', () => {
    let b = createRemediationBudget(100);
    b = spend(b, 'lint_re_run', 'lint', 1, 1);
    const cats = getSpentByCategory(b);
    assert.ok('lint_re_run' in cats);
    assert.ok(!('tool_retry' in cats));
  });
});

// ─── getAuditReport tests ─────────────────────────────────────────────────────

describe('getAuditReport', () => {
  it('returns a string', () => {
    const b = createRemediationBudget(100);
    assert.equal(typeof getAuditReport(b), 'string');
  });

  it('includes total, spent, remaining', () => {
    let b = createRemediationBudget(100);
    b = spend(b, 'tool_retry', 'test retry', 1, 1);
    const report = getAuditReport(b);
    assert.ok(report.includes('100'));
    assert.ok(report.includes(String(COST_TABLE.tool_retry)));
  });

  it('includes audit trail entries', () => {
    let b = createRemediationBudget(100);
    b = spend(b, 'context_repack', 'repacked context', 3, 2);
    const report = getAuditReport(b);
    assert.ok(report.includes('context_repack'));
    assert.ok(report.includes('repacked context'));
    assert.ok(report.includes('cycle 2'));
    assert.ok(report.includes('turn 3'));
  });

  it('includes spend-by-category section when entries exist', () => {
    let b = createRemediationBudget(100);
    b = spend(b, 'test_re_run', 'tests failed', 1, 1);
    const report = getAuditReport(b);
    assert.ok(report.includes('test_re_run'));
  });
});
