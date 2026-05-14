import { createScriptedLLM, createMockExecutor } from '../benchmarkRunner.mjs';

const CYCLE_DONE = `## summary\nFixed divide by zero in src/math.js.\n\n## deliverables_addressed\n- src/math.js: edited\n\n## next_cycle_needed\nNo.\n\n<CYCLE_COMPLETE>`;

const plan = {
  version: '2026.1',
  taskId: 'bench-04',
  goal: 'Fix the failing test in src/math.test.js — the divide function should handle division by zero',
  deliverables: [
    { id: 'd1', type: 'edit', path: 'src/math.js', description: 'Fix divide to handle zero', acceptanceCriteria: 'ok' },
  ],
  dependencies: [],
  validationSteps: [],
  estimatedCycles: 1,
  contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
};

export default {
  id: 'bench-04',
  name: 'Bugfix: divide by zero',
  mockRepo: {
    'src/math.js': 'export function divide(a, b) { return a / b; }',
    'src/math.test.js': 'import { divide } from "./math.js"; if (divide(1, 0) !== Infinity) throw new Error("fail");',
  },
  expectedCycles: 1,
  expectedTurns: 10,
  expectedDeliverables: ['d1'],
  shouldHalt: false,
  taskSpec: { taskId: 'bench-04', goal: plan.goal, plan, options: { maxCycles: 2, maxTurnsPerCycle: 12, contextWindow: 32000, requirePlanReview: false, requireCompletionConfirm: false } },
  createCallLLM() {
    return createScriptedLLM([
      `\`\`\`json\n${JSON.stringify({ tool: 'edit_file', input: { file_path: 'src/math.js', new_content: 'export function divide(a, b) { if (b === 0) return Infinity; return a / b; }' } })}\n\`\`\``,
      CYCLE_DONE,
    ]);
  },
  createExecuteTool(mockFs) {
    return createMockExecutor(mockFs);
  },
};
