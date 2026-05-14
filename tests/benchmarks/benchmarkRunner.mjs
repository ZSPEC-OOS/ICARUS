/**
 * Phase 8 — Benchmark Runner
 * Runs standardized tasks with mock LLM + mock filesystem to verify V2 engine behavior.
 * All benchmarks use deterministic scripted responses — no real LLM calls.
 */
import { runTask } from '../../src/core-v2/taskRunner.js';
import { createPlanContract } from '../../src/core-v2/planContract.js';

// ─── Mock Utilities ───────────────────────────────────────────────────────────

export function createMockFileSystem(initialFiles = {}) {
  const fs = { ...initialFiles };
  return {
    get: (path) => fs[path],
    set: (path, content) => { fs[path] = content; },
    has: (path) => path in fs,
    all: () => ({ ...fs }),
  };
}

export function createMockExecutor(mockFs, options = {}) {
  const { failWrites = false, failWritesCount = Infinity } = options;
  let writeFails = 0;
  return async function executeTool(name, input) {
    switch (name) {
      case 'write_file': {
        if (failWrites && writeFails < failWritesCount) {
          writeFails++;
          return `ERROR: Permission denied: cannot write to ${input.path}`;
        }
        mockFs.set(input.path, input.content ?? '');
        return `File written: ${input.path}`;
      }
      case 'edit_file': {
        const p = input.file_path ?? input.path;
        if (!mockFs.has(p)) return `ERROR: File not found: ${p}`;
        mockFs.set(p, input.new_content ?? input.new_str ?? '');
        return `File edited: ${p}`;
      }
      case 'read_file':
        return mockFs.has(input.path) ? mockFs.get(input.path) : `ERROR: File not found: ${input.path}`;
      case 'run_command':
        return `exit 0\n${input.command ?? ''} ok`;
      case 'list_directory':
        return Object.keys(mockFs.all()).join('\n');
      case 'search_files':
      case 'grep':
        return Object.keys(mockFs.all()).filter(p => p.includes(input.pattern ?? '')).join('\n');
      default:
        return `ERROR: Unknown tool: ${name}`;
    }
  };
}

export const CYCLE_COMPLETE_MSG = (summary = 'Done.') =>
  `## summary\n${summary}\n\n## deliverables_addressed\n- completed\n\n## next_cycle_needed\nNo.\n\n<CYCLE_COMPLETE>`;

export function createScriptedLLM(responses) {
  let idx = 0;
  return async function callLLM(_messages) {
    const r = responses[Math.min(idx, responses.length - 1)];
    idx++;
    if (typeof r === 'function') return r(_messages);
    return r;
  };
}

function toolCallMsg(toolName, input) {
  return `\`\`\`json\n${JSON.stringify({ tool: toolName, input })}\n\`\`\``;
}

export function createMockCallbacks(callLLM, executeTool, extra = {}) {
  return {
    onPhaseChange: () => {},
    onCycleStart: () => {},
    onCycleEnd: () => {},
    onPlanReview: async () => 'approve',
    onCompletionCheck: async () => 'accept',
    onEvent: () => {},
    onError: () => {},
    callLLM,
    executeTool,
    ...extra,
  };
}

// ─── Benchmark Evaluator ──────────────────────────────────────────────────────

export function evaluateBenchmark(benchmark, result) {
  if (benchmark.shouldHalt) {
    if (result.phase === 'done') return { passed: false, reason: 'Expected halt but task completed' };
    if (result.cycles.length > 3) return { passed: false, reason: `Too many cycles: ${result.cycles.length} > 3` };
    return { passed: true };
  }

  if (result.cycles.length > benchmark.expectedCycles) {
    return { passed: false, reason: `Too many cycles: ${result.cycles.length} > ${benchmark.expectedCycles}` };
  }
  if (result.totalTurnsUsed > benchmark.expectedTurns) {
    return { passed: false, reason: `Too many turns: ${result.totalTurnsUsed} > ${benchmark.expectedTurns}` };
  }
  if (benchmark.expectedDeliverables) {
    const completed = (result.plan?.deliverables ?? []).filter(d => d.completed).map(d => d.id);
    for (const expected of benchmark.expectedDeliverables) {
      if (!completed.includes(expected)) {
        return { passed: false, reason: `Deliverable '${expected}' not completed. Completed: ${completed.join(', ')}` };
      }
    }
  }
  return { passed: true };
}

// ─── Run Single Benchmark ─────────────────────────────────────────────────────

export async function runBenchmark(benchmark) {
  const mockFs = createMockFileSystem(benchmark.mockRepo ?? {});
  const executeTool = benchmark.createExecuteTool
    ? benchmark.createExecuteTool(mockFs)
    : createMockExecutor(mockFs);
  const callLLM = benchmark.createCallLLM();
  const callbacks = createMockCallbacks(callLLM, executeTool);

  const startTime = Date.now();
  let result;
  try {
    result = await runTask(benchmark.taskSpec, callbacks);
  } catch (err) {
    result = { phase: 'failed', cycles: [], plan: null, totalTurnsUsed: 0, totalTokensUsed: 0, totalTimeMs: Date.now() - startTime, failureReason: err.message };
  }
  const endTime = Date.now();

  const evaluation = evaluateBenchmark(benchmark, result);

  return {
    id: benchmark.id,
    name: benchmark.name,
    passed: evaluation.passed,
    failureReason: evaluation.reason,
    actualCycles: result.cycles?.length ?? 0,
    actualTurns: result.totalTurnsUsed ?? 0,
    actualTimeMs: endTime - startTime,
    tokensUsed: result.totalTokensUsed ?? 0,
    completed: result.phase === 'done',
    phase: result.phase,
    rawResult: result,
  };
}

// ─── Load and Run All Benchmarks ──────────────────────────────────────────────

async function runAll() {
  const benchmarkModules = [
    './tasks/bench-01-simple-file.mjs',
    './tasks/bench-02-multi-file.mjs',
    './tasks/bench-03-refactor.mjs',
    './tasks/bench-04-bugfix.mjs',
    './tasks/bench-05-large-change.mjs',
    './tasks/bench-06-loop-trap.mjs',
    './tasks/bench-07-error-recovery.mjs',
    './tasks/bench-08-context-pressure.mjs',
  ];

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  BLUSWAN V2 Benchmark Suite');
  console.log('═══════════════════════════════════════════════════════════\n');

  const results = [];
  for (const modPath of benchmarkModules) {
    const mod = await import(modPath);
    const benchmark = mod.default;
    process.stdout.write(`  Running ${benchmark.id}: ${benchmark.name}... `);
    const r = await runBenchmark(benchmark);
    results.push(r);
    const icon = r.passed ? '✓' : '✗';
    console.log(`${icon} [${r.actualCycles}c/${r.actualTurns}t] ${r.phase}${r.passed ? '' : ` — ${r.failureReason}`}`);
  }

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  console.log('\n───────────────────────────────────────────────────────────');
  console.log(`  Results: ${passed}/${total} passed`);

  const completionRate = results.filter(r => r.completed || r.phase === 'halted').length / total;
  const avgTurns = results.reduce((s, r) => s + r.actualTurns, 0) / total;
  console.log(`  Task completion/halt rate: ${(completionRate * 100).toFixed(1)}%`);
  console.log(`  Average turns per task: ${avgTurns.toFixed(1)}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (passed < total) {
    console.error(`BENCHMARK FAILURES: ${total - passed} benchmark(s) failed`);
    process.exit(1);
  }
}

runAll().catch(err => { console.error('Benchmark runner failed:', err); process.exit(1); });
