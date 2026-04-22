# BLUSWAN vs Qwen Code: Gap Analysis & Integration Enhancements

_Date: 2026-04-22_

## Scope

This document compares BLUSWAN (current repository) with Qwen Code (`QwenLM/qwen-code`) at the product/workflow level and identifies integration-ready enhancements.

## What BLUSWAN already does well

BLUSWAN already has significant strengths:

- Browser-first UX with no backend requirement.
- Reliability pipeline (`plan -> execute -> verify -> rollback`) and critique/quality gates.
- Multi-model orchestration with role routing and fallback/ensemble/cost-aware strategies.
- Built-in RAG, repository indexing, package-docs injection, TDD loop, and auto-debug loop.
- Tool ecosystem including GitHub PR creation and command execution.

These are competitive differentiators and should be preserved.

## Where BLUSWAN currently falls short vs Qwen Code

### 1) Protocol support model (native adapters)

- **Qwen Code** explicitly supports multiple native protocols (OpenAI-compatible, Anthropic, Google GenAI) and provider-specific auth/config pathways.
- **BLUSWAN** currently frames provider support around OpenAI-compatible endpoints.

**Impact:** Limits out-of-the-box support for protocol-specific features and richer auth/runtime options.

### 2) Terminal UX maturity

- **Qwen Code** emphasizes a rich terminal interaction model (session commands, keyboard shortcuts, terminal-native workflows).
- **BLUSWAN** includes a CLI runner, but command surface and interaction ergonomics are comparatively minimal.

**Impact:** Lower developer throughput for terminal-first users and less parity with established CLI agent workflows.

### 3) IDE integration surface

- **Qwen Code** documents editor integrations (VS Code, Zed, JetBrains).
- **BLUSWAN** documentation is browser-SPA-centric and does not currently present first-class IDE integrations.

**Impact:** Higher context-switch cost for users who primarily code in IDEs.

### 4) Automation packaging (headless + CI workflows)

- **Qwen Code** presents headless mode as a first-class usage path for scripts/CI.
- **BLUSWAN** has a CLI with `run/plan/replay/traces`, but CI-oriented guidance and hardened non-interactive workflows are not yet at the same maturity level.

**Impact:** Harder adoption for teams that want deterministic agent steps in CI/CD.

### 5) SDK/platform extensibility posture

- **Qwen Code** advertises a TypeScript SDK path.
- **BLUSWAN** has strong internal services but lacks a public, documented SDK contract for embedding BLUSWAN as a component in other tools.

**Impact:** Fewer integration opportunities for ecosystem builders.

### 6) Config standardization for team portability

- **Qwen Code** has a clear global/project `settings.json` model and documented override behavior.
- **BLUSWAN** uses UI + localStorage/Firebase, plus a CLI config file convention, but does not expose a unified, repo-portable, policy-driven config spec.

**Impact:** Team onboarding and reproducibility are weaker than file-based declarative config workflows.

### 7) Benchmark transparency

- **Qwen Code** surfaces benchmark positioning directly in project docs.
- **BLUSWAN** has benchmarking scripts, but public benchmark narratives and comparable scorecards are not prominently documented.

**Impact:** Harder for adopters to assess expected quality/cost/latency before rollout.

## Enhancement backlog (integration-ready)

## P0 (highest leverage)

1. **Add native protocol adapter layer**
   - Add first-class adapters for Anthropic and Gemini (not only OpenAI-compatible shim).
   - Keep OpenAI-compatible route as fallback.
   - Expose adapter capability metadata so orchestration can route by feature support.

2. **Formalize a portable config spec**
   - Introduce `.bluswan/settings.json` (project) + `~/.bluswan/settings.json` (user) merge order.
   - Support env-var indirection for secrets and policy blocks for approvals/tools.
   - Keep UI as a writer/editor over the same canonical schema.

3. **Harden headless/CI mode**
   - Add deterministic flags (`--json`, `--max-turns`, `--timeout`, `--fail-on-quality-gate`).
   - Add stable machine-readable event schema for CI parsing.
   - Add examples for GitHub Actions and pre-merge checks.

## P1

4. **IDE bridge integrations**
   - Start with VS Code extension shim around existing CLI/service layer.
   - Add editor-side commands: ask agent, edit selection, generate tests, explain diagnostics.
   - Optionally add JetBrains and Zed adapters once protocol is stable.

5. **CLI experience upgrades**
   - Add interactive slash commands (`/help`, `/model`, `/tools`, `/approve`) and shell-like history controls.
   - Add session compression/summarization and resumable session IDs.

6. **Publish a BLUSWAN SDK package**
   - Expose agent loop orchestration APIs and tool contract registry.
   - Provide embedding examples for custom frontends and automation services.

## P2

7. **Public benchmark dashboard**
   - Promote nightly benchmark script outputs to versioned docs.
   - Track quality, latency, and token cost per model/provider.

8. **Enterprise auth/identity options**
   - Add optional SSO/OIDC-compatible auth gateway mode for team deployments.

## Suggested implementation sequence

1. Protocol adapters + config spec (unlocks reliability and provider parity).
2. CI/headless hardening (immediate enterprise utility).
3. IDE bridge + CLI UX upgrades (adoption and daily usability).
4. SDK + benchmark transparency (ecosystem and trust).

## References

- BLUSWAN repository README and CLI implementation.
- Qwen Code GitHub README: https://github.com/QwenLM/qwen-code
- Qwen Code raw README: https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md
