/**
 * chaos-01: Tool failure injection.
 * edit_file fails deterministically (every 2nd call).
 * Expected: loop guard detects repeated failing sequence and halts cleanly.
 */
import {
  createChaosExecutor,
  createBaseExecutor,
  createChaosCallbacks,
} from '../chaosEngine.mjs';

const plan = {
  version: '2026.1',
  taskId: 'chaos-01',
  goal: 'Refactor src/index.js to use named exports',
  deliverables: [
    { id: 'd1', type: 'edit', path: 'src/index.js', description: 'Convert to named exports', acceptanceCriteria: 'ok' },
  ],
  dependencies: [],
  validationSteps: [],
  estimatedCycles: 1,
  contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
};

const EDIT_CALL = JSON.stringify({ tool: 'edit_file', input: { file_path: 'src/index.js', new_content: 'export { foo } from "./foo.js";\n' } });

// LLM keeps retrying edit_file after failures — loop guard halts it
function createTimingOutLLM() {
  let calls = 0;
  return async function chaosLLM(_messages) {
    calls++;
    return `\`\`\`json\n${EDIT_CALL}\n\`\`\``;
  };
}

export default {
  id: 'chaos-01',
  name: 'Tool failure: edit_file fails 50%',
  expectedBehavior: 'Loop guard halts after detecting repeated failing tool sequence',
  taskSpec: {
    taskId: 'chaos-01',
    goal: plan.goal,
    plan,
    options: {
      maxCycles: 2,
      maxTurnsPerCycle: 10,
      contextWindow: 32000,
      requirePlanReview: false,
      requireCompletionConfirm: false,
    },
  },
  createCallbacks() {
    const base = createBaseExecutor({ 'src/index.js': 'module.exports = require("./foo");\n' });
    const chaosExec = createChaosExecutor(base, {
      failureRate: 0.5,
      targetTools: ['edit_file'],
      failureTypes: ['error'],
      maxFailuresPerCycle: 6,
      deterministic: true,
    });
    const callLLM = createTimingOutLLM();
    return createChaosCallbacks(callLLM, chaosExec);
  },
  evaluate(chaosResult) {
    return chaosResult.taskCompletedOrHaltedCleanly;
  },
};
