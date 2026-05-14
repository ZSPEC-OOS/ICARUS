/**
 * chaos-04: Loop induction.
 * LLM always returns the same read_file tool call, never making progress.
 * Expected: loopPrevention halts the task in ≤3 cycles.
 */
import {
  createLoopInducingLLM,
  createBaseExecutor,
  createChaosCallbacks,
} from '../chaosEngine.mjs';

const plan = {
  version: '2026.1',
  taskId: 'chaos-04',
  goal: 'Analyze src/app.js and write a summary to src/summary.js',
  deliverables: [
    { id: 'd1', type: 'file', path: 'src/summary.js', description: 'Analysis summary', acceptanceCriteria: 'ok' },
  ],
  dependencies: [],
  validationSteps: [],
  estimatedCycles: 1,
  contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
};

export default {
  id: 'chaos-04',
  name: 'Loop induction: LLM repeats same read_file call forever',
  expectedBehavior: 'loopPrevention halts the task within 3 cycles',
  taskSpec: {
    taskId: 'chaos-04',
    goal: plan.goal,
    plan,
    options: {
      maxCycles: 5,
      maxTurnsPerCycle: 15,
      contextWindow: 32000,
      requirePlanReview: false,
      requireCompletionConfirm: false,
    },
  },
  createCallbacks() {
    const base = createBaseExecutor({
      'src/app.js': 'export function app() { return "hello"; }',
    });
    // Repeats read_file on src/app.js indefinitely
    const callLLM = createLoopInducingLLM('read_file', 'src/app.js', 100);
    return createChaosCallbacks(callLLM, base);
  },
  evaluate(chaosResult) {
    return chaosResult.taskCompletedOrHaltedCleanly && chaosResult.cyclesUsed <= 3;
  },
};
