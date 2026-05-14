import { createScriptedLLM } from '../benchmarkRunner.mjs';

const CYCLE_DONE = `## summary\nCreated src/utils.js with add function.\n\n## deliverables_addressed\n- src/utils.js: written\n\n## next_cycle_needed\nNo.\n\n<CYCLE_COMPLETE>`;

const plan = {
  version: '2026.1',
  taskId: 'bench-01',
  goal: 'Create a file src/utils.js that exports a function add(a, b)',
  deliverables: [
    { id: 'd1', type: 'file', path: 'src/utils.js', description: 'Utils module with add function', acceptanceCriteria: 'ok' },
  ],
  dependencies: [],
  validationSteps: [],
  estimatedCycles: 1,
  contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
};

export default {
  id: 'bench-01',
  name: 'Simple file creation',
  mockRepo: {},
  expectedCycles: 1,
  expectedTurns: 5,
  expectedDeliverables: ['d1'],
  shouldHalt: false,
  taskSpec: { taskId: 'bench-01', goal: plan.goal, plan, options: { maxCycles: 2, maxTurnsPerCycle: 10, contextWindow: 32000, requirePlanReview: false, requireCompletionConfirm: false } },
  createCallLLM() {
    return createScriptedLLM([
      `\`\`\`json\n${JSON.stringify({ tool: 'write_file', input: { path: 'src/utils.js', content: 'export function add(a, b) { return a + b; }' } })}\n\`\`\``,
      CYCLE_DONE,
    ]);
  },
};
