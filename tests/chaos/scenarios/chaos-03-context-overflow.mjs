/**
 * chaos-03: Context overflow.
 * contextWindow set to 1000 (very small) with a 20-file repo.
 * Expected: engine handles context budget gracefully — task completes or halts, never crashes.
 * Plan contract must NOT be pruned (plan is always included regardless of budget).
 */
import {
  createBaseExecutor,
  createChaosCallbacks,
} from '../chaosEngine.mjs';
import { createScriptedLLM } from '../../benchmarks/benchmarkRunner.mjs';

// Build a mock repo with 20 large files to stress context packing
const mockFiles = {};
for (let i = 0; i < 20; i++) {
  mockFiles[`src/module-${i.toString().padStart(2, '0')}.js`] = `export const data${i} = "${'x'.repeat(500)}";`;
}
mockFiles['src/output.js'] = '// placeholder';

const plan = {
  version: '2026.1',
  taskId: 'chaos-03',
  goal: 'Write src/output.js with a summary of all modules',
  deliverables: [
    { id: 'd1', type: 'file', path: 'src/output.js', description: 'Summary output', acceptanceCriteria: 'ok' },
  ],
  dependencies: [],
  validationSteps: [],
  estimatedCycles: 1,
  contextStrategy: { maxTokensPerCycle: 1000, includeRepoMap: true },
};

const CYCLE_DONE = `## summary\nWrote output.js.\n\n## deliverables_addressed\n- src/output.js: written\n\n## next_cycle_needed\nNo.\n\n<CYCLE_COMPLETE>`;

export default {
  id: 'chaos-03',
  name: 'Context overflow: tiny context window with large repo',
  expectedBehavior: 'Task completes or halts cleanly; plan contract preserved; no crash',
  taskSpec: {
    taskId: 'chaos-03',
    goal: plan.goal,
    plan,
    options: {
      maxCycles: 2,
      maxTurnsPerCycle: 5,
      contextWindow: 1000,
      requirePlanReview: false,
      requireCompletionConfirm: false,
    },
  },
  createCallbacks() {
    const base = createBaseExecutor({ ...mockFiles });
    const callLLM = createScriptedLLM([
      `\`\`\`json\n${JSON.stringify({ tool: 'write_file', input: { path: 'src/output.js', content: 'export const summary = "20 modules";' } })}\n\`\`\``,
      CYCLE_DONE,
    ]);
    return createChaosCallbacks(callLLM, base);
  },
  evaluate(chaosResult) {
    return chaosResult.taskCompletedOrHaltedCleanly;
  },
};
