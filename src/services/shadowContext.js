// ─── ShadowContext — Phase 4 ─────────────────────────────────────────────────
// Background indexes the connected GitHub repo so BLUSWAN knows which files exist,
// what conventions the project uses, and can suggest file paths without asking.
// Now also indexes file contents (symbols, imports, previews) for content-aware
// relevance scoring and cached context delivery.
//
// Usage:
//   shadowContext.startIndexing(token, owner, repo, branch, onUpdate)
//   shadowContext.suggestFilePath(promptText)   → 'src/hooks/useSearch.jsx' | null
//   shadowContext.findRelevantFiles(query, n)   → [{path, name, ext, score}]
//   shadowContext.getConventions()              → {framework, testFramework, …}
//   shadowContext.getContextContent(query, n)   → [{path, content}]  (cached)

import { listDirectory, getFileContent } from './githubService.js'
import { decodeBase64 } from '../utils/base64.js'
import { memoryGraphService } from './memoryGraphService.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('ShadowContext')
import {
  SHADOW_MAX_FILES         as MAX_FILES,
  SHADOW_MAX_DEPTH         as MAX_DEPTH,
  SHADOW_MAX_CONTENT_FILES as MAX_CONTENT_FILES,
  SHADOW_MAX_CONTENT_SIZE  as MAX_CONTENT_SIZE,
  SHADOW_CACHE_TTL_MS      as CACHE_TTL,
  SHADOW_BATCH_SIZE        as BATCH_SIZE,
  SHADOW_CONTENT_CAP,
  SHADOW_PREVIEW_CAP,
  STYLE_EXCERPT_LINES,
} from '../config/constants.js'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv',
  'coverage', '.turbo', 'out', '.cache', 'vendor', '.idea', '.vscode',
  'storybook-static', '.expo', '.svelte-kit', 'public',
])

const CODE_EXTS = /\.(js|jsx|ts|tsx|py|go|rs|java|rb|css|scss|json|md|sh|yaml|yml|vue|svelte)$/i

// Source exts worth fetching content for (exclude json/yaml/md/sh which add noise)
const SRC_EXTS  = /\.(js|jsx|ts|tsx|py|go|rs|java|rb|css|scss|vue|svelte)$/i

// ─── Module-level singleton (survives React re-renders) ───────────────────────
class ShadowContextStore {
  constructor() {
    this._fileIndex    = []   // [{path, name, ext, size}]
    this._totalRepoFiles = 0  // includes non-code files for metadata accuracy
    this._contentIndex = {}   // {path: {full, preview, symbols, imports}}
    this._importGraph  = {}   // {path: [depPath, ...]}   — files this file imports
    this._importedBy   = {}   // {path: [consumerPath, ...]} — files that import this
    this._conventions  = null
    this._repoKey      = null
    this._config       = null
    this.bluswanMd       = null
    this.isIndexing    = false
    this.isReady       = false
    this._onUpdate     = null
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async startIndexing(token, owner, repo, branch, onUpdate) {
    const key = `${owner}/${repo}@${branch}`
    this._onUpdate = onUpdate

    // Check sessionStorage cache first
    try {
      const cached = sessionStorage.getItem(`shadow:${key}`)
      if (cached) {
        const { ts, index, totalRepoFiles, conventions, contentIndex } = JSON.parse(cached)
        if (Date.now() - ts < CACHE_TTL) {
          this._fileIndex    = index
          this._totalRepoFiles = totalRepoFiles || (index?.length || 0)
          this._conventions  = conventions
          this._contentIndex = contentIndex || {}
          this._repoKey      = key
          this.isReady       = true
          this._onUpdate?.()
          return
        }
      }
    } catch {}

    if (this.isIndexing && this._repoKey === key) return
    if (this._repoKey === key && this.isReady) return

    this._fileIndex    = []
    this._totalRepoFiles = 0
    this._contentIndex = {}
    this._importGraph  = {}
    this._importedBy   = {}
    this._conventions  = null
    this.bluswanMd       = null
    this._repoKey      = key
    this._config       = { token, owner, repo, branch }
    this.isReady       = false
    this.isIndexing    = true
    this._onUpdate?.()

    try {
      await this._crawl('', 0)
      await this._fetchContentBatch()   // build symbol/preview/import index
      this._buildImportGraph()          // derive dependency graph from imports
      await this._detectConventions()
      memoryGraphService.ingestShadowContext(this, key)
      this.isReady = true
      // Persist to sessionStorage
      try {
        sessionStorage.setItem(`shadow:${key}`, JSON.stringify({
          ts: Date.now(),
          index:        this._fileIndex,
          totalRepoFiles: this._totalRepoFiles,
          conventions:  this._conventions,
          contentIndex: this._contentIndex,
        }))
      } catch (e) {
        log.warn('failed to cache index to sessionStorage (quota exceeded?)', e.message)
      }
    } catch (e) {
      log.warn('indexing error', e.message)
    } finally {
      this.isIndexing = false
      this._onUpdate?.()
    }
  }

  getConventions() { return this._conventions }
  getBluswanMd()     { return this.bluswanMd }

  // Regex search across indexed file content.
  // Returns [{path, line, text}] — max 200 results.
  // Only covers files in the content index (~800 files max).
  grepContent(pattern, pathFilter = null, flags = '') {
    const results = []
    let re
    try { re = new RegExp(pattern, flags) } catch (e) { throw new Error(`Invalid regex: ${e.message}`) }
    for (const [path, entry] of Object.entries(this._contentIndex)) {
      if (pathFilter && !path.startsWith(pathFilter)) continue
      if (!entry.full) continue
      const lines = entry.full.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push({ path, line: i + 1, text: lines[i] })
          if (results.length >= 200) return results
        }
      }
    }
    return results
  }

  // Number of files in the content index (for diagnostics)
  indexedFileCount() { return Object.keys(this._contentIndex).length }

  // Aider-style repo map: a compact symbol index ranked by import-graph centrality.
  // Returns a string like:
  //   src/services/agentLoop.js: runAgentLoop, pruneMessages
  //   src/components/Bluswan.jsx: Bluswan
  // Ranked by in-degree (most-imported files first), token-budgeted by maxChars.
  buildRepoMap(maxChars = 3000) {
    const index = this._contentIndex
    if (!index || Object.keys(index).length === 0) return null

    // Compute import in-degree for each file
    const inDegree = {}
    for (const deps of Object.values(this._importGraph || {})) {
      for (const dep of deps) inDegree[dep] = (inDegree[dep] || 0) + 1
    }

    const ranked = Object.entries(index)
      .map(([path, entry]) => ({ path, symbols: entry.symbols || [], degree: inDegree[path] || 0 }))
      .filter(f => f.symbols.length > 0)
      .sort((a, b) => b.degree - a.degree || a.path.localeCompare(b.path))

    const lines = []
    let chars = 0
    for (const { path, symbols } of ranked) {
      const line = `${path}: ${symbols.slice(0, 12).join(', ')}`
      if (chars + line.length + 1 > maxChars) break
      lines.push(line)
      chars += line.length + 1
    }
    return lines.length ? lines.join('\n') : null
  }

  // Force reindexing (clears cache and re-crawls the repo)
  async reindex() {
    if (!this._config) return
    try {
      sessionStorage.removeItem(`shadow:${this._repoKey}`)
    } catch {}
    if (this._config) {
      const { token, owner, repo, branch } = this._config
      await this.startIndexing(token, owner, repo, branch, this._onUpdate)
    }
  }

  // Expose import graph for downstream planning/ordering
  getImportGraph() { return { ...this._importGraph } }

  // ── Content-aware relevance scoring ──────────────────────────────────────
  //
  // Score breakdown:
  //   +12  exact path segment match (e.g. query word = directory or stem name)
  //   +10  exact filename stem match
  //   +6   filename stem contains query word
  //   +3   path segment contains query word
  //   +10  exact symbol name match
  //   +6   symbol name contains query word
  //   +5   preview contains query word (capped — avoids large files dominating)
  //   +3   import path contains query word
  //   +2   extension matches inferred type (e.g. "hook" → .jsx/.tsx preferred)
  findRelevantFiles(query, limit = 5) {
    if (!this.isReady || this._fileIndex.length === 0) return []
    const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
    if (words.length === 0) return []

    // Infer type hints from query for extension bonus
    const queryL       = query.toLowerCase()
    const prefersReact = /hook|component|jsx|tsx|react/i.test(queryL)
    const prefersPy    = /python|django|flask|pytest/i.test(queryL)
    const prefersTest  = /test|spec|unit|integration/i.test(queryL)

    return this._fileIndex
      .map(f => {
        const pathL    = f.path.toLowerCase()
        const segments = pathL.split('/')
        const nameL    = f.name.toLowerCase().replace(/\.[^.]+$/, '')
        const ci       = this._contentIndex[f.path]
        let score      = 0

        for (const w of words) {
          // Path-segment exact match (strongest signal)
          if (segments.some(seg => seg === w || seg.replace(/\.[^.]+$/, '') === w)) score += 12
          // Filename stem
          if (nameL === w)               score += 10
          else if (nameL.includes(w))    score += 6
          // Path segments partial
          if (segments.some(seg => seg !== nameL + '.' + f.ext && seg.includes(w))) score += 3

          // Symbol exact vs. contains
          if (ci?.symbols) {
            const symL = ci.symbols.map(s => s.toLowerCase())
            if (symL.some(s => s === w))           score += 10
            else if (symL.some(s => s.includes(w))) score += 6
          }

          // Preview (cap at +5 per word — avoids large files drowning small focused ones)
          if (ci?.preview?.toLowerCase().includes(w)) score += 5

          // Import paths
          if (ci?.imports?.some(im => im.toLowerCase().includes(w))) score += 3
        }

        // Extension preference bonus
        if (prefersReact && /\.(jsx|tsx)$/.test(f.name))  score += 2
        if (prefersPy    && f.ext === 'py')                score += 2
        if (prefersTest  && /\.(test|spec)\.[jt]sx?$/.test(f.name)) score += 4

        return { ...f, score }
      })
      .filter(f => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  // Returns the best file path for a prompt, or null if nothing is confident
  suggestFilePath(prompt) {
    if (!prompt?.trim() || !this.isReady || !this._conventions) return null
    const conv = this._conventions

    const existing = this.findRelevantFiles(prompt, 1)
    if (existing.length > 0 && existing[0].score >= 5) return existing[0].path

    const lower = prompt.toLowerCase()
    const nameMatch = lower.match(/\b(?:add|create|build|make|write|implement)\s+(?:a\s+)?(?:new\s+)?(\w+)/i)
    if (!nameMatch) return null

    const rawName = nameMatch[1]
    const ext = conv.framework === 'react'  ? (conv.language?.includes('TypeScript') ? '.tsx' : '.jsx')
              : conv.framework === 'vue'    ? '.vue'
              : conv.language?.includes('TypeScript') ? '.ts'
              : conv.language?.includes('Python')     ? '.py'
              : '.js'

    const name = conv.namingConvention === 'PascalCase'
      ? rawName.charAt(0).toUpperCase() + rawName.slice(1)
      : rawName.charAt(0).toLowerCase() + rawName.slice(1)

    const isHook      = lower.includes('hook') || /\buse[A-Z\s]/.test(prompt)
    const isComponent = /component|button|modal|form|card|panel|view|page/i.test(lower) && conv.framework === 'react'
    const isUtil      = /util|helper|service|api|handler|lib/i.test(lower)

    const base   = conv.srcDir || 'src'
    const subdir = isHook ? 'hooks' : isComponent ? 'components' : isUtil ? 'utils' : ''
    return subdir ? `${base}/${subdir}/${name}${ext}` : `${base}/${name}${ext}`
  }

  // Fetch top-N relevant files and return full content for context injection.
  // Uses the content index cache when available — avoids redundant API calls.
  // Expands selection via depth-2 import graph traversal (deps + consumers of top hits).
  async getContextContent(query, limit = 5) {
    if (!this.isReady || !this._config) return []
    const relevant = this.findRelevantFiles(query, limit + 4)
    if (relevant.length === 0) return []

    // Seed with direct results
    const seen = new Set(relevant.slice(0, limit).map(f => f.path))

    // Depth-2 import graph expansion: direct deps + their deps, direct consumers
    for (const f of relevant.slice(0, 3)) {
      const directDeps = this._importGraph[f.path] || []
      for (const dep of directDeps) {
        if (seen.size >= limit + 6) break
        seen.add(dep)
        // One level deeper
        for (const dep2 of (this._importGraph[dep] || []).slice(0, 2)) {
          if (seen.size >= limit + 6) break
          seen.add(dep2)
        }
      }
      for (const consumer of (this._importedBy[f.path] || []).slice(0, 2)) {
        if (seen.size >= limit + 6) break
        seen.add(consumer)
      }
    }

    const { token, owner, repo, branch } = this._config

    const results = await Promise.allSettled(
      [...seen].slice(0, limit).map(async path => {
        // Use the content cache first (saves API call + is instant)
        const ci = this._contentIndex[path]
        if (ci?.full) return { path, content: ci.full }

        // Fallback: fetch from GitHub.
        // Guard the content index size so on-demand fetches can't grow it
        // past the initial cap (prevents unbounded memory growth in long sessions).
        const file = await getFileContent(token, owner, repo, path, branch)
        if (!file?.content) return null
        const content = decodeBase64(file.content)
        if (Object.keys(this._contentIndex).length < MAX_CONTENT_FILES) {
          this._contentIndex[path] = {
            full:    content.slice(0, SHADOW_CONTENT_CAP),
            preview: content.slice(0, SHADOW_PREVIEW_CAP),
            symbols: this._extractSymbols(content),
            imports: this._extractImports(content),
          }
        }
        return { path, content: content.slice(0, SHADOW_CONTENT_CAP) }
      })
    )
    return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value)
  }

  // Returns short excerpts from files stylistically relevant to the query.
  // Strips import lines so the excerpt shows actual implementation patterns.
  // Used to inject "match this style" examples into generation prompts.
  getStyleExamples(query, limit = 3) {
    if (!this.isReady || Object.keys(this._contentIndex).length === 0) return []
    const relevant = this.findRelevantFiles(query, limit + 3)
    const results = []
    for (const f of relevant) {
      const ci = this._contentIndex[f.path]
      if (!ci?.full) continue
      // Skip pure config / data files — they're not style patterns
      if (/\.(json|yaml|yml|md|sh|env)$/i.test(f.name)) continue
      const lines = ci.full.split('\n')
      // Drop leading import/require block so the excerpt shows real implementation
      const implStart = lines.findIndex(l => {
        const t = l.trimStart()
        return t.length > 0 && !t.startsWith('import ') && !t.startsWith('from ') &&
               !t.startsWith('require(') && !t.startsWith('//')  && !t.startsWith('#!')
      })
      const implLines = implStart >= 0 ? lines.slice(implStart) : lines
      const excerpt = implLines.slice(0, STYLE_EXCERPT_LINES).join('\n').trim()
      if (excerpt.length > 30) {
        results.push({ path: f.path, excerpt })
      }
      if (results.length >= limit) break
    }
    return results
  }

  // Returns a short human-readable summary for the UI badge
  statusSummary() {
    if (this.isIndexing) return `indexing…`
    if (!this.isReady)   return null
    const c            = this._conventions
    const label        = [c?.framework !== 'unknown' ? c?.framework : '', c?.language].filter(Boolean).join(' · ')
    const contentCount = Object.keys(this._contentIndex).length
    return `${this._totalRepoFiles} files · ${this._fileIndex.length} code files · ${contentCount} indexed · ${label}`
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async _crawl(dirPath, depth) {
    if (depth > MAX_DEPTH || this._fileIndex.length >= MAX_FILES || !this._config) return
    const { token, owner, repo, branch } = this._config

    let items
    try {
      items = await listDirectory(token, owner, repo, dirPath, branch)
    } catch { return }

    for (const item of items) {
      if (this._fileIndex.length >= MAX_FILES) break
      if (item.type === 'dir') {
        if (SKIP_DIRS.has(item.name)) continue
        await this._crawl(item.path, depth + 1)
      } else {
        this._totalRepoFiles += 1
        if (!CODE_EXTS.test(item.name)) continue
        const ext = item.name.split('.').pop()?.toLowerCase() || ''
        this._fileIndex.push({ path: item.path, name: item.name, ext, size: item.size || 0 })
      }
    }
  }

  // Fetch file contents for the most relevant source files.
  // Prioritises smaller files (more focused) and proper source extensions.
  async _fetchContentBatch() {
    if (!this._config) return
    const { token, owner, repo, branch } = this._config

    const candidates = this._fileIndex
      .filter(f => SRC_EXTS.test(f.name) && (f.size || 0) <= MAX_CONTENT_SIZE && f.size > 0)
      .sort((a, b) => (a.size || 0) - (b.size || 0))
      .slice(0, MAX_CONTENT_FILES)

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE)
      await Promise.allSettled(batch.map(async f => {
        try {
          const file = await getFileContent(token, owner, repo, f.path, branch)
          if (!file?.content) return
          const content = decodeBase64(file.content)
          this._contentIndex[f.path] = {
            full:    content.slice(0, SHADOW_CONTENT_CAP),
            preview: content.slice(0, SHADOW_PREVIEW_CAP),
            symbols: this._extractSymbols(content),
            imports: this._extractImports(content),
          }
        } catch (e) {
          log.warn('failed to fetch content for ' + f.path, e.message)
        }
      }))
    }
  }

  // Build a dependency graph from the import data already in _contentIndex.
  // Resolves relative imports to known file paths in _fileIndex.
  _buildImportGraph() {
    this._importGraph = {}
    this._importedBy  = {}

    const pathSet = new Set(this._fileIndex.map(f => f.path))

    for (const [filePath, ci] of Object.entries(this._contentIndex)) {
      const dir = filePath.split('/').slice(0, -1).join('/')
      const resolved = []

      for (const imp of (ci.imports || [])) {
        if (!imp.startsWith('.')) continue   // skip external packages

        // Normalize the relative path
        const parts = imp.split('/')
        const segments = dir ? dir.split('/') : []
        for (const part of parts) {
          if (part === '..') segments.pop()
          else if (part !== '.') segments.push(part)
        }
        const base = segments.join('/')

        // Find a matching file (with or without extension, handles index files)
        const match = this._fileIndex.find(f =>
          f.path === base ||
          f.path.startsWith(base + '.') ||
          f.path === base + '/index.js'  ||
          f.path === base + '/index.ts'  ||
          f.path === base + '/index.jsx' ||
          f.path === base + '/index.tsx'
        )
        if (match && !resolved.includes(match.path)) resolved.push(match.path)
      }

      this._importGraph[filePath] = resolved
      for (const dep of resolved) {
        if (!this._importedBy[dep]) this._importedBy[dep] = []
        if (!this._importedBy[dep].includes(filePath)) this._importedBy[dep].push(filePath)
      }
    }
  }

  // Extract function, class, and top-level const names from source.
  //
  // Improvements over original:
  //   • Exported symbols are collected first and tagged so buildRepoMap can
  //     prioritise them; the AI benefits most from knowing the public API.
  //   • `export { Name, Name as Alias }` named-export lists are now captured.
  //   • Arrow-function consts (const handler = async () => {}) are detected by
  //     checking whether the RHS starts with a function/arrow expression.
  //   • React hooks (camelCase functions starting with 'use') are recognised.
  //   • Single-character names and generic noise ('i', 'e', 'tmp') are filtered.
  _extractSymbols(content) {
    const str = String(content || '')
    const seen = new Set()
    // Exported symbols collected first so they appear at the top of the list
    const exported = []
    const internal = []

    function add(name, isExport) {
      if (!name || name.length < 2) return
      // Filter obvious noise: loop vars, single-letter, generic names
      if (/^(i|j|k|e|n|m|x|y|v|d|t|r|s|f|p|el|ev|fn|cb|ok|id|op|tmp|err|res|req|key|val|obj|arr|ctx|ref|idx|len|cnt|row|col|buf|ptr)$/.test(name)) return
      if (seen.has(name)) return
      seen.add(name)
      if (isExport) exported.push(name)
      else internal.push(name)
    }

    // ── Pattern 1: export { Name, Other as Alias, … } ──────────────────────
    const namedExportBlock = /export\s*\{([^}]+)\}/gm
    let m
    while ((m = namedExportBlock.exec(str)) !== null) {
      for (const part of m[1].split(',')) {
        // Handle "Name as Alias" — the exported name is the alias
        const alias = part.match(/\bas\s+(\w+)/)
        const orig  = part.match(/^\s*(\w+)/)
        add(alias ? alias[1] : orig?.[1], true)
      }
    }

    // ── Pattern 2: export (default)? (async)? function/class Name ──────────
    const exportedDecl = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+))/gm
    while ((m = exportedDecl.exec(str)) !== null) add(m[1] || m[2], true)

    // ── Pattern 3: export const/let Name = (function / arrow / class) ───────
    const exportedConst = /^export\s+(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:\(|function\s*\(|class\s*[\{(])/gm
    while ((m = exportedConst.exec(str)) !== null) add(m[1], true)

    // ── Pattern 4: export default function / class (anonymous OK) ────────────
    const exportDefault = /^export\s+default\s+(?:async\s+)?(?:function|class)\s+(\w+)/gm
    while ((m = exportDefault.exec(str)) !== null) add(m[1], true)

    // ── Pattern 5: internal function / class declarations ────────────────────
    const internalDecl = /^(?:async\s+)?function\s+(\w+)|^class\s+(\w+)/gm
    while ((m = internalDecl.exec(str)) !== null) add(m[1] || m[2], false)

    // ── Pattern 6: React hooks — const useX = (…) => / function useX ────────
    const hooks = /\bconst\s+(use[A-Z]\w+)\s*=|function\s+(use[A-Z]\w+)\s*\(/gm
    while ((m = hooks.exec(str)) !== null) add(m[1] || m[2], /^export\b/.test(str.slice(Math.max(0, m.index - 10), m.index + 5)))

    // ── Pattern 7: Python def / Go func / TypeScript type|interface ──────────
    const otherLang = /^(?:def\s+(\w+)\s*\(|func\s+(\w+)\s*[\({]|type\s+(\w+)\s*[=\{]|interface\s+(\w+)\s*\{)/gm
    while ((m = otherLang.exec(str)) !== null) add(m[1] || m[2] || m[3] || m[4], false)

    // Exported symbols first, then internal — up to 60 total
    return [...exported, ...internal].slice(0, 60)
  }

  // Extract imported module paths
  _extractImports(content) {
    const imports = []
    const re = /(?:import\s+(?:[\w\s{},*]+\s+from\s+)?['"](.+?)['"]|require\(\s*['"](.+?)['"]\s*\)|from\s+['"](.+?)['"]\s+import)/gm
    let m
    while ((m = re.exec(content)) !== null) {
      const src = m[1] || m[2] || m[3]
      if (src && !imports.includes(src)) imports.push(src)
    }
    return imports.slice(0, 40)
  }

  async _detectConventions() {
    const paths = this._fileIndex.map(f => f.path)
    const names = this._fileIndex.map(f => f.name)

    // Framework
    let framework = 'unknown'
    if (paths.some(p => /\.(jsx|tsx)$/.test(p)))       framework = 'react'
    else if (paths.some(p => /\.vue$/.test(p)))         framework = 'vue'
    else if (paths.some(p => /\.svelte$/.test(p)))      framework = 'svelte'
    else if (paths.some(p => /manage\.py$/.test(p)))    framework = 'django'
    else if (this._fileIndex.some(f => f.ext === 'go')) framework = 'go'
    else if (paths.some(p => /next\.config\./.test(p))) framework = 'next.js'
    else if (paths.some(p => /nuxt\.config\./.test(p))) framework = 'nuxt'
    else if (paths.some(p => /angular\.json/.test(p)))  framework = 'angular'

    // Test framework
    let testFramework = 'unknown'
    if (paths.some(p => /\.(test|spec)\.(jsx?|tsx?)$/.test(p)))  testFramework = 'jest/vitest'
    else if (paths.some(p => /\.(test|spec)\.py$/.test(p)))       testFramework = 'pytest'
    else if (paths.some(p => /\.(test|spec)\.go$/.test(p)))       testFramework = 'go test'
    else if (paths.some(p => /_spec\.rb$/.test(p)))               testFramework = 'rspec'

    // Primary language
    const extCounts = {}
    this._fileIndex.forEach(f => { extCounts[f.ext] = (extCounts[f.ext] || 0) + 1 })
    const primaryExt = Object.entries(extCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'js'
    const langMap = { js:'JavaScript', jsx:'JavaScript/React', ts:'TypeScript', tsx:'TypeScript/React',
                      py:'Python', go:'Go', rs:'Rust', java:'Java', rb:'Ruby', vue:'Vue', svelte:'Svelte',
                      c:'C', cpp:'C++', php:'PHP', kt:'Kotlin', scala:'Scala' }
    const language = langMap[primaryExt] || 'JavaScript'

    // Naming convention
    const fileStems = names.map(n => n.replace(/\.[^.]+$/, '')).filter(n => !['index','main','app'].includes(n))
    const hasPascal  = fileStems.some(n => /^[A-Z][a-z]/.test(n))
    const hasCamel   = fileStems.some(n => /^[a-z].*[A-Z]/.test(n))
    const hasKebab   = fileStems.some(n => /-/.test(n))
    const namingConvention = hasPascal ? 'PascalCase' : hasKebab ? 'kebab-case' : hasCamel ? 'camelCase' : 'camelCase'

    // Source directory
    const srcDir = paths.find(p => p.startsWith('src/')) ? 'src'
                 : paths.find(p => p.startsWith('app/')) ? 'app' : ''

    // Existing hook names (React)
    const hooks = this._fileIndex
      .filter(f => /\/use[A-Z]/.test(f.path))
      .map(f => f.name.replace(/\.[^.]+$/, ''))
      .slice(0, 8)

    // Fetch package.json for dependency info
    let deps = []
    if (this._config) {
      try {
        const { token, owner, repo, branch } = this._config
        const pkgFile = await getFileContent(token, owner, repo, 'package.json', branch)
        if (pkgFile?.content) {
          const pkg = JSON.parse(decodeBase64(pkgFile.content))
          deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
        }
      } catch {}
    }

    // Fetch tsconfig.json for path aliases (e.g. "@/*" → "src/*")
    let pathAliases = {}
    if (this._config) {
      try {
        const { token, owner, repo, branch } = this._config
        const tsconfigFile = await getFileContent(token, owner, repo, 'tsconfig.json', branch)
        if (tsconfigFile?.content) {
          // Strip single-line comments before parsing (tsconfig allows them)
          const raw = decodeBase64(tsconfigFile.content).replace(/\/\/[^\n]*/g, '')
          const tsconfig = JSON.parse(raw)
          const paths = tsconfig.compilerOptions?.paths || {}
          // Normalise: {"@/*": ["src/*"]} → {"@": "src"}
          for (const [alias, targets] of Object.entries(paths)) {
            const key    = alias.replace(/\/\*$/, '')
            const target = String(targets[0] || '').replace(/\/\*$/, '')
            if (key && target) pathAliases[key] = target
          }
        }
      } catch {}
    }

    // Fetch BLUSWAN.md for standing project instructions
    if (this._config) {
      try {
        const { token, owner, repo, branch } = this._config
        const bluswanFile = await getFileContent(token, owner, repo, 'BLUSWAN.md', branch)
        if (bluswanFile?.content) {
          this.bluswanMd = decodeBase64(bluswanFile.content)
        }
      } catch {}
    }

    this._conventions = {
      framework, testFramework, language, namingConvention,
      srcDir, hooks, deps, pathAliases, totalFiles: this._totalRepoFiles,
      contentIndexed: Object.keys(this._contentIndex).length,
    }
  }
}

export { ShadowContextStore }
export const shadowContext  = new ShadowContextStore()
export const shadowContext2 = new ShadowContextStore()
