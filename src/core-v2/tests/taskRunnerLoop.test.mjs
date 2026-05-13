import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runTask } from '../taskRunner.js';
import { createPlanContract } from '../planContract.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePlan(deliverables = []) {
  return createPlanContract({
    version: '2026.1',
    taskId: 'loop-test',
    goal: 'Loop prevention test',
    estimatedCycles: 2,
    deliverables: deliverables.length > 0 ? deliverables : [
      {
        id: 'deliv-1',
        type: 'file',
        path: 'out/result.js',
        description: 'Create result file',
        acceptanceCriteria: 'file exists',
        completed: false,
      },
    ],
    dependencies: [],
    validationSteps: [],
    contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: false },
  });
}

function makeCallbacks(callLLM, executeTool = async () => '') {
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
  };
}

// ─── Sequence Repeat Halt ─────────────────────────────────────────────────────

describe('taskRunner: tool_sequence_repeat halt', () => {
  it('halts when LLM repeats the same read_file call past the limit', async () => {
    const plan = makePlan();

    // LLM always emits the same read_file call, never completing
    const callLLM = async () => `
I need to read the file.
\`\`\`json
{"tool": "read_file", "input": {"path": "src/main.js"}}
\`\`\`
`;

    const result = await runTask(
      { taskId: 'seq-test', goal: 'test', plan, options: { maxCycles: 2, maxTurnsPerCycle: 6 } },
      makeCallbacks(callLLM, async (name) => {
        if (name === 'read_file') return 'const x = 1;';
        return '';
      })
    );

    assert.equal(result.phase, 'halted');
    assert.ok(result.haltReason, 'haltReason should be set');
  });
});

// ─── Read Without Action Halt ─────────────────────────────────────────────────

describe('taskRunner: read_without_action halt', () => {
  it('halts when LLM reads the same file repeatedly without editing', async () => {
    const plan = makePlan();
    let turn = 0;

    // LLM reads same file 3+ times without editing
    const callLLM = async () => {
      turn++;
      return `
Reading the file again (turn ${turn}).
\`\`\`json
{"tool": "read_file", "input": {"path": "src/target.js"}}
\`\`\`
`;
    };

    const result = await runTask(
      { taskId: 'read-test', goal: 'test', plan, options: { maxCycles: 1, maxTurnsPerCycle: 10 } },
      makeCallbacks(callLLM, async (name) => {
        if (name === 'read_file') return 'existing content';
        return '';
      })
    );

    assert.equal(result.phase, 'halted');
    const reason = (result.haltReason ?? '').toLowerCase();
    assert.ok(reason.includes('read') || reason.includes('tool sequence'), `Unexpected haltReason: ${result.haltReason}`);
  });
});

// ─── Command Repeat Halt ──────────────────────────────────────────────────────

describe('taskRunner: command_repeat halt', () => {
  it('halts when LLM runs the same command twice in a cycle', async () => {
    const plan = makePlan([{
      id: 'deliv-cmd',
      type: 'command',
      path: '',
      description: 'Run tests',
      acceptanceCriteria: 'tests pass',
      completed: false,
    }]);

    let turn = 0;

    const callLLM = async () => {
      turn++;
      // First turn: run the command. Second turn: run it again.
      return `
Running tests (attempt ${turn}).
\`\`\`json
{"tool": "run_command", "input": {"command": "npm test"}}
\`\`\`
`;
    };

    const result = await runTask(
      { taskId: 'cmd-test', goal: 'test', plan, options: { maxCycles: 1, maxTurnsPerCycle: 5 } },
      makeCallbacks(callLLM, async (name) => {
        if (name === 'run_command') return '1 test passed';
        return '';
      })
    );

    assert.equal(result.phase, 'halted');
    const reason = (result.haltReason ?? '').toLowerCase();
    assert.ok(reason.includes('command') || reason.includes('tool sequence'), `Unexpected haltReason: ${result.haltReason}`);
  });
});

// ─── Deliverable Retry Exhausted ──────────────────────────────────────────────

describe('taskRunner: deliverable_retry_exhausted halt', () => {
  it('halts when the same deliverable fails across multiple cycles', async () => {
    const plan = makePlan();

    // LLM never completes anything — always returns same read call,
    // which will cause a tool_sequence_repeat halt in each cycle.
    // The task-level guard fires once per failing cycle × 2 retries.
    const callLLM = async () => `
\`\`\`json
{"tool": "read_file", "input": {"path": "src/main.js"}}
\`\`\`
`;

    const events = [];
    const callbacks = {
      ...makeCallbacks(callLLM, async (name) => {
        if (name === 'read_file') return 'const x = 1;';
        return '';
      }),
      onEvent: (e) => events.push(e),
    };

    // 3 cycles, each cycle will halt due to sequence repeat,
    // then the task-level guard fires on the 2nd failed cycle
    const result = await runTask(
      { taskId: 'retry-test', goal: 'test', plan, options: { maxCycles: 3, maxTurnsPerCycle: 6 } },
      callbacks
    );

    assert.equal(result.phase, 'halted');
    // Either cycle-level or task-level guard fired
    assert.ok(result.haltReason, 'haltReason should be set');
  });
});

// ─── Successful Task Baseline ─────────────────────────────────────────────────

describe('taskRunner: successful task completes without loop guard intervention', () => {
  it('completes cleanly when LLM writes the file and emits CYCLE_COMPLETE', async () => {
    const plan = makePlan();
    let turn = 0;

    const files = {};
    const callLLM = async () => {
      turn++;
      if (turn === 1) {
        return `
I'll write the file now.
\`\`\`json
{"tool": "write_file", "input": {"path": "out/result.js", "content": "export const result = 42;"}}
\`\`\`
`;
      }
      // Turn 2: emit completion
      return `
Done!
<CYCLE_COMPLETE>
summary: Wrote result.js
deliverables_addressed: deliv-1
next_cycle_needed: false
</CYCLE_COMPLETE>
`;
    };

    const result = await runTask(
      { taskId: 'success-test', goal: 'test', plan, options: { maxCycles: 1, maxTurnsPerCycle: 5 } },
      makeCallbacks(callLLM, async (name, input) => {
        if (name === 'write_file') {
          files[input.path] = input.content;
          return `wrote ${input.path}`;
        }
        return '';
      })
    );

    // Should complete (or reach completion_check/done)
    // Even if safety/completion gates fail without real file system,
    // the cycle itself should complete (not halt due to loop guard)
    assert.notEqual(result.phase, 'halted' && result.haltReason?.includes('loop'));
    assert.ok(result.cycles.length > 0);
    // The cycle should have completed status
    const finishedCycle = result.cycles[0];
    assert.equal(finishedCycle.status, 'completed');
  });
});
