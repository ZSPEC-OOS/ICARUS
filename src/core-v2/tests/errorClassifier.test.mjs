import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyError,
  formatErrorForLLM,
  formatErrorForUser,
  isFatal,
  getErrorRegistry,
} from '../errorClassifier.js';
import { ContextBudgetExceededError, ContextBudgetError } from '../contextBudget.js';
import { ToolNotAllowedError } from '../cycleEngine.js';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('classifyError — HTTP status codes', () => {
  it('HTTP 401 → api-401, fatal', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    const result = classifyError(err);
    assert.equal(result.code, 'api-401');
    assert.equal(result.category, 'api');
    assert.equal(result.severity, 'fatal');
    assert.equal(result.isRetryable, false);
  });

  it('HTTP 429 → api-429, recoverable', () => {
    const err = Object.assign(new Error('Rate limited'), { status: 429 });
    const result = classifyError(err);
    assert.equal(result.code, 'api-429');
    assert.equal(result.severity, 'recoverable');
    assert.equal(result.isRetryable, true);
  });

  it('HTTP 503 → api-500, recoverable', () => {
    const err = Object.assign(new Error('Service unavailable'), { status: 503 });
    const result = classifyError(err);
    assert.equal(result.code, 'api-500');
    assert.equal(result.severity, 'recoverable');
  });
});

describe('classifyError — tool errors', () => {
  it('edit mismatch → tool-edit-mismatch', () => {
    const err = new Error('old_str not found in src/utils.js');
    const result = classifyError(err);
    assert.equal(result.code, 'tool-edit-mismatch');
    assert.equal(result.isRetryable, true);
  });

  it('ToolNotAllowedError → tool-not-allowed', () => {
    const err = new ToolNotAllowedError('edit_file', ['write_file']);
    const result = classifyError(err);
    assert.equal(result.code, 'tool-not-allowed');
    assert.equal(result.severity, 'fatal');
    assert.equal(result.isRetryable, false);
  });

  it('file not found → tool-read-notfound', () => {
    const err = new Error('ENOENT: no such file or directory');
    const result = classifyError(err);
    assert.equal(result.code, 'tool-read-notfound');
  });
});

describe('classifyError — budget errors', () => {
  it('ContextBudgetExceededError → budget-exceeded', () => {
    const err = new ContextBudgetExceededError({
      requested: 5000, available: 3000, overflow: 2000, suggestion: 'Reduce toolResults',
    });
    const result = classifyError(err);
    assert.equal(result.code, 'budget-exceeded');
    assert.equal(result.severity, 'fatal');
    assert.equal(result.isRetryable, false);
  });

  it('ContextBudgetError → budget-exceeded', () => {
    const err = new ContextBudgetError('Window too small');
    const result = classifyError(err);
    assert.equal(result.code, 'budget-exceeded');
  });
});

describe('classifyError — loop errors', () => {
  it('loop tool sequence message → loop-tool-sequence', () => {
    const err = new Error('tool sequence repeated');
    const result = classifyError(err);
    assert.equal(result.code, 'loop-tool-sequence');
    assert.equal(result.severity, 'fatal');
  });

  it('idle turns message → loop-idle-turns', () => {
    const err = new Error('No progress for 8 turns');
    const result = classifyError(err);
    assert.equal(result.code, 'loop-idle-turns');
  });
});

describe('formatErrorForLLM', () => {
  it('includes code, explanation, strategy, and cost', () => {
    const classified = classifyError(Object.assign(new Error(), { status: 429 }));
    const formatted = formatErrorForLLM(classified);
    assert.ok(formatted.includes('api-429'));
    assert.ok(formatted.includes('Rate limited'));
    assert.ok(formatted.includes('retry'));
    assert.ok(formatted.includes('10')); // cost
  });

  it('starts with [ERROR] marker', () => {
    const classified = classifyError(new Error('old_str not found'));
    const formatted = formatErrorForLLM(classified);
    assert.ok(formatted.startsWith('[ERROR]'));
  });
});

describe('formatErrorForUser', () => {
  it('is human-readable and includes retryability hint', () => {
    const classified = classifyError(Object.assign(new Error(), { status: 401 }));
    const formatted = formatErrorForUser(classified);
    assert.ok(typeof formatted === 'string');
    assert.ok(formatted.includes('api-401'));
    assert.ok(formatted.toLowerCase().includes('retry') || formatted.toLowerCase().includes('cannot'));
  });
});

describe('isFatal', () => {
  it('returns true for fatal errors', () => {
    const classified = classifyError(Object.assign(new Error(), { status: 401 }));
    assert.equal(isFatal(classified), true);
  });

  it('returns false for warning severity', () => {
    const classified = classifyError(new Error('already exists'));
    assert.equal(isFatal(classified), false);
  });

  it('returns false for recoverable severity', () => {
    const classified = classifyError(Object.assign(new Error(), { status: 429 }));
    assert.equal(isFatal(classified), false);
  });
});

describe('unknown errors', () => {
  it('unknown errors get unknown-error code with fatal severity', () => {
    const result = classifyError(new Error('some completely unknown thing happened xyz'));
    assert.equal(result.code, 'unknown-error');
    assert.equal(result.severity, 'fatal');
    assert.equal(result.suggestedStrategy, 'abort');
    assert.equal(result.isRetryable, false);
  });

  it('null/undefined gets unknown-error', () => {
    const result = classifyError(null);
    assert.equal(result.code, 'unknown-error');
  });
});

describe('error registry completeness', () => {
  it('all registry entries have required fields', () => {
    const registry = getErrorRegistry();
    const requiredFields = ['category', 'severity', 'explanation', 'suggestedStrategy', 'isRetryable'];

    for (const [code, entry] of Object.entries(registry)) {
      for (const field of requiredFields) {
        assert.ok(
          Object.hasOwn(entry, field),
          `Registry entry '${code}' missing field '${field}'`
        );
      }
      // severity must be valid
      assert.ok(
        ['fatal', 'recoverable', 'warning'].includes(entry.severity),
        `'${code}' has invalid severity '${entry.severity}'`
      );
      // category must be valid
      assert.ok(
        ['api', 'tool', 'validation', 'system', 'budget', 'loop'].includes(entry.category),
        `'${code}' has invalid category '${entry.category}'`
      );
      // suggestedStrategy must be valid
      assert.ok(
        ['retry', 'skip', 'abort', 'escalate', 'reduce_scope'].includes(entry.suggestedStrategy),
        `'${code}' has invalid strategy '${entry.suggestedStrategy}'`
      );
    }
  });
});
