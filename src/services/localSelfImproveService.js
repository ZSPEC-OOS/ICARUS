// ─── localSelfImproveService.js ───────────────────────────────────────────────
// Single-repo self-improvement loop.
// Each cycle: agent explores the repo, picks ONE improvement, implements it.
// No GitHub API, no second repo — just read/write local files directly.

import { runAgentLoop }                                      from './agentLoop.js'
import { listLocalDir, readLocalFile, writeLocalFile }       from './localFileService.js'

// ── Tool schema ───────────────────────────────────────────────────────────────

export const LOCAL_AGENT_TOOLS = [
  {
    name: 'list_directory',
    description: 'List files and subdirectories in the repository.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from repo root. Empty for root.' },
      },
      required: [],
    },
  },
  {
    name: 'read_file',
    description: 'Read the full content of a file in the repository.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file in the repository.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Relative file path.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Edit an existing file by replacing one exact string with another.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Relative file path.' },
        old_str: { type: 'string', description: 'Exact text to find (must appear exactly once).' },
        new_str: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_str', 'new_str'],
    },
  },
]

// ── Executor ──────────────────────────────────────────────────────────────────

function makeExecutor(repoHandle) {
  return async function executeTool(toolName, input) {
    switch (toolName) {
      case 'list_directory': {
        const entries = await listLocalDir(repoHandle, input.path || '')
        return { entries }
      }
      case 'read_file': {
        const content = await readLocalFile(repoHandle, input.path)
        return { content, path: input.path }
      }
      case 'write_file': {
        await writeLocalFile(repoHandle, input.path, input.content)
        return { written: true, path: input.path }
      }
      case 'edit_file': {
        const original = await readLocalFile(repoHandle, input.path)
        if (!original.includes(input.old_str)) {
          throw new Error(`edit_file: old_str not found in ${input.path}`)
        }
        const updated = original.replace(input.old_str, input.new_str)
        await writeLocalFile(repoHandle, input.path, updated)
        return { edited: true, path: input.path }
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`)
    }
  }
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = repoName =>
`You are an autonomous code improvement agent working on a local repository called "${repoName}".

Available tools: list_directory, read_file, write_file, edit_file

Rules:
- Make exactly ONE focused, concrete improvement per cycle
- Affect at most 1–3 files
- Never break existing functionality — only enhance
- Match the existing code style exactly
- Prefer editing files over creating new ones`

const CYCLE_PROMPT = (cycle, repoName) =>
`Self-improvement cycle #${cycle} on "${repoName}".

STEP 1  Explore the repository: use list_directory to map structure, then read_file on key files.
STEP 2  Identify ONE specific improvement opportunity:
        • Real functionality, robustness, clarity, or UX improvement
        • Compatible with the existing architecture (1–3 files max)
STEP 3  Implement it now using write_file or edit_file.
STEP 4  End your response with exactly: "Enhancement: <one-line description of what you did>"`

// ── Main loop ─────────────────────────────────────────────────────────────────

/**
 * @param {object} config
 *   .handle      FileSystemDirectoryHandle
 *   .name        string — display name
 *   .modelConfig { model, apiKey, … }
 *   .maxCycles   number (default 100)
 *   .signal      AbortSignal
 * @param {object} callbacks
 *   .onStep(info)   { cycle, msg }
 *   .onEvent(e)     agent event with .cycle
 *   .onLog(entry)   { cycle, description, timestamp }
 *   .onCycleEnd(n)
 *   .onAbortCheck() → boolean
 */
export async function runLocalSelfImproveLoop(config, callbacks) {
  const { handle, name, modelConfig, maxCycles = 100, signal } = config
  const { onStep, onEvent, onLog, onCycleEnd, onAbortCheck } = callbacks

  function aborted() {
    return signal?.aborted || onAbortCheck?.()
  }

  const executor = makeExecutor(handle)

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    if (aborted()) break

    onStep?.({ cycle, msg: `Exploring ${name} for an enhancement…` })

    let output = ''
    const writtenFiles = []   // files actually modified this cycle

    try {
      await runAgentLoop({
        task:         CYCLE_PROMPT(cycle, name),
        systemPrompt: SYSTEM_PROMPT(name),
        tools:        LOCAL_AGENT_TOOLS,
        executeTool:  executor,
        modelConfig,
        onEvent: e => {
          if (e.type === 'text_delta') output += e.text
          // Track every file the agent writes/edits
          if (e.type === 'tool_done' && (e.tool_name === 'write_file' || e.tool_name === 'edit_file')) {
            const p = e.tool_input?.path
            if (p && !writtenFiles.includes(p)) writtenFiles.push(p)
          }
          onEvent?.({ ...e, cycle })
        },
        signal,
      })
    } catch (e) {
      if (aborted()) break
      onEvent?.({ type: 'error', text: `Cycle ${cycle} error: ${e.message}`, cycle })
    }

    // 1. Try the explicit "Enhancement: ..." line (case-insensitive, trimmed)
    // 2. Fall back to the list of files actually modified
    // 3. Last resort: first meaningful sentence from the agent's text
    const tagged = output.match(/Enhancement[:\s]+(.{8,})/i)?.[1]?.split('\n')[0]?.trim()
    const filesDesc = writtenFiles.length > 0
      ? `Modified ${writtenFiles.join(', ')}`
      : null
    const textFallback = output.replace(/\n+/g, ' ').match(/(?:I (?:have |))(?:added|implemented|updated|improved|fixed|refactored|created)\s+(.{10,120})/i)?.[1]?.trim()

    const description = tagged || filesDesc || textFallback || `Cycle ${cycle} — no changes detected`

    onLog?.({ cycle, description, files: writtenFiles, timestamp: Date.now() })
    onStep?.({ cycle, msg: description })
    onCycleEnd?.(cycle)

    if (aborted()) break
  }
}
