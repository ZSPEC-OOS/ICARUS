import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { packCycleContext, packPlanReviewContext } from '../contextPacker.js';
import { createContextBudget, computeTokenEstimate, ContextBudgetError } from '../contextBudget.js';
import { createPlanContract } from '../planContract.js';
import { createCycle } from '../cycleEngine.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePlan(deliverableCount = 2) {
  const deliverables = Array.from({ length: deliverableCount }, (_, i) => ({
    id: `deliv-${i + 1}`,
    type: i % 2 === 0 ? 'file' : 'edit',
    path: `src/file-${i + 1}.js`,
    description: `Deliverable ${i + 1}`,
    acceptanceCriteria: `file-${i + 1} exists`,
  }));
  return createPlanContract({
    version: '2026.1',
    taskId: 'pack-test',
    goal: 'Test context packing',
    estimatedCycles: Math.max(1, Math.ceil(deliverableCount / 3)),
    deliverables,
    dependencies: [],
    validationSteps: [],
    contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
  });
}

function makeCycle(plan, cycleNumber = 1, targetIds = ['deliv-1']) {
  return createCycle(plan, cycleNumber, targetIds);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('packCycleContext', () => {
  it('returns messages in correct order (system, system, user×3+)', () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const cycle = makeCycle(plan);
    const { messages } = packCycleContext(budget, cycle, plan.deliverables, []);

    assert.equal(messages[0].role, 'system'); // system prompt
    assert.equal(messages[1].role, 'system'); // plan contract
    assert.equal(messages[2].role, 'user');   // cycle context (tier 1)
    assert.equal(messages[3].role, 'user');   // deliverables (tier 2)
    assert.equal(messages[4].role, 'user');   // tool results (tier 3)
  });

  it('includes system + plan contract + cycle context + deliverables + tool results', () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const cycle = makeCycle(plan);
    const { metadata } = packCycleContext(budget, cycle, plan.deliverables, []);

    assert.ok(metadata.includedTiers.includes('systemPrompt'));
    assert.ok(metadata.includedTiers.includes('planContract'));
    assert.ok(metadata.includedTiers.includes('cycleContext'));
    assert.ok(metadata.includedTiers.includes('deliverables'));
    assert.ok(metadata.includedTiers.includes('toolResults'));
  });

  it('includes repoMap and relevantFiles when budget allows', () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const cycle = makeCycle(plan);
    const { metadata } = packCycleContext(budget, cycle, plan.deliverables, [], {
      repoMap: 'src/\n  file.js\n',
      relevantFileContents: new Map([['src/file.js', 'const x = 1;']]),
    });

    assert.ok(metadata.includedTiers.includes('repoMap'));
    assert.ok(metadata.includedTiers.includes('relevantFiles'));
  });

  it('drops lower tiers when budget is very tight', () => {
    const plan = makePlan();
    // Create a tiny budget — just enough for reserved + mandatory tiers
    const budget = createContextBudget(15000); // available = 10000
    const cycle = makeCycle(plan);

    // Big repo map that won't fit
    const bigRepoMap = 'file.js\n'.repeat(2000); // ~8000 chars = ~2000 tokens, over 1500 max
    const { metadata } = packCycleContext(budget, cycle, plan.deliverables, [], {
      repoMap: bigRepoMap,
    });

    assert.ok(metadata.droppedTiers.includes('repoMap'));
  });

  it('first-turn message says "No tool results yet"', () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const cycle = makeCycle(plan);
    const { messages } = packCycleContext(budget, cycle, plan.deliverables, []);

    const toolMsg = messages[4];
    assert.ok(toolMsg.content.includes('No tool results yet'));
  });

  it('no message exceeds its tier max tokens (with tolerance for reserved)', () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const cycle = makeCycle(plan);
    const { messages, metadata } = packCycleContext(budget, cycle, plan.deliverables, []);

    // Tier 1 (index 2): cycleContext max = 3000
    assert.ok(computeTokenEstimate(messages[2].content) <= 3200); // allow small margin
    // Tier 2 (index 3): deliverables max = 2000
    assert.ok(computeTokenEstimate(messages[3].content) <= 2200);
    // Tier 3 (index 4): toolResults max = 4000
    assert.ok(computeTokenEstimate(messages[4].content) <= 4200);
  });

  it('metadata includes includedTiers and droppedTiers arrays', () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const cycle = makeCycle(plan);
    const { metadata } = packCycleContext(budget, cycle, plan.deliverables, []);

    assert.ok(Array.isArray(metadata.includedTiers));
    assert.ok(Array.isArray(metadata.droppedTiers));
    assert.ok(typeof metadata.totalTokensEstimated === 'number');
    assert.ok(typeof metadata.reservedTokens === 'number');
    assert.ok(typeof metadata.dynamicTokens === 'number');
  });

  it('toolResultsSummarized reflects number of results condensed', () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const cycle = makeCycle(plan);
    const toolResults = [
      { toolName: 'write_file', input: { path: 'x.js' }, output: 'ok', turnNumber: 1 },
      { toolName: 'read_file', input: { path: 'y.js' }, output: 'content', turnNumber: 1 },
    ];
    const { metadata } = packCycleContext(budget, cycle, plan.deliverables, toolResults);
    assert.equal(metadata.toolResultsSummarized, 2);
  });
});

describe('packPlanReviewContext', () => {
  it('is simpler and includes the full plan', () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const { messages } = packPlanReviewContext(budget, plan);

    // Should have system, plan, summary, approval prompt
    assert.ok(messages.length >= 4);
    assert.equal(messages[0].role, 'system');
    // Plan JSON in second message
    assert.ok(messages[1].content.includes('pack-test') || messages[1].content.includes('"taskId"'));
  });

  it('includes approval prompt', () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const { messages } = packPlanReviewContext(budget, plan);

    const combined = messages.map((m) => m.content).join('\n');
    assert.ok(combined.includes('Approve this plan?'));
  });

  it('metadata has includedTiers and no droppedTiers', () => {
    const plan = makePlan();
    const budget = createContextBudget(128000);
    const { metadata } = packPlanReviewContext(budget, plan);

    assert.ok(Array.isArray(metadata.includedTiers));
    assert.ok(Array.isArray(metadata.droppedTiers));
    assert.deepEqual(metadata.droppedTiers, []);
  });
});
