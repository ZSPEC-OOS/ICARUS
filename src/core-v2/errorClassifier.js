/**
 * @module errorClassifier
 * Classification-only error handling. Classifies errors, never repairs them.
 * Replaces bluswanRepairEngine.js with a predictable, auditable registry.
 */

// ─── JSDoc Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {'api'|'tool'|'validation'|'system'|'budget'|'loop'} ErrorCategory
 */

/**
 * @typedef {'fatal'|'recoverable'|'warning'} ErrorSeverity
 */

/**
 * @typedef {'retry'|'skip'|'abort'|'escalate'|'reduce_scope'} ErrorStrategy
 */

/**
 * @typedef {Object} ClassifiedError
 * @property {string} code
 * @property {ErrorCategory} category
 * @property {ErrorSeverity} severity
 * @property {string} explanation
 * @property {ErrorStrategy} suggestedStrategy
 * @property {number} [remediationCost]
 * @property {boolean} isRetryable
 */

// ─── Error Registry ───────────────────────────────────────────────────────────

/** @type {Readonly<Record<string, Omit<ClassifiedError, 'code'>>>} */
const ERROR_REGISTRY = Object.freeze({
  'api-401': {
    category: 'api', severity: 'fatal',
    explanation: 'API key rejected. Check key in Settings.',
    suggestedStrategy: 'abort', remediationCost: 0, isRetryable: false,
  },
  'api-429': {
    category: 'api', severity: 'recoverable',
    explanation: 'Rate limited. Wait before retry.',
    suggestedStrategy: 'retry', remediationCost: 10, isRetryable: true,
  },
  'api-500': {
    category: 'api', severity: 'recoverable',
    explanation: 'Server error. Try again.',
    suggestedStrategy: 'retry', remediationCost: 10, isRetryable: true,
  },
  'api-timeout': {
    category: 'api', severity: 'recoverable',
    explanation: 'Request timed out. Try again.',
    suggestedStrategy: 'retry', remediationCost: 10, isRetryable: true,
  },
  'tool-not-found': {
    category: 'tool', severity: 'fatal',
    explanation: 'Tool does not exist. Check tool name.',
    suggestedStrategy: 'abort', remediationCost: 0, isRetryable: false,
  },
  'tool-not-allowed': {
    category: 'tool', severity: 'fatal',
    explanation: 'Tool not allowed in this cycle. Use allowed tools only.',
    suggestedStrategy: 'abort', remediationCost: 0, isRetryable: false,
  },
  'tool-edit-mismatch': {
    category: 'tool', severity: 'recoverable',
    explanation: 'edit_file old_str not found. Re-read file and try exact match.',
    suggestedStrategy: 'retry', remediationCost: 5, isRetryable: true,
  },
  'tool-write-exists': {
    category: 'tool', severity: 'warning',
    explanation: 'write_file target already exists. Use edit_file instead.',
    suggestedStrategy: 'retry', remediationCost: 5, isRetryable: true,
  },
  'tool-read-notfound': {
    category: 'tool', severity: 'warning',
    explanation: 'File not found. Check path or create it.',
    suggestedStrategy: 'skip', remediationCost: 2, isRetryable: false,
  },
  'tool-command-failed': {
    category: 'tool', severity: 'recoverable',
    explanation: 'Command exited non-zero. Check error output.',
    suggestedStrategy: 'retry', remediationCost: 10, isRetryable: true,
  },
  'budget-exceeded': {
    category: 'budget', severity: 'fatal',
    explanation: 'Context budget exceeded. Reduce scope or split task.',
    suggestedStrategy: 'reduce_scope', remediationCost: 0, isRetryable: false,
  },
  'budget-remedy-exhausted': {
    category: 'budget', severity: 'fatal',
    explanation: 'Remediation budget exhausted. Task incomplete.',
    suggestedStrategy: 'abort', remediationCost: 0, isRetryable: false,
  },
  'loop-tool-sequence': {
    category: 'loop', severity: 'fatal',
    explanation: 'Repeating same tool calls. Try different approach.',
    suggestedStrategy: 'abort', remediationCost: 0, isRetryable: false,
  },
  'loop-read-without-action': {
    category: 'loop', severity: 'fatal',
    explanation: 'Reading same file repeatedly without editing.',
    suggestedStrategy: 'abort', remediationCost: 0, isRetryable: false,
  },
  'loop-idle-turns': {
    category: 'loop', severity: 'fatal',
    explanation: 'No progress for 8 turns. Task may be too complex.',
    suggestedStrategy: 'reduce_scope', remediationCost: 0, isRetryable: false,
  },
  'loop-deliverable-retry': {
    category: 'loop', severity: 'fatal',
    explanation: 'Failed same deliverable twice. Different approach needed.',
    suggestedStrategy: 'abort', remediationCost: 0, isRetryable: false,
  },
  'validation-failed': {
    category: 'validation', severity: 'warning',
    explanation: 'Output did not meet acceptance criteria.',
    suggestedStrategy: 'retry', remediationCost: 15, isRetryable: true,
  },
  'completion-missing-token': {
    category: 'validation', severity: 'warning',
    explanation: 'Missing <CYCLE_COMPLETE> token.',
    suggestedStrategy: 'retry', remediationCost: 5, isRetryable: true,
  },
  'plan-invalid': {
    category: 'system', severity: 'fatal',
    explanation: 'Generated plan failed validation.',
    suggestedStrategy: 'abort', remediationCost: 0, isRetryable: false,
  },
});

// ─── Inference Helpers ────────────────────────────────────────────────────────

/**
 * Infers an error code from an Error object or string.
 * @param {unknown} error
 * @returns {string}
 */
function inferCode(error) {
  if (!error) return 'unknown-error';

  // HTTP status codes
  if (typeof error === 'object' && error !== null) {
    const status = /** @type {any} */ (error).status;
    if (status === 401) return 'api-401';
    if (status === 429) return 'api-429';
    if (status >= 500 && status < 600) return 'api-500';

    const code = /** @type {any} */ (error).code;
    if (typeof code === 'string') {
      // Map known internal codes
      if (code === 'ContextBudgetExceededError' || code === 'budget-exceeded') return 'budget-exceeded';
      if (code === 'ToolNotAllowedError' || code === 'tool-not-allowed') return 'tool-not-allowed';
    }

    const name = /** @type {any} */ (error).name;
    if (name === 'ContextBudgetExceededError') return 'budget-exceeded';
    if (name === 'ContextBudgetError') return 'budget-exceeded';
    if (name === 'ToolNotAllowedError') return 'tool-not-allowed';
    if (name === 'PlanValidationError') return 'plan-invalid';

    // Timeout
    const msg = String(/** @type {any} */ (error).message ?? '').toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out')) return 'api-timeout';
    if (msg.includes('old_str') || msg.includes('not found in')) return 'tool-edit-mismatch';
    if (msg.includes('enoent') || msg.includes('not found')) return 'tool-read-notfound';
    if (msg.includes('already exists')) return 'tool-write-exists';
    if (msg.includes('exited with code') || msg.includes('non-zero')) return 'tool-command-failed';
    if (msg.includes('budget') && msg.includes('exceed')) return 'budget-exceeded';
    if (msg.includes('remediation') && msg.includes('exhaust')) return 'budget-remedy-exhausted';
    if (msg.includes('tool') && msg.includes('sequence')) return 'loop-tool-sequence';
    if (msg.includes('read') && msg.includes('without')) return 'loop-read-without-action';
    if (msg.includes('idle') || msg.includes('no progress')) return 'loop-idle-turns';
    if (msg.includes('deliverable') && msg.includes('retry')) return 'loop-deliverable-retry';
    if (msg.includes('<cycle_complete>') || msg.includes('completion token')) return 'completion-missing-token';
    if (msg.includes('acceptance criteria') || msg.includes('validation failed')) return 'validation-failed';
    if (msg.includes('plan') && msg.includes('validation')) return 'plan-invalid';
  }

  if (typeof error === 'string') {
    const lower = error.toLowerCase();
    if (lower.includes('old_str')) return 'tool-edit-mismatch';
    if (lower.includes('already exists')) return 'tool-write-exists';
    if (lower.includes('not found')) return 'tool-read-notfound';
    if (lower.includes('timeout')) return 'api-timeout';
    if (lower.includes('rate limit')) return 'api-429';
    if (lower.includes('budget')) return 'budget-exceeded';
  }

  return 'unknown-error';
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Classifies any error into a structured ClassifiedError.
 *
 * @param {unknown} error
 * @returns {ClassifiedError}
 */
export function classifyError(error) {
  const code = inferCode(error);
  const entry = ERROR_REGISTRY[code];

  if (entry) {
    return { code, ...entry };
  }

  // Unknown errors are always fatal — fail loud, not silent
  return {
    code: 'unknown-error',
    category: 'system',
    severity: 'fatal',
    explanation: `Unclassified error: ${String(error instanceof Error ? error.message : error)}`,
    suggestedStrategy: 'abort',
    remediationCost: 0,
    isRetryable: false,
  };
}

/**
 * Formats a ClassifiedError for inclusion in the next cycle's LLM context.
 *
 * @param {ClassifiedError} classifiedError
 * @returns {string}
 */
export function formatErrorForLLM(classifiedError) {
  const costLine = classifiedError.remediationCost !== undefined
    ? `\nRemediation cost: ${classifiedError.remediationCost} units.`
    : '';

  return (
    `[ERROR] ${classifiedError.code} (${classifiedError.severity})\n` +
    `${classifiedError.explanation}\n` +
    `Strategy: ${classifiedError.suggestedStrategy}.` +
    costLine
  );
}

/**
 * Formats a ClassifiedError for display in the user-facing UI.
 *
 * @param {ClassifiedError} classifiedError
 * @returns {string}
 */
export function formatErrorForUser(classifiedError) {
  const retryNote = classifiedError.isRetryable
    ? ' This can be retried.'
    : ' This cannot be automatically retried.';

  return (
    `Error [${classifiedError.code}]: ${classifiedError.explanation}` +
    retryNote
  );
}

/**
 * Returns true if the error severity is 'fatal'.
 * Fatal errors must halt the cycle immediately.
 *
 * @param {ClassifiedError} classifiedError
 * @returns {boolean}
 */
export function isFatal(classifiedError) {
  return classifiedError.severity === 'fatal';
}

/**
 * Returns the full error registry for inspection/testing.
 * @returns {Readonly<Record<string, Omit<ClassifiedError, 'code'>>>}
 */
export function getErrorRegistry() {
  return ERROR_REGISTRY;
}
