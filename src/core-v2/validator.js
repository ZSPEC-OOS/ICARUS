/**
 * @module validator
 * Post-cycle validation runner. Runs build/test/lint steps once per cycle.
 * Failures are quality signals, not blocks (unless safety gate also fires).
 * Output is capped per step to prevent context bloat.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_STEP_OUTPUT = 2000;
const MAX_SUMMARY_CHARS = 1000;

// ─── JSDoc Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ValidationStep
 * @property {string} id
 * @property {string} label - Human-readable name (e.g. "Build", "Tests")
 * @property {string} command - Shell command to run
 * @property {boolean} [required] - If false, failure is advisory only
 */

/**
 * @typedef {Object} ValidationResult
 * @property {string} id
 * @property {string} label
 * @property {boolean} passed
 * @property {string} command
 * @property {string} output
 * @property {string} [error]
 * @property {number} durationMs
 */

/**
 * @typedef {Object} ValidationSuite
 * @property {ValidationStep[]} steps
 * @property {boolean} stopOnFirstFailure
 * @property {number} maxOutputLength - Cap output per step
 */

/**
 * @typedef {Object} ValidationRunResult
 * @property {ValidationResult[]} results
 * @property {boolean} allPassed
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @param {import('./planContract.js').Deliverable[]} deliverables
 * @returns {boolean}
 */
function hasJsDeliverables(deliverables) {
  return deliverables.some((d) => d.path && /\.[jt]sx?$/.test(d.path));
}

/**
 * @param {import('./planContract.js').Deliverable[]} deliverables
 * @returns {boolean}
 */
function hasTestDeliverables(deliverables) {
  return deliverables.some((d) => d.type === 'test');
}

/**
 * Determines if a command output represents a pass.
 * Non-ERROR, non-"fail" output is treated as pass.
 *
 * @param {string} output
 * @returns {boolean}
 */
function outputIndicatesPass(output) {
  const lower = output.toLowerCase();
  if (output.startsWith('ERROR:')) return false;
  if (/\bfailed?\b/.test(lower) && !/\b0 failed\b/.test(lower)) return false;
  if (/\berror\b/.test(lower) && !/\b0 error/.test(lower) && !/no error/i.test(lower)) return false;
  return true;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Builds a validation suite from a plan's validationSteps.
 * Adds default steps when none are specified based on deliverable types.
 *
 * @param {import('./planContract.js').ExecutionPlan} plan
 * @returns {ValidationSuite}
 */
export function createValidationSuite(plan) {
  const steps = [];
  const deliverables = plan.deliverables ?? [];
  const planSteps = plan.validationSteps ?? [];

  // Use explicit steps from plan if available
  // planContract.ValidationStep schema: { id, description, type: 'command'|'lint'|'test'|'typecheck'|'manual' }
  if (planSteps.length > 0) {
    for (const s of planSteps) {
      if (!s || typeof s !== 'object') continue;
      const typeToCommand = {
        lint:      'npm run lint --if-present 2>&1 || true',
        test:      'npm test --if-present 2>&1 || true',
        typecheck: 'npx tsc --noEmit 2>&1 || true',
        command:   'npm run build --if-present 2>&1 || true',
        manual:    null, // skip — requires human
      };
      const cmd = typeToCommand[s.type] ?? null;
      if (!cmd) continue; // skip manual and unknown types
      steps.push({
        id: s.id ?? `plan-step-${steps.length}`,
        label: s.description ?? s.type,
        command: cmd,
        required: false,
      });
    }
  } else {
    // Auto-derive default steps
    if (hasJsDeliverables(deliverables)) {
      steps.push({
        id: 'build',
        label: 'Build',
        command: 'npm run build --if-present 2>&1 || npx tsc --noEmit 2>&1 || true',
        required: false,
      });
    }

    if (hasTestDeliverables(deliverables)) {
      // Look for explicit test command in deliverables
      const testDeliverable = deliverables.find((d) => d.type === 'test' && d.path);
      const testCmd = testDeliverable?.path ? `node --test ${testDeliverable.path}` : 'npm test --if-present 2>&1 || true';
      steps.push({
        id: 'tests',
        label: 'Tests',
        command: testCmd,
        required: false,
      });
    }

    // Lint step if any JS/TS deliverables
    if (hasJsDeliverables(deliverables)) {
      steps.push({
        id: 'lint',
        label: 'Lint',
        command: 'npm run lint --if-present 2>&1 || true',
        required: false,
      });
    }
  }

  return {
    steps,
    stopOnFirstFailure: false,
    maxOutputLength: MAX_STEP_OUTPUT,
  };
}

/**
 * Runs all steps in a validation suite and collects results.
 * Never throws — all errors become failing ValidationResults.
 *
 * @param {ValidationSuite} suite
 * @param {(name: string, input: Object) => Promise<string>} executeTool
 * @returns {Promise<ValidationRunResult>}
 */
export async function runValidation(suite, executeTool) {
  const results = [];

  for (const step of suite.steps) {
    const start = Date.now();
    let output = '';
    let error;
    let passed = false;

    try {
      const raw = await executeTool('run_command', { command: step.command });
      output = String(raw).slice(0, suite.maxOutputLength);
      if (output.length < String(raw).length) {
        output += `\n[...truncated at ${suite.maxOutputLength} chars]`;
      }
      passed = outputIndicatesPass(output);
    } catch (err) {
      output = '';
      error = err.message;
      passed = false;
    }

    results.push({
      id: step.id,
      label: step.label,
      passed,
      command: step.command,
      output,
      ...(error ? { error } : {}),
      durationMs: Date.now() - start,
    });

    if (!passed && suite.stopOnFirstFailure) break;
  }

  return {
    results,
    allPassed: results.every((r) => r.passed),
  };
}

/**
 * Returns a ≤1000 char human-readable summary of validation results.
 *
 * @param {ValidationResult[]} results
 * @returns {string}
 */
export function summarizeValidation(results) {
  if (results.length === 0) return 'No validation steps ran.';

  const passCount = results.filter((r) => r.passed).length;
  const lines = ['Validation Results', '──────────────────'];

  // Failed steps first for visibility
  const sorted = [...results].sort((a, b) => {
    if (a.passed === b.passed) return 0;
    return a.passed ? 1 : -1;
  });

  for (const r of sorted) {
    const icon = r.passed ? '✓' : '✗';
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    lines.push(`${icon} ${r.label}: ${r.passed ? 'passed' : 'failed'} (${dur})`);
    if (!r.passed && r.output) {
      // Include first 200 chars of output for failed steps
      const snippet = r.output.split('\n').filter(Boolean).slice(0, 3).join('\n');
      if (snippet) lines.push(`  ${snippet.slice(0, 200)}`);
    }
  }

  lines.push(`${passCount}/${results.length} passed`);

  const summary = lines.join('\n');
  if (summary.length > MAX_SUMMARY_CHARS) {
    return summary.slice(0, MAX_SUMMARY_CHARS - 3) + '...';
  }
  return summary;
}
