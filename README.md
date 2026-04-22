# BLUSWAN

**An AI-powered coding agent with multi-model orchestration, reliability gates, and a full tool ecosystem — running entirely in the browser.**

BLUSWAN is a React SPA that lets you point any AI provider at your codebase and run an autonomous coding agent loop. It plans, writes, tests, and verifies changes, escalates to a backup model when needed, fetches live library documentation, and remembers what it did across sessions — all configurable through a settings UI with no backend required.

---

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:5173` and log in:

| Field | Value |
|---|---|
| Username | `bluswan` |
| Password | `admin` |

Then open **Settings → AI Provider** and paste in your API key.

---

## Configuration

### AI Provider

BLUSWAN supports any OpenAI-compatible API endpoint. Tested providers:

- **Anthropic** — Claude 3.5 Sonnet, Claude 3 Haiku, Claude 3 Opus
- **OpenAI** — GPT-4o, GPT-4o-mini, o1-mini
- **Kimi** (Moonshot) — moonshot-v1-128k
- Any other provider that follows the OpenAI chat completions spec

Add as many models as you like. Each model entry stores its own API key — you can mix providers freely.

### GitHub Token

Add a Personal Access Token with `repo` scope under **Settings → GitHub**. This enables:
- Reading and writing files to your connected repository
- Creating pull requests with auto-generated descriptions
- Branch management

### Optional: Firebase

If you want model configuration and settings to persist across devices, configure a Firebase project under **Settings → Firebase**. Without Firebase, all settings are stored in `localStorage` and stay local to the browser.

### Optional: Tavily Web Search

Add a Tavily API key under **Settings → Web Search** to enable the `web_search` tool. Tavily is CORS-enabled so calls go directly from the browser.

---

## Feature Overview

### Agent Loop

The core of BLUSWAN is a reliability finite-state machine that runs every task through four phases:

```
plan → execute → verify → [rollback if needed]
```

- **Max 100 turns** per session with a 10-turn sliding window for context retention
- **Rollback handler** reverts file changes if the verification phase fails
- **Quality floor** runs configurable acceptance checks before marking a task complete
- **Critique pass** evaluates grounding, constraint adherence, and completeness after every draft
- **Patch validator** catches malformed edits (fuzzy match + bracket-balance check) before they hit the filesystem

### Multi-Model Orchestration

The **Model Router** classifies each task into one of five agent roles and dispatches it to the appropriate model:

| Role | Default Cost Tier |
|---|---|
| `planner` | High |
| `debugger` | Medium |
| `refactorer` | Medium |
| `test-writer` | Low |
| `reviewer` | Low |

Four routing strategies are available:

| Strategy | Behavior |
|---|---|
| `single` | Use the role's primary model, no fallback |
| `fallback` | Try primary; walk the fallback chain on error |
| `ensemble` | Call multiple models in parallel, pick best result |
| `cost_aware` | Prefer the cheapest capable model for the task |

Fallback preferences are persisted to `localStorage` with a 24-hour TTL — if a fallback model succeeds after a primary failure, the router skips the bad primary automatically on the next session.

### Model 2 Attachment

Attach a secondary model that takes over the entire task when the primary fails:

- **Error escalation** — triggers when the primary model's API call throws (on by default)
- **Quality-gate escalation** — triggers when the task completes but reliability gates fail (optional; runs the whole task twice so use deliberately)
- Recursion guard (`_escalated` flag) prevents infinite loops
- Escalation events appear in the activity feed with the reason and target model

Configure in **Settings → Model 2 Attachment**: pick the backup model from any model you have already added.

### Library Context (Auto-Docs Injection)

Before the first model call on any task, BLUSWAN scans the task text for package references and fetches live documentation from public registries:

- Detects `npm install`, `pip install`, ES `import` statements, `require()` calls, and scoped `@org/package` names
- Fetches from `registry.npmjs.org` (npm) and `pypi.org` (PyPI) — no auth required
- 10-minute in-memory cache so repeated tasks don't re-fetch
- Results injected as a structured context block before the model writes any code

The `install_package` tool lets the model install packages mid-task via the Exec Bridge, then fetches and injects the post-install docs automatically.

### Auto-Debug Loop

Enable **Settings → Hooks → Auto-debug loop** to run your test suite after every file write:

- Configurable test command (defaults to `npm test -- --passWithNoTests 2>&1 | tail -60`)
- Supports Vitest, Jest, Node test runner, and Pytest output parsing
- Pass/fail badge + last 600 chars of output are appended to the tool result inline
- The model sees the test results on the same turn as the write and can self-correct without extra orchestration

### Smart PR Description Generator

The `generate_pr_description` tool builds a structured pull request body from the diff between two branches:

- Groups changed files by directory area
- Bullets each commit in the range
- Calculates line counts per file
- Generates a heuristic test plan checklist
- Pass `create: true` to open the PR immediately via the GitHub API

### Cross-Session Memory

Enable **Settings → Cross-session memory** to give the agent institutional recall across sessions:

- After each successful verified run that changes files, a one-line summary is auto-appended to `BLUSWAN.md`
- `BLUSWAN.md` is already injected into every system prompt
- The model sees a running log of what was done and when, with no extra infrastructure

### RAG (Retrieval-Augmented Generation)

Hybrid BM25 + vector search over your repository, enabled by default:

- **BM25 weight**: 0.45 | **Vector weight**: 0.55 (configurable)
- Reranks top 12 candidates, injects top 6 into context
- Degrades gracefully — returns empty context with zero latency when the index isn't ready
- Tools: `hybrid_search`, `retrieve_context`

### ShadowContext (Repo Indexer)

An async background indexer that builds a queryable map of your connected repository:

- Import graph extraction
- Symbol-level indexing (functions, classes, exports) — up to 200 symbols per file
- Convention detection (naming patterns, file structure)
- Powers RAG retrieval and the `analyze_codebase` tool
- Index refreshes at the start of each agent loop when stale

### Skills Discovery (SKILL.md Runtime Bootstrap)

BLUSWAN can now discover skill manifests across the indexed repository to support skill-aware orchestration:

- Scans indexed paths for `SKILL.md` files
- Returns each skill root plus `scripts/`, `references/`, and `assets/` presence
- Optional frontmatter extraction for quick metadata routing
- Exposed through the `discover_skills` tool for both primary and spawned read-only agents

### TDD Loop

A closed-loop test orchestrator that drives the agent to green:

- Parses test output from Vitest, Jest, Node test runner, and Pytest
- Extracts pass/fail counts, error locations, and failure messages
- Feeds structured diagnostics back into the agent loop so the model targets the right failing test

### Security Scanner

The `security_scanner` service runs on written code to flag common vulnerability patterns before changes are committed.

### DRCT Creative Pipeline

An optional four-stage creative workflow for generative and architectural tasks:

| Stage | What happens |
|---|---|
| **Dream** | Generate N candidate responses in parallel across available models |
| **Remix** | Recombine and cross-pollinate the best candidates |
| **Critique** | Score and rank the remixed outputs |
| **Transcend** | Synthesize a final response that exceeds any single candidate |

### Simple Mode

A stripped-down agent configuration for quick tasks that don't need the full orchestration stack. Lower latency, fewer tokens, same tool access.

### Prompt Registry

A/B variant tracking for system prompts. Win/loss signals are recorded so you can measure which prompt variants produce better task outcomes over time.

---

## Built-in Tools (35+)

| Category | Tools |
|---|---|
| **File I/O** | `read_file`, `write_file`, `edit_file`, `delete_file`, `revert_file`, `read_many_files` |
| **Navigation** | `list_directory`, `list_source_directory`, `glob`, `search_files` |
| **Code Analysis** | `grep`, `analyze_codebase`, `discover_skills`, `analyze_stacktrace`, `find_tech_debt`, `lint_file` |
| **RAG** | `hybrid_search`, `retrieve_context` |
| **Web** | `web_search`, `web_fetch`, `check_url_health` |
| **GitHub** | `create_pull_request`, `generate_pr_description` |
| **Packages** | `install_package` |
| **Utilities** | `run_command`, `update_memory`, `todo`, `json_repair`, `token_io_optimizer` |

All tools are validated against typed input/output contracts at runtime (`src/tools/contracts.js`). Custom tools can be loaded via the tool loader at `src/services/toolLoader.js`.

---

## Enhancer Configuration

All optional capabilities are controlled through `src/services/enhancers/config.js`. Every block has safe defaults and can be toggled independently:

```js
import { resolveEnhancerConfig } from './src/services/enhancers/config.js'

const config = resolveEnhancerConfig({
  rag:              { enabled: true, injectTopK: 8 },
  critique:         { enabled: true, mode: 'llm' },
  deepReasoning:    { enabled: true },
  plannerExecutor:  { enabled: true, parallelExecution: true },
  model2Attachment: { enabled: true, modelId: 'claude-3-opus-20240229', escalateOnError: true },
  crossSessionMemory: { enabled: true },
  orchestration: {
    strategy: 'fallback',
    roles: {
      planner:    { primary: 'claude-3-opus-20240229', fallbacks: ['gpt-4o'], cost: 'high' },
      debugger:   { primary: 'gpt-4o', fallbacks: [], cost: 'medium' },
      'test-writer': { primary: 'claude-3-haiku-20240307', fallbacks: [], cost: 'low' },
    },
  },
})
```

Settings written from the UI are stored in `localStorage` and merged with defaults on load.

---

## Exec Bridge (Local Shell Access)

The terminal and tool execution features send shell commands to a local Vite middleware endpoint at `/api/exec`. This is **dev-only** and is stripped from production builds.

The exec bridge powers:
- `run_command` tool
- `lint_file` tool (runs ESLint/Pylint locally)
- Auto-debug loop hook (runs your test suite)
- `install_package` tool (runs npm/pip/pnpm)
- Type-check hook (runs `tsc --noEmit`)

The bridge is available whenever `npm run dev` is running. In a deployed build, tools that require it degrade gracefully.

---

## Architecture

```
src/
├── services/
│   ├── agentLoop.js              # Main FSM: plan → execute → verify → rollback
│   ├── agentExecutor.js          # Tool dispatch and hook pipeline
│   ├── agentTools.js             # Tool schema definitions
│   ├── libraryContextService.js  # Package detection + registry doc fetching
│   ├── memoryGraphService.js     # 128-dim FNV-1a embeddings, cosine similarity
│   ├── shadowContext.js          # Async repo indexer (import graph + symbols)
│   ├── tddLoop.js                # Closed-loop test runner + output parser
│   ├── securityScanner.js        # Vulnerability pattern detection
│   ├── planner.js                # Task planning service
│   ├── toolLoader.js             # Custom tool loader
│   ├── toolTraceStore.js         # Per-session tool call trace
│   ├── promptRegistry.js         # A/B prompt variant tracker
│   ├── bluswanSimpleMode.js      # Lightweight agent mode
│   ├── enhancers/
│   │   ├── config.js             # Central enhancer feature flags
│   │   ├── ragService.js         # Hybrid BM25 + vector search
│   │   ├── critiqueMiddleware.js  # Post-draft critique pass
│   │   ├── structuredPrompting.js # Prompt contract middleware
│   │   ├── qualityFloor.js       # Acceptance gate evaluators
│   │   ├── contextPacker.js      # Token-aware context assembly
│   │   └── deepReasoningPipeline.js
│   ├── orchestration/
│   │   ├── modelRouter.js        # Role-based model dispatch (4 strategies)
│   │   ├── taskClassifier.js     # Task → agent role classification
│   │   └── taskDecomposer.js     # Complex task → subtask decomposition
│   ├── reliability/
│   │   ├── fsm.js                # Reliability state machine
│   │   ├── gateEvaluators.js     # Quality gate checks
│   │   └── rollbackHandler.js    # File change reversion
│   └── creative/
│       ├── drctPipeline.js       # Dream → Remix → Critique → Transcend
│       ├── recombinator.js       # Candidate cross-pollination
│       └── transcendOperator.js  # Final synthesis
├── tools/                        # 35+ built-in tools (one file each)
├── components/
│   ├── bluswan/                  # Activity feed, diff viewer, settings UI
│   └── workspace/                # Workspace state and layout
├── core/hooks/                   # React hooks: agent session, conversation, exec bridge
└── cli/
    └── bluswan-cli.mjs           # Headless CLI (no browser required)
```

---

## Deploying to Render (Static Site)

A `render.yaml` blueprint is included for zero-config Render deployment:

- **Build command:** `npm ci && npm run build`
- **Publish directory:** `dist`
- All routes rewrite to `index.html` so SPA deep links work

The exec bridge is automatically excluded from production builds. All AI calls go directly from the browser to your configured provider endpoints.

---

## Headless CLI

Run BLUSWAN without a browser:

```bash
node src/cli/bluswan-cli.mjs --task "Refactor auth module to use async/await" --model claude-3-5-sonnet-20241022
```

The CLI uses the same agent loop, tool set, and enhancer pipeline as the UI.

---

## Benchmark Suite

Run the nightly evaluation harness:

```bash
npm run benchmark:nightly
```

Outputs are written to `.bluswan/benchmarks/`:

| File | Contents |
|---|---|
| `latest.json` | Machine-readable metrics and regression signals |
| `<suite>.json` | Historical snapshot per benchmark suite |
| `<suite>.md` | Comparative markdown summary |

Tracked metrics: correctness rate, AST-aware edit distance, test pass rate, time-to-green, cost per task.

CI automation runs nightly via `.github/workflows/nightly-benchmark.yml` and uploads artifacts.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `VITE_AI_PROXY_URL` | Route AI API calls through a backend proxy instead of direct browser calls |

Copy `.env.example` to `.env.local` to configure.
