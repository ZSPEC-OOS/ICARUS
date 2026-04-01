# LOGIK — Claude Code Project Instructions

## Repository
- **GitHub**: `zspec-oos/logik`
- **Local working directory**: `/home/user/logik`
- **Active development branch**: `claude/model-orchestration-engine-ohzd4`

---

## Capabilities — Local Folder vs GitHub Repo

The two contexts have the same logical capabilities but different commit semantics:

### Local folder (primary — use by default)

- File edits (`Edit`, `Write`) modify files **on disk only** — nothing is committed or pushed until explicitly requested.
- Changes accumulate locally; `git commit` + `git push` are separate, deliberate steps.
- Automatic file edits are allowed freely; automatic git pushes are not.

### GitHub MCP (for PR/issue management only)

- `mcp__github__create_or_update_file` and `mcp__github__push_files` **commit directly to GitHub** — there is no staging area; every edit is an immediate push to the remote branch.
- Because of this, only use GitHub MCP file-write tools when there is no local branch, or when the user explicitly asks to edit via GitHub directly.
- Automatic file edits via MCP are **not** allowed without explicit user instruction, precisely because they push immediately.

### Capability map

| Capability | Local (git + fs tools) | GitHub (MCP tools) |
|---|---|---|
| Read files / browse code | Read, Glob, Grep | `mcp__github__get_file_contents`, `mcp__github__search_code` |
| Edit / write files | Edit, Write — **local only, no auto-push** | `mcp__github__create_or_update_file` — **immediate remote commit** |
| Commit + push | `git commit` then `git push` (explicit) | `mcp__github__push_files` (always pushes) |
| View branches | `git branch` | `mcp__github__list_branches` |
| View commits / history | `git log` | `mcp__github__list_commits` |
| Issues | N/A | `mcp__github__issue_read`, `mcp__github__issue_write` |
| Pull requests | N/A | `mcp__github__pull_request_read`, `mcp__github__create_pull_request` |

**Default**: always prefer local tools. GitHub MCP file-write tools are a last resort.

---

## Pull Request Rules

**NEVER create a pull request automatically.**

Only create a PR when:
1. The user **explicitly asks** ("create a PR", "open a pull request", "make a PR")

In all other cases: commit and push to the branch, then stop. Do not offer to create a PR unprompted.

---

## Git Workflow

- All commits go to the active feature branch (see top of this file)
- Push with: `git push -u origin <branch-name>`
- Retry push up to 4 times on network failure (backoff: 2s, 4s, 8s, 16s)
- Never force-push, never skip hooks, never push directly to `main` or `master`

---

## Project Context

LOGIK is an AI-powered developer assistant built as a React SPA with a Node.js service layer. Key areas:

- `src/services/` — agent loop, orchestration, memory graph, trace store, enhancers
- `src/components/logik/` — UI components (activity feed, diff viewer, task lanes, code pane)
- `src/core/hooks/` — React hooks for agent session state
- `src/cli/` — headless CLI (`logik-cli.mjs`)
- `tests/` — benchmark and unit tests

See `README.md` for setup. See `docs/` for architecture details.
