// ── agentExecutor — connects tool names to real I/O ──────────────────────────
//
// makeExecutor() returns an async function (name, input) => string
// that the agentic loop calls for each tool the model requests.
//
// Execution routes:
//   read_file         → GitHub Contents API (with optional line range)
//   read_many_files   → GitHub Contents API (parallel batch)
//   write_file        → GitHub Contents API (create or update)
//   edit_file         → read → patch → write via GitHub
//   list_directory    → GitHub Contents API (paginated, includes file sizes)
//   search_files      → ShadowContext relevance index
//   grep              → ShadowContext content index (regex search)
//   web_fetch         → exec bridge curl | direct fetch fallback
//   web_search        → Tavily REST API
//   update_memory     → appends note to BLUSWAN.md via GitHub API
//   token_io_optimizer → returns a quality-preserving token optimization plan
//   run_command       → Vite exec bridge (POST /api/exec)
//   create_pull_request → GitHub Pulls API
//   spawn_agent       → recursive read-only sub-agent (max depth 1)

import {
  getFileContent,
  createOrUpdateFile,
  deleteFile,
  listDirectory,
  createPullRequest,
  listFileCommits,
  compareCommits,
  listCommits,
  createIssue,
  getWorkflowRuns,
} from './githubService.js'
import { decodeBase64 } from '../utils/base64.js'
import { shadowContext } from './shadowContext.js'
import { EXEC_BRIDGE_TIMEOUT_MS } from '../config/constants.js'
import { retrieveContext, hybridSearch } from './enhancers/ragService.js'
import { resolveEnhancerConfig } from './enhancers/config.js'
import { validateToolInput, validateToolOutput, schemaVersion } from '../tools/contracts.js'
import { beginToolTrace, endToolTrace, replayTrace, setTraceLoopState } from './toolTraceStore.js'
import { runAgentLoop } from './agentLoop.js'
import { AGENT_TOOLS } from './agentTools.js'
import { fetchNpmMeta } from './libraryContextService.js'
import { validatePatch } from './patchValidator.js'
import { codeIntelligence } from './codeIntelligence.js'
import { runTDDLoop } from './tddLoop.js'

// ── Exec bridge call ──────────────────────────────────────────────────────────
async function execBridge(cmd, cwd) {
  try {
    const res = await fetch('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, cwd, timeout: EXEC_BRIDGE_TIMEOUT_MS }),
    })
    if (!res.ok) return `bridge HTTP error ${res.status}`
    const { stdout, stderr, exitCode } = await res.json()
    const out = [stdout?.trimEnd(), stderr?.trimEnd()].filter(Boolean).join('\n')
    return `exit ${exitCode}\n${out || '(no output)'}`
  } catch (err) {
    return `exec bridge unavailable: ${err.message}`
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────
// ── Web search via Tavily ─────────────────────────────────────────────────────
// Tavily explicitly supports browser-side requests (CORS-enabled).
// In dev mode requests are proxied through Vite to avoid any CORS edge cases.
const IS_DEV_EXEC = typeof import.meta !== 'undefined' && import.meta.env?.DEV
const TAVILY_URL = IS_DEV_EXEC ? '/api/proxy/tavily/search' : 'https://api.tavily.com/search'

async function tavilySearch(apiKey, query, maxResults, includeDomains) {
  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key:         apiKey,
      query,
      search_depth:    'basic',
      include_answer:  true,
      max_results:     Math.min(maxResults || 5, 10),
      include_domains: includeDomains || [],
    }),
  })
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`)
  return res.json()
}

// ── Aider-inspired helpers ────────────────────────────────────────────────────

// When edit_file fails, show the closest matching region so the model can
// self-correct without re-reading the whole file (Aider's side-by-side diagnostic).
function findSimilarLines(content, oldStr, maxResults = 3) {
  const target = oldStr.split('\n')[0].trim()
  if (!target) return ''
  // Extract words of 4+ chars as matching keys
  const words = target.split(/\W+/).filter(w => w.length >= 4)
  if (words.length === 0) return ''
  const lines = content.split('\n')
  const scored = []
  for (let i = 0; i < Math.min(lines.length, 3000); i++) {
    const score = words.filter(w => lines[i].includes(w)).length
    if (score > 0) scored.push({ i, score })
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.slice(0, maxResults).map(({ i }) => {
    const ctx = Math.min(oldStr.split('\n').length + 1, 8)
    const s   = Math.max(0, i - 1)
    const e   = Math.min(lines.length, i + ctx)
    return lines.slice(s, e).map((l, idx) => `  ${s + idx + 1}: ${l}`).join('\n')
  }).join('\n  ---\n')
}

// Conventional Commits message fallback (Aider commit-message pattern).
// Used when the model doesn't supply an explicit commit message.
function buildCommitMsg(action, path, userMsg) {
  if (userMsg) return userMsg
  const name = path.split('/').pop()
  const stem = name.replace(/\.[^.]+$/, '')
  const ext  = (name.match(/\.([^.]+)$/) || [])[1] || ''
  const type =
    action === 'delete'                    ? 'chore' :
    action === 'write'                     ? 'feat'  :
    /test|spec/i.test(name)                ? 'test'  :
    /css|scss|less/i.test(ext)             ? 'style' :
    /md|txt|rst/i.test(ext)               ? 'docs'  :
    /config|\.env|rc/i.test(name)          ? 'chore' : 'fix'
  const verb = action === 'delete' ? 'remove' : action === 'write' ? 'add' : 'update'
  return `${type}(${stem}): ${verb} ${name}`
}

function inferStackHint(errorName = '', message = '') {
  const hay = `${errorName} ${message}`.toLowerCase()
  if (hay.includes('undefined') || hay.includes('null')) return 'Check null/undefined guards before property access.'
  if (hay.includes('module') && hay.includes('not found')) return 'Verify import path, file casing, and dependency installation.'
  if (hay.includes('syntaxerror')) return 'Inspect nearby syntax (missing bracket/comma/quote) at the first frame.'
  if (hay.includes('typeerror')) return 'Inspect the top frame variables and expected object/function types.'
  return 'Start at the top frame and inspect surrounding code plus recent edits.'
}

function parseStackFrame(line) {
  const trimmed = String(line || '').trim()
  const withFn = trimmed.match(/^at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)$/)
  if (withFn) return { fn: withFn[1], file: withFn[2], line: Number(withFn[3]), column: Number(withFn[4]) }

  const anon = trimmed.match(/^at\s+(.*?):(\d+):(\d+)$/)
  if (anon) return { fn: '(anonymous)', file: anon[1], line: Number(anon[2]), column: Number(anon[3]) }

  return null
}

function attemptJsonRepair(raw) {
  let next = String(raw)
    .replace(/\r\n/g, '\n')
    .replace(/,\s*([}\]])/g, '$1')

  next = next
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g, '"$1":')
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"')

  return next
}

// ── Phase 2 helpers ───────────────────────────────────────────────────────────

// Convert a glob pattern to a RegExp (supports **, *, ?, {a,b}).
function globToRegex(glob) {
  const src = glob
    .replace(/[.+^${}()|[\]\\]/g, (c) => (c === '{' || c === '}' ? c : `\\${c}`))
    .replace(/\{([^}]+)\}/g, (_, g) => `(?:${g.split(',').map(s => s.replace(/[.+^$[\]\\]/g, '\\$&')).join('|')})`)
    .replace(/\*\*/g, '\x00')  // placeholder
    .replace(/\*/g,   '[^/]*')
    .replace(/\?/g,   '[^/]')
    .replace(/\x00/g, '.*')
  return new RegExp(`^${src}$`)
}

// Parse a unified diff into an array of hunks.
// Each hunk: { oldStart, lines: ['+'/'-'/' ' prefixed strings] }
function parsePatchHunks(patch) {
  const hunks = []
  let current = null
  for (const line of patch.split('\n')) {
    const m = line.match(/@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/)
    if (m) {
      current = { oldStart: Number(m[1]) - 1, lines: [] }  // 0-indexed
      hunks.push(current)
      continue
    }
    if (current && (line[0] === '+' || line[0] === '-' || line[0] === ' ')) {
      current.lines.push(line)
    }
  }
  return hunks
}

// Apply parsed hunks to file lines array (in-place reverse order to preserve positions).
// Returns { ok, content, error }.
function applyHunks(fileContent, hunks) {
  if (hunks.length === 0) return { ok: false, error: 'No valid @@ hunks found in patch.' }
  const result = fileContent.split('\n')

  for (const hunk of [...hunks].reverse()) {
    // Build "expected old" (context + removed) and "replacement" (context + added)
    const oldLines = hunk.lines.filter(l => l[0] !== '+').map(l => l.slice(1))
    const newLines = hunk.lines.filter(l => l[0] !== '-').map(l => l.slice(1))

    // Locate old content near hinted position (fuzz ±10 lines)
    let foundAt = -1
    const lo = Math.max(0, hunk.oldStart - 10)
    const hi = Math.min(result.length - oldLines.length, hunk.oldStart + 10)

    for (let pos = lo; pos <= hi; pos++) {
      if (oldLines.every((l, i) => result[pos + i] === l)) { foundAt = pos; break }
    }
    // Second pass: trim-normalised match
    if (foundAt === -1) {
      for (let pos = 0; pos <= result.length - oldLines.length; pos++) {
        if (oldLines.every((l, i) => result[pos + i]?.trimEnd() === l.trimEnd())) { foundAt = pos; break }
      }
    }
    if (foundAt === -1) {
      const ctx = oldLines.slice(0, 3).join('\n')
      return { ok: false, error: `Hunk at line ${hunk.oldStart + 1} could not be applied — context not found:\n${ctx}\n\nUse edit_file for manual patching.` }
    }
    result.splice(foundAt, oldLines.length, ...newLines)
  }
  return { ok: true, content: result.join('\n') }
}

// ── Phase 3 helpers ───────────────────────────────────────────────────────────

// Resolve git conflict markers in file content.
// Lines between <<<<<<< and ======= are "ours"; between ======= and >>>>>>> are "theirs".
function resolveConflictMarkers(content, resolution) {
  const lines = content.split('\n')
  const result = []
  let state = 'normal'   // 'normal' | 'ours' | 'theirs'
  let count = 0
  let unclosed = false

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      state = 'ours'
      count++
    } else if (line.startsWith('=======') && state === 'ours') {
      state = 'theirs'
    } else if (line.startsWith('>>>>>>>') && (state === 'ours' || state === 'theirs')) {
      state = 'normal'
    } else {
      if (state === 'normal')                          result.push(line)
      else if (state === 'ours'   && resolution === 'ours')   result.push(line)
      else if (state === 'theirs' && resolution === 'theirs') result.push(line)
    }
  }
  if (state !== 'normal') unclosed = true
  return { resolved: result.join('\n'), count, unclosed }
}

function buildTokenIoPlan(task, expectedOutputSize = 'medium', mode = 'adaptive') {
  const normalizedSize = ['small', 'medium', 'large', 'huge'].includes(expectedOutputSize)
    ? expectedOutputSize
    : 'medium'
  const normalizedMode = ['off', 'adaptive', 'aggressive'].includes(mode)
    ? mode
    : 'adaptive'

  const basePlan = [
    'Keep full implementation quality: never omit required code, tests, or error handling.',
    'Batch reads using read_many_files and use grep before opening many files.',
    'Avoid redundant tool calls by caching prior read/search results within the session.',
    'Use edit_file for surgical patches; reserve write_file for full rewrites/new files.',
    'Defer verbose prose until final answer; keep intermediate tool outputs concise.',
  ]

  if (normalizedSize === 'large' || normalizedSize === 'huge') {
    basePlan.push('Split work into milestones and only load context relevant to the current milestone.')
  }

  if (normalizedMode === 'off') {
    basePlan.unshift('Optimization mode OFF: prioritize maximal context and verbosity.')
  } else if (normalizedMode === 'aggressive') {
    basePlan.push('Aggressive mode: cap repeated file reads and summarize unchanged sections after first inspection.')
    basePlan.push('Aggressive mode: prefer short tool arguments and avoid re-sending unchanged large strings.')
  } else {
    basePlan.push('Adaptive mode: optimize only when requests are long or repetitive.')
  }

  return {
    tool: 'token_io_optimizer',
    mode: normalizedMode,
    expectedOutputSize: normalizedSize,
    qualityGuardrail: 'Do not sacrifice correctness, completeness, or code quality for token savings.',
    taskSummary: String(task || '').trim().slice(0, 400),
    recommendations: basePlan,
  }
}

export function makeExecutor({ token, owner, repo, branch, onFileWrite, sourceRepoConfig, webSearchApiKey, bridgeAvailable, modelConfig, availableModels, _depth = 0, enhancerConfig: enhancerConfigOverrides, hooksConfig, modularTools = [] }) {
  const enhancerConfig = resolveEnhancerConfig(enhancerConfigOverrides)

  async function rawExecuteTool(name, input) {
    // ── modular tool dispatch (loadworkflow_ injected tools) ──────────────────
    if (name.startsWith('modular_') && modularTools.length) {
      const toolId = name.slice(8)
      const tool   = modularTools.find(t => t.id === toolId)
      if (tool?._execute) {
        try {
          const result = await tool._execute(input.input ?? '', {})
          return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        } catch (e) {
          return `Modular tool error: ${e.message}`
        }
      }
      return `Modular tool '${toolId}' not found.`
    }

    switch (name) {
      // ── analyze_codebase ───────────────────────────────────────────────
      case 'analyze_codebase': {
        if (!shadowContext.isReady) {
          return `Codebase index not ready (${shadowContext.indexedFileCount()} files indexed).`
        }
        const conventions = shadowContext.getConventions?.() || {}
        const importGraph = shadowContext.getImportGraph?.() || {}
        const inDegree = {}
        for (const deps of Object.values(importGraph)) {
          for (const dep of deps || []) inDegree[dep] = (inDegree[dep] || 0) + 1
        }
        const topLimit = Math.max(3, Math.min(input.top_hubs || 10, 20))
        const topHubs = Object.entries(inDegree)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, topLimit)
          .map(([path, degree]) => `${path} (imports: ${degree})`)
        const mapChars = Math.max(1200, Math.min(input.max_chars || 3000, 8000))
        const repoMap = shadowContext.buildRepoMap?.(mapChars) || '(repo map unavailable)'
        const lines = [
          `Indexed files: ${shadowContext.indexedFileCount()}`,
          `Framework: ${conventions.framework || 'unknown'}`,
          `Language: ${conventions.language || 'unknown'}`,
          `Naming: ${conventions.namingConvention || 'unknown'}`,
          '',
          'Top dependency hubs:',
          ...(topHubs.length ? topHubs.map((h, i) => `${i + 1}. ${h}`) : ['(no import graph data)']),
          '',
          'Repository map:',
          repoMap,
        ]
        return lines.join('\n')
      }

      // ── read_file (with optional line range) ───────────────────────────
      case 'read_file': {
        const file = await getFileContent(token, owner, repo, input.path, branch)
        if (!file?.content) return `File not found: ${input.path}`
        let content = decodeBase64(file.content)
        const lines = content.split('\n')
        if (input.start_line || input.end_line) {
          const s = Math.max(0, (input.start_line || 1) - 1)
          const e = Math.min(lines.length, input.end_line || lines.length)
          return `--- ${input.path} (lines ${s + 1}–${e} of ${lines.length}) ---\n${lines.slice(s, e).join('\n')}`
        }
        return `--- ${input.path} (${lines.length} lines) ---\n${content.slice(0, 20000)}`
      }

      // ── read_many_files ────────────────────────────────────────────────
      case 'read_many_files': {
        const paths = (input.paths || []).slice(0, 20)
        if (paths.length === 0) return 'No paths provided.'
        const settled = await Promise.allSettled(paths.map(async p => {
          const file = await getFileContent(token, owner, repo, p, branch)
          if (!file?.content) return `--- ${p} ---\nFile not found.`
          const content = decodeBase64(file.content)
          return `--- ${p} (${content.split('\n').length} lines) ---\n${content.slice(0, 10000)}`
        }))
        return settled.map(r => r.status === 'fulfilled' ? r.value : `Error: ${r.reason}`).join('\n\n')
      }

      // ── write_file ─────────────────────────────────────────────────────
      case 'write_file': {
        const existing = await getFileContent(token, owner, repo, input.path, branch)
        const sha      = existing?.sha || null
        const msg      = buildCommitMsg(sha ? 'edit' : 'write', input.path, input.message)
        await createOrUpdateFile(token, owner, repo, input.path, input.content, msg, branch, sha)
        onFileWrite?.(input.path, 'write')
        return `Written: ${input.path} (${input.content.split('\n').length} lines)`
      }

      // ── edit_file (pre-write patch validation + Aider-style diagnostics) ──
      case 'edit_file': {
        const file = await getFileContent(token, owner, repo, input.path, branch)
        if (!file?.content) return `File not found: ${input.path}`
        const current = decodeBase64(file.content)
        const fileSha = file.sha

        // ── Pre-write validation (Phase 1: patchValidator) ─────────────────
        // Validates old_str presence, indentation alignment, and post-edit
        // syntax balance before touching the GitHub API.
        const validation = validatePatch(input.path, input.old_str, input.new_str, current)
        if (!validation.valid) {
          const detail =
            validation.suggestion
              ? `\n\nCorrected old_str (use this exactly, indentation preserved):\n${validation.suggestion}`
              : validation.nearestMatch
              ? `\n\n${validation.nearestMatch}\n\nCopy the exact text including all whitespace.`
              : `\n\nUse grep or read_file (with start_line/end_line) to confirm the exact text.`
          return `edit_file failed: ${validation.reason}${detail}`
        }
        // ───────────────────────────────────────────────────────────────────

        const updated = current.replace(input.old_str, input.new_str)
        const msg = buildCommitMsg('edit', input.path, input.message)
        await createOrUpdateFile(token, owner, repo, input.path, updated, msg, branch, fileSha)
        onFileWrite?.(input.path, 'edit')
        const syntaxNote = validation.syntaxWarning ? `\n⚠ ${validation.syntaxWarning}` : ''
        return `Edited: ${input.path}${syntaxNote}`
      }

      // ── delete_file ────────────────────────────────────────────────────
      case 'delete_file': {
        const file = await getFileContent(token, owner, repo, input.path, branch)
        if (!file?.sha) return `File not found: ${input.path}`
        const msg = buildCommitMsg('delete', input.path, input.message)
        await deleteFile(token, owner, repo, input.path, file.sha, msg, branch)
        onFileWrite?.(input.path, 'delete')
        return `Deleted: ${input.path}`
      }

      // ── list_directory (with file sizes) ──────────────────────────────
      case 'list_directory': {
        const items = await listDirectory(token, owner, repo, input.path || '', branch)
        if (items.length === 0) return `Empty or not found: ${input.path || '/'}`
        return items.map(i => {
          const sz = i.type === 'file' && i.size ? ` (${(i.size / 1024).toFixed(1)} KB)` : ''
          return `${i.type === 'dir' ? 'd' : 'f'} ${i.path}${sz}`
        }).join('\n')
      }

      // ── grep ───────────────────────────────────────────────────────────
      case 'grep': {
        if (!shadowContext.isReady)
          return `Codebase index not ready (${shadowContext.indexedFileCount()} files indexed). Try list_directory instead.`
        let results
        try {
          results = shadowContext.grepContent(input.pattern, input.path || null, input.ignore_case ? 'i' : '')
        } catch (e) {
          return `grep error: ${e.message}`
        }
        if (results.length === 0) return `No matches for /${input.pattern}/${input.ignore_case ? 'i' : ''} in ${shadowContext.indexedFileCount()} indexed files.`
        const lines = results.slice(0, 150).map(r => `${r.path}:${r.line}: ${r.text.trimEnd()}`)
        const suffix = results.length > 150 ? `\n… (${results.length - 150} more results, refine the pattern)` : ''
        return lines.join('\n') + suffix
      }

      // ── search_files ───────────────────────────────────────────────────
      case 'search_files': {
        if (!shadowContext.isReady) return 'Codebase index not ready yet. Try list_directory instead.'
        const results = shadowContext.findRelevantFiles(input.query, input.limit || 8)
        if (results.length === 0) return `No files found matching: ${input.query}`
        return results.map(f => `${f.path} (score: ${f.score})`).join('\n')
      }

      // ── install_package ────────────────────────────────────────────────
      case 'install_package': {
        if (!bridgeAvailable) return 'install_package requires the exec bridge (run with npm run dev).'

        const pkgs = (input.packages || [])
          .map(p => String(p).trim())
          .filter(Boolean)
          .slice(0, 8)

        if (!pkgs.length) return 'install_package: no packages specified.'

        // Reject names that look like shell injection attempts
        const SAFE_PKG = /^(@[\w-]+\/[\w-]+|[\w][\w\-./]*)$/
        const bad = pkgs.filter(p => !SAFE_PKG.test(p))
        if (bad.length) return `install_package: rejected — invalid package name(s): ${bad.join(', ')}`

        const mgr = input.manager || 'npm'
        const devFlag = input.dev
          ? mgr === 'yarn' ? '--dev ' : '--save-dev '
          : ''

        let cmd
        if      (mgr === 'pip')  cmd = `pip install ${pkgs.join(' ')}`
        else if (mgr === 'yarn') cmd = `yarn add ${devFlag}${pkgs.join(' ')}`
        else if (mgr === 'pnpm') cmd = `pnpm add ${devFlag}${pkgs.join(' ')}`
        else                     cmd = `npm install ${devFlag}${pkgs.join(' ')}`

        const installOut = await execBridge(cmd, input.cwd)

        // Fetch docs for installed npm packages (best-effort, silent on failure)
        const docsLines = []
        if (mgr !== 'pip') {
          const fetched = await Promise.allSettled(pkgs.slice(0, 3).map(p => fetchNpmMeta(p, 600)))
          for (const r of fetched) {
            const m = r.status === 'fulfilled' ? r.value : null
            if (!m) continue
            const lines = [
              `\n## ${m.name} v${m.version}`,
              m.description,
              m.keywords   ? `Keywords: ${m.keywords}` : null,
              m.hasTypes   ? 'TypeScript types: yes' : null,
              m.homepage   ? `Docs: ${m.homepage}` : null,
              m.readmeExcerpt ? `\n${m.readmeExcerpt}` : null,
            ].filter(Boolean)
            docsLines.push(lines.join('\n'))
          }
        }

        const docsBlock = docsLines.length
          ? `\n\n--- Package docs ---${docsLines.join('\n\n---\n')}`
          : ''

        return `${installOut}${docsBlock}`
      }

      // ── run_command ────────────────────────────────────────────────────
      case 'run_command': {
        const replayMatch = String(input?.cmd || '').trim().match(/^replay\s+--trace-id\s+(\S+)$/)
        if (replayMatch) {
          try {
            const replayed = await replayTrace(replayMatch[1], rawExecuteTool)
            return JSON.stringify(replayed, null, 2)
          } catch (error) {
            return `replay failed: ${error.message}`
          }
        }
        return execBridge(input.cmd, input.cwd)
      }

      // ── create_pull_request ────────────────────────────────────────────
      case 'create_pull_request': {
        const pr = await createPullRequest(
          token, owner, repo,
          input.title,
          input.head,
          input.base,
          input.body || '',
        )
        return pr?.html_url
          ? `PR created: ${pr.html_url} (#${pr.number})`
          : `PR creation failed`
      }

      // ── read_source_file ───────────────────────────────────────────────
      case 'read_source_file': {
        if (!sourceRepoConfig?.owner) return 'No source repository connected.'
        const { token: sToken, owner: sOwner, repo: sRepo, branch: sBranch } = sourceRepoConfig
        const file = await getFileContent(sToken || token, sOwner, sRepo, input.path, sBranch)
        if (!file?.content) return `File not found in source repo: ${input.path}`
        const content = decodeBase64(file.content)
        return `--- [SOURCE: ${sOwner}/${sRepo}] ${input.path} (${content.split('\n').length} lines) ---\n${content.slice(0, 20000)}`
      }

      // ── list_source_directory ──────────────────────────────────────────
      case 'list_source_directory': {
        if (!sourceRepoConfig?.owner) return 'No source repository connected.'
        const { token: sToken, owner: sOwner, repo: sRepo, branch: sBranch } = sourceRepoConfig
        const items = await listDirectory(sToken || token, sOwner, sRepo, input.path || '', sBranch)
        if (items.length === 0) return `Empty or not found in source repo: ${input.path || '/'}`
        return items.map(i => `${i.type === 'dir' ? 'd' : 'f'} ${i.path}`).join('\n')
      }


      // ── hybrid_search ──────────────────────────────────────────────────
      case 'hybrid_search': {
        if (!enhancerConfig.rag.enabled) return 'RAG enhancer is disabled in settings/config.'
        const results = hybridSearch({
          query: input.query,
          limit: Math.max(1, Math.min(input.limit || 8, 20)),
          shadowContext,
          weights: {
            bm25: enhancerConfig.rag.bm25Weight,
            vector: enhancerConfig.rag.vectorWeight,
          },
          minScore: enhancerConfig.rag.minScore,
        })
        if (!results.length) return `No retrieval candidates found for: ${input.query}`
        return results
          .map((r, idx) => `${idx + 1}. ${r.path} (score: ${r.score.toFixed(3)}, section: ${r.metadata.section}, owner: ${r.metadata.owner || 'n/a'})`)
          .join('\n')
      }

      // ── retrieve_context ───────────────────────────────────────────────
      case 'retrieve_context': {
        if (!enhancerConfig.rag.enabled) return 'RAG enhancer is disabled in settings/config.'
        const out = retrieveContext({ query: input.query, shadowContext, config: enhancerConfig.rag })
        if (!out.contexts.length) return `No context retrieved for: ${input.query}`
        return [
          `Query: ${out.query}`,
          `Candidates: ${out.totalCandidates}`,
          '',
          out.contexts
            .map((c, idx) => `[#${idx + 1}] ${c.path} (score ${c.score.toFixed(3)})\n${c.text.slice(0, 240)}`)
            .join('\n\n'),
        ].join('\n')
      }

      // ── web_fetch ──────────────────────────────────────────────────────
      case 'web_fetch': {
        // Prefer exec-bridge curl (avoids CORS, strips HTML to plain text)
        if (bridgeAvailable) {
          const safe = input.url.replace(/"/g, '\\"')
          const raw = await execBridge(`curl -s -L --max-time 20 --max-filesize 500000 -A "Mozilla/5.0" "${safe}"`, null)
          const text = raw
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ').trim()
            .slice(0, 15000)
          return text || '(empty response)'
        }
        // Fallback: direct browser fetch (works for CORS-enabled APIs / raw files)
        try {
          const res = await fetch(input.url, { signal: AbortSignal.timeout(20000) })
          if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`
          const text = await res.text()
          return text.slice(0, 15000)
        } catch (err) {
          return `web_fetch failed: ${err.message}. For arbitrary URLs, run with the exec bridge (npm run dev).`
        }
      }

      // ── update_memory ──────────────────────────────────────────────────
      case 'update_memory': {
        const memPath = 'BLUSWAN.md'
        const existing = await getFileContent(token, owner, repo, memPath, branch)
        const current  = existing?.content ? decodeBase64(existing.content) : ''
        const today    = new Date().toISOString().slice(0, 10)
        const appended = `${current.trimEnd()}\n\n## Agent Note (${today})\n\n${input.note.trim()}\n`
        const sha = existing?.sha || null
        await createOrUpdateFile(token, owner, repo, memPath, appended,
          `agent: memory — ${input.note.slice(0, 60)}`, branch, sha)
        onFileWrite?.(memPath, 'edit')
        return `Memory updated: appended note to ${memPath}`
      }

      // ── web_search ─────────────────────────────────────────────────────
      case 'web_search': {
        if (!webSearchApiKey) {
          return 'Web search is not configured. Add a Tavily API key in Settings → Web Search, then reload.'
        }
        try {
          const data = await tavilySearch(webSearchApiKey, input.query, input.max_results, input.include_domains)
          const lines = []
          if (data.answer) lines.push(`Answer: ${data.answer}\n`)
          for (const r of (data.results || []).slice(0, 8)) {
            lines.push(`[${r.title}](${r.url})`)
            if (r.content) lines.push(r.content.slice(0, 400))
            lines.push('')
          }
          return lines.join('\n').trim() || 'No results found.'
        } catch (err) {
          return `web_search error: ${err.message}`
        }
      }

      // ── lint_file ──────────────────────────────────────────────────────
      // Aider runs lint automatically after edits; here the agent calls it proactively.
      case 'lint_file': {
        if (!bridgeAvailable) return 'lint_file requires the exec bridge (run with npm run dev).'
        if (!/\.(js|jsx|ts|tsx)$/.test(input.path)) return `lint_file only supports .js/.jsx/.ts/.tsx (got ${input.path}).`
        const out = await execBridge(
          `npx eslint "${input.path}" --format compact 2>&1 | head -80`,
          null,
        )
        if (!out || (out.includes('bridge') && out.includes('unavailable'))) return 'exec bridge unavailable.'
        const clean = /0 errors/.test(out) || out.trim() === ''
        return clean ? `No lint errors in ${input.path} ✓` : out.slice(0, 3000)
      }

      // ── todo ───────────────────────────────────────────────────────────
      case 'todo': {
        const icons = { add: '📋', in_progress: '⚙', done: '✓' }
        const icon = icons[input.action] || '📋'
        return `${icon} [${input.action}] ${input.task}`
      }

      // ── revert_file (Claude Code-style undo) ───────────────────────────
      // Restores a file to its state N commits before its most recent change.
      // Uses the GitHub Commits API to find the prior version's tree SHA, then
      // reads the blob at that commit and writes it back as a new revert commit.
      case 'revert_file': {
        const n = Math.max(1, Math.min(input.commits_back || 1, 10))
        // Fetch the last (n+1) commits that touched this file
        const commits = await listFileCommits(token, owner, repo, input.path, branch, n + 1)
        if (commits.length < n + 1) {
          if (commits.length === 0)
            return `revert_file failed: no commit history found for ${input.path} on branch ${branch}.`
          return `revert_file failed: only ${commits.length} commit(s) found for ${input.path}, cannot go back ${n}.`
        }
        // The commit at index n is the one *before* the last n changes
        const targetSha = commits[n].sha
        // Read the file content at that historical commit
        const historical = await getFileContent(token, owner, repo, input.path, targetSha)
        if (!historical?.content)
          return `revert_file failed: could not retrieve ${input.path} at commit ${targetSha.slice(0, 7)}.`
        const content = decodeBase64(historical.content)
        // Get the current file SHA so we can overwrite it
        const current = await getFileContent(token, owner, repo, input.path, branch)
        if (!current?.sha)
          return `revert_file failed: could not get current SHA for ${input.path}.`
        const msg = input.message || `revert(${input.path.split('/').pop()}): restore to ${targetSha.slice(0, 7)}`
        await createOrUpdateFile(token, owner, repo, input.path, content, msg, branch, current.sha)
        onFileWrite?.(input.path, 'edit')
        return `Reverted: ${input.path} → restored to state at ${targetSha.slice(0, 7)} (${commits[n].message})`
      }

      // ── analyze_stacktrace ─────────────────────────────────────────────
      case 'analyze_stacktrace': {
        if (!input?.stacktrace || typeof input.stacktrace !== 'string') {
          return 'analyze_stacktrace error: stacktrace is required.'
        }
        const lines = input.stacktrace.split('\n').filter(Boolean)
        const header = lines[0] || ''
        const headMatch = header.match(/^([\w$.]+):\s*(.*)$/)
        const errorName = headMatch?.[1] || 'Error'
        const message = headMatch?.[2] || header
        const maxFrames = Math.max(1, Math.min(Number(input.max_frames) || 8, 25))
        const frames = []
        for (const line of lines.slice(1)) {
          const parsed = parseStackFrame(line)
          if (parsed) frames.push(parsed)
          if (frames.length >= maxFrames) break
        }
        return JSON.stringify({
          error: { name: errorName, message },
          frameCount: frames.length,
          frames,
          hint: inferStackHint(errorName, message),
        }, null, 2)
      }

      // ── find_tech_debt ────────────────────────────────────────────────
      case 'find_tech_debt': {
        if (!shadowContext.isReady) {
          return `Codebase index not ready (${shadowContext.indexedFileCount()} files indexed). Try grep when indexing completes.`
        }
        const markers = Array.isArray(input.markers) && input.markers.length
          ? input.markers
          : ['TODO', 'FIXME', 'HACK', 'BUG']
        const escaped = markers.map(m => String(m).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        const pattern = `\\b(${escaped.join('|')})\\b`
        const limit = Math.max(1, Math.min(Number(input.limit) || 50, 200))
        const matches = shadowContext.grepContent(pattern, input.path || null, 'i') || []
        const sliced = matches.slice(0, limit)
        const byFile = {}
        for (const match of sliced) byFile[match.path] = (byFile[match.path] || 0) + 1
        const hotspots = Object.entries(byFile)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 10)
          .map(([file, count]) => ({ file, count }))
        return JSON.stringify({
          pattern,
          total: matches.length,
          returned: sliced.length,
          hotspots,
          matches: sliced,
        }, null, 2)
      }

      // ── check_url_health ───────────────────────────────────────────────
      case 'check_url_health': {
        if (!input?.url) return 'check_url_health error: url is required.'
        const timeoutMs = Math.max(500, Math.min(Number(input.timeout_ms) || 8000, 30000))
        const method = String(input.method || 'GET').toUpperCase()
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), timeoutMs)
        const started = Date.now()
        try {
          const res = await fetch(input.url, { method, signal: controller.signal })
          return JSON.stringify({
            url: input.url,
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            latencyMs: Date.now() - started,
            redirected: res.redirected,
            finalUrl: res.url,
          }, null, 2)
        } catch (err) {
          const msg = err?.name === 'AbortError' ? 'timeout' : err.message
          return JSON.stringify({
            url: input.url,
            ok: false,
            status: 0,
            error: msg,
            latencyMs: Date.now() - started,
          }, null, 2)
        } finally {
          clearTimeout(timeout)
        }
      }

      // ── json_repair ────────────────────────────────────────────────────
      case 'json_repair': {
        if (typeof input?.text !== 'string' || !input.text.trim()) {
          return 'json_repair error: text is required.'
        }
        try {
          const parsed = JSON.parse(input.text)
          return JSON.stringify({ repaired: false, valid: true, json: JSON.stringify(parsed, null, 2) }, null, 2)
        } catch {
          const candidate = attemptJsonRepair(input.text)
          try {
            const parsed = JSON.parse(candidate)
            return JSON.stringify({ repaired: true, valid: true, json: JSON.stringify(parsed, null, 2) }, null, 2)
          } catch (e) {
            return JSON.stringify({ repaired: true, valid: false, error: e.message, json: candidate }, null, 2)
          }
        }
      }

      // ── token_io_optimizer ─────────────────────────────────────────────
      case 'token_io_optimizer': {
        if (typeof input?.task !== 'string' || !input.task.trim()) {
          return 'token_io_optimizer error: task is required.'
        }
        const plan = buildTokenIoPlan(input.task, input.expected_output_size, input.mode)
        return JSON.stringify(plan, null, 2)
      }

      // ── spawn_agent ────────────────────────────────────────────────────
      // Phase 4: allow_writes: true unlocks full tool access on the same branch.
      case 'spawn_agent': {
        if (!input.task?.trim()) return 'spawn_agent error: task is required.'
        if (_depth >= 1) return 'spawn_agent error: sub-agents cannot spawn further sub-agents.'
        if (!modelConfig) return 'spawn_agent error: no model config available.'

        const subTask    = input.task.trim()
        const label      = (input.description?.trim() || subTask).slice(0, 60)
        const allowWrites = !!input.allow_writes

        // Read-only tool set (research/investigation mode)
        const READ_ONLY_TOOLS = new Set([
          'analyze_codebase', 'read_file', 'list_directory', 'search_files',
          'glob', 'grep', 'read_many_files', 'web_fetch', 'web_search',
          'hybrid_search', 'retrieve_context', 'check_url_health',
          'git_log', 'check_ci_status', 'get_diff',
        ])

        // Write mode: all tools except spawn_agent (no recursion)
        const subTools = allowWrites
          ? AGENT_TOOLS.filter(t => t.name !== 'spawn_agent')
          : AGENT_TOOLS.filter(t => READ_ONLY_TOOLS.has(t.name))

        const subFilesChanged = []
        const subExecutor = makeExecutor({
          token, owner, repo, branch,
          sourceRepoConfig,
          webSearchApiKey,
          bridgeAvailable: allowWrites ? bridgeAvailable : false,
          modelConfig,
          availableModels,
          _depth: _depth + 1,
          onFileWrite: allowWrites
            ? (path, action) => { subFilesChanged.push({ path, action }); onFileWrite?.(path, action) }
            : undefined,
        })

        const subSystemPrompt = allowWrites
          ? [
              `You are a focused implementation sub-agent working on the GitHub repository ${owner}/${repo} (branch: ${branch}).`,
              'Complete the assigned task autonomously. Read files before editing. Use lint_file after edits.',
              'Do NOT spawn further sub-agents. Return a concise summary of what you implemented and which files you changed.',
            ].join('\n')
          : [
              'You are a focused research sub-agent. Complete the assigned task thoroughly and return a comprehensive, well-structured answer.',
              `You have read-only access to the GitHub repository ${owner}/${repo} (branch: ${branch}).`,
              'Do NOT attempt to write, edit, or delete any files — you have no write tools.',
              'Be precise and structured in your response. Return all findings directly.',
            ].join('\n')

        const textChunks = []
        let result
        try {
          result = await runAgentLoop({
            task: subTask,
            systemPrompt: subSystemPrompt,
            tools: subTools,
            executeTool: subExecutor,
            modelConfig,
            onEvent: (ev) => { if (ev.type === 'text_delta') textChunks.push(ev.delta) },
            signal: null,
            conversationHistory: [],
            enhancerConfig: null,
            availableModels: availableModels || [],
          })
        } catch (err) {
          return `spawn_agent error: sub-agent failed — ${err.message}`
        }

        const finalText = result?.finalText || textChunks.join('') || '(no result)'
        const filesSummary = subFilesChanged.length
          ? `\n\nFiles changed (${subFilesChanged.length}): ${subFilesChanged.map(f => f.path).join(', ')}`
          : ''
        return `[Sub-agent: ${label}]\n\n${finalText}${filesSummary}`
      }

      // ── git_log ────────────────────────────────────────────────────────
      // Commit history for a branch or file via GitHub Commits API.
      case 'git_log': {
        const targetBranch = (input.branch || branch || '').trim()
        const limit = Math.max(1, Math.min(Number(input.limit) || 10, 50))
        const commits = await listCommits(token, owner, repo, targetBranch, input.path || null, limit)

        if (commits.length === 0) {
          return input.path
            ? `No commits found for ${input.path} on branch ${targetBranch}.`
            : `No commits found on branch ${targetBranch}.`
        }

        const header = input.path
          ? `Last ${commits.length} commit(s) touching ${input.path} on ${targetBranch}:`
          : `Last ${commits.length} commit(s) on ${targetBranch}:`

        const rows = commits.map(c => {
          const date = c.date ? c.date.slice(0, 10) : '??'
          return `${c.shortSha}  ${date}  ${c.author.slice(0, 20).padEnd(20)}  ${c.message.slice(0, 72)}`
        })
        return `${header}\n\n${'SHA      Date        Author               Message'.padEnd(120)}\n${'─'.repeat(110)}\n${rows.join('\n')}`
      }

      // ── check_ci_status ────────────────────────────────────────────────
      // Latest GitHub Actions workflow runs for a branch.
      case 'check_ci_status': {
        const targetBranch = (input.branch || branch || '').trim()
        const data = await getWorkflowRuns(token, owner, repo, targetBranch, 5)
        const runs = data?.workflow_runs || []

        if (runs.length === 0) {
          return `No workflow runs found for branch "${targetBranch}". CI may not be configured, or the branch has no push events yet.`
        }

        // Deduplicate by workflow name — keep most recent per workflow
        const seen = new Map()
        for (const run of runs) {
          if (!seen.has(run.name)) seen.set(run.name, run)
        }
        const latest = [...seen.values()]

        const statusIcon = (run) => {
          if (run.status === 'in_progress' || run.status === 'queued') return '◌'
          if (run.conclusion === 'success')   return '✓'
          if (run.conclusion === 'failure')   return '✗'
          if (run.conclusion === 'cancelled') return '○'
          return '?'
        }

        const overallPassing = latest.every(r => r.conclusion === 'success')
        const anyFailing     = latest.some(r  => r.conclusion === 'failure')
        const anyRunning     = latest.some(r  => r.status !== 'completed')

        const summary = anyRunning   ? `CI running on ${targetBranch}…`
                      : anyFailing   ? `CI FAILING on ${targetBranch}`
                      : overallPassing ? `CI passing on ${targetBranch} ✓`
                      : `CI status mixed on ${targetBranch}`

        const rows = latest.map(r => {
          const icon    = statusIcon(r)
          const created = (r.created_at || '').slice(0, 16).replace('T', ' ')
          const conc    = r.conclusion || r.status || 'unknown'
          return `${icon}  ${r.name.slice(0, 40).padEnd(40)}  ${conc.padEnd(12)}  ${created}  ${r.html_url}`
        })

        return `${summary}\n\n${rows.join('\n')}`
      }

      // ── create_github_issue ────────────────────────────────────────────
      // Opens a GitHub issue for a discovered bug or future task.
      case 'create_github_issue': {
        if (!input.title?.trim()) return 'create_github_issue: title is required.'
        try {
          const issue = await createIssue(
            token, owner, repo,
            input.title.trim(),
            input.body || '',
            input.labels || [],
          )
          return issue?.html_url
            ? `Issue created: ${issue.html_url} (#${issue.number}) — "${issue.title}"`
            : 'Issue creation failed — no URL returned.'
        } catch (err) {
          return `create_github_issue failed: ${err.message}`
        }
      }

      // ── resolve_merge_conflict ─────────────────────────────────────────
      // Cleans up <<<<<<< / ======= / >>>>>>> markers from a file.
      case 'resolve_merge_conflict': {
        if (!input.path?.trim()) return 'resolve_merge_conflict: path is required.'

        const file = await getFileContent(token, owner, repo, input.path, branch)
        if (!file?.content) return `File not found: ${input.path}`
        const original = decodeBase64(file.content)

        // Sanity check — does the file actually have conflict markers?
        const markerCount = (original.match(/^<{7}/gm) || []).length
        if (markerCount === 0) return `No conflict markers found in ${input.path}.`

        let resolved
        if (input.resolution === 'manual') {
          if (!input.manual_content?.trim())
            return 'resolve_merge_conflict: manual_content is required when resolution is "manual".'
          // Verify manual_content has no remaining markers
          if (/^[<=>]{7}/m.test(input.manual_content))
            return 'resolve_merge_conflict: manual_content still contains conflict markers — resolve them first.'
          resolved = input.manual_content
        } else {
          const result = resolveConflictMarkers(original, input.resolution)
          if (result.unclosed)
            return `resolve_merge_conflict: unclosed conflict block detected in ${input.path} — file may be malformed.`
          resolved = result.resolved
        }

        const msg = input.message || `fix(${input.path.split('/').pop()}): resolve merge conflict (${input.resolution})`
        await createOrUpdateFile(token, owner, repo, input.path, resolved, msg, branch, file.sha)
        onFileWrite?.(input.path, 'edit')

        const resolvedCount = markerCount
        return `resolve_merge_conflict: ${resolvedCount} conflict(s) resolved in ${input.path} using "${input.resolution}" strategy ✓`
      }

      // ── multi_edit_file ────────────────────────────────────────────────
      // Applies N edits to a single file in one read → patch → write cycle.
      case 'multi_edit_file': {
        const edits = input.edits || []
        if (edits.length === 0) return 'multi_edit_file: edits array is empty.'

        const file = await getFileContent(token, owner, repo, input.path, branch)
        if (!file?.content) return `File not found: ${input.path}`
        let current = decodeBase64(file.content)
        const fileSha = file.sha
        const applied = []
        const failed  = []

        for (let i = 0; i < edits.length; i++) {
          const { old_str, new_str } = edits[i]
          if (!current.includes(old_str)) {
            // Try indent-normalised match
            const normContent = current.split('\n').map(l => l.trimStart()).join('\n')
            const normOld     = old_str.split('\n').map(l => l.trimStart()).join('\n')
            if (normContent.includes(normOld)) {
              failed.push(`Edit ${i + 1}: matched only after stripping indentation — use exact whitespace from read_file.`)
            } else {
              const similar = findSimilarLines(current, old_str)
              failed.push(`Edit ${i + 1}: old_str not found.${similar ? `\nClosest match:\n${similar}` : ''}`)
            }
          } else {
            current = current.replace(old_str, new_str)
            applied.push(i + 1)
          }
        }

        if (failed.length > 0) {
          const summary = applied.length
            ? `Applied ${applied.length}/${edits.length} edits, then stopped — fix errors before retrying:\n${failed.join('\n')}`
            : `No edits applied:\n${failed.join('\n')}`
          return summary
        }

        const msg = input.message || `refactor(${input.path.split('/').pop()}): apply ${edits.length} edits`
        await createOrUpdateFile(token, owner, repo, input.path, current, msg, branch, fileSha)
        onFileWrite?.(input.path, 'edit')
        return `multi_edit_file: applied ${edits.length} edit(s) to ${input.path} ✓`
      }

      // ── search_replace_many ────────────────────────────────────────────
      // Bulk find-and-replace across all (or glob-filtered) indexed files.
      case 'search_replace_many': {
        if (!shadowContext.isReady)
          return 'Codebase index not ready — try again once indexing completes.'

        const { pattern, replacement, path_glob, literal, dry_run, message: userMsg } = input
        if (!pattern) return 'search_replace_many: pattern is required.'

        // Build regex
        let re
        try {
          re = literal ? null : new RegExp(pattern, 'g')
        } catch (e) {
          return `search_replace_many: invalid regex — ${e.message}. Set literal: true for plain string search.`
        }

        // Candidate files: grep index for matches, then optionally filter by glob
        let candidates = shadowContext.grepContent(literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, null, '') || []
        candidates = [...new Set(candidates.map(r => r.path))]

        if (path_glob) {
          const globRe = globToRegex(path_glob)
          candidates = candidates.filter(p => globRe.test(p))
        }

        if (candidates.length === 0) return `No files contain a match for: ${pattern}`

        if (dry_run) {
          return `Dry run — ${candidates.length} file(s) would be changed:\n${candidates.join('\n')}`
        }

        const changed = [], errors = []
        for (const filePath of candidates) {
          try {
            const file = await getFileContent(token, owner, repo, filePath, branch)
            if (!file?.content) { errors.push(`${filePath}: not found`); continue }
            const original = decodeBase64(file.content)
            const updated  = literal
              ? original.split(pattern).join(replacement)
              : original.replace(re, replacement)
            if (updated === original) continue  // index hit but content already changed
            const msg = userMsg
              ? `${userMsg}: ${filePath.split('/').pop()}`
              : buildCommitMsg('edit', filePath, null)
            await createOrUpdateFile(token, owner, repo, filePath, updated, msg, branch, file.sha)
            onFileWrite?.(filePath, 'edit')
            changed.push(filePath)
          } catch (err) {
            errors.push(`${filePath}: ${err.message}`)
          }
        }

        const lines = [`search_replace_many: ${changed.length} file(s) changed.`]
        if (changed.length)  lines.push(`Changed:\n${changed.map(p => `  ${p}`).join('\n')}`)
        if (errors.length)   lines.push(`Errors:\n${errors.map(e => `  ${e}`).join('\n')}`)
        return lines.join('\n')
      }

      // ── move_file ──────────────────────────────────────────────────────
      // Copies content to a new path, deletes old path, surfaces import refs.
      case 'move_file': {
        if (!input.from?.trim() || !input.to?.trim()) return 'move_file: from and to are required.'
        if (input.from === input.to) return 'move_file: from and to are the same path.'

        const file = await getFileContent(token, owner, repo, input.from, branch)
        if (!file?.content) return `File not found: ${input.from}`
        const content = decodeBase64(file.content)

        // Write to new path
        const existingDest = await getFileContent(token, owner, repo, input.to, branch)
        const writeMsg = input.message || `refactor: move ${input.from.split('/').pop()} → ${input.to.split('/').pop()}`
        await createOrUpdateFile(token, owner, repo, input.to, content, writeMsg, branch, existingDest?.sha || null)
        onFileWrite?.(input.to, 'write')

        // Delete old path
        await deleteFile(token, owner, repo, input.from, file.sha, `chore: remove ${input.from} (moved to ${input.to})`, branch)
        onFileWrite?.(input.from, 'delete')

        // Surface import references for the caller to update
        const lines = [`Moved: ${input.from} → ${input.to} ✓`]
        const doImports = input.update_imports !== false
        if (doImports && shadowContext.isReady) {
          const oldName  = input.from.replace(/\.[^/.]+$/, '')   // strip extension
          const baseName = oldName.split('/').pop()
          const refs = shadowContext.grepContent(baseName, null, '') || []
          const importingFiles = [...new Set(
            refs
              .filter(r => r.path !== input.from && r.text.match(/import|require/))
              .map(r => r.path)
          )]
          if (importingFiles.length > 0) {
            lines.push(`\n${importingFiles.length} file(s) may need import updates (old path: ${input.from}):\n${importingFiles.map(p => `  ${p}`).join('\n')}`)
            lines.push(`\nRun search_replace_many to update them, e.g.:\n  pattern: "${baseName}", replacement: "${input.to.replace(/\.[^/.]+$/, '').split('/').pop()}"`)
          } else {
            lines.push('No import references found that need updating.')
          }
        }
        return lines.join('\n')
      }

      // ── apply_patch ────────────────────────────────────────────────────
      // Applies a unified diff to a file with fuzzy hunk matching (±10 lines).
      case 'apply_patch': {
        if (!input.patch?.trim()) return 'apply_patch: patch is required.'

        const file = await getFileContent(token, owner, repo, input.path, branch)
        if (!file?.content) return `File not found: ${input.path}`
        const original = decodeBase64(file.content)

        const hunks = parsePatchHunks(input.patch)
        const result = applyHunks(original, hunks)

        if (!result.ok) return `apply_patch failed: ${result.error}`

        const msg = input.message || buildCommitMsg('edit', input.path, null)
        await createOrUpdateFile(token, owner, repo, input.path, result.content, msg, branch, file.sha)
        onFileWrite?.(input.path, 'edit')

        const oldCount = hunks.reduce((n, h) => n + h.lines.filter(l => l[0] === '-').length, 0)
        const newCount = hunks.reduce((n, h) => n + h.lines.filter(l => l[0] === '+').length, 0)
        return `apply_patch: ${input.path} — ${hunks.length} hunk(s) applied, -${oldCount} +${newCount} lines ✓`
      }

      // ── get_diff ───────────────────────────────────────────────────────
      // Compares two refs (branch, tag, SHA) and returns a unified diff.
      // Falls back to GitHub Compare API when exec bridge is unavailable.
      case 'get_diff': {
        const head = (input.head || branch || '').trim()
        const base = (input.base || 'main').trim()

        // Prefer exec bridge — shows uncommitted changes and is faster
        if (bridgeAvailable) {
          const pathArg = input.path ? `-- "${input.path}"` : ''
          const out = await execBridge(`git diff ${base}...${head} ${pathArg} 2>&1 | head -400`, null)
          if (out && !out.includes('bridge unavailable')) {
            return out.trim() || `No differences between ${base} and ${head}.`
          }
        }

        // Fall back to GitHub Compare API
        try {
          const comparison = await compareCommits(token, owner, repo, base, head)
          const allFiles = comparison.files || []
          const files = input.path
            ? allFiles.filter(f => f.filename === input.path || f.filename.startsWith(input.path + '/'))
            : allFiles

          if (files.length === 0) {
            return input.path
              ? `No differences for ${input.path} between ${base} and ${head}.`
              : `No differences between ${base} and ${head}.`
          }

          const header = [
            `Comparing ${base}...${head}`,
            `${comparison.ahead_by ?? '?'} commit(s) ahead, ${comparison.behind_by ?? '?'} behind`,
            `${files.length} file(s) changed (showing up to 20)`,
            '',
          ]
          const patches = files.slice(0, 20).map(f => {
            const stat = `+${f.additions}/-${f.deletions}`
            const patchBlock = f.patch ? `\n${f.patch.slice(0, 4000)}` : ' (binary or too large)'
            return `## ${f.status}: ${f.filename} (${stat})${patchBlock}`
          })
          return [...header, ...patches].join('\n').slice(0, 20000)
        } catch (err) {
          return `get_diff failed: ${err.message}`
        }
      }

      // ── type_check ─────────────────────────────────────────────────────
      // Runs tsc --noEmit and returns structured errors with file/line/message.
      case 'type_check': {
        if (!bridgeAvailable) return 'type_check requires the exec bridge (run with npm run dev).'

        const raw = await execBridge('npx tsc --noEmit 2>&1 | head -150', null)
        if (!raw || (raw.includes('bridge') && raw.includes('unavailable'))) return 'exec bridge unavailable.'

        // Filter to requested path if given
        const rawLines = raw.split('\n')
        const relevant = input.path
          ? rawLines.filter(l => !l.match(/^[^\s].*\(\d+,\d+\):/) || l.includes(input.path))
          : rawLines

        // Parse "file(line,col): error|warning TSxxxx: message"
        const errorRe = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/
        const errors = []
        for (const line of relevant) {
          const m = line.match(errorRe)
          if (m) errors.push({
            file:     m[1].trim(),
            line:     Number(m[2]),
            col:      Number(m[3]),
            severity: m[4],
            code:     m[5],
            message:  m[6].trim(),
          })
        }

        if (errors.length === 0) {
          // tsc exited clean (or no TS errors in filtered path)
          return raw.includes('error TS')
            ? relevant.join('\n').slice(0, 3000) // unparseable output — return raw
            : `TypeScript check passed ✓${input.path ? ` (${input.path})` : ''}`
        }

        const label = errors.length === 1 ? '1 type error' : `${errors.length} type errors`
        return `${label}\n${JSON.stringify({ errorCount: errors.length, errors }, null, 2)}`
      }

      // ── run_tests ──────────────────────────────────────────────────────
      // Auto-detects Vitest, Jest, or npm test from package.json, runs the
      // suite, and returns a structured pass/fail summary + raw output tail.
      case 'run_tests': {
        if (!bridgeAvailable) return 'run_tests requires the exec bridge (run with npm run dev).'

        // Detect test runner from package.json
        let runner = 'npm'
        let testCmd = 'npm test -- --passWithNoTests 2>&1'
        try {
          const pkgFile = await getFileContent(token, owner, repo, 'package.json', branch)
          if (pkgFile?.content) {
            const pkg = JSON.parse(decodeBase64(pkgFile.content))
            const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
            const scripts = pkg.scripts || {}
            const pat   = input.test_pattern ? `-t "${input.test_pattern.replace(/"/g, '\\"')}"` : ''
            const path  = input.path ? `"${input.path}"` : ''

            if (deps['vitest'] || scripts.test?.includes('vitest')) {
              runner = 'vitest'
              testCmd = `npx vitest run ${path} ${pat} 2>&1`
            } else if (deps['jest'] || scripts.test?.includes('jest')) {
              runner = 'jest'
              testCmd = `npx jest ${path} ${pat} --no-coverage --passWithNoTests 2>&1`
            } else if (scripts.test) {
              runner = 'npm'
              testCmd = `npm test 2>&1`
            }
          }
        } catch { /* fall through to default */ }

        const raw = await execBridge(`${testCmd} | tail -80`, null)
        if (!raw || (raw.includes('bridge') && raw.includes('unavailable'))) return 'exec bridge unavailable.'

        // Parse pass/fail counts
        let passed = 0, failed = 0, skipped = 0
        // Vitest: "✓ 12 passed" / "× 2 failed" / "↓ 3 skipped"
        const vPass = raw.match(/(\d+)\s+passed/)
        const vFail = raw.match(/(\d+)\s+failed/)
        const vSkip = raw.match(/(\d+)\s+skipped/)
        if (vPass) passed  = Number(vPass[1])
        if (vFail) failed  = Number(vFail[1])
        if (vSkip) skipped = Number(vSkip[1])
        // Jest: "Tests: 5 passed, 1 failed, 6 total"
        const jLine = raw.match(/Tests:\s+(.+)/)
        if (jLine) {
          const jp = jLine[1].match(/(\d+) passed/);  if (jp) passed  = Number(jp[1])
          const jf = jLine[1].match(/(\d+) failed/);  if (jf) failed  = Number(jf[1])
          const js = jLine[1].match(/(\d+) skipped/); if (js) skipped = Number(js[1])
        }

        const icon    = failed > 0 ? '✗' : passed > 0 ? '✓' : '?'
        const summary = `${icon} ${runner}: ${passed} passed, ${failed} failed, ${skipped} skipped`
        return `${summary}\n\n${raw.slice(0, 6000)}`
      }

      // ── watch_process ──────────────────────────────────────────────────
      // Health-checks a running local service: HTTP probe + port listener + pgrep.
      case 'watch_process': {
        if (!bridgeAvailable) return 'watch_process requires the exec bridge (run with npm run dev).'

        const port        = Math.max(1, Math.min(Number(input.port) || 5173, 65535))
        const processName = (input.process_name || '').trim().replace(/"/g, '')
        const lines       = Math.max(5, Math.min(Number(input.lines) || 30, 200))
        const parts       = []

        // 1. HTTP probe
        const httpOut = await execBridge(
          `curl -s -o /dev/null -w "HTTP %{http_code} in %{time_total}s" http://localhost:${port}/ --max-time 5 2>&1`,
          null,
        )
        parts.push(`Port ${port} HTTP probe: ${httpOut.replace(/^exit \d+\n/, '').trim() || 'no response'}`)

        // 2. TCP listener
        const lsofOut = await execBridge(
          `lsof -i :${port} -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $1,$2,$9}' | head -5`,
          null,
        )
        const listener = lsofOut.replace(/^exit \d+\n/, '').trim()
        parts.push(listener ? `Listening: ${listener}` : `Nothing listening on :${port}`)

        // 3. Named process (optional)
        if (processName) {
          const pgrepOut = await execBridge(`pgrep -a -f "${processName}" 2>/dev/null | head -8`, null)
          const procs = pgrepOut.replace(/^exit \d+\n/, '').trim()
          parts.push(procs
            ? `Process "${processName}":\n${procs}`
            : `No process matching "${processName}".`)
        }

        // 4. Tail recent stdout/stderr if a log file exists
        const logOut = await execBridge(
          `tail -${lines} /tmp/bluswan-dev.log /tmp/vite.log /tmp/dev.log 2>/dev/null | tail -${lines}`,
          null,
        )
        const log = logOut.replace(/^exit \d+\n/, '').trim()
        if (log) parts.push(`Recent log (${lines} lines):\n${log.slice(0, 3000)}`)

        return parts.join('\n\n')
      }

      // ── browser_screenshot ─────────────────────────────────────────────
      // Takes a headless screenshot via Playwright CLI, saves PNG to repo,
      // returns GitHub URL + console errors. Falls back to HTML on failure.
      case 'browser_screenshot': {
        if (!bridgeAvailable) return 'browser_screenshot requires the exec bridge (run with npm run dev).'

        const port    = Math.max(1, Math.min(Number(input.port) || 5173, 65535))
        const url     = (input.url || `http://localhost:${port}`).replace(/"/g, '')
        const outFile = '/tmp/bluswan-screenshot.png'

        // Try Playwright CLI (zero-config, most modern JS projects have it)
        const pwOut = await execBridge(
          `npx --yes playwright screenshot "${url}" "${outFile}" --wait-for-timeout 4000 2>&1`,
          null,
        )
        const pwExit   = Number((pwOut.match(/^exit (\d+)/) || [])[1] ?? 1)
        const pwStdout = pwOut.replace(/^exit \d+\n/, '').trim()

        if (pwExit !== 0) {
          // Playwright unavailable or failed — return HTML snippet instead
          const htmlOut = await execBridge(
            `curl -s "${url}" --max-time 8 2>&1 | head -80`,
            null,
          )
          const html = htmlOut.replace(/^exit \d+\n/, '').trim()
          return [
            `browser_screenshot: Playwright not available (${pwStdout.slice(0, 120)}).`,
            `Falling back to raw HTML from ${url}:`,
            html.slice(0, 4000),
          ].join('\n')
        }

        // Read screenshot as base64 and commit to repo
        const b64Out = await execBridge(`base64 -w 0 "${outFile}" 2>/dev/null`, null)
        const b64    = b64Out.replace(/^exit \d+\n/, '').trim()

        if (!b64 || b64.includes('unavailable')) {
          return `Screenshot taken but base64 read failed. Playwright output:\n${pwStdout.slice(0, 500)}`
        }

        const timestamp     = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')
        const screenshotPath = `screenshots/${timestamp}.png`
        try {
          const existing = await getFileContent(token, owner, repo, screenshotPath, branch)
          await createOrUpdateFile(
            token, owner, repo, screenshotPath, b64,
            `chore: screenshot ${timestamp}`, branch, existing?.sha || null,
          )
          onFileWrite?.(screenshotPath, 'write')
          const lines = [
            `Screenshot saved: ${screenshotPath}`,
            `GitHub: https://github.com/${owner}/${repo}/blob/${branch}/${screenshotPath}`,
            `URL captured: ${url}`,
          ]
          if (pwStdout) lines.push(`Playwright output: ${pwStdout.slice(0, 200)}`)
          return lines.join('\n')
        } catch (err) {
          return `Screenshot taken but upload failed: ${err.message}\nPlaywright: ${pwStdout.slice(0, 300)}`
        }
      }

      // ── find_symbol (Phase 1: code intelligence) ───────────────────────
      case 'find_symbol': {
        const mode     = input.mode || 'definition'
        const symName  = String(input.name || '').trim()
        if (!symName) return 'find_symbol requires a non-empty name.'
        if (!codeIntelligence.isReady) {
          return `Code intelligence index not ready (${codeIntelligence.fileCount()} files indexed). The index builds automatically on the next agent loop start.`
        }
        return codeIntelligence.formatResult(mode, symName)
      }

      // ── find_usages (Phase 1: code intelligence) ───────────────────────
      case 'find_usages': {
        const symName = String(input.name || '').trim()
        if (!symName) return 'find_usages requires a non-empty name.'
        if (!codeIntelligence.isReady) {
          return `Code intelligence index not ready. The index builds automatically on the next agent loop start.`
        }
        return codeIntelligence.formatResult('usages', symName)
      }

      // ── run_tdd_loop (Phase 1: TDD loop) ───────────────────────────────
      case 'run_tdd_loop': {
        if (!bridgeAvailable) {
          return 'run_tdd_loop requires the exec bridge (npm run dev). The exec bridge is currently offline.'
        }
        const result = await runTDDLoop({
          spec:           String(input.spec || ''),
          testCmd:        String(input.test_cmd || 'npm test'),
          testFilePath:   input.test_file_path || null,
          implFilePath:   input.impl_file_path || null,
          executeTool:    rawExecuteTool,
          maxIterations:  input.max_iterations || undefined,
          onEvent:        (ev) => { /* TDD events flow through outer executeTool trace */ },
        })
        const statusEmoji = result.status === 'green' ? '✅' : result.status === 'red' ? '❌' : '⚠'
        return [
          `${statusEmoji} TDD loop finished: ${result.status.toUpperCase()}`,
          `Iterations: ${result.iterations}`,
          `Pass rate: ${Math.round(result.passRate * 100)}%`,
          result.filesChanged.length ? `Files changed: ${result.filesChanged.join(', ')}` : '',
          '',
          'Last test output (tail):',
          result.lastOutput.slice(-600),
        ].filter(Boolean).join('\n')
      }

      default:
        return `Unknown tool: ${name}`
    }
  }

  return async function executeTool(name, input = {}) {
    const loopStateOverride = input?.__loopState || null
    const normalizedInput = loopStateOverride
      ? Object.fromEntries(Object.entries(input || {}).filter(([k]) => k !== '__loopState'))
      : input
    if (loopStateOverride) setTraceLoopState(loopStateOverride)

    const trace = beginToolTrace(name, normalizedInput)
    const inputValidation = validateToolInput(name, normalizedInput)
    if (!inputValidation.ok) {
      const err = `Invalid input for ${name} (schema v${inputValidation.schemaVersion || schemaVersion()}): ${inputValidation.errors.join('; ')}`
      endToolTrace({ traceId: trace.traceId, toolName: name, input: normalizedInput, output: null, error: err, startedAt: trace.startedAt })
      if (loopStateOverride) setTraceLoopState(null)
      return err
    }

    try {
      let output = await rawExecuteTool(name, normalizedInput)
      const outputValidation = validateToolOutput(name, output)
      if (!outputValidation.ok) {
        const err = `Invalid output for ${name} (schema v${outputValidation.schemaVersion || schemaVersion()}): ${outputValidation.errors.join('; ')}`
        endToolTrace({ traceId: trace.traceId, toolName: name, input: normalizedInput, output, error: err, startedAt: trace.startedAt })
        return err
      }

      // ── Per-tool hooks (Phase 4) ────────────────────────────────────────
      // After write/edit operations on code files, optionally auto-run lint
      // and/or type-check and append results to the tool output.
      if (hooksConfig && bridgeAvailable) {
        const WRITE_OPS = new Set(['write_file', 'edit_file', 'multi_edit_file', 'apply_patch', 'move_file'])
        const CODE_RE   = /\.(js|jsx|ts|tsx)$/
        if (WRITE_OPS.has(name)) {
          const changedPath = normalizedInput.path || normalizedInput.to || null
          const hookLines = []

          if (hooksConfig.autoLintAfterWrite && changedPath && CODE_RE.test(changedPath)) {
            try {
              const lintOut = await rawExecuteTool('lint_file', { path: changedPath })
              hookLines.push(`\n[hook: lint] ${lintOut.slice(0, 400)}`)
            } catch { /* lint hook errors are non-fatal */ }
          }

          if (hooksConfig.autoTypeCheckAfterEdit && changedPath && CODE_RE.test(changedPath)) {
            try {
              const tcOut = await rawExecuteTool('type_check', { path: changedPath })
              hookLines.push(`\n[hook: type_check] ${tcOut.slice(0, 600)}`)
            } catch { /* type-check hook errors are non-fatal */ }
          }

          if (hookLines.length) output = output + hookLines.join('')
        }
      }

      endToolTrace({ traceId: trace.traceId, toolName: name, input: normalizedInput, output, error: null, startedAt: trace.startedAt })
      return output
    } catch (error) {
      endToolTrace({ traceId: trace.traceId, toolName: name, input: normalizedInput, output: null, error: error.message, startedAt: trace.startedAt })
      throw error
    } finally {
      if (loopStateOverride) setTraceLoopState(null)
    }
  }
}
