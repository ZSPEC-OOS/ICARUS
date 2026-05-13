/**
 * @module remediationBudget
 * Explicit per-task remediation accounting with audit trail.
 * No hidden costs — every spend is recorded with reason and location.
 */

/** @type {Record<string, number>} */
export const COST_TABLE = Object.freeze({
  tool_retry: 5,
  file_re_read: 2,
  test_re_run: 10,
  lint_re_run: 5,
  model_re_call: 20,
  rollback_attempt: 50,
  error_recovery: 8,
  context_repack: 15,
});

export class RemediationBudgetExhaustedError extends Error {
  /**
   * @param {string} action
   * @param {number} cost
   * @param {number} remaining
   */
  constructor(action, cost, remaining) {
    super(`Remediation budget exhausted: '${action}' costs ${cost} but only ${remaining} remaining`);
    this.name = 'RemediationBudgetExhaustedError';
    this.action = action;
    this.cost = cost;
    this.remaining = remaining;
  }
}

/**
 * @typedef {Object} BudgetEntry
 * @property {string} action
 * @property {number} cost
 * @property {string} reason
 * @property {number} turnNumber
 * @property {number} cycleNumber
 * @property {number} timestamp
 */

/**
 * @typedef {Object} RemediationBudget
 * @property {number} total
 * @property {number} spent
 * @property {number} remaining
 * @property {BudgetEntry[]} auditTrail
 */

/**
 * Create a new remediation budget for a task.
 * @param {number} [total=100]
 * @returns {RemediationBudget}
 */
export function createRemediationBudget(total = 100) {
  if (typeof total !== 'number' || total <= 0) {
    throw new RangeError(`Remediation budget total must be a positive number, got: ${total}`);
  }
  return {
    total,
    spent: 0,
    remaining: total,
    auditTrail: [],
  };
}

/**
 * Spend budget for an action. Returns a new budget object (immutable).
 * Throws RemediationBudgetExhaustedError if insufficient funds.
 * @param {RemediationBudget} budget
 * @param {string} action - key from COST_TABLE
 * @param {string} reason
 * @param {number} turnNumber
 * @param {number} cycleNumber
 * @returns {RemediationBudget}
 */
export function spend(budget, action, reason, turnNumber, cycleNumber) {
  const cost = COST_TABLE[action];
  if (cost === undefined) {
    throw new RangeError(`Unknown remediation action: '${action}'. Known actions: ${Object.keys(COST_TABLE).join(', ')}`);
  }
  if (budget.remaining < cost) {
    throw new RemediationBudgetExhaustedError(action, cost, budget.remaining);
  }
  const entry = {
    action,
    cost,
    reason,
    turnNumber,
    cycleNumber,
    timestamp: Date.now(),
  };
  return {
    total: budget.total,
    spent: budget.spent + cost,
    remaining: budget.remaining - cost,
    auditTrail: [...budget.auditTrail, entry],
  };
}

/**
 * Check if the budget can afford an action without spending.
 * @param {RemediationBudget} budget
 * @param {string} action
 * @returns {boolean}
 */
export function canAfford(budget, action) {
  const cost = COST_TABLE[action];
  if (cost === undefined) return false;
  return budget.remaining >= cost;
}

/**
 * Aggregate spent amounts by action category.
 * @param {RemediationBudget} budget
 * @returns {Record<string, number>}
 */
export function getSpentByCategory(budget) {
  const result = {};
  for (const entry of budget.auditTrail) {
    result[entry.action] = (result[entry.action] ?? 0) + entry.cost;
  }
  return result;
}

/**
 * Return a human-readable audit report.
 * @param {RemediationBudget} budget
 * @returns {string}
 */
export function getAuditReport(budget) {
  const lines = [
    `Remediation Budget Report`,
    `  Total:     ${budget.total}`,
    `  Spent:     ${budget.spent}`,
    `  Remaining: ${budget.remaining}`,
    ``,
    `Audit Trail (${budget.auditTrail.length} entries):`,
  ];
  for (const entry of budget.auditTrail) {
    lines.push(
      `  [cycle ${entry.cycleNumber} turn ${entry.turnNumber}] ${entry.action} (-${entry.cost}): ${entry.reason}`
    );
  }
  const byCategory = getSpentByCategory(budget);
  if (Object.keys(byCategory).length > 0) {
    lines.push(``, `Spend by Category:`);
    for (const [action, total] of Object.entries(byCategory)) {
      lines.push(`  ${action}: ${total}`);
    }
  }
  return lines.join('\n');
}
