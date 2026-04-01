# LOGIK — Claude Code Project Instructions

## Repository
- **GitHub**: `zspec-oos/logik`
- **Local working directory**: `/home/user/logik`
- **Active development branch**: `claude/model-orchestration-engine-ohzd4`

---

## Workflow by Context

### Local folder attached

1. Present a plan for the changes
2. Wait for the user to say **"apply"** (or equivalent confirmation)
3. Write the changes to disk using `Edit` / `Write`
4. Done — no git, no commit, no push

Never touch git in local folder context unless explicitly instructed.
Plan mode is already the default for local folder — no difference.

---

### GitHub repo only (no local folder)

**Normal mode:**
1. Make the edits
2. Commit and push to the feature branch
3. Done — user handles merge and branch deletion manually on GitHub

**Plan mode:**
1. Present a plan for the changes
2. Wait for the user to confirm
3. Make the edits, commit, and push to the feature branch
4. Done — user handles merge and branch deletion manually on GitHub

No PR creation. No auto-merge. No branch cleanup.

---

## Git Rules

- All commits go to the active feature branch (see top of this file)
- Push with: `git push -u origin <branch-name>`
- Retry push up to 4 times on network failure (backoff: 2s, 4s, 8s, 16s)
- Never force-push, never skip hooks, never push directly to `main` or `master`

---

## Capability Map

| Capability | Local (git + fs tools) | GitHub (MCP tools) |
|---|---|---|
| Read files | Read, Glob, Grep | `mcp__github__get_file_contents`, `mcp__github__search_code` |
| Edit / write files | Edit, Write (after user confirms "apply") | `mcp__github__push_files` (commit + push) |
| Branches | N/A in local context | `mcp__github__list_branches`, `mcp__github__create_branch` |
| History | `git log` | `mcp__github__list_commits` |
| Issues | N/A | `mcp__github__issue_read`, `mcp__github__issue_write` |
| Pull requests | Never auto-create | Never auto-create — user merges manually |

---

## Project Context

LOGIK is an AI-powered developer assistant built as a React SPA with a Node.js service layer. Key areas:

- `src/services/` — agent loop, orchestration, memory graph, trace store, enhancers
- `src/components/logik/` — UI components (activity feed, diff viewer, task lanes, code pane)
- `src/core/hooks/` — React hooks for agent session state
- `src/cli/` — headless CLI (`logik-cli.mjs`)
- `tests/` — benchmark and unit tests

See `README.md` for setup. See `docs/` for architecture details.
