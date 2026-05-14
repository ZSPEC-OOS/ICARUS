/**
 * bench-05: Large change — 4 deliverables across 2 cycles.
 * Cycle 1 picks d1/d2/d4 (all file type, same dir src/api/).
 * Cycle 2 picks d3 (edit type, src/index.js).
 */
import { createScriptedLLM, createMockExecutor } from '../benchmarkRunner.mjs';

const CYCLE1_DONE = `## summary\nCreated API files.\n\n## deliverables_addressed\n- src/api/client.js: written\n- src/api/types.js: written\n- src/api/client.test.js: written\n\n## next_cycle_needed\nYes.\n\n<CYCLE_COMPLETE>`;
const CYCLE2_DONE = `## summary\nUpdated src/index.js.\n\n## deliverables_addressed\n- src/index.js: edited\n\n## next_cycle_needed\nNo.\n\n<CYCLE_COMPLETE>`;

const plan = {
  version: '2026.1',
  taskId: 'bench-05',
  goal: 'Add a new feature: create src/api/client.js, src/api/types.js, update src/index.js to export it, and create src/api/client.test.js',
  deliverables: [
    { id: 'd1', type: 'file', path: 'src/api/client.js', description: 'API client', acceptanceCriteria: 'ok' },
    { id: 'd2', type: 'file', path: 'src/api/types.js', description: 'API types', acceptanceCriteria: 'ok' },
    { id: 'd3', type: 'edit', path: 'src/index.js', description: 'Export API client', acceptanceCriteria: 'ok' },
    { id: 'd4', type: 'file', path: 'src/api/client.test.js', description: 'API client tests', acceptanceCriteria: 'ok' },
  ],
  dependencies: [],
  validationSteps: [],
  estimatedCycles: 2,
  contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
};

export default {
  id: 'bench-05',
  name: 'Large change: 4 deliverables across 2 cycles',
  mockRepo: {
    'src/index.js': '// Main entry point\n',
    'package.json': '{"name":"test","type":"module"}',
  },
  expectedCycles: 2,
  expectedTurns: 30,
  expectedDeliverables: ['d1', 'd2', 'd3', 'd4'],
  shouldHalt: false,
  taskSpec: { taskId: 'bench-05', goal: plan.goal, plan, options: { maxCycles: 3, maxTurnsPerCycle: 20, contextWindow: 32000, requirePlanReview: false, requireCompletionConfirm: false } },
  createCallLLM() {
    // Cycle 1: write d1, d2, d4 (all file type in src/api/)
    // Cycle 2: edit d3 (edit type, src/index.js)
    return createScriptedLLM([
      `\`\`\`json\n${JSON.stringify({ tool: 'write_file', input: { path: 'src/api/client.js', content: 'export async function fetchData(url) { return fetch(url); }' } })}\n\`\`\``,
      `\`\`\`json\n${JSON.stringify({ tool: 'write_file', input: { path: 'src/api/types.js', content: 'export const API_VERSION = "1.0";' } })}\n\`\`\``,
      `\`\`\`json\n${JSON.stringify({ tool: 'write_file', input: { path: 'src/api/client.test.js', content: 'import { fetchData } from "./client.js"; console.log("test ok");' } })}\n\`\`\``,
      CYCLE1_DONE,
      `\`\`\`json\n${JSON.stringify({ tool: 'edit_file', input: { file_path: 'src/index.js', new_content: 'export { fetchData } from "./api/client.js";\n' } })}\n\`\`\``,
      CYCLE2_DONE,
    ]);
  },
  createExecuteTool(mockFs) {
    return createMockExecutor(mockFs);
  },
};
