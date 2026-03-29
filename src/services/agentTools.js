// ── agentTools — tool schemas for the agentic loop ───────────────────────────
// Defined in Anthropic format (input_schema).
// callWithTools() in aiService.js converts to OpenAI format automatically.

import { LOGIK_MD_CAP } from '../config/constants.js'

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
    description: 'Append a persistent note to LOGIK.md in the repository root. Use this to record important decisions, conventions, or facts that should survive across agent sessions.',
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
]

// System prompt injected at the start of every agent session.
// planMode=true  → read-only analysis; no file writes.
// webSearch=true → web_search tool is active (Tavily key configured).
export function buildAgentSystemPrompt(conventions, logikMd, repoOwner, repoName, bridgeAvailable, sourceRepoConfig = null, planMode = false, webSearch = false, repoMap = null) {
  const hasSrc = !!(sourceRepoConfig?.owner && sourceRepoConfig?.repo)
  const srcLabel = hasSrc ? `${sourceRepoConfig.owner}/${sourceRepoConfig.repo}` : null

  const lines = [
    planMode
      ? `You are LOGIK Agent operating in READ-ONLY PLAN MODE on the GitHub repository ${repoOwner}/${repoName}.`
      : hasSrc
        ? `You are LOGIK Agent, an autonomous AI coding assistant operating in FUSION MODE.`
        : `You are LOGIK Agent, an autonomous AI coding assistant operating on the GitHub repository ${repoOwner}/${repoName}.`,
    ``,
    planMode
      ? `READ-ONLY MODE: You may only read files, list directories, and search the codebase. Do NOT write, edit, or delete any files. Your job is to analyse the code and produce a detailed plan or explanation.`
      : null,
    planMode ? `` : null,
    !planMode && hasSrc ? `TARGET repository (read + write): ${repoOwner}/${repoName}` : null,
    !planMode && hasSrc ? `SOURCE repository (read-only):    ${srcLabel} (branch: ${sourceRepoConfig?.branch || 'main'})` : null,
    !planMode && hasSrc ? `` : null,
    planMode
      ? `You have access to analyze_codebase, read_file (with optional start_line/end_line), read_many_files, list_directory, search_files, grep, and lint_file to explore and analyse the codebase.`
      : `You have access to tools that let you analyze_codebase, read files, write files, edit files, search the codebase, grep file contents, lint JS/TS files, run shell commands, and create pull requests.`,
    !planMode && hasSrc ? `You also have read_source_file and list_source_directory to read from the SOURCE repo.` : null,
    webSearch ? `You have web_search (Tavily) and web_fetch to look up documentation, errors, or research.` : `You have web_fetch to read URLs when the exec bridge is active.`,
    `Use grep to search file contents by regex — far faster than opening files one by one.`,
    `Use read_many_files to read several files in one call.`,
    `Use lint_file after editing JS/TS files to catch errors before moving on.`,
    `Use update_memory to append important facts to LOGIK.md so they persist across sessions.`,
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
    !planMode ? `5. Run tests or lint if available to verify correctness.` : null,
    `${planMode ? '4' : '6'}. Mark tasks done with todo(done) and summarise what you found${planMode ? '' : ' / changed'}.`,
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

  if (logikMd) {
    lines.push(``, `PROJECT INSTRUCTIONS (from LOGIK.md — follow exactly):`, logikMd.slice(0, LOGIK_MD_CAP))
  }

  return lines.filter(l => l !== undefined).join('\n')
}
