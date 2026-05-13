import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepoIndex } from '../repoIndex.js';
import { packCycleContext } from '../contextPacker.js';
import { createContextBudget } from '../contextBudget.js';
import { createPlanContract } from '../planContract.js';
import { createCycle } from '../cycleEngine.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePlan(overrides = {}) {
  return createPlanContract({
    version: '2026.1',
    taskId: 'ctx-int-test',
    goal: 'Integration test',
    estimatedCycles: 1,
    deliverables: [{
      id: 'deliv-1', type: 'file', path: 'src/out.js',
      description: 'Create output file', acceptanceCriteria: 'file exists', completed: false,
    }],
    dependencies: [], validationSteps: [],
    contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
    ...overrides,
  });
}

const SAMPLE_CONTENT = `
import { helper } from './helper.js';
export function processData(input) { return helper(input); }
export const MAX = 100;
`.trim();

function makeMockFetch(filePaths, fileContents = {}) {
  return async (url) => {
    if (url.includes('/git/trees/')) {
      return {
        ok: true,
        json: async () => ({
          tree: filePaths.map((p) => ({ path: p, type: 'blob', size: 50, sha: `sha-${p}` })),
        }),
      };
    }
    const pathMatch = url.match(/\/contents\/([^?]+)/);
    const path = pathMatch ? decodeURIComponent(pathMatch[1]) : '';
    if (path in fileContents) {
      return {
        ok: true,
        json: async () => ({
          encoding: 'base64',
          content: Buffer.from(fileContents[path]).toString('base64') + '\n',
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

async function buildTestIndex() {
  const files = ['src/core/main.js', 'src/utils/helper.js', 'src/components/App.jsx', 'package.json'];
  const contents = {
    'src/core/main.js': SAMPLE_CONTENT,
    'src/utils/helper.js': 'export const helper = (x) => x * 2;',
    'src/components/App.jsx': 'import React from "react";\nexport default function App() { return null; }',
  };
  const fetchFn = makeMockFetch(files, contents);
  return buildRepoIndex('owner/repo', 'main', 'token', { fetchFn });
}

// ─── Context Integration Tests ────────────────────────────────────────────────

describe('repoIndex → packCycleContext pipeline', () => {
  it('build repoIndex → packCycleContext → verify all mandatory tiers present', async () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const repoIndex = await buildTestIndex();

    const { metadata } = packCycleContext(budget, cycle, plan.deliverables, [], repoIndex);

    assert.ok(metadata.includedTiers.includes('systemPrompt'), 'Missing systemPrompt tier');
    assert.ok(metadata.includedTiers.includes('planContract'), 'Missing planContract tier');
    assert.ok(metadata.includedTiers.includes('cycleContext'), 'Missing cycleContext tier');
    assert.ok(metadata.includedTiers.includes('deliverables'), 'Missing deliverables tier');
    assert.ok(metadata.includedTiers.includes('toolResults'), 'Missing toolResults tier');
  });

  it('repoMap (Tier 4) is present when repoIndex is provided', async () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const repoIndex = await buildTestIndex();

    const { messages, metadata } = packCycleContext(budget, cycle, plan.deliverables, [], repoIndex);

    assert.ok(metadata.includedTiers.includes('repoMap'), 'Expected repoMap in Tier 4');
    const repoMapMsg = messages.find((m) => m.content.includes('--- Repository Map ---'));
    assert.ok(repoMapMsg, 'Expected a message with Repository Map header');
    assert.ok(repoMapMsg.content.includes('src/'), 'Expected src/ directory in repo map');
  });

  it('relevantFiles (Tier 5) populated from read_file tool results via cache', async () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const repoIndex = await buildTestIndex();

    // Pre-populate cache with file that was "read" this cycle
    repoIndex.contentCache.set('src/core/main.js', SAMPLE_CONTENT);

    const toolResults = [
      { toolName: 'read_file', input: { path: 'src/core/main.js' }, output: SAMPLE_CONTENT, turnNumber: 1 },
    ];

    const { messages, metadata } = packCycleContext(
      budget, cycle, plan.deliverables, toolResults, repoIndex
    );

    assert.ok(metadata.includedTiers.includes('relevantFiles'), 'Expected relevantFiles in Tier 5');
    const filesMsg = messages.find((m) => m.content.includes('--- Relevant Files ---'));
    assert.ok(filesMsg, 'Expected a Relevant Files message');
    assert.ok(filesMsg.content.includes('src/core/main.js'), 'Expected file path in relevant files');
  });

  it('no conversation history leakage — messages contain only defined tiers', async () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const repoIndex = await buildTestIndex();

    const { messages } = packCycleContext(budget, cycle, plan.deliverables, [], repoIndex);

    // All messages should have role system or user — no assistant or tool messages
    for (const msg of messages) {
      assert.ok(
        msg.role === 'system' || msg.role === 'user',
        `Unexpected role '${msg.role}' — conversation history leaked`
      );
    }
  });

  it('reserved space (system + plan) always present regardless of budget pressure', async () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const repoIndex = await buildTestIndex();

    const { messages, metadata } = packCycleContext(budget, cycle, plan.deliverables, [], repoIndex);

    assert.ok(metadata.reservedTokens > 0, 'Reserved tokens should be > 0');
    assert.ok(metadata.includedTiers.includes('systemPrompt'));
    assert.ok(metadata.includedTiers.includes('planContract'));

    // System message content must include the completion protocol
    const sysMsg = messages[0];
    assert.ok(sysMsg.content.includes('<CYCLE_COMPLETE>') || sysMsg.content.includes('CYCLE_COMPLETE'));
  });

  it('truncation markers present when large content is capped', async () => {
    // Build repoIndex with a very large file
    const bigContent = 'const x = 1;\n'.repeat(600); // 600 lines — exceeds 500-line cap
    const files = ['src/big.js'];
    const fetchFn = makeMockFetch(files, { 'src/big.js': bigContent });
    const repoIndex = await buildRepoIndex('o/r', 'main', '', { fetchFn });

    // Verify truncation marker in cached content
    const cached = repoIndex.contentCache.get('src/big.js');
    assert.ok(cached, 'File should be cached after buildRepoIndex');
    assert.ok(
      cached.includes('[...truncated'),
      `Expected truncation marker in capped content, got: ${cached.slice(0, 100)}`
    );
  });

  it('repoIndex is discarded by caller — no state leakage between tasks', async () => {
    const repoIndex = await buildTestIndex();

    // Simulate a write that invalidates cache
    repoIndex.contentCache.set('src/new.js', 'const x = 1;');
    assert.ok(repoIndex.contentCache.has('src/new.js'));

    // After task: caller would discard repoIndex. Simulate by creating a new one.
    const repoIndex2 = await buildTestIndex();
    assert.ok(!repoIndex2.contentCache.has('src/new.js'), 'New index should not have old task state');
  });

  it('legacy options backward compat — repoMap via options still works', () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const cycle = createCycle(plan, 1, ['deliv-1']);

    // Old call style with options object
    const { metadata } = packCycleContext(budget, cycle, plan.deliverables, [], {
      repoMap: 'src/\n  foo.js\n',
      relevantFileContents: new Map([['src/foo.js', 'const foo = 1;']]),
    });

    assert.ok(metadata.includedTiers.includes('repoMap'));
    assert.ok(metadata.includedTiers.includes('relevantFiles'));
  });
});
