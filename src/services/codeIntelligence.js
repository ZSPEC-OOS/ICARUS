// ─── Code Intelligence Service ────────────────────────────────────────────────
// Browser-safe symbol extraction and cross-file reference graph built on
// advanced regex patterns (no Node.js AST parser required).
//
// Extracts from JS/TS/JSX/TSX/Vue/Svelte/Python source files:
//   • Function / arrow-function declarations with parameter signatures
//   • Class declarations (including extends chain)
//   • Named + default exports / re-exports
//   • Named + default imports + require() calls
//
// Builds a queryable symbol index that supports:
//   findDefinition(name)   → where is this symbol declared?
//   findUsages(name)       → every file/line that references it
//   findCallGraph(entry)   → shallow call graph from an entry point
//   query(text)            → fuzzy name search across the whole index
//
// Integrates with shadowContext's file list for content retrieval.
// The index is rebuilt lazily when the file count changes or the TTL expires.
//
// Integration:
//   • agentExecutor.js  — exposes as `find_symbol` and `find_usages` tools
//   • agentLoop.js      — calls buildIndex(shadowContext) on loop start

import {
  CODE_INTEL_MAX_SYMBOLS_PER_FILE,
  CODE_INTEL_CALL_GRAPH_DEPTH,
} from '../config/constants.js'

// ── Pattern library ───────────────────────────────────────────────────────────
// All patterns use the 'gm' flag and are reset via lastIndex before each scan.

const P = {
  // function foo(a, b) { / async function foo(
  FUNC_DECL:      /^[ \t]*(?:export\s+)?(?:async\s+)?function\s*([\w$]+)\s*\(([^)]{0,120})\)/gm,
  // const foo = (a, b) => / const foo = async (
  ARROW_FUNC:     /^[ \t]*(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?\(([^)]{0,120})\)\s*=>/gm,
  // const foo = function(a, b)
  FUNC_EXPR:      /^[ \t]*(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s+)?function\s*\(([^)]{0,120})\)/gm,
  // class Foo extends Bar
  CLASS_DECL:     /^[ \t]*(?:export\s+)?(?:abstract\s+)?class\s+([\w$]+)(?:\s+extends\s+([\w$.]+))?/gm,
  // foo(a, b) {  — method inside a class (indented)
  METHOD_DECL:    /^[ \t]{2,}(?:(?:async|static|get|set|override|public|private|protected)\s+){0,3}([\w$]+)\s*\(([^)]{0,120})\)\s*\{/gm,
  // export { foo, bar as Baz }
  NAMED_EXPORT:   /\bexport\s+\{\s*([^}]+)\}/gm,
  // export default Foo
  DEFAULT_EXPORT: /\bexport\s+default\s+([\w$]+)/gm,
  // export * from './other'
  REEXPORT:       /\bexport\s+\*(?:\s+as\s+([\w$]+))?\s+from\s+['"]([^'"]+)['"]/gm,
  // import { foo, bar as b } from './mod'
  IMPORT_NAMED:   /\bimport\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gm,
  // import Foo from './mod'
  IMPORT_DEFAULT: /\bimport\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]/gm,
  // import * as ns from './mod'
  IMPORT_STAR:    /\bimport\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]/gm,
  // const x = require('./mod')
  REQUIRE:        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
  // Python def foo(a, b):
  PY_FUNC:        /^[ \t]*(?:async\s+)?def\s+([\w]+)\s*\(([^)]{0,120})\)\s*(?:->.*?)?:/gm,
  // Python class Foo(Bar):
  PY_CLASS:       /^[ \t]*class\s+([\w]+)\s*(?:\(([^)]{0,80})\))?:/gm,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** 1-based line number for a character offset inside text. */
function lineAt(text, index) {
  let n = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') n++
  }
  return n
}

/** Normalise a parameter list string for display. */
function cleanParams(raw = '') {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** Escape a string for safe use inside a RegExp. */
function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** File extensions to index. */
const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.py'])
function isCodeFile(path = '') {
  const dot = path.lastIndexOf('.')
  return dot !== -1 && CODE_EXTS.has(path.slice(dot).toLowerCase())
}

// ── Symbol extraction ─────────────────────────────────────────────────────────

/**
 * Extract all symbols declared in a single file.
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {FileSymbols}
 */
export function extractSymbols(content = '', filePath = '') {
  const text    = String(content)
  const isPy    = filePath.endsWith('.py')
  const symbols = []
  const exports = []
  const imports = []

  let m

  if (isPy) {
    // ── Python ────────────────────────────────────────────────────────────
    P.PY_FUNC.lastIndex = 0
    while ((m = P.PY_FUNC.exec(text)) !== null && symbols.length < CODE_INTEL_MAX_SYMBOLS_PER_FILE) {
      symbols.push({ name: m[1], kind: 'function', params: cleanParams(m[2]), file: filePath, line: lineAt(text, m.index), exported: !m[0].startsWith('    ') })
    }
    P.PY_CLASS.lastIndex = 0
    while ((m = P.PY_CLASS.exec(text)) !== null && symbols.length < CODE_INTEL_MAX_SYMBOLS_PER_FILE) {
      symbols.push({ name: m[1], kind: 'class', extends: m[2]?.split(',')[0]?.trim() || null, file: filePath, line: lineAt(text, m.index), exported: true })
    }
  } else {
    // ── JS/TS/JSX/TSX ─────────────────────────────────────────────────────

    P.FUNC_DECL.lastIndex = 0
    while ((m = P.FUNC_DECL.exec(text)) !== null && symbols.length < CODE_INTEL_MAX_SYMBOLS_PER_FILE) {
      const exported = /\bexport\b/.test(m[0])
      symbols.push({ name: m[1], kind: 'function', params: cleanParams(m[2]), file: filePath, line: lineAt(text, m.index), exported })
      if (exported) exports.push(m[1])
    }

    P.ARROW_FUNC.lastIndex = 0
    while ((m = P.ARROW_FUNC.exec(text)) !== null && symbols.length < CODE_INTEL_MAX_SYMBOLS_PER_FILE) {
      const exported = /\bexport\b/.test(m[0])
      symbols.push({ name: m[1], kind: 'arrow', params: cleanParams(m[2]), file: filePath, line: lineAt(text, m.index), exported })
      if (exported) exports.push(m[1])
    }

    P.FUNC_EXPR.lastIndex = 0
    while ((m = P.FUNC_EXPR.exec(text)) !== null && symbols.length < CODE_INTEL_MAX_SYMBOLS_PER_FILE) {
      const exported = /\bexport\b/.test(m[0])
      if (!symbols.find(s => s.name === m[1] && s.file === filePath)) {
        symbols.push({ name: m[1], kind: 'function-expr', params: cleanParams(m[2]), file: filePath, line: lineAt(text, m.index), exported })
        if (exported) exports.push(m[1])
      }
    }

    P.CLASS_DECL.lastIndex = 0
    while ((m = P.CLASS_DECL.exec(text)) !== null && symbols.length < CODE_INTEL_MAX_SYMBOLS_PER_FILE) {
      const exported = /\bexport\b/.test(m[0])
      symbols.push({ name: m[1], kind: 'class', extends: m[2] || null, file: filePath, line: lineAt(text, m.index), exported })
      if (exported) exports.push(m[1])
    }

    P.METHOD_DECL.lastIndex = 0
    while ((m = P.METHOD_DECL.exec(text)) !== null && symbols.length < CODE_INTEL_MAX_SYMBOLS_PER_FILE) {
      // Skip constructor and common non-method matches
      if (m[1] === 'if' || m[1] === 'for' || m[1] === 'while' || m[1] === 'switch') continue
      symbols.push({ name: m[1], kind: 'method', params: cleanParams(m[2]), file: filePath, line: lineAt(text, m.index), exported: false })
    }

    // Named exports
    P.NAMED_EXPORT.lastIndex = 0
    while ((m = P.NAMED_EXPORT.exec(text)) !== null) {
      const names = m[1].split(',')
        .map(s => s.trim().split(/\s+as\s+/).pop()?.trim())
        .filter(Boolean)
      for (const n of names) if (!exports.includes(n)) exports.push(n)
    }

    // Default export
    P.DEFAULT_EXPORT.lastIndex = 0
    while ((m = P.DEFAULT_EXPORT.exec(text)) !== null) {
      const entry = `default:${m[1]}`
      if (!exports.includes(entry)) exports.push(entry)
    }

    // Re-exports
    P.REEXPORT.lastIndex = 0
    while ((m = P.REEXPORT.exec(text)) !== null) {
      imports.push({ name: m[1] || '*', from: m[2], kind: 'reexport' })
    }

    // Named imports
    P.IMPORT_NAMED.lastIndex = 0
    while ((m = P.IMPORT_NAMED.exec(text)) !== null) {
      const names = m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]?.trim()).filter(Boolean)
      for (const name of names) imports.push({ name, from: m[2], kind: 'named' })
    }

    // Default imports
    P.IMPORT_DEFAULT.lastIndex = 0
    while ((m = P.IMPORT_DEFAULT.exec(text)) !== null) {
      imports.push({ name: m[1], from: m[2], kind: 'default' })
    }

    // Namespace imports
    P.IMPORT_STAR.lastIndex = 0
    while ((m = P.IMPORT_STAR.exec(text)) !== null) {
      imports.push({ name: m[1], from: m[2], kind: 'namespace' })
    }

    // require() calls
    P.REQUIRE.lastIndex = 0
    while ((m = P.REQUIRE.exec(text)) !== null) {
      imports.push({ name: '*', from: m[1], kind: 'require' })
    }
  }

  return { filePath, symbols, exports, imports }
}

// ── Service singleton ─────────────────────────────────────────────────────────

/** @type {Map<string, FileSymbols>}  filePath → FileSymbols */
const _fileCache = new Map()
/** @type {Map<string, SymbolEntry[]>}  symbolName → [definition locations] */
let _nameIndex = null
let _indexedAt = 0
const INDEX_TTL_MS = 120_000  // 2 minutes

export const codeIntelligence = {

  /**
   * Build or refresh the symbol index from shadowContext's file list.
   * Safe to call on every agent loop start — uses a TTL + size change guard
   * to skip unnecessary re-indexing.
   *
   * @param {object} shadowCtx  The shadowContext singleton
   * @returns {boolean}  true if index was (re)built
   */
  buildIndex(shadowCtx) {
    if (!shadowCtx?.isReady) return false

    const allFiles = shadowCtx.getAllFiles?.() || []
    const fresh    = Date.now() - _indexedAt < INDEX_TTL_MS
    if (fresh && _nameIndex !== null && allFiles.length === _fileCache.size) return false

    _fileCache.clear()
    _nameIndex = new Map()

    for (const file of allFiles) {
      if (!file?.content || !isCodeFile(file.path)) continue
      const fs = extractSymbols(file.content, file.path)
      _fileCache.set(file.path, fs)
      for (const sym of fs.symbols) {
        if (!_nameIndex.has(sym.name)) _nameIndex.set(sym.name, [])
        _nameIndex.get(sym.name).push(sym)
      }
    }

    _indexedAt = Date.now()
    return true
  },

  /** True when the name index has been built. */
  get isReady() { return _nameIndex !== null && _nameIndex.size > 0 },

  /** Total unique symbol names indexed. */
  symbolCount() { return _nameIndex?.size ?? 0 },

  /** Total files indexed. */
  fileCount() { return _fileCache.size },

  /**
   * Find all declaration sites for a symbol name.
   *
   * @param {string} name
   * @returns {SymbolEntry[]}
   */
  findDefinition(name) {
    if (!_nameIndex || !name) return []
    return _nameIndex.get(String(name)) || []
  },

  /**
   * Find every file + line that contains a reference to `name`.
   * Uses whole-word matching to avoid substring false positives.
   *
   * @param {string}  name
   * @param {number}  [limit]
   * @returns {{ file: string, line: number, context: string }[]}
   */
  findUsages(name, limit = 60) {
    if (!_nameIndex || !name) return []
    const re      = new RegExp(`\\b${escapeRe(String(name))}\\b`)
    const results = []

    for (const [filePath, fs] of _fileCache) {
      // We store the filePath in fs but need the content — retrieve from cache
      // (shadowContext stores content in the file objects; we mirror it below)
      const content = _contentFor(filePath)
      if (!content) continue

      const lines = content.split('\n')
      for (let i = 0; i < lines.length && results.length < limit; i++) {
        if (re.test(lines[i])) {
          results.push({ file: filePath, line: i + 1, context: lines[i].trim().slice(0, 140) })
        }
      }
      if (results.length >= limit) break
    }

    return results
  },

  /**
   * Trace the call graph from an entry symbol up to maxDepth hops.
   * Heuristic: considers all symbols that share a file with the entry's
   * definition as first-degree callees (conservative but parser-free).
   *
   * @param {string} entrySymbol
   * @param {number} [maxDepth]
   * @returns {{ nodes: string[], edges: { from: string, to: string, file: string }[] }}
   */
  findCallGraph(entrySymbol, maxDepth = CODE_INTEL_CALL_GRAPH_DEPTH) {
    if (!_nameIndex) return { nodes: [], edges: [] }

    const visited = new Set([entrySymbol])
    const edges   = []
    const queue   = [{ name: entrySymbol, depth: 0 }]

    while (queue.length > 0) {
      const { name, depth } = queue.shift()
      if (depth >= maxDepth) continue

      const defs = this.findDefinition(name)
      for (const def of defs) {
        const fs = _fileCache.get(def.file)
        if (!fs) continue
        // Treat every other exported symbol in the same file as a potential callee
        for (const sym of fs.symbols) {
          if (sym.name === name || visited.has(sym.name)) continue
          visited.add(sym.name)
          edges.push({ from: name, to: sym.name, file: def.file })
          queue.push({ name: sym.name, depth: depth + 1 })
        }
      }
    }

    return { nodes: [...visited], edges }
  },

  /**
   * Fuzzy symbol search — returns symbols whose names contain `query`
   * (case-insensitive substring match).
   *
   * @param {string} query
   * @param {number} [limit]
   * @returns {SymbolEntry[]}
   */
  query(query = '', limit = 20) {
    if (!_nameIndex) return []
    const q       = String(query).toLowerCase()
    const results = []

    for (const [name, defs] of _nameIndex) {
      if (name.toLowerCase().includes(q)) {
        for (const def of defs) {
          results.push({ name, ...def })
          if (results.length >= limit) return results
        }
      }
    }
    return results
  },

  /**
   * Produce a human-readable summary for tool output.
   *
   * @param {'definition'|'usages'|'callgraph'|'query'} mode
   * @param {string} symbolName
   * @param {object} [shadowCtx]
   * @returns {string}
   */
  formatResult(mode, symbolName, shadowCtx = null) {
    if (!this.isReady) {
      return `Code intelligence index not ready (${_fileCache.size} files indexed). Call buildIndex first.`
    }
    if (mode === 'definition') {
      const defs = this.findDefinition(symbolName)
      if (!defs.length) return `No definition found for '${symbolName}'.`
      return defs.map(d => `${d.file}:${d.line}  [${d.kind}]  ${d.name}(${d.params || ''})`).join('\n')
    }
    if (mode === 'usages') {
      const usages = this.findUsages(symbolName)
      if (!usages.length) return `No usages found for '${symbolName}'.`
      return usages.map(u => `${u.file}:${u.line}  ${u.context}`).join('\n')
    }
    if (mode === 'callgraph') {
      const { nodes, edges } = this.findCallGraph(symbolName)
      if (!edges.length) return `No call graph found for '${symbolName}'.`
      const edgeLines = edges.slice(0, 40).map(e => `  ${e.from} → ${e.to}  (${e.file})`)
      return [`Call graph from '${symbolName}' (${nodes.length} nodes, ${edges.length} edges):`, ...edgeLines].join('\n')
    }
    if (mode === 'query') {
      const hits = this.query(symbolName, 30)
      if (!hits.length) return `No symbols matching '${symbolName}'.`
      return hits.map(h => `${h.file}:${h.line}  [${h.kind}]  ${h.name}`).join('\n')
    }
    return 'Unknown mode. Use: definition | usages | callgraph | query'
  },
}

// ── Content accessor ──────────────────────────────────────────────────────────
// The FileSymbols objects store the file path but NOT the raw content (to save
// memory).  This helper retrieves the content string from the raw file cache
// that shadowContext populates, mirrored here on buildIndex.

/** @type {Map<string, string>}  filePath → raw content */
const _rawContent = new Map()

// Patch buildIndex to also cache content for findUsages
const _origBuild = codeIntelligence.buildIndex.bind(codeIntelligence)
codeIntelligence.buildIndex = function buildIndex(shadowCtx) {
  _rawContent.clear()
  const allFiles = shadowCtx?.getAllFiles?.() || []
  for (const file of allFiles) {
    if (file?.content && isCodeFile(file.path)) _rawContent.set(file.path, file.content)
  }
  return _origBuild(shadowCtx)
}

function _contentFor(filePath) {
  return _rawContent.get(filePath) || null
}

/**
 * @typedef {{ name: string, kind: string, params?: string, extends?: string|null, file: string, line: number, exported: boolean }} SymbolEntry
 * @typedef {{ filePath: string, symbols: SymbolEntry[], exports: string[], imports: object[] }} FileSymbols
 */
