import { createScriptedLLM } from '../benchmarkRunner.mjs';

const CYCLE_DONE = `## summary\nCreated auth.js and auth.test.js.\n\n## deliverables_addressed\n- src/auth.js: written\n- src/auth.test.js: written\n\n## next_cycle_needed\nNo.\n\n<CYCLE_COMPLETE>`;

const plan = {
  version: '2026.1',
  taskId: 'bench-02',
  goal: 'Create src/auth.js with login function and src/auth.test.js with a test',
  deliverables: [
    { id: 'd1', type: 'file', path: 'src/auth.js', description: 'Auth module', acceptanceCriteria: 'ok' },
    { id: 'd2', type: 'file', path: 'src/auth.test.js', description: 'Auth tests', acceptanceCriteria: 'ok' },
  ],
  dependencies: [],
  validationSteps: [],
  estimatedCycles: 1,
  contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
};

export default {
  id: 'bench-02',
  name: 'Multi-file creation',
  mockRepo: { 'package.json': '{"name":"test","type":"module"}' },
  expectedCycles: 1,
  expectedTurns: 12,
  expectedDeliverables: ['d1', 'd2'],
  shouldHalt: false,
  taskSpec: { taskId: 'bench-02', goal: plan.goal, plan, options: { maxCycles: 2, maxTurnsPerCycle: 15, contextWindow: 32000, requirePlanReview: false, requireCompletionConfirm: false } },
  createCallLLM() {
    return createScriptedLLM([
      `\`\`\`json\n${JSON.stringify({ tool: 'write_file', input: { path: 'src/auth.js', content: 'export function login(u, p) { return u === "admin"; }' } })}\n\`\`\``,
      `\`\`\`json\n${JSON.stringify({ tool: 'write_file', input: { path: 'src/auth.test.js', content: 'import { login } from "./auth.js"; console.assert(login("admin","x"));' } })}\n\`\`\``,
      CYCLE_DONE,
    ]);
  },
};
