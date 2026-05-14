/**
 * chaos-05: Remediation exhaustion.
 * Every tool call returns an error — LLM keeps trying to fix but always fails.
 * Expected: remediation budget exhausted, task halts gracefully.
 */
import {
  createChaosExecutor,
  createBaseExecutor,
  createChaosCallbacks,
} from '../chaosEngine.mjs';

const plan = {
  version: '2026.1',
  taskId: 'chaos-05',
  goal: 'Create src/config.js with environment configuration',
  deliverables: [
    { id: 'd1', type: 'file', path: 'src/config.js', description: 'Config module', acceptanceCriteria: 'ok' },
  ],
  dependencies: [],
  validationSteps: [],
  estimatedCycles: 1,
  contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
};

const WRITE_CALL = JSON.stringify({ tool: 'write_file', input: { path: 'src/config.js', content: 'export const config = { env: "production" };\n' } });

// LLM always retries write_file after seeing errors
function createRetryLLM() {
  return async function retryLLM(_messages) {
    return `\`\`\`json\n${WRITE_CALL}\n\`\`\``;
  };
}

export default {
  id: 'chaos-05',
  name: 'Remediation exhaustion: every write fails permanently',
  expectedBehavior: 'Task halts cleanly when max turns or loop guard triggered by persistent failures',
  taskSpec: {
    taskId: 'chaos-05',
    goal: plan.goal,
    plan,
    options: {
      maxCycles: 2,
      maxTurnsPerCycle: 8,
      contextWindow: 32000,
      requirePlanReview: false,
      requireCompletionConfirm: false,
    },
  },
  createCallbacks() {
    const base = createBaseExecutor({});
    // All write_file calls fail on every attempt
    const chaosExec = createChaosExecutor(base, {
      failureRate: 1.0,
      targetTools: ['write_file'],
      failureTypes: ['error'],
      maxFailuresPerCycle: 20,
      deterministic: true,
    });
    const callLLM = createRetryLLM();
    return createChaosCallbacks(callLLM, chaosExec);
  },
  evaluate(chaosResult) {
    return chaosResult.taskCompletedOrHaltedCleanly;
  },
};
