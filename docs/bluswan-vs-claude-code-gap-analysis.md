# BLUSWAN Capability Gaps vs Claude Code (as of 2026-04-22)

This note compares BLUSWAN's current repository capabilities to publicly documented Claude Code capabilities.

## BLUSWAN capabilities confirmed in this repo

- Browser-first coding agent with autonomous plan → execute → verify workflow.
- Built-in tool registry plus localStorage-installed custom tools.
- Multi-model routing/fallback/ensemble and quality gates.
- File editing, shell command, web fetch/search, and GitHub PR tools.
- Optional per-tool auto-lint/typecheck/test hooks.

## Gaps relative to Claude Code

1. **No MCP server ecosystem integration (major gap).**
   - BLUSWAN provides native built-in tools, but there is no MCP protocol layer, MCP server discovery, or MCP tool transport in the codebase.

2. **Partial Skills support (bootstrap only).**
   - BLUSWAN now includes `discover_skills` for indexed `SKILL.md` discovery and basic metadata extraction.
   - Still missing: full skill execution policy, strict scope inheritance rules, and native slash-command invocation ergonomics.

3. **Partial subagent support (runtime spawn, limited authoring model).**
   - BLUSWAN includes a `spawn_agent` capability and read-only/write tool gating for spawned sessions.
   - Still missing: declarative repo-level subagent definitions (`.claude/agents`-style), reusable subagent catalogs, and richer role-specific policy controls.

4. **No plugin packaging/marketplace model.**
   - BLUSWAN can install tool source code locally, but lacks installable plugin bundles that package skills/hooks/subagents/MCP servers and namespacing.

5. **Limited hook model compared with Claude Code lifecycle hooks.**
   - BLUSWAN offers post-write style auto-lint/typecheck/test toggles.
   - It does not expose broad lifecycle hooks (pre-tool, agent-stop, prompt-submit, async/http hooks, etc.) as a configurable framework.

6. **No explicit multi-session "agent teams" orchestration.**
   - BLUSWAN does have strategy routing/ensembles, but no first-class coordination of independent long-running agent sessions for parallel research/review roles.

7. **No documented slash-command layer comparable to Claude Code command/skills UX.**
   - BLUSWAN uses UI settings and tools, not a dedicated slash command interface for workflow primitives.

8. **No repository-level `.claude/*` convention compatibility surface.**
   - BLUSWAN doesn't implement the Claude Code config family (`.claude/skills`, `.claude/agents`, etc.), which limits portability of Claude Code workflows.

## Areas where BLUSWAN is already competitive

- Strong browser-native UX and no-backend operation mode.
- Multi-model orchestration and reliability-gated execution loop.
- Built-in RAG/repository indexing and architecture analysis tooling.
- GitHub PR flow and local shell bridge in development mode.

## Priority roadmap (suggested)

1. Add **MCP client runtime + tool adapter**.
2. Add **Skill runtime** (`SKILL.md` parser, registry, invocation policy).
3. Add **Subagent definitions** with isolated context/tool scopes.
4. Add **plugin bundle format** + signed/verified install sources.
5. Expand hooks into a **full lifecycle event bus**.
6. Add **task-level parallel agent teams** and result arbitration.
