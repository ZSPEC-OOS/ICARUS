// ── agentTools — tool schemas for the agentic loop ───────────────────────────
// Defined in Anthropic format (input_schema).
// callWithTools() in aiService.js converts to OpenAI format automatically.

import { BLUSWAN_MD_CAP } from '../config/constants.js'
import { getInputSchema, schemaVersion } from '../tools/contracts.js'
import { promptRegistry } from './promptRegistry.js'

export const AGENT_TOOLS = [
  {
    name: 'analyze_codebase',
    description: 'Generate an architecture-level summary from the indexed repository: conventions, dependency hotspots, and a compact repo map.',
    input_schema: {
      type: 'object',
      properties: {
        top_hubs:  { type: 'number', description: 'How many top dependency hubs to return (default 10, max 20)' },
        max_chars: { type: 'number', description: 'Character budget for the repo map section (default 3000)' },
      },
      required: [],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file from the connected GitHub repository. For large files use start_line/end_line to read only the relevant section.',
    input_schema: {
      type: 'object',
      properties: {
        path:       { type: 'string', description: 'File path relative to repo root, e.g. src/App.jsx' },
        start_line: { type: 'number', description: 'First line to return (1-indexed, optional)'         },
        end_line:   { type: 'number', description: 'Last line to return (inclusive, optional)'           },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing file in the repository.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path relative to repo root' },
        content: { type: 'string', description: 'Full file content to write'       },
        message: { type: 'string', description: 'Commit message (optional)'        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Surgically replace an exact string in a file. Preferred over write_file for small changes.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path relative to repo root'          },
        old_str: { type: 'string', description: 'Exact text to find and replace'           },
        new_str: { type: 'string', description: 'Replacement text'                         },
        message: { type: 'string', description: 'Commit message (optional)'                },
      },
      required: ['path', 'old_str', 'new_str'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and subdirectories inside a directory of the repository.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path, or empty string for repo root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search the indexed repository for files relevant to a query. Returns scored file paths.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms, e.g. "authentication hook"' },
        limit: { type: 'number', description: 'Max results to return (default 8)'        },
      },
      required: ['query'],
    },
  },
  {
    name: 'run_command',
    description: 'Execute a shell command via the local exec bridge (npm, git, eslint, tsc, etc.). Only available when the Vite dev server is running.',
    input_schema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Full command string, e.g. "npm test" or "git status"' },
        cwd: { type: 'string', description: 'Working directory (optional, defaults to project root)' },
      },
      required: ['cmd'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the repository. Use with caution — this is irreversible without a git revert.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path relative to repo root' },
        message: { type: 'string', description: 'Commit message (optional)'       },
      },
      required: ['path'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a GitHub pull request from the current working branch to the base branch.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR title'                       },
        body:  { type: 'string', description: 'PR description in Markdown'     },
        head:  { type: 'string', description: 'Source branch name'             },
        base:  { type: 'string', description: 'Target branch (e.g. "main")'   },
      },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'read_source_file',
    description: 'Read a file from the SOURCE (secondary) repository — use this to explore and learn from the source repo. Only available when a source repo is connected.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to source repo root, e.g. src/services/agentLoop.js' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_source_directory',
    description: 'List files and subdirectories in a directory of the SOURCE (secondary) repository. Use this to explore the source repo structure.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path in source repo, or empty string for root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern across the indexed repository. Supports *, **, ?, and {a,b} brace expansion. Returns sorted file paths. Faster than list_directory for targeted file discovery.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. src/**/*.jsx or **/*.{ts,tsx}' },
        path:    { type: 'string', description: 'Optional base directory to restrict results, e.g. src/components' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Regex search across indexed file contents. Returns matching lines with file paths and line numbers. Covers the indexed portion of the repo (~800 files). Much faster than reading files one by one.',
    input_schema: {
      type: 'object',
      properties: {
        pattern:     { type: 'string',  description: 'Regular expression pattern to search for'                       },
        path:        { type: 'string',  description: 'Restrict to files whose path starts with this prefix (optional)'},
        ignore_case: { type: 'boolean', description: 'Case-insensitive search (default false)'                        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_many_files',
    description: 'Read multiple files in a single call — more efficient than separate read_file calls. Returns all contents concatenated with file headers.',
    input_schema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Array of file paths relative to repo root (max 20)' },
      },
      required: ['paths'],
    },
  },

  {
    name: 'hybrid_search',
    description: 'Run hybrid lexical + vector retrieval over the indexed repo. Returns scored chunks with metadata.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query describing required context' },
        limit: { type: 'number', description: 'Maximum number of chunks (default 8, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'retrieve_context',
    description: 'Retrieve and rerank context for prompt grounding. Use before complex implementation decisions.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Grounding query, usually the task goal' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and return its text content. Best for reading documentation, API specs, or GitHub raw files. When the exec bridge is active the response is automatically converted from HTML to plain text.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch (https://…)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'update_memory',
    description: 'Append a persistent note to BLUSWAN.md in the repository root. Use this to record important decisions, conventions, or facts that should survive across agent sessions.',
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Note to append (Markdown format, one concise paragraph)' },
      },
      required: ['note'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for up-to-date information, documentation, error messages, or research. Returns a summary and top results with URLs. Requires a Tavily API key in Settings → Web Search.',
    input_schema: {
      type: 'object',
      properties: {
        query:          { type: 'string', description: 'Search query'                                                    },
        max_results:    { type: 'number', description: 'Max results to return (default 5, max 10)'                       },
        include_domains:{ type: 'array',  items: { type: 'string' }, description: 'Restrict results to these domains'    },
      },
      required: ['query'],
    },
  },
  {
    name: 'lint_file',
    description: 'Run ESLint on a JS/TS file after writing or editing it. Returns errors with line numbers, or confirms no errors. Requires the exec bridge (npm run dev). Mirrors Aider\'s auto-lint behaviour.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to lint (.js/.jsx/.ts/.tsx only)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'todo',
    description: 'Track your own tasks during complex multi-step operations. Call with action="add" to register a pending task, "in_progress" when starting it, and "done" when finished. Helps you stay organised and keeps the user informed of progress.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'in_progress', 'done'], description: 'Task lifecycle action'  },
        task:   { type: 'string', description: 'Short description of the task (one line)'                     },
      },
      required: ['action', 'task'],
    },
  },
  {
    name: 'revert_file',
    description: 'Restore a file to its state before the last N commits that touched it. Use this to undo a mistake or a bad edit. commits_back=1 (default) restores to the state just before the most recent commit to this file.',
    input_schema: {
      type: 'object',
      properties: {
        path:         { type: 'string', description: 'File path relative to repo root'                              },
        commits_back: { type: 'number', description: 'How many commits back to restore (default 1, max 10)'         },
        message:      { type: 'string', description: 'Commit message for the revert (optional)'                     },
      },
      required: ['path'],
    },
  },
  {
    name: 'analyze_stacktrace',
    description: 'Parse a JavaScript/TypeScript stacktrace into structured frames and return a concise debugging hint.',
    input_schema: {
      type: 'object',
      properties: {
        stacktrace: { type: 'string', description: 'Raw stacktrace text including error header and frames' },
        max_frames: { type: 'number', description: 'Maximum frames to return (default 8, max 25)' },
      },
      required: ['stacktrace'],
    },
  },
  {
    name: 'find_tech_debt',
    description: 'Scan indexed code for debt markers (TODO/FIXME/HACK/BUG) and summarize hotspots.',
    input_schema: {
      type: 'object',
      properties: {
        markers: { type: 'array', items: { type: 'string' }, description: 'Marker tokens to scan for (default TODO/FIXME/HACK/BUG)' },
        path: { type: 'string', description: 'Optional path prefix filter, e.g. src/services' },
        limit: { type: 'number', description: 'Max match rows to return (default 50, max 200)' },
      },
      required: [],
    },
  },
  {
    name: 'check_url_health',
    description: 'Probe a URL and return status code, latency, redirect info, and timeout/network diagnostics.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to probe (https://...)' },
        timeout_ms: { type: 'number', description: 'Request timeout in milliseconds (default 8000, min 500, max 30000)' },
        method: { type: 'string', description: 'HTTP method to use (default GET)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'json_repair',
    description: 'Attempt lightweight repair of malformed JSON (single quotes, trailing commas) and validate output.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Raw JSON-like text to validate/repair' },
      },
      required: ['text'],
    },
  },
  {
    name: 'token_io_optimizer',
    description: 'Generate a token-optimization plan for long requests. Prioritizes reducing unnecessary token spend without degrading code quality.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'User request or task summary to optimize for' },
        expected_output_size: { type: 'string', enum: ['small', 'medium', 'large', 'huge'], description: 'Expected response size (default medium)' },
        mode: { type: 'string', enum: ['off', 'adaptive', 'aggressive'], description: 'Optimization mode (default adaptive)' },
      },
      required: ['task'],
    },
  },
  {
    name: 'spawn_agent',
    description: "Spawn a focused sub-agent to handle a specific task in isolation. By default the sub-agent is read-only (research, analysis, investigation). Set allow_writes: true to give the sub-agent full write access so it can implement a parallel workstream on the same branch. Sub-agents cannot spawn further sub-agents. Returns the sub-agent's full output plus a list of files changed (if any).",
    input_schema: {
      type: 'object',
      properties: {
        task:         { type: 'string',  description: 'Clear, specific task for the sub-agent. Be precise — it has no context from the current conversation.' },
        description:  { type: 'string',  description: 'Short label shown in the activity log (e.g. "Write unit tests for auth module")' },
        allow_writes: { type: 'boolean', description: 'If true, sub-agent gets full write access (write_file, edit_file, etc.) on the same branch. Default: false (read-only).' },
      },
      required: ['task'],
    },
  },

  // ── PR workflow ──────────────────────────────────────────────────────────────
  {
    name: 'generate_pr_description',
    description: 'Generate a complete pull request title and body by comparing the current branch against a base branch. Analyses commit history, changed files, and line diffs to produce a structured PR description with a summary, change areas, and a test plan. Optionally creates the PR immediately.',
    input_schema: {
      type: 'object',
      properties: {
        base_branch: {
          type: 'string',
          description: 'Branch to compare against (default: main)',
        },
        head_branch: {
          type: 'string',
          description: 'Branch to describe (default: current working branch)',
        },
        create: {
          type: 'boolean',
          description: 'If true, immediately create the PR after generating the description (default: false)',
        },
      },
      required: [],
    },
  },

  // ── Library / package management ────────────────────────────────────────────
  {
    name: 'install_package',
    description: 'Install one or more npm or pip packages into the project using the exec bridge, then automatically fetch and return each package\'s README / API summary so you know how to use it before writing code. Requires the exec bridge (npm run dev).',
    input_schema: {
      type: 'object',
      properties: {
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Package names to install, e.g. ["axios", "zod"] or ["@tanstack/react-query"]',
        },
        manager: {
          type: 'string',
          enum: ['npm', 'yarn', 'pnpm', 'pip'],
          description: 'Package manager to use (default: npm)',
        },
        dev: {
          type: 'boolean',
          description: 'Install as a dev dependency — npm --save-dev / yarn --dev / pnpm --save-dev (default: false)',
        },
      },
      required: ['packages'],
    },
  },

  // ── Phase 5: Environment feedback ───────────────────────────────────────────
  {
    name: 'watch_process',
    description: 'Check the health of a running local process: HTTP-probes a port, lists what is listening on it, and optionally checks for a named process by name. Use this after code changes to verify the dev server or test watcher is still running correctly. Requires the exec bridge (npm run dev).',
    input_schema: {
      type: 'object',
      properties: {
        port:         { type: 'number', description: 'Port to probe (default: 5173 for Vite)' },
        process_name: { type: 'string', description: 'Optional process name to look up with pgrep (e.g. "vite", "node", "jest")' },
        lines:        { type: 'number', description: 'Number of log lines to return (default 30, max 200)' },
      },
      required: [],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a headless-browser screenshot of the running dev server (or any URL) using Playwright CLI. Saves the screenshot as a PNG to the repository under screenshots/ and returns the GitHub URL plus any JavaScript console errors detected. Falls back to returning the raw HTML if Playwright is not installed. Requires the exec bridge (npm run dev).',
    input_schema: {
      type: 'object',
      properties: {
        url:  { type: 'string', description: 'Full URL to screenshot (default: http://localhost:<port>)' },
        port: { type: 'number', description: 'Dev server port (default: 5173). Used to build the default URL.' },
      },
      required: [],
    },
  },

  // ── Phase 3: Repository intelligence ────────────────────────────────────────
  {
    name: 'git_log',
    description: 'Fetch commit history for a branch or a specific file. Returns commits with SHA, short message, author, and date. Use this to understand when a bug was introduced, trace the evolution of a file, or find the commit that last changed a function.',
    input_schema: {
      type: 'object',
      properties: {
        path:   { type: 'string', description: 'Limit log to commits that touched this file path (optional)' },
        branch: { type: 'string', description: 'Branch to query (default: current working branch)'           },
        limit:  { type: 'number', description: 'Max commits to return (default 10, max 50)'                  },
      },
      required: [],
    },
  },
  {
    name: 'check_ci_status',
    description: 'Check the latest GitHub Actions CI status for a branch. Returns the status (queued / in_progress / completed) and conclusion (success / failure / cancelled) of recent workflow runs. Use this to verify CI passes before considering a task done, or to diagnose a failing build.',
    input_schema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch to check (default: current working branch)' },
      },
      required: [],
    },
  },
  {
    name: 'create_github_issue',
    description: 'Open a GitHub issue in the repository. Use this to log a bug, track a future improvement, or flag a discovered problem without derailing the current task. The issue is created immediately and the URL is returned.',
    input_schema: {
      type: 'object',
      properties: {
        title:  { type: 'string', description: 'Issue title (required)'                                },
        body:   { type: 'string', description: 'Issue body in Markdown (optional)'                    },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply (optional, labels must already exist in the repo)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'resolve_merge_conflict',
    description: 'Resolve git merge conflict markers (<<<<<<<, =======, >>>>>>>) in a file. Choose "ours" to keep the HEAD version, "theirs" to keep the incoming branch version, or "manual" to supply the fully resolved content yourself. Writes the clean file back and returns how many conflicts were resolved.',
    input_schema: {
      type: 'object',
      properties: {
        path:           { type: 'string', description: 'File path containing conflict markers'                                                              },
        resolution:     { type: 'string', enum: ['ours', 'theirs', 'manual'], description: '"ours" = keep HEAD, "theirs" = keep incoming, "manual" = use manual_content' },
        manual_content: { type: 'string', description: 'Fully resolved file content — required when resolution is "manual"'                                 },
        message:        { type: 'string', description: 'Commit message (optional)'                                                                          },
      },
      required: ['path', 'resolution'],
    },
  },

  // ── Phase 2: Precision editing ───────────────────────────────────────────────
  {
    name: 'multi_edit_file',
    description: 'Apply multiple find-and-replace edits to a single file in one atomic commit. Reads the file once, applies all edits sequentially, then writes back. Preferred over multiple edit_file calls when changing several non-contiguous sections of the same file, since it avoids re-read overhead and eliminates the risk of edit collisions.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path relative to repo root' },
        edits:   {
          type: 'array',
          description: 'Ordered list of edits to apply. Applied sequentially — each edit operates on the result of the previous one.',
          items: {
            type: 'object',
            properties: {
              old_str: { type: 'string', description: 'Exact text to find (must be unique in the file at the time this edit runs)' },
              new_str: { type: 'string', description: 'Replacement text' },
            },
            required: ['old_str', 'new_str'],
          },
        },
        message: { type: 'string', description: 'Commit message (optional)' },
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'search_replace_many',
    description: 'Find and replace a pattern across multiple files in the repository. Use this for bulk refactors: renaming a symbol, changing an API call, migrating an import path. Returns a summary of changed files. Pass dry_run: true to preview matches without writing.',
    input_schema: {
      type: 'object',
      properties: {
        pattern:     { type: 'string',  description: 'Search pattern — treated as a regex by default. Escape special chars or set literal: true for plain string search.' },
        replacement: { type: 'string',  description: 'Replacement text. Regex capture groups ($1, $2…) are supported unless literal: true.' },
        path_glob:   { type: 'string',  description: 'Optional glob pattern to restrict which files are searched, e.g. "src/**/*.ts" or "**/*.css"' },
        literal:     { type: 'boolean', description: 'If true, treat pattern as a literal string (no regex). Default: false.' },
        dry_run:     { type: 'boolean', description: 'If true, return the list of files that would be changed without modifying anything. Default: false.' },
        message:     { type: 'string',  description: 'Commit message prefix used for each changed file (optional)' },
      },
      required: ['pattern', 'replacement'],
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file within the repository: copies content to the new path, deletes the old path, and returns a list of files that likely import the old path so you can update them with search_replace_many.',
    input_schema: {
      type: 'object',
      properties: {
        from:           { type: 'string',  description: 'Current file path relative to repo root, e.g. src/utils/old.js' },
        to:             { type: 'string',  description: 'New file path relative to repo root, e.g. src/utils/new.js'     },
        update_imports: { type: 'boolean', description: 'If true (default), scan the codebase and list files that reference the old path so you can update them.' },
        message:        { type: 'string',  description: 'Commit message (optional)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'apply_patch',
    description: 'Apply a unified diff patch to a file. Parses standard `@@ -l,s +l,s @@` hunk headers and applies context-matched additions and deletions. Useful when reasoning in diff form or applying an externally generated patch. Falls back gracefully: on hunk mismatch it reports the failing hunk with context so you can retry with edit_file.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path relative to repo root' },
        patch:   { type: 'string', description: 'Unified diff text (the @@ hunks, with optional --- +++ header)' },
        message: { type: 'string', description: 'Commit message (optional)' },
      },
      required: ['path', 'patch'],
    },
  },

  // ── Phase 1: Self-verification loop ─────────────────────────────────────────
  {
    name: 'get_diff',
    description: 'Show a unified diff of changes between two git refs (branches, tags, or SHAs) in the repository. Defaults to comparing the current working branch against the base branch. Use path to limit the diff to a single file. Essential for reviewing your own changes before creating a PR.',
    input_schema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Base ref to diff from (default: repo default branch, e.g. "main")' },
        head: { type: 'string', description: 'Head ref to diff to (default: current working branch)'             },
        path: { type: 'string', description: 'Limit diff to this file path (optional)'                           },
      },
      required: [],
    },
  },
  {
    name: 'type_check',
    description: 'Run the TypeScript compiler (tsc --noEmit) on the project and return structured type errors with file, line, and message. Pass an optional path to filter results to a specific file. Returns "TypeScript check passed ✓" when there are no errors. Requires the exec bridge (npm run dev).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional file path to filter errors to (e.g. src/services/agentLoop.ts)' },
      },
      required: [],
    },
  },
  {
    name: 'run_tests',
    description: 'Detect the project test runner (Vitest, Jest, or npm test) from package.json and execute the test suite. Returns a structured summary (passed / failed / skipped) plus the raw output tail. Pass path to run only tests in a specific file or directory, and test_pattern to filter by test name. Requires the exec bridge (npm run dev).',
    input_schema: {
      type: 'object',
      properties: {
        path:         { type: 'string', description: 'Test file or directory to run (optional, e.g. tests/unit)' },
        test_pattern: { type: 'string', description: 'Filter tests by name pattern (optional, passed as -t flag)'  },
      },
      required: [],
    },
  },

  // ── Phase 1 enhancements ────────────────────────────────────────────────────
  {
    name: 'find_symbol',
    description: 'Search the code intelligence index for a symbol (function, class, or variable) by name. Returns definition locations (file + line + signature) and optionally usages. More precise than grep for navigating to a specific symbol.',
    input_schema: {
      type: 'object',
      properties: {
        name:        { type: 'string',  description: 'Exact or partial symbol name to look up' },
        mode:        { type: 'string',  description: '"definition" (default) | "usages" | "callgraph" | "query" — "query" does a fuzzy substring search across all indexed symbol names' },
        max_depth:   { type: 'number',  description: 'Call graph traversal depth (default 3, max 5). Only used when mode="callgraph"' },
      },
      required: ['name'],
    },
  },
  {
    name: 'find_usages',
    description: 'Find every file and line that references a symbol by name (whole-word match). Faster than grep for symbol-level reference searches. Returns file path, line number, and the matching line of code.',
    input_schema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: 'Symbol name to search for (exact, whole-word)' },
        limit: { type: 'number', description: 'Maximum results to return (default 60)'        },
      },
      required: ['name'],
    },
  },
  {
    name: 'run_tdd_loop',
    description: 'Run a closed Test-Driven Development loop: (1) optionally write a failing-test scaffold, (2) execute the test command, (3) parse pass/fail, (4) append a fix hint to the implementation file, (5) repeat until green or maxIterations. Returns the final status (green/red/no_output) and per-iteration metrics. Requires the exec bridge.',
    input_schema: {
      type: 'object',
      properties: {
        spec:            { type: 'string', description: 'Feature or behaviour description driving the tests' },
        test_cmd:        { type: 'string', description: 'Shell command to run tests, e.g. "npm test" or "pytest tests/"' },
        test_file_path:  { type: 'string', description: 'Path to generate the test scaffold (optional — skip to use existing tests)' },
        impl_file_path:  { type: 'string', description: 'Path of the implementation file to fix when tests fail (optional)' },
        max_iterations:  { type: 'number', description: `Max run→fix cycles before giving up (default ${5})` },
      },
      required: ['spec', 'test_cmd'],
    },
  },
]

for (const tool of AGENT_TOOLS) {
  tool.input_schema = getInputSchema(tool.name)
  tool.schema_version = schemaVersion()
}

// System prompt injected at the start of every agent session.
// planMode=true  → read-only analysis; no file writes.
// webSearch=true → web_search tool is active (Tavily key configured).
export function buildAgentSystemPrompt(conventions, bluswanMd, repoOwner, repoName, bridgeAvailable, sourceRepoConfig = null, planMode = false, webSearch = false, repoMap = null, sessionId = '') {
  const hasSrc = !!(sourceRepoConfig?.owner && sourceRepoConfig?.repo)
  const srcLabel = hasSrc ? `${sourceRepoConfig.owner}/${sourceRepoConfig.repo}` : null

  // ── Prompt registry: resolve A/B variant for identity line ────────────────
  const identityVariant = promptRegistry.get('agent.identity', sessionId)
  const identityLabel   = identityVariant?.content || 'an autonomous AI coding assistant'

  const lines = [
    planMode
      ? `You are BLUSWAN Agent operating in READ-ONLY PLAN MODE on the GitHub repository ${repoOwner}/${repoName}.`
      : hasSrc
        ? `You are BLUSWAN Agent, ${identityLabel} operating in FUSION MODE.`
        : `You are BLUSWAN Agent, ${identityLabel} operating on the GitHub repository ${repoOwner}/${repoName}.`,
    ``,
    planMode
      ? `READ-ONLY MODE: You may only read files, list directories, and search the codebase. Do NOT write, edit, or delete any files. Your job is to analyse the code and produce a detailed plan or explanation.`
      : null,
    planMode ? `` : null,
    !planMode && hasSrc ? `TARGET repository (read + write): ${repoOwner}/${repoName}` : null,
    !planMode && hasSrc ? `SOURCE repository (read-only):    ${srcLabel} (branch: ${sourceRepoConfig?.branch || 'main'})` : null,
    !planMode && hasSrc ? `` : null,
    planMode
      ? `You have access to analyze_codebase, read_file (with optional start_line/end_line), read_many_files, list_directory, glob, search_files, grep, and lint_file to explore and analyse the codebase.`
      : `You have access to tools that let you analyze_codebase, read files, write files, edit files, search the codebase, grep file contents, lint JS/TS files, run shell commands, and create pull requests.`,
    !planMode && hasSrc ? `You also have read_source_file and list_source_directory to read from the SOURCE repo.` : null,
    webSearch ? `You have web_search (Tavily) and web_fetch to look up documentation, errors, or research.` : `You have web_fetch to read URLs when the exec bridge is active.`,
    `Use glob to find files by name pattern (e.g. src/**/*.jsx) — faster than list_directory for targeted discovery.`,
    `Use grep to search file contents by regex — far faster than opening files one by one.`,
    `Use read_many_files to read several files in one call.`,
    `Use multi_edit_file when making several changes to the same file — one read, one commit, no collision risk.`,
    !planMode ? `Use search_replace_many for bulk renames/refactors across multiple files (symbol rename, import migration, etc.).` : null,
    !planMode ? `Use move_file to rename/relocate a file — it handles copy+delete and surfaces import references to update.` : null,
    !planMode ? `Use apply_patch when you have a unified diff — more expressive than edit_file for multi-hunk changes.` : null,
    `Use lint_file after editing JS/TS files to catch errors before moving on.`,
    !planMode ? `Use type_check to catch TypeScript type errors across the project after making changes.` : null,
    !planMode ? `Use run_tests to verify your changes pass the test suite before finishing.` : null,
    !planMode ? `Use get_diff to review everything you changed on this branch before creating a PR.` : null,
    planMode  ? `Use get_diff to inspect existing branch changes during analysis.` : null,
    `Use git_log to trace commit history for a branch or file — useful for finding when a bug was introduced.`,
    !planMode ? `Use check_ci_status to verify CI passes on your branch before considering a task done.` : null,
    !planMode ? `Use create_github_issue to log discovered bugs or future improvements without interrupting the current task.` : null,
    !planMode ? `Use resolve_merge_conflict to clean up conflict markers (<<<<<<< / ======= / >>>>>>>) in a file.` : null,
    !planMode && bridgeAvailable ? `Use watch_process to verify the dev server is still healthy after code changes (probes the port, checks the process).` : null,
    !planMode && bridgeAvailable ? `Use browser_screenshot to take a visual snapshot of the running app and detect JS console errors — saves PNG to the repo.` : null,
    `Use token_io_optimizer for long/complex requests to reduce unnecessary token spend while preserving implementation quality.`,
    `Use update_memory to append important facts to BLUSWAN.md so they persist across sessions.`,
    `Use the todo tool to track tasks when working on complex multi-step operations.`,
    `Work autonomously — do not ask the user for clarification. Make smart decisions and get the task done.`,
    ``,
    `WORKFLOW:`,
    `1. Use todo(add) to list the steps you plan to take for complex tasks.`,
    planMode
      ? `2. Explore the codebase: start with analyze_codebase, then use grep for symbols/patterns, list_directory for structure, and read_many_files for multiple files at once.`
      : `2. Explore the codebase: grep for patterns, search_files for relevance, list_directory for structure.`,
    !planMode && hasSrc ? `2b. Explore the SOURCE repo using list_source_directory and read_source_file.` : null,
    planMode
      ? `3. Analyse the relevant code and produce a clear, actionable plan or explanation.`
      : `3. Read relevant files before modifying them.`,
    !planMode ? `4. Make changes using edit_file (for small changes) or write_file (for new files or rewrites).` : null,
    !planMode ? `5. ${(promptRegistry.get('agent.verification', sessionId)?.content) || 'VERIFICATION LOOP — run after every set of edits (skip steps that are unavailable):\n   a. lint_file on each changed .js/.jsx/.ts/.tsx file\n   b. type_check to surface TypeScript errors across the project\n   c. run_tests to confirm the test suite passes\n   Fix any errors found before moving on.'}` : null,
    `${planMode ? '4' : '6'}. Mark tasks done with todo(done) and summarise what you found${planMode ? '' : ' / changed'}.`,
    !planMode ? `7. Call get_diff to review the full branch diff, then create the PR.` : null,
    ``,
    `RULES:`,
    !planMode ? `- Always read a file before editing it.` : null,
    !planMode ? `- Prefer edit_file over write_file for modifications to existing files.` : null,
    !planMode ? `- Never truncate code — write complete, production-ready implementations.` : null,
    `- Do not ask the user questions — proceed with best judgment.`,
    !planMode && hasSrc ? `- read_source_file and list_source_directory are READ-ONLY — never try to write to the source repo.` : null,
    !planMode && hasSrc ? `- All writes go to the TARGET repo (${repoOwner}/${repoName}) only.` : null,
    !planMode && !bridgeAvailable ? `- run_command is not available (exec bridge offline).` : null,
    !planMode && bridgeAvailable  ? `- run_command is available — use it to verify your work.` : null,
    planMode ? `- You are in READ-ONLY mode — do NOT call write_file, edit_file, delete_file, or create_pull_request.` : null,
    ``,
    `NARRATION:`,
    (promptRegistry.get('agent.narration', sessionId)?.content) ||
    `As you work, write short natural-language sentences before and after significant actions — what you are about to do and why, what you found, what decision you made. Write like a developer talking to their colleague: direct, specific, and informative.\nKeep it brief (1–2 sentences). Do not restate what the tool call itself already shows. Narrate the thinking, not the mechanics.`,
  ].filter(l => l !== null)

  if (conventions && conventions.framework !== 'unknown') {
    lines.push(``, `PROJECT CONVENTIONS (follow exactly):`)
    lines.push(`  Framework: ${conventions.framework}`)
    lines.push(`  Language: ${conventions.language}`)
    lines.push(`  Naming: ${conventions.namingConvention}`)
    if (conventions.testFramework !== 'unknown') lines.push(`  Tests: ${conventions.testFramework}`)
    if (conventions.srcDir) lines.push(`  Source root: ${conventions.srcDir}/`)
    if (conventions.deps?.length) lines.push(`  Key deps: ${conventions.deps.slice(0, 12).join(', ')}`)
  }

  // Aider-style repo map: compact symbol index ranked by import-graph centrality.
  // Gives the model an overview of what exists without requiring file reads.
  if (repoMap) {
    lines.push(``, `REPOSITORY MAP (${repoMap.split('\n').length} key files, ranked by centrality — read-only reference):`)
    lines.push(repoMap)
    lines.push(`Use grep or read_file to explore any file in detail.`)
  }

  if (bluswanMd) {
    lines.push(``, `PROJECT INSTRUCTIONS (from BLUSWAN.md — follow exactly):`, bluswanMd.slice(0, BLUSWAN_MD_CAP))
  }

  return lines.filter(l => l !== undefined).join('\n')
}
