/**
 * Phase 8 — Chaos Engine
 * Injects failures into tool execution to verify graceful degradation.
 * All scenarios use deterministic injection (seeded by scenario config).
 */
import { runTask } from '../../src/core-v2/taskRunner.js';

// ─── Chaos Executor Factory ───────────────────────────────────────────────────

/**
 * @typedef {Object} ChaosConfig
 * @property {number} failureRate - 0.0 to 1.0
 * @property {string[]} targetTools - Which tools to affect ([] = all)
 * @property {string[]} failureTypes - 'timeout'|'error'|'wrong_output'
 * @property {number} maxFailuresPerCycle - Default 3
 * @property {boolean} [deterministic] - Use injection count instead of random
 */

export function createChaosExecutor(baseExecutor, config) {
  const {
    failureRate = 0.5,
    targetTools = [],
    failureTypes = ['error'],
    maxFailuresPerCycle = 3,
    deterministic = true,
  } = config;

  let injectionCount = 0;
  let callCount = 0;

  const executor = async function chaosExecuteTool(name, input) {
    callCount++;
    const isTargeted = targetTools.length === 0 || targetTools.includes(name);
    const shouldInject = isTargeted &&
      injectionCount < maxFailuresPerCycle &&
      (deterministic ? (callCount % Math.round(1 / failureRate) === 0) : Math.random() < failureRate);

    if (shouldInject) {
      injectionCount++;
      const type = failureTypes[injectionCount % failureTypes.length];
      switch (type) {
        case 'timeout':
          return 'ERROR: Request timed out after 5000ms';
        case 'error':
          if (name === 'edit_file') return 'ERROR: old_str not found in file';
          if (name === 'read_file') return 'ERROR: File not found';
          return `ERROR: Chaos injection #${injectionCount} for ${name}`;
        case 'wrong_output':
          return '(chaos: wrong output injected)';
        default:
          return `ERROR: Chaos injection type '${type}'`;
      }
    }
    return baseExecutor(name, input);
  };

  executor.getInjectionCount = () => injectionCount;
  executor.getCallCount = () => callCount;
  return executor;
}

// ─── Chaos LLM Factory ────────────────────────────────────────────────────────

export function createLoopInducingLLM(toolName, path, maxRepeat = 100) {
  let count = 0;
  return async function chaosLLM(_messages) {
    count++;
    if (count <= maxRepeat) {
      return `\`\`\`json\n${JSON.stringify({ tool: toolName, input: { path } })}\n\`\`\``;
    }
    return `## summary\nDone.\n## deliverables_addressed\n- ok\n## next_cycle_needed\nNo.\n<CYCLE_COMPLETE>`;
  };
}

// ─── Base Executor ────────────────────────────────────────────────────────────

export function createBaseExecutor(mockFiles = {}) {
  const fs = { ...mockFiles };
  return async function executeTool(name, input) {
    switch (name) {
      case 'write_file':
        fs[input.path] = input.content ?? '';
        return `File written: ${input.path}`;
      case 'edit_file': {
        const p = input.file_path ?? input.path;
        if (!(p in fs)) return `ERROR: File not found: ${p}`;
        fs[p] = input.new_content ?? input.new_str ?? '';
        return `File edited: ${p}`;
      }
      case 'read_file':
        return (input.path in fs) ? fs[input.path] : `ERROR: File not found: ${input.path}`;
      case 'run_command':
        return `exit 0\n${input.command ?? ''} ok`;
      case 'list_directory':
        return Object.keys(fs).join('\n');
      default:
        return `ERROR: Unknown tool: ${name}`;
    }
  };
}

// ─── Chaos Callbacks ──────────────────────────────────────────────────────────

export function createChaosCallbacks(callLLM, executeTool, extra = {}) {
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

// ─── Run Single Chaos Scenario ────────────────────────────────────────────────

export async function runChaosScenario(scenario) {
  const { taskSpec, createCallbacks } = scenario;
  const callbacks = createCallbacks();

  const startTime = Date.now();
  let result;
  try {
    result = await runTask(taskSpec, callbacks);
  } catch (err) {
    result = { phase: 'error', cycles: [], plan: null, totalTurnsUsed: 0, totalTokensUsed: 0, failureReason: err.message, totalTimeMs: Date.now() - startTime };
  }

  const cleanPhases = new Set(['done', 'failed', 'halted', 'completion_confirm']);
  return {
    taskId: taskSpec.taskId,
    phase: result.phase,
    taskCompletedOrHaltedCleanly: cleanPhases.has(result.phase),
    cyclesUsed: result.cycles?.length ?? 0,
    turnsUsed: result.totalTurnsUsed ?? 0,
    failureReason: result.failureReason ?? result.haltReason ?? null,
    rawResult: result,
  };
}

// ─── Run All Chaos Scenarios ──────────────────────────────────────────────────

async function runAll() {
  const scenarioModules = [
    './scenarios/chaos-01-tool-failure.mjs',
    './scenarios/chaos-02-api-timeout.mjs',
    './scenarios/chaos-03-context-overflow.mjs',
    './scenarios/chaos-04-loop-induction.mjs',
    './scenarios/chaos-05-remediation-exhaustion.mjs',
    './scenarios/chaos-06-safety-trigger.mjs',
  ];

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  BLUSWAN V2 Chaos Engineering Suite');
  console.log('═══════════════════════════════════════════════════════════\n');

  const results = [];
  for (const modPath of scenarioModules) {
    const mod = await import(modPath);
    const scenario = mod.default;
    process.stdout.write(`  Running ${scenario.id}: ${scenario.name}... `);

    const chaosResult = await runChaosScenario(scenario);
    const passed = scenario.evaluate(chaosResult);
    results.push({ id: scenario.id, passed, chaosResult });

    const icon = passed ? '✓' : '✗';
    console.log(`${icon} [${chaosResult.cyclesUsed}c/${chaosResult.turnsUsed}t] ${chaosResult.phase}${passed ? '' : ` — ASSERTION FAILED`}`);
    if (!passed) {
      console.log(`    Expected: ${scenario.expectedBehavior}`);
      console.log(`    Got: phase=${chaosResult.phase}, cycles=${chaosResult.cyclesUsed}`);
    }
  }

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  console.log('\n───────────────────────────────────────────────────────────');
  console.log(`  Results: ${passed}/${total} scenarios passed`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (passed < total) {
    console.error(`CHAOS FAILURES: ${total - passed} scenario(s) failed`);
    process.exit(1);
  }
}

runAll().catch(err => { console.error('Chaos runner failed:', err); process.exit(1); });
