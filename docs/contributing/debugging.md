# Contributing: Debugging

This guide covers how to diagnose failures in the V2 execution pipeline using the telemetry system, structured logs, and the benchmark runner.

---

## Telemetry Export

Every task emits structured telemetry events through `src/core-v2/telemetry.js`. In the browser, the telemetry panel (V2 UI) displays events in real time. For programmatic access:

```javascript
import { createTelemetrySink } from './src/core-v2/telemetry.js';

const sink = createTelemetrySink({
  onFlush: (events) => {
    // events: Array<{ type, taskId, data, timestamp, phase }>
    console.log(JSON.stringify(events, null, 2));
  },
});
```

Pass the sink to `runTask` via the `callbacks.onTelemetryFlush` field.

To export a full trace from a completed task, call `sink.flush()`. The returned array contains every event emitted during the task lifetime in emission order.

---

## Telemetry Event Types

| Event type | Emitted when |
|---|---|
| `task.start` | `runTask()` begins |
| `task.done` | Task reaches `done` phase |
| `task.failed` | Task reaches `failed` phase |
| `task.halted` | Task reaches `halted` phase (loop guard or budget) |
| `phase.transition` | Any phase transition in the TSM |
| `cycle.start` | A new execution cycle begins |
| `cycle.complete` | A cycle completes successfully |
| `cycle.halt` | A cycle is stopped by a loop guard |
| `tool.call` | The LLM emits a tool call |
| `tool.result` | Tool execution completes |
| `budget.spend` | A remediation budget unit is spent |
| `budget.exhausted` | Remediation budget reaches zero |
| `context.pack` | Context packer assembles a turn context |
| `quality.signal` | A quality signal is evaluated |
| `loop.guard` | A loop guard fires |

---

## Telemetry Report Format

A full telemetry report has this shape:

```json
{
  "taskId": "task-abc123",
  "goal": "Refactor auth module",
  "startedAt": "2026-05-14T10:00:00.000Z",
  "completedAt": "2026-05-14T10:04:32.000Z",
  "phase": "done",
  "cycles": [
    {
      "cycleNumber": 1,
      "status": "completed",
      "turns": 4,
      "toolCalls": ["read_file", "write_file", "write_file"],
      "remediationSpent": 0,
      "contextTokensUsed": 12400
    }
  ],
  "qualityReport": {
    "hasWarnings": false,
    "signals": []
  },
  "remediationBudget": {
    "initial": 100,
    "remaining": 100,
    "auditTrail": []
  },
  "events": [ ... ]
}
```

---

## Common Failure Modes

### `phase: halted` with `haltReason: tool_sequence_repeat`

The LLM repeated the same tool call more than the allowed threshold (default: 3 times per cycle). This usually means the LLM is stuck waiting for a file or result that it already has.

**Diagnose:** Check `events` for the repeated `tool.call` entries. Look at the tool result — if the content is non-empty, the LLM received it but isn't using it.

**Fix:** Add a note to the plan's `validationSteps` telling the executor to proceed after reading. Alternatively, reduce `maxTurnsPerCycle` to surface the loop sooner.

---

### `phase: halted` with `haltReason: read_without_action`

The LLM read the same file more than 3 times without editing it. The loop guard in `src/core-v2/loopPrevention.js` fires the `checkFileRead` guard.

**Diagnose:** Check `events` for the repeated `read_file` tool calls on the same path.

**Fix:** Ensure the deliverable description is specific enough to prompt an edit. Vague deliverables like "update the auth file" allow the LLM to interpret reading as progress.

---

### `phase: failed` with LLM error in first cycle

The LLM callback threw on every turn. This usually means an API credential issue or a network failure.

**Diagnose:** Check `events` for `tool.result` entries with `error: true`. The error message is included.

**Fix:** Verify API keys in `.env.local`. If using a custom OpenAI-compatible endpoint, verify the base URL.

---

### `ContextBudgetError` thrown

The context packer could not fit all required tiers within the token budget. This is thrown (not swallowed) by `src/core-v2/contextBudget.js`.

**Diagnose:** The error message includes the token counts per tier and the total overage.

**Fix:** Either reduce the number of deliverables in the plan (fewer files in the repo map), or increase `contextStrategy.maxTokensPerCycle` in the plan contract.

---

### Quality signals show lint warnings after `done`

The task completed but `qualityReport.hasWarnings` is `true`. Quality signals are non-blocking (see [ADR 005](../adr/adr-005-quality-signals-vs-gates.md)).

**Fix:** File a follow-up task targeting the specific files that triggered warnings. Include the `qualityReport` output in the follow-up task's goal.

---

## Benchmark Runner

The benchmark runner in `tests/benchmarks/benchmarkRunner.mjs` allows scripted end-to-end testing with a mock LLM and mock filesystem. It exports:

```javascript
createMockCallbacks(callLLM, executeTool)
createMockExecutor(mockFs)
createMockFileSystem(initialFiles)
createScriptedLLM(responses)
```

Use `createScriptedLLM` to feed a fixed sequence of LLM responses and verify task outcome without a real API call. See `tests/integration/migration.test.mjs` for usage examples.

---

## Phase Transition Debugging

To trace every phase transition during a task:

```javascript
const callbacks = {
  onPhaseChange: (from, to, context) => {
    console.log(`[TSM] ${from} → ${to}`, context);
  },
  // ... other callbacks
};
```

`onPhaseChange` is called synchronously before the transition is recorded. If a transition throws `InvalidPhaseTransitionError`, it means a phase transition was attempted that is not in the allowed-transitions table in `src/core-v2/taskStateMachine.js`.
