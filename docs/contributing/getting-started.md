# Contributing: Getting Started

This guide covers how to set up a local development environment and make changes to the BLUSWAN codebase.

---

## Prerequisites

| Requirement | Minimum version |
|---|---|
| Node.js | 22.x |
| npm | 10.x |
| Git | 2.40+ |

No other global tools are required. All build and test tooling is in `devDependencies`.

---

## Setup

```bash
git clone https://github.com/zspec-oos/bluswan.git
cd bluswan
npm install
```

Copy the environment template and fill in your API keys:

```bash
cp .env.example .env.local
```

Required variables for local development:

```
VITE_ANTHROPIC_API_KEY=...   # or any OpenAI-compatible key
VITE_FIREBASE_API_KEY=...    # required for auth; use a dev Firebase project
```

Start the dev server:

```bash
npm run dev
```

Open `http://localhost:5173`.

---

## Project Structure

```
src/
  core-v2/          # V2 execution pipeline (state machine, budgets, loop prevention)
  services-v2/      # V2 agent executor and tool executor
  components-v2/    # V2 React components (task lanes, budget bar, telemetry panel)
  services/         # V1 agent loop and reliability FSM (kept for fallback routing)
  components/       # V1 UI components
  config/           # Feature flags and constants
  cli/              # Headless CLI (bluswan-cli.mjs)
  tools/            # Tool schema registry (shared between V1 and V2)

docs/
  adr/              # Architecture decision records
  contributing/     # These docs
  api/              # Public API reference

tests/
  benchmarks/       # Scripted LLM benchmark runner and fixtures
  integration/      # Integration tests for migration routing
  unit/             # Unit tests for shared utilities
```

`src/core-v2/tests/` contains unit tests for the V2 pipeline, co-located with the source files they test. These are picked up by `npm test`.

---

## Feature Flags

V2 code paths are gated behind runtime feature flags defined in `src/config/featureFlags.js`. Flags can be activated without changing code:

| Flag | How to activate |
|---|---|
| `useV2Engine` | Add `?v2=true` to the URL |
| `useV2UI` | Add `?v2ui=true` to the URL |
| `v2_full` | Add `?v2=true&v2ui=true` |

You can also set flags persistently in the browser console:

```javascript
localStorage.setItem('bluswan_v2_engine', 'true');
localStorage.setItem('bluswan_v2_ui', 'true');
```

The `FeatureFlagPanel` component (`src/components-v2/FeatureFlagPanel.jsx`) is available in development builds at the bottom of the screen and shows the active flag state.

---

## Running Tests

```bash
npm test          # all tests
npm run lint      # ESLint check
npm run build     # production build (Vite)
```

Tests use Node.js's built-in test runner (`node:test`). No additional test framework is needed.

The test command runs:

```
node --test src/core-v2/tests/*.test.mjs src/components-v2/tests/*.test.mjs tests/unit/*.test.mjs
```

Integration tests are in `tests/integration/` and are run separately:

```bash
node --test tests/integration/*.test.mjs
```

---

## Adding a Tool

Tools are defined as JSON schema objects in `src/tools/`. Each tool has:

1. A schema file: `src/tools/<tool-name>.json`
2. Registration in `src/tools/index.js`

The V2 pipeline loads allowed tools via `getAllowedTools()` from `src/core-v2/taskRunner.js`. The `enforceToolRestriction()` function in `src/core-v2/cycleEngine.js` validates every tool call against the allowed set.

To add a tool:

1. Create `src/tools/my-tool.json` with `name`, `description`, and `parameters` fields matching the OpenAI function-call schema format.
2. Add the tool to the export in `src/tools/index.js`.
3. Implement the tool handler in `src/services-v2/agentExecutor.js` under the `executeTool` switch.
4. Add a unit test in `src/core-v2/tests/` or `tests/unit/`.

---

## Adding a Quality Signal

Quality signals are defined in `src/core-v2/qualitySignals.js`. Each signal is a function with the signature:

```javascript
async function mySignal(context) {
  // context: { modifiedFiles, taskId, workingDir }
  // return: { name, passed, message, severity: 'warn' | 'info' }
}
```

Register it in the `SIGNAL_REGISTRY` array at the bottom of `qualitySignals.js`. Signals run after each cycle completes and their output appears in `TaskResult.qualityReport`.

Signals must be non-blocking: they should never throw. Wrap implementations in try/catch and return a degraded result on error.
