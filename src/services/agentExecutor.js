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
//   update_memory     → appends note to LOGIK.md via GitHub API
//   run_command       → Vite exec bridge (POST /api/exec)
//   create_pull_request → GitHub Pulls API

import {
  getFileContent,
  createOrUpdateFile,
  deleteFile,
  listDirectory,
  createPullRequest,
  listFileCommits,
} from './githubService.js'
import { decodeBase64 } from '../utils/base64.js'
import { readLocalFile, writeLocalFile, listLocalDir } from './localFileService.js'
import { shadowContext } from './shadowContext.js'
import { EXEC_BRIDGE_TIMEOUT_MS } from '../config/constants.js'

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

export function makeExecutor({ token, owner, repo, branch, onFileWrite, sourceRepoConfig, webSearchApiKey, bridgeAvailable, localDirHandle }) {
  return async function executeTool(name, input) {
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
        let content
        if (localDirHandle) {
          try { content = await readLocalFile(localDirHandle, input.path) }
          catch { return `File not found: ${input.path}` }
        } else {
          const file = await getFileContent(token, owner, repo, input.path, branch)
          if (!file?.content) return `File not found: ${input.path}`
          content = decodeBase64(file.content)
        }
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
          let content
          if (localDirHandle) {
            content = await readLocalFile(localDirHandle, p)
          } else {
            const file = await getFileContent(token, owner, repo, p, branch)
            if (!file?.content) return `--- ${p} ---\nFile not found.`
            content = decodeBase64(file.content)
          }
          return `--- ${p} (${content.split('\n').length} lines) ---\n${content.slice(0, 10000)}`
        }))
        return settled.map(r => r.status === 'fulfilled' ? r.value : `Error: ${r.reason}`).join('\n\n')
      }

      // ── write_file ─────────────────────────────────────────────────────
      case 'write_file': {
        if (localDirHandle) {
          await writeLocalFile(localDirHandle, input.path, input.content)
        } else {
          const existing = await getFileContent(token, owner, repo, input.path, branch)
          const sha      = existing?.sha || null
          const msg      = buildCommitMsg(sha ? 'edit' : 'write', input.path, input.message)
          await createOrUpdateFile(token, owner, repo, input.path, input.content, msg, branch, sha)
        }
        onFileWrite?.(input.path, 'write')
        return `Written: ${input.path} (${input.content.split('\n').length} lines)`
      }

      // ── edit_file (with Aider-style similar-lines diagnostic on failure) ─
      case 'edit_file': {
        let current, fileSha
        if (localDirHandle) {
          try { current = await readLocalFile(localDirHandle, input.path) }
          catch { return `File not found: ${input.path}` }
        } else {
          const file = await getFileContent(token, owner, repo, input.path, branch)
          if (!file?.content) return `File not found: ${input.path}`
          current = decodeBase64(file.content)
          fileSha = file.sha
        }

        if (!current.includes(input.old_str)) {
          const normCurrent = current.split('\n').map(l => l.trimStart()).join('\n')
          const normOld     = input.old_str.split('\n').map(l => l.trimStart()).join('\n')
          if (!normCurrent.includes(normOld)) {
            const similar = findSimilarLines(current, input.old_str)
            const hint = similar
              ? `\n\nMost similar lines found in ${input.path}:\n${similar}\n\nCopy the exact text including all whitespace.`
              : `\n\nUse grep or read_file to confirm the exact text before retrying.`
            return `edit_file failed: old_str not found in ${input.path}.${hint}`
          }
          return `edit_file failed: old_str matched only after stripping indentation in ${input.path}. Use read_file (with start_line/end_line) to copy the exact whitespace.`
        }

        const updated = current.replace(input.old_str, input.new_str)
        if (localDirHandle) {
          await writeLocalFile(localDirHandle, input.path, updated)
        } else {
          const msg = buildCommitMsg('edit', input.path, input.message)
          await createOrUpdateFile(token, owner, repo, input.path, updated, msg, branch, fileSha)
        }
        onFileWrite?.(input.path, 'edit')
        return `Edited: ${input.path}`
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
        if (localDirHandle) {
          const items = await listLocalDir(localDirHandle, input.path || '')
          if (items.length === 0) return `Empty or not found: ${input.path || '/'}`
          return items.map(i => `${i.type === 'dir' ? 'd' : 'f'} ${i.path}`).join('\n')
        }
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

      // ── run_command ────────────────────────────────────────────────────
      case 'run_command': {
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
        const memPath = 'LOGIK.md'
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

      default:
        return `Unknown tool: ${name}`
    }
  }
}
