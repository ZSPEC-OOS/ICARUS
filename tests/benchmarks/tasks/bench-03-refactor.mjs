import { createScriptedLLM, createMockExecutor } from '../benchmarkRunner.mjs';

const CYCLE_DONE = `## summary\nRenamed oldName to newName in both files.\n\n## deliverables_addressed\n- src/utils.js: edited\n- src/app.js: edited\n\n## next_cycle_needed\nNo.\n\n<CYCLE_COMPLETE>`;

const plan = {
  version: '2026.1',
  taskId: 'bench-03',
  goal: 'Rename function oldName to newName in src/utils.js and update all references in src/app.js',
  deliverables: [
    { id: 'd1', type: 'edit', path: 'src/utils.js', description: 'Rename function in utils', acceptanceCriteria: 'ok' },
    { id: 'd2', type: 'edit', path: 'src/app.js', description: 'Update references in app', acceptanceCriteria: 'ok' },
  ],
  dependencies: [],
  validationSteps: [],
  estimatedCycles: 1,
  contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
};

export default {
  id: 'bench-03',
  name: 'Refactor: rename function across files',
  mockRepo: {
    'src/utils.js': 'export function oldName(x) { return x * 2; }',
    'src/app.js': 'import { oldName } from "./utils.js";\nconsole.log(oldName(5));',
  },
  expectedCycles: 2,
  expectedTurns: 20,
  expectedDeliverables: ['d1', 'd2'],
  shouldHalt: false,
  taskSpec: { taskId: 'bench-03', goal: plan.goal, plan, options: { maxCycles: 3, maxTurnsPerCycle: 15, contextWindow: 32000, requirePlanReview: false, requireCompletionConfirm: false } },
  createCallLLM() {
    return createScriptedLLM([
      `\`\`\`json\n${JSON.stringify({ tool: 'edit_file', input: { file_path: 'src/utils.js', new_content: 'export function newName(x) { return x * 2; }' } })}\n\`\`\``,
      `\`\`\`json\n${JSON.stringify({ tool: 'edit_file', input: { file_path: 'src/app.js', new_content: 'import { newName } from "./utils.js";\nconsole.log(newName(5));' } })}\n\`\`\``,
      CYCLE_DONE,
    ]);
  },
  createExecuteTool(mockFs) {
    return createMockExecutor(mockFs);
  },
};
