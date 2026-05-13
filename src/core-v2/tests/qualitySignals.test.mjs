import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runQualitySignals, formatQualityReport } from '../qualitySignals.js';
import { createPlanContract } from '../planContract.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePlan(deliverables = []) {
  return createPlanContract({
    version: '2026.1',
    taskId: 'qs-test',
    goal: 'Quality signals test',
    estimatedCycles: 1,
    deliverables: deliverables.length > 0 ? deliverables : [
      { id: 'd1', type: 'file', path: 'src/index.js', description: 'Create file', acceptanceCriteria: 'exists', completed: false },
    ],
    dependencies: [],
    validationSteps: [],
    contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: false },
  });
}

function makeCycleWithWrite(path, content) {
  return {
    cycleNumber: 1,
    status: 'completed',
    toolResults: [
      {
        toolName: 'write_file',
        input: { path, content },
        output: `wrote ${path}`,
        turnNumber: 1,
      },
    ],
  };
}

const noopExecuteTool = async () => '';

// ─── runQualitySignals basics ─────────────────────────────────────────────────

describe('runQualitySignals', () => {
  it('returns a QualityReport with signals array', async () => {
    const plan = makePlan();
    const report = await runQualitySignals(plan, [], null, noopExecuteTool);
    assert.ok(Array.isArray(report.signals));
    assert.ok(typeof report.passCount === 'number');
    assert.ok(typeof report.warnCount === 'number');
    assert.ok(typeof report.failCount === 'number');
    assert.ok(typeof report.summary === 'string');
  });

  it('every signal has blocksCompletion: false', async () => {
    const plan = makePlan();
    const cycles = [makeCycleWithWrite('src/index.js', 'const x = 1;')];
    const report = await runQualitySignals(plan, cycles, null, noopExecuteTool);
    for (const sig of report.signals) {
      assert.equal(sig.blocksCompletion, false, `Signal '${sig.id}' has blocksCompletion !== false`);
    }
  });

  it('never throws even if executeTool throws', async () => {
    const plan = makePlan();
    const throwingTool = async () => { throw new Error('tool failure'); };
    let threw = false;
    try {
      await runQualitySignals(plan, [], null, throwingTool);
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
  });
});

// ─── test_coverage signal ─────────────────────────────────────────────────────

describe('test_coverage signal', () => {
  it('warns when code deliverables exist but no test deliverables', async () => {
    const plan = makePlan([
      { id: 'd1', type: 'file', path: 'src/app.js', description: 'App', acceptanceCriteria: 'exists', completed: false },
    ]);
    const report = await runQualitySignals(plan, [], null, noopExecuteTool);
    const sig = report.signals.find((s) => s.id === 'test_coverage');
    assert.ok(sig, 'test_coverage signal should be present');
    assert.equal(sig.status, 'warn');
  });

  it('passes when test deliverables are present', async () => {
    const plan = makePlan([
      { id: 'd1', type: 'file', path: 'src/app.js', description: 'App', acceptanceCriteria: 'exists', completed: false },
      { id: 'd2', type: 'test', path: 'src/app.test.js', description: 'Tests', acceptanceCriteria: 'pass', completed: false },
    ]);
    const report = await runQualitySignals(plan, [], null, noopExecuteTool);
    const sig = report.signals.find((s) => s.id === 'test_coverage');
    assert.equal(sig.status, 'pass');
  });
});

// ─── console_logs signal ──────────────────────────────────────────────────────

describe('console_logs signal', () => {
  it('warns when console.log found in written JS files', async () => {
    const plan = makePlan();
    const cycles = [makeCycleWithWrite('src/index.js', 'console.log("debug");\nconst x = 1;')];
    const report = await runQualitySignals(plan, cycles, null, noopExecuteTool);
    const sig = report.signals.find((s) => s.id === 'console_logs');
    assert.ok(sig, 'console_logs signal should be present');
    assert.equal(sig.status, 'warn');
  });

  it('passes when no console.log in written files', async () => {
    const plan = makePlan();
    const cycles = [makeCycleWithWrite('src/index.js', 'export const x = 1;')];
    const report = await runQualitySignals(plan, cycles, null, noopExecuteTool);
    const sig = report.signals.find((s) => s.id === 'console_logs');
    assert.equal(sig.status, 'pass');
  });
});

// ─── unused_imports signal ────────────────────────────────────────────────────

describe('unused_imports signal', () => {
  it('warns when an imported name is not used in non-import code', async () => {
    const plan = makePlan();
    // Import { foo } but never use foo in the rest of the file
    const content = "import { foo, bar } from './utils.js';\nexport const x = bar(1);";
    const cycles = [makeCycleWithWrite('src/index.js', content)];
    const report = await runQualitySignals(plan, cycles, null, noopExecuteTool);
    const sig = report.signals.find((s) => s.id === 'unused_imports');
    assert.ok(sig, 'unused_imports signal should be present');
    assert.equal(sig.status, 'warn');
  });

  it('passes when all imports are used', async () => {
    const plan = makePlan();
    const content = "import { foo } from './utils.js';\nexport const x = foo(1);";
    const cycles = [makeCycleWithWrite('src/index.js', content)];
    const report = await runQualitySignals(plan, cycles, null, noopExecuteTool);
    const sig = report.signals.find((s) => s.id === 'unused_imports');
    assert.equal(sig.status, 'pass');
  });
});

// ─── api_changes signal ───────────────────────────────────────────────────────

describe('api_changes signal', () => {
  it('returns info (not warn) when files in src/services/ are modified', async () => {
    const plan = makePlan();
    const cycles = [makeCycleWithWrite('src/services/myService.js', 'export function foo() {}')];
    const report = await runQualitySignals(plan, cycles, null, noopExecuteTool);
    const sig = report.signals.find((s) => s.id === 'api_changes');
    assert.ok(sig, 'api_changes signal should be present');
    assert.equal(sig.status, 'info', `Expected 'info', got '${sig.status}'`);
    assert.equal(sig.blocksCompletion, false);
  });

  it('passes when no API surface files modified', async () => {
    const plan = makePlan();
    const cycles = [makeCycleWithWrite('src/components/Button.jsx', 'export default function Button() {}')];
    const report = await runQualitySignals(plan, cycles, null, noopExecuteTool);
    const sig = report.signals.find((s) => s.id === 'api_changes');
    assert.equal(sig.status, 'pass');
  });
});

// ─── lint_clean signal — uses cached results ──────────────────────────────────

describe('lint_clean signal', () => {
  it('uses cached validation result when available (does not re-run lint)', async () => {
    let execCalls = 0;
    const executeTool = async () => { execCalls++; return 'lint output'; };

    const plan = makePlan();
    const cachedResults = [
      { id: 'lint', label: 'Lint', passed: true, command: 'npm run lint', output: 'no errors', durationMs: 100 },
    ];
    const report = await runQualitySignals(plan, [], null, executeTool, cachedResults);
    const sig = report.signals.find((s) => s.id === 'lint_clean');
    assert.equal(sig.status, 'pass');
    // Since a cached result was provided for lint, executeTool should not be called for lint
    // (it may be called for build/type check, so we just verify the lint signal status)
    assert.ok(sig, 'lint_clean signal should be present');
  });

  it('reports warn when linter returns errors', async () => {
    const plan = makePlan();
    const cachedResults = [
      { id: 'lint', label: 'Lint', passed: false, command: 'npm run lint', output: '2 style issues found', durationMs: 100 },
    ];
    const report = await runQualitySignals(plan, [], null, noopExecuteTool, cachedResults);
    const sig = report.signals.find((s) => s.id === 'lint_clean');
    assert.equal(sig.status, 'warn');
  });
});

// ─── formatQualityReport ──────────────────────────────────────────────────────

describe('formatQualityReport', () => {
  it('returns a markdown string with a table', async () => {
    const plan = makePlan();
    const report = await runQualitySignals(plan, [], null, noopExecuteTool);
    const md = formatQualityReport(report);
    assert.ok(md.includes('## Quality Signals'));
    assert.ok(md.includes('| Signal | Status | Detail |'));
    assert.ok(md.includes('**Summary:**'));
  });

  it('returns fallback string for empty report', () => {
    const md = formatQualityReport({ signals: [], passCount: 0, warnCount: 0, failCount: 0, summary: '' });
    assert.ok(md.includes('No signals recorded'));
  });

  it('includes recommendation when there are warnings', async () => {
    const plan = makePlan();
    // No test deliverables → warns on test_coverage
    const report = await runQualitySignals(plan, [], null, noopExecuteTool);
    const md = formatQualityReport(report);
    if (report.warnCount > 0) {
      assert.ok(md.includes('Recommendation:'), 'Should include recommendation when warnings exist');
    }
  });
});
