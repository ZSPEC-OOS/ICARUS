# BLUSWAN — AI professional coder

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:5173 and log in with:
- **Username:** bluswan
- **Password:** admin

## Configuration

1. Open Settings (⚙ gear icon in the sidebar)
2. Enter your AI provider API key (Anthropic, OpenAI, Kimi, etc.)
3. Add a GitHub Personal Access Token with `repo` scope for code push/PR features

## Exec Bridge (Terminal & Tools tab)

The terminal and Tools tab require the Vite dev server to be running — they send
shell commands to a local middleware endpoint (`/api/exec`). This is dev-only and
is never included in a production build.

## Environment

Optional: copy `.env.example` to `.env.local` and set `VITE_AI_PROXY_URL` to
route API calls through a backend proxy instead of calling providers directly.

## Deploying to Render (Static Site)

This repo includes a `render.yaml` blueprint for a static deployment. Render will:
- install dependencies (`npm ci`)
- build with Vite (`npm run build`)
- publish the `dist/` directory
- rewrite all routes to `index.html` so deep links in the SPA do not 404

If you deploy from the Render UI instead of a Blueprint, use:
- **Build Command:** `npm ci && npm run build`
- **Publish Directory:** `dist`


## Enhancer Modules (Incremental Integration)

This branch adds pluggable "high-impact enhancer" modules on top of the existing tool framework without breaking legacy flows.

### New enhancer capabilities

- **Structured Prompt Contract** middleware (Goal, Constraints, Inputs, Expected Outputs, Acceptance Tests).
- **Self-check / Critique pass** after draft responses (rule-based checks by default).
- **RAG retrieval tools** with hybrid scoring + reranking:
  - `hybrid_search`
  - `retrieve_context`
- **Deep Reasoning workflow builder** (`createDeepReasoningWorkflow`) that composes:
  1) complexity classification,
  2) planning,
  3) retrieval,
  4) execution,
  5) critique,
  6) concise+detailed output rendering.

### Central configuration

Use `src/services/enhancers/config.js` to enable/disable each enhancer independently.
By default, high-coupling enhancers are **off** to preserve backward compatibility.

### Integration points

- Agent loop middleware: `src/services/agentLoop.js`
  - Structured prompt injection (optional)
  - Critique event emitted before final `done`
- Tool execution engine: `src/services/agentExecutor.js`
  - Added RAG-backed tool handlers (`hybrid_search`, `retrieve_context`)
- Modular tools registry: `src/tools/index.js`
  - Added built-in tools (`hybrid-search`, `retrieve-context`) for tool pane usage.

### Example deep-reasoning usage

```js
import { createDeepReasoningWorkflow } from './src/services/enhancers/deepReasoningPipeline.js'
import { resolveEnhancerConfig } from './src/services/enhancers/config.js'

const run = createDeepReasoningWorkflow({
  enhancerConfig: resolveEnhancerConfig({ deepReasoning: { enabled: true }, rag: { enabled: true } }),
  shadowContext,
  planner: async ({ task }) => ({
    steps: [`Analyze: ${task.goal}`, 'Implement change', 'Run validation', 'Summarize results'],
    dependencies: [],
  }),
  runAgent: async (taskText) => ({ text: `Executed with task:\n${taskText}` }),
})

const result = await run('Goal: hard task\nConstraints: keep API stable')
console.log(result.concise)
```

## Nightly Benchmark Suite (Evaluation Moat)

Run the local benchmark harness:

```bash
npm run benchmark:nightly
```

Outputs are written to `.bluswan/benchmarks/`:
- `latest.json` machine-readable metrics and regression signals
- `<suite>.json` historical report snapshot
- `<suite>.md` comparative markdown summary

Tracked metrics:
- correctness rate
- AST-aware edit distance (normalized syntax proxy)
- test pass rate
- time-to-green
- cost per task

CI automation is defined in `.github/workflows/nightly-benchmark.yml` and uploads nightly artifacts.
