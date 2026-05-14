/**
 * bench-08: Context pressure — mock repo has 20 large files.
 * Expected: engine handles context budget gracefully (Tier 5 best-effort drops).
 * Plan contract must NOT be pruned. Task completes or fails gracefully.
 */
import { createScriptedLLM } from '../benchmarkRunner.mjs';

const LARGE_FILE_CONTENT = 'x'.repeat(4000);

const mockRepo = {};
for (let i = 0; i < 20; i++) {
  mockRepo[`src/module-${i.toString().padStart(2, '0')}.js`] = `export const data${i} = ${JSON.stringify(LARGE_FILE_CONTENT)};`;
}

const CYCLE_DONE = `## summary\nCreated output.js.\n\n## deliverables_addressed\n- src/output.js: written\n\n## next_cycle_needed\nNo.\n\n<CYCLE_COMPLETE>`;

const plan = {
  version: '2026.1',
  taskId: 'bench-08',
  goal: 'Read and summarize 20 large files in src/, output the summary to src/output.js',
  deliverables: [
    { id: 'd1', type: 'file', path: 'src/output.js', description: 'Summary file', acceptanceCriteria: 'ok' },
  ],
  dependencies: [],
  validationSteps: [],
  estimatedCycles: 1,
  contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
};

export default {
  id: 'bench-08',
  name: 'Context pressure: 20 large files',
  mockRepo,
  expectedCycles: 2,
  expectedTurns: 999,
  shouldHalt: false,
  taskSpec: { taskId: 'bench-08', goal: plan.goal, plan, options: { maxCycles: 2, maxTurnsPerCycle: 10, contextWindow: 16000, requirePlanReview: false, requireCompletionConfirm: false } },
  createCallLLM() {
    return createScriptedLLM([
      `\`\`\`json\n${JSON.stringify({ tool: 'write_file', input: { path: 'src/output.js', content: 'export const summary = "20 modules summarized";' } })}\n\`\`\``,
      CYCLE_DONE,
    ]);
  },
};
