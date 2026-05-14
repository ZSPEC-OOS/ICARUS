/**
 * chaos-02: API timeout injection.
 * callLLM always throws a timeout error.
 * Expected: error classified as api-timeout (recoverable), turns exhausted, task fails cleanly.
 */
import {
  createBaseExecutor,
  createChaosCallbacks,
} from '../chaosEngine.mjs';

const plan = {
  version: '2026.1',
  taskId: 'chaos-02',
  goal: 'Create src/logger.js with a log function',
  deliverables: [
    { id: 'd1', type: 'file', path: 'src/logger.js', description: 'Logger module', acceptanceCriteria: 'ok' },
  ],
  dependencies: [],
  validationSteps: [],
  estimatedCycles: 1,
  contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
};

// Always throws a timeout — never succeeds
function createTimeoutLLM() {
  return async function timeoutLLM(_messages) {
    throw Object.assign(new Error('Request timed out after 5000ms'), { code: 'ETIMEDOUT' });
  };
}

export default {
  id: 'chaos-02',
  name: 'API timeout: callLLM always times out',
  expectedBehavior: 'Task fails cleanly when all turns exhausted by api-timeout recoverable errors',
  taskSpec: {
    taskId: 'chaos-02',
    goal: plan.goal,
    plan,
    options: {
      maxCycles: 1,
      maxTurnsPerCycle: 3,
      contextWindow: 32000,
      requirePlanReview: false,
      requireCompletionConfirm: false,
    },
  },
  createCallbacks() {
    const base = createBaseExecutor({});
    const callLLM = createTimeoutLLM();
    return createChaosCallbacks(callLLM, base);
  },
  evaluate(chaosResult) {
    // Must halt cleanly — either 'failed' (turns exhausted) or 'halted'
    return chaosResult.taskCompletedOrHaltedCleanly;
  },
};
