# Public API Reference

**API version:** 2.0.0 (plan contract version `2026.1`)

All stable exports are available from the `src/core-v2/index.js` entry point. Imports from internal sub-modules are supported but not covered by the stability guarantee below.

---

## Stability Policy

Exports marked `@stable` in JSDoc will not have breaking changes within the `2.x` version line. This means:

- Function signatures will not change
- Required parameters will not be added
- Returned object shapes will only gain optional fields (no field removals)
- Error types will not be renamed or removed

Exports not listed in this document are internal and may change without notice.

---

## Core Entry Point

```javascript
import { runTask, createPlanContract } from './src/core-v2/index.js';
```

---

## `runTask(taskSpec, callbacks) → Promise<TaskResult>`

Runs a complete task from plan to completion through the Task State Machine.

**Since:** 2.0.0 | **Stable**

### `TaskSpec`

| Field | Type | Required | Description |
|---|---|---|---|
| `taskId` | `string` | yes | Unique identifier for this task run |
| `goal` | `string` | yes | Plain-language description of the task goal |
| `plan` | `ExecutionPlan` | yes | Validated plan contract (from `createPlanContract`) |
| `options` | `TaskOptions` | no | Runtime options (see below) |

### `TaskOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `maxCycles` | `number` | `3` | Maximum number of execution cycles |
| `maxTurnsPerCycle` | `number` | `25` | Maximum LLM turns per cycle |
| `contextWindow` | `number` | `128000` | Token budget for context assembly |
| `remediationBudget` | `number` | `100` | Remediation units available for the task |
| `requirePlanReview` | `boolean` | `true` | Whether to call `onPlanReview` before execution |
| `requireCompletionConfirm` | `boolean` | `true` | Whether to call `onCompletionCheck` after execution |

### `TaskCallbacks`

| Field | Type | Description |
|---|---|---|
| `callLLM` | `async (prompt: string) => string` | LLM bridge — receives assembled context, returns LLM response |
| `executeTool` | `async (name: string, input: object) => string` | Tool executor — runs a tool call, returns string result |
| `onPhaseChange` | `(from, to, context) => void` | Called on every TSM phase transition |
| `onCycleStart` | `(cycleNumber) => void` | Called when a cycle begins |
| `onCycleEnd` | `(cycleNumber, result) => void` | Called when a cycle ends |
| `onPlanReview` | `async (plan) => 'approve' \| 'reject'` | Human checkpoint before execution |
| `onCompletionCheck` | `async (result) => 'accept' \| 'reject'` | Human checkpoint after execution |
| `onEvent` | `(event) => void` | Called for every telemetry event |
| `onError` | `(error) => void` | Called for non-fatal errors during execution |
| `onTelemetryFlush` | `(events) => void` | Called when the telemetry buffer flushes |

### `TaskResult`

| Field | Type | Description |
|---|---|---|
| `taskId` | `string` | Matches `taskSpec.taskId` |
| `phase` | `'done' \| 'failed' \| 'halted'` | Final phase of the task |
| `haltReason` | `string \| null` | Set when `phase === 'halted'`; describes the loop guard that fired |
| `cycles` | `CycleResult[]` | One entry per executed cycle |
| `qualityReport` | `QualityReport` | Aggregated quality signal results |
| `remediationBudget` | `BudgetSummary` | Final remediation budget state and audit trail |
| `durationMs` | `number` | Total wall-clock time in milliseconds |

### `CycleResult`

| Field | Type | Description |
|---|---|---|
| `cycleNumber` | `number` | 1-indexed cycle number |
| `status` | `'completed' \| 'halted' \| 'failed'` | Cycle outcome |
| `turns` | `number` | Number of LLM turns executed in this cycle |
| `summary` | `string` | Cycle summary from the `<CYCLE_COMPLETE>` block |
| `deliverablesAddressed` | `string[]` | Deliverable IDs mentioned in the cycle summary |
| `nextCycleNeeded` | `boolean` | Whether the LLM requested another cycle |

---

## `createPlanContract(rawPlan) → ExecutionPlan`

Validates and freezes a plan object. Throws `PlanValidationError` if the plan is invalid.

**Since:** 2.0.0 | **Stable**

### `ExecutionPlan`

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | `string` | yes | Plan schema version — must be `'2026.1'` |
| `taskId` | `string` | yes | Matches `TaskSpec.taskId` |
| `goal` | `string` | yes | Task goal |
| `deliverables` | `Deliverable[]` | yes | At least one deliverable required |
| `estimatedCycles` | `number` | yes | Expected cycle count (informational, not enforced) |
| `dependencies` | `string[]` | no | File paths this task depends on |
| `validationSteps` | `string[]` | no | Commands to run for completion gating |
| `contextStrategy` | `ContextStrategy` | yes | Context assembly configuration |

### `Deliverable`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique within the plan |
| `type` | `'file' \| 'command' \| 'test'` | Deliverable type |
| `path` | `string` | File path or command string |
| `description` | `string` | What this deliverable produces |
| `acceptanceCriteria` | `string` | How completion is verified |
| `completed` | `boolean` | Set to `false` in the plan; updated by the engine |

### `ContextStrategy`

| Field | Type | Description |
|---|---|---|
| `maxTokensPerCycle` | `number` | Token budget for context assembly per cycle |
| `includeRepoMap` | `boolean` | Whether to include the repo map in context |

---

## `PlanValidationError`

Thrown by `createPlanContract` when the plan fails validation.

```javascript
import { PlanValidationError } from './src/core-v2/index.js';

try {
  const plan = createPlanContract(rawPlan);
} catch (err) {
  if (err instanceof PlanValidationError) {
    console.error(err.validationErrors); // string[]
  }
}
```

---

## `InvalidPhaseTransitionError`

Thrown by the Task State Machine when a phase transition is not in the allowed-transitions table. This is a programming error, not a runtime task failure.

---

## `ContextBudgetError` / `ContextBudgetExceededError`

Thrown by `contextBudget.js` when the assembled context exceeds the token budget. Not swallowed — callers must handle or let the task fail.

---

## `RemediationBudgetExhaustedError`

Not thrown automatically. Raised only if `spend()` is called with `throwOnExhaust: true`. Default behavior on exhaustion is to complete the task with quality warnings.

---

## Versioning

The API version tracks the plan contract version. Version `2.0.0` corresponds to plan contract version `2026.1`. Breaking changes will increment the major version; new stable exports will increment the minor version.
