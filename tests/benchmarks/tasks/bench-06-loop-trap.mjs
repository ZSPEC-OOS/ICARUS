/**
 * bench-06: Loop trap — deliberately ambiguous task, mock LLM keeps reading same file.
 * Expected: engine halts cleanly in ≤3 cycles due to loop guard.
 */
import { createScriptedLLM } from '../benchmarkRunner.mjs';

const plan = {
  version: '2026.1',
  taskId: 'bench-06',
  goal: 'Fix the bug',
  deliverables: [
    { id: 'd1', type: 'edit', path: 'src/app.js', description: 'Fix the bug', acceptanceCriteria: 'ok' },
  ],
  dependencies: [],
  validationSteps: [],
  estimatedCycles: 1,
  contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
};

// LLM keeps reading the same file repeatedly — triggers read loop guard
const READ_SAME_FILE = `\`\`\`json\n${JSON.stringify({ tool: 'read_file', input: { path: 'src/app.js' } })}\n\`\`\``;

export default {
  id: 'bench-06',
  name: 'Loop trap: ambiguous task causes halt',
  mockRepo: {
    'src/app.js': 'function main() { /* no bug here */ }',
  },
  expectedCycles: 3,
  expectedTurns: 999,
  shouldHalt: true,
  taskSpec: { taskId: 'bench-06', goal: plan.goal, plan, options: { maxCycles: 3, maxTurnsPerCycle: 15, contextWindow: 32000, requirePlanReview: false, requireCompletionConfirm: false } },
  createCallLLM() {
    // Always returns a read of the same file → triggers loop guard
    return createScriptedLLM([READ_SAME_FILE]);
  },
};
