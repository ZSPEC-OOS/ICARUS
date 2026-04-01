# LOGIK — Claude Code Project Instructions

## Repository
- **GitHub**: `zspec-oos/logik`
- **Local working directory**: `/home/user/logik`
- **Active development branch**: `claude/model-orchestration-engine-ohzd4`

---

## Workflow by Context

### Local folder attached

1. Make all file edits locally using `Edit` / `Write` tools
2. At the end of the request, **always ask**:
   > "Would you like me to push/apply these edits?"
3. If the user says **yes** — run the full apply sequence:
   - `git add` the changed files
   - `git commit` with a descriptive message
   - `git push -u origin <branch>`
   - Create a PR on GitHub
   - Once merged, delete the feature branch
4. If the user says **no** — leave the edits on disk, do nothing else

Never commit, push, or create a PR automatically in local folder context.

---

### GitHub repo attached (no local folder)

Run the full flow automatically after completing edits — no confirmation prompt needed:

1. Push changes to the feature branch via `mcp__github__push_files`
2. Create a pull request
3. After merge, delete the branch

This mirrors the standard Claude Code GitHub workflow exactly.

---

## Pull Request Rules

- **Local folder**: PR is created only after the user confirms the push/apply prompt
- **GitHub repo**: PR is created automatically as part of the post-edit flow
- **Never** create a PR without first pushing/committing the changes
- PR title should be concise (under 70 chars); details go in the body

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
| Edit / write files | Edit, Write (local only — no auto-push) | `mcp__github__create_or_update_file` (immediate remote commit) |
| Commit + push | `git commit` + `git push` | `mcp__github__push_files` |
| Branches | `git branch` | `mcp__github__list_branches`, `mcp__github__create_branch` |
| History | `git log` | `mcp__github__list_commits` |
| Issues | N/A | `mcp__github__issue_read`, `mcp__github__issue_write` |
| Pull requests | via `gh` after push | `mcp__github__create_pull_request`, `mcp__github__merge_pull_request` |

**Default**: always prefer local tools. GitHub MCP file-write tools only when no local folder is attached.

---

## Project Context

LOGIK is an AI-powered developer assistant built as a React SPA with a Node.js service layer. Key areas:

- `src/services/` — agent loop, orchestration, memory graph, trace store, enhancers
- `src/components/logik/` — UI components (activity feed, diff viewer, task lanes, code pane)
- `src/core/hooks/` — React hooks for agent session state
- `src/cli/` — headless CLI (`logik-cli.mjs`)
- `tests/` — benchmark and unit tests

See `README.md` for setup. See `docs/` for architecture details.
