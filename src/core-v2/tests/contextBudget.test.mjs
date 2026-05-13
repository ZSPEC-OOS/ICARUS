import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createContextBudget,
  allocateTier,
  enforceBudget,
  truncateToBudget,
  summarizeToolResults,
  computeTokenEstimate,
  ContextBudgetError,
  ContextBudgetExceededError,
} from '../contextBudget.js';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createContextBudget', () => {
  it('computes available correctly', () => {
    // reserved = 2000 + 1500 + 500 + 1000 = 5000
    const budget = createContextBudget(128000);
    assert.equal(budget.totalWindow, 128000);
    assert.equal(budget.available, 128000 - 5000);
    assert.equal(budget.reserved.systemPrompt, 2000);
    assert.equal(budget.reserved.planContract, 1500);
    assert.equal(budget.reserved.completionProtocol, 500);
    assert.equal(budget.reserved.safetyBuffer, 1000);
  });

  it('throws ContextBudgetError on window < 6000', () => {
    assert.throws(
      () => createContextBudget(5999),
      (err) => {
        assert.ok(err instanceof ContextBudgetError);
        assert.ok(err.message.includes('too small'));
        return true;
      }
    );
  });

  it('has correct tier defaults', () => {
    const budget = createContextBudget(128000);
    assert.equal(budget.tiers.cycleContext.max, 3000);
    assert.equal(budget.tiers.deliverables.max, 2000);
    assert.equal(budget.tiers.toolResults.max, 4000);
    assert.equal(budget.tiers.repoMap.max, 1500);
    assert.equal(budget.tiers.relevantFiles.max, 3000);
    assert.equal(budget.tiers.cycleContext.priority, 1);
  });
});

describe('allocateTier', () => {
  it('grants min(requested, tierMax)', () => {
    const budget = createContextBudget(128000);
    const result = allocateTier(budget, 'cycleContext', 1000);
    assert.equal(result.granted, 1000);
    assert.equal(result.remaining, 2000); // 3000 - 1000
  });

  it('caps grant at tier max when requested exceeds it', () => {
    const budget = createContextBudget(128000);
    const result = allocateTier(budget, 'cycleContext', 99999);
    assert.equal(result.granted, 3000); // tier max
    assert.equal(result.remaining, 0);
  });

  it('throws on unknown tier', () => {
    const budget = createContextBudget(128000);
    assert.throws(
      () => allocateTier(budget, 'nonexistent', 100),
      (err) => {
        assert.ok(err instanceof ContextBudgetError);
        return true;
      }
    );
  });
});

describe('enforceBudget', () => {
  it('passes when messages fit within available budget', () => {
    const budget = createContextBudget(128000);
    const messages = [{ role: 'user', content: 'Hello' }];
    assert.doesNotThrow(() => enforceBudget(budget, messages));
  });

  it('throws ContextBudgetExceededError with details when over budget', () => {
    const budget = createContextBudget(6000); // available = 6000 - 5000 = 1000
    // Each token ≈ 4 chars, so 5000 tokens = 20000 chars — way over 1000 available
    const bigContent = 'x'.repeat(20000);
    const messages = [{ role: 'user', content: bigContent }];

    assert.throws(
      () => enforceBudget(budget, messages),
      (err) => {
        assert.ok(err instanceof ContextBudgetExceededError);
        assert.ok(err.details.requested > err.details.available);
        assert.ok(err.details.overflow > 0);
        assert.ok(typeof err.details.suggestion === 'string');
        return true;
      }
    );
  });
});

describe('truncateToBudget', () => {
  it('adds truncation marker when content exceeds budget', () => {
    const content = 'A'.repeat(1000);
    const result = truncateToBudget(content, 50); // 50 tokens = 200 chars
    assert.ok(result.includes('[...truncated'));
    assert.ok(result.includes('chars removed'));
    assert.ok(computeTokenEstimate(result) <= 60); // allow small margin for suffix
  });

  it('does not truncate when under budget', () => {
    const content = 'Hello world';
    const result = truncateToBudget(content, 100);
    assert.equal(result, content);
    assert.ok(!result.includes('[...truncated'));
  });

  it('never silently truncates — always adds marker', () => {
    const content = 'B'.repeat(500);
    const result = truncateToBudget(content, 10); // tiny budget
    assert.ok(result.includes('[...truncated') || result.includes('chars removed'));
  });
});

describe('summarizeToolResults', () => {
  it('prioritizes errors first', () => {
    const results = [
      { toolName: 'read_file', input: { path: 'a.js' }, output: 'content', turnNumber: 1 },
      { toolName: 'write_file', input: { path: 'b.js' }, output: 'written', error: 'permission denied', turnNumber: 2 },
    ];
    const summary = summarizeToolResults(results, 1000);
    // Error should appear before the read
    const errIdx = summary.indexOf('permission denied');
    const readIdx = summary.indexOf('a.js');
    assert.ok(errIdx < readIdx || readIdx === -1, 'Error should come before reads');
  });

  it('returns "No tool results" for empty array', () => {
    assert.equal(summarizeToolResults([], 1000), 'No tool results.');
  });

  it('truncates to budget', () => {
    const results = Array.from({ length: 20 }, (_, i) => ({
      toolName: 'read_file',
      input: { path: `file-${i}.js` },
      output: 'x'.repeat(500),
      turnNumber: i + 1,
    }));
    const summary = summarizeToolResults(results, 100);
    assert.ok(computeTokenEstimate(summary) <= 120); // small margin
  });
});

describe('computeTokenEstimate', () => {
  it('uses ceil(length / 4) formula', () => {
    assert.equal(computeTokenEstimate('ABCD'), 1);       // 4/4 = 1
    assert.equal(computeTokenEstimate('ABCDE'), 2);      // ceil(5/4) = 2
    assert.equal(computeTokenEstimate(''), 0);
    assert.equal(computeTokenEstimate('A'.repeat(400)), 100);
  });
});
