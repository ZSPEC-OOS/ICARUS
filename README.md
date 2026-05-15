# BLUSWAN

Build software at the speed of intent.

BLUSWAN is an AI-powered engineering workspace that combines a deterministic execution engine, bounded resource budgets, and integrated tooling into one browser-first experience. Plan changes, execute code edits, validate quality, and ship with confidence.

---

## What's New in V2

V2 replaces the V1 nested-loop architecture with structural guarantees:

| Concern | V1 | V2 |
|---|---|---|
| Loop prevention | Heuristics (30% infinite-loop rate) | Forward-only 11-phase Task State Machine — loops structurally impossible |
| Token waste | ~40% on auto-repair loops | ≤10% — remediation budget makes repair costs explicit |
| Context management | 10 competing injectors, silent pruning | Reserved tiers + `ContextBudgetError` — no silent drops |
| Error handling | 1,400-line auto-repair engine, hidden retries | Classify-only `errorClassifier.js` — LLM decides fix strategy |
| Quality checks | Uniform hard gates — any warning blocks shipping | Gates (blocking) + signals (non-blocking, reported) |
| Observability | Final outcome only | Full telemetry trace — every event, budget spend, and phase transition |

V1 routing is preserved. The V2 engine is opt-in via feature flags and does not affect existing integrations.

---

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:5173` and sign in via the Firebase Auth prompt.

Configure your AI provider in **Settings → AI Provider**.

To enable the V2 engine, add `?v2=true` to the URL. To enable the V2 UI as well, use `?v2=true&v2ui=true`.

---

## Feature Flags

| URL param | Effect |
|---|---|
| `?v2=true` | Routes tasks through the V2 state machine |
| `?v2ui=true` | Enables the V2 task lanes, budget bar, and telemetry panel |
| `?v2=true&v2ui=true` | Full V2 experience |

Flags can also be set persistently in `localStorage`:

```javascript
localStorage.setItem('bluswan_v2_engine', 'true');
localStorage.setItem('bluswan_v2_ui', 'true');
```

---

## Core Architecture (V2)

### Task State Machine

Every task moves forward through 11 phases:

```
idle → planning → plan_review → cycle_prep → cycle_exec
     → cycle_validate → [repeat] → completion_check
     → completion_confirm → done | failed | halted
```

Phases are forward-only. No phase can be revisited. The plan is immutable after `plan_review`. Hard caps: max 3 cycles, max 25 turns per cycle (both configurable).

### Bounded Remediation

Each task has a 100-unit remediation budget. Every fix attempt costs units:

| Action | Cost |
|---|---|
| `tool_retry` | 5 |
| `test_re_run` | 10 |
| `lint_re_run` | 5 |
| `model_re_call` | 20 |
| `context_repack` | 15 |

When the budget is exhausted, the task completes with quality warnings rather than failing. The full audit trail is in `TaskResult.remediationBudget.auditTrail`.

### Context Budget

Context is assembled in priority-ordered tiers. Reserved space is inviolable:

- System prompt: 2,000 tokens
- Plan contract: 1,500 tokens
- Completion protocol: 500 tokens
- Safety buffer: 1,000 tokens

Overflow throws `ContextBudgetError` — no silent pruning that drops the task goal.

---

## CLI

Headless operation for scripted and CI workflows:

```bash
node src/cli/bluswan-cli.mjs run "Refactor auth module to use async/await" --model=claude-3-5-sonnet-20241022
```

---

## Documentation

| Document | Description |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full V2 architecture: state machine diagram, context budget tiers, quality pipeline |
| [docs/api/public-api.md](docs/api/public-api.md) | Stable public API reference (`runTask`, `createPlanContract`, all types) |
| [docs/contributing/getting-started.md](docs/contributing/getting-started.md) | Setup, project structure, feature flags, adding tools and quality signals |
| [docs/contributing/debugging.md](docs/contributing/debugging.md) | Telemetry export, event types, common failure modes |
| [docs/adr/](docs/adr/) | Architecture Decision Records (5 ADRs covering V2 design decisions) |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

---

## Deployment

A `render.yaml` blueprint is included for static deployment workflows.
