/**
 * bench-07: Error recovery — mock filesystem denies all writes.
 * Expected: task fails gracefully, does NOT retry more than allowed by remediation budget.
 */
import { createScriptedLLM, createMockExecutor, createMockFileSystem } from '../benchmarkRunner.mjs';

const plan = {
  version: '2026.1',
  taskId: 'bench-07',
  goal: 'Create src/db.js with database connection logic',
  deliverables: [
    { id: 'd1', type: 'file', path: 'src/db.js', description: 'DB module', acceptanceCriteria: 'ok' },
  ],
  dependencies: [],
  validationSteps: [],
  estimatedCycles: 1,
  contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
};

const WRITE_ATTEMPT = `\`\`\`json\n${JSON.stringify({ tool: 'write_file', input: { path: 'src/db.js', content: 'export const db = null;' } })}\n\`\`\``;

export default {
  id: 'bench-07',
  name: 'Error recovery: read-only filesystem',
  mockRepo: {},
  expectedCycles: 2,
  expectedTurns: 999,
  shouldHalt: true,
  taskSpec: { taskId: 'bench-07', goal: plan.goal, plan, options: { maxCycles: 3, maxTurnsPerCycle: 10, contextWindow: 32000, remediationBudget: 50, requirePlanReview: false, requireCompletionConfirm: false } },
  createCallLLM() {
    return createScriptedLLM([WRITE_ATTEMPT]);
  },
  createExecuteTool(_mockFs) {
    return async function executeTool(name, _input) {
      if (name === 'write_file') return 'ERROR: Permission denied: filesystem is read-only';
      if (name === 'read_file') return 'ERROR: File not found';
      if (name === 'run_command') return 'exit 0\nok';
      if (name === 'list_directory') return '';
      return 'ERROR: Unknown tool';
    };
  },
};
