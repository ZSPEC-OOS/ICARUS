# Bluswan vs ChatGPT Codex Capability Alignment

## Scope
This assessment compares Bluswan's baseline capabilities against ChatGPT Codex-style coding-agent workflows, then documents concrete upgrades made in this change set.

## Baseline capability comparison (before enhancements)

### Areas where Bluswan was already strong
- **Modular tool architecture** via built-in registry + user-installable tools.
- **Agentic loop with tool calls** (read/write/edit/search/grep/run/lint/PR) and loop detection.
- **Repository indexing (ShadowContext)** with conventions detection and import graph extraction.
- **Provider flexibility** (Anthropic/OpenAI-compatible endpoints and several presets).

### Key weaknesses relative to Codex
1. **No dedicated architecture-analysis tool** exposed to the model.
   - ShadowContext had rich metadata, but the agent could not call one tool to synthesize it.
2. **Redundant repeated reads/search calls** in long runs.
   - The loop re-executed identical read/search operations, increasing latency and token churn.
3. **Limited first-step strategic guidance in prompt workflow**.
   - System workflow encouraged grep/search/read, but not a fast top-down architectural pass.
4. **Capability visibility gap**.
   - The high-value repo-map and dependency-centrality signals were mostly implicit.

## Technical improvements implemented

### 1) New modular analysis tool: `analyze-codebase`
- Added a first-class tool module that returns:
  - index readiness + indexed file count
  - detected project conventions
  - top dependency hubs from import in-degree
  - compact repository map
  - recommendations for planning code changes
- Integrated into built-in tool registry.

### 2) Agent tool exposure: `analyze_codebase`
- Added `analyze_codebase` schema to agent tool list so the autonomous loop can call it directly.
- Updated system prompt guidance to recommend starting analysis with `analyze_codebase`.

### 3) Executor support for architecture analysis
- Implemented `analyze_codebase` execution route in `agentExecutor` that formats a concise architecture report from ShadowContext.

### 4) Performance improvement: read/search result caching in the loop
- Added per-session cache for deterministic analysis/read tools:
  - `analyze_codebase`, `read_file`, `read_many_files`, `list_directory`, `search_files`, `grep`
- Automatically invalidates cache after any filesystem mutation (`write_file`, `edit_file`, `delete_file`, `revert_file`).
- Reduces duplicate tool latency and avoids repetitive context payloads.

## Post-enhancement alignment assessment

### Improved parity with Codex-style strengths
- **Higher-level repo understanding**: now available through one explicit tool call.
- **Faster iterative reasoning**: repeated exploratory calls are cached.
- **Better planning ergonomics**: workflow now nudges architecture-first analysis before edits.
- **Preserved identity constraints**:
  - UI layout/design unchanged.
  - Modular tool architecture retained and extended via the same patterns.

### Remaining gaps (future work)
- Multi-agent task decomposition/execution.
- Native semantic code index (AST + symbol references) beyond regex/surface imports.
- Deterministic patch planning and patch validation simulation before writes.
- Built-in benchmark harness for latency/success comparisons against Codex tasks.
