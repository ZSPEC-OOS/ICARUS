/**
 * @module repoIndex
 * Lightweight in-memory repo index. No vector embeddings. No persistent storage.
 * Regex-based import and symbol scanning. LRU content cache (max 50 files).
 * Rebuilt on task start, discarded on task end.
 */

const CONTENT_CACHE_MAX = 50;
const MAX_FILE_CONTENT_LINES = 500;
const SEARCH_TOP_N = 20;
const RELATED_FILES_LIMIT = 10;
const JS_TS_RE = /\.[jt]sx?$/;
const MAX_EAGER_SCAN_FILES = 200;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} FileNode
 * @property {string} path
 * @property {'file'|'dir'} type
 * @property {number} [size]
 * @property {string} [sha]
 */

/**
 * @typedef {Object} ImportGraph
 * @property {Map<string, string[]>} imports    - path → paths this file imports
 * @property {Map<string, string[]>} importedBy - path → paths that import this file
 */

/**
 * @typedef {Object} SymbolEntry
 * @property {string} name
 * @property {'function'|'class'|'const'|'let'|'var'|'export'|'import'} kind
 * @property {number} line
 */

/**
 * @typedef {Object} SymbolIndex
 * @property {Map<string, SymbolEntry[]>} symbols - path → symbols
 */

/**
 * @typedef {Object} RepoIndex
 * @property {string} repoUrl
 * @property {string} branch
 * @property {string} owner
 * @property {string} repo
 * @property {string} token
 * @property {FileNode[]} fileTree
 * @property {LRUCache} contentCache
 * @property {ImportGraph} importGraph
 * @property {SymbolIndex} symbolIndex
 * @property {boolean} isReady
 */

// ─── LRU Cache ────────────────────────────────────────────────────────────────

class LRUCache {
  constructor(max) {
    this.max = max;
    this._map = new Map();
  }

  get(key) {
    if (!this._map.has(key)) return undefined;
    const val = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, val);
    return val;
  }

  set(key, val) {
    if (this._map.has(key)) this._map.delete(key);
    if (this._map.size >= this.max) {
      this._map.delete(this._map.keys().next().value);
    }
    this._map.set(key, val);
  }

  has(key) { return this._map.has(key); }
  delete(key) { return this._map.delete(key); }
  get size() { return this._map.size; }
  keys() { return this._map.keys(); }
}

// ─── URL / API Helpers ────────────────────────────────────────────────────────

/**
 * @param {string} repoUrl
 * @returns {{ owner: string, repo: string }}
 */
function parseRepoUrl(repoUrl) {
  const match = String(repoUrl).match(/(?:github\.com\/)?([^/\s]+)\/([^/\s.]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error(`Cannot parse repoUrl: ${repoUrl}`);
  return { owner: match[1], repo: match[2] };
}

async function fetchGitTree(owner, repo, branch, token, fetchFn) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const headers = { Accept: 'application/vnd.github.v3+json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchFn(url, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: GET ${url}`);
  const data = await res.json();
  return Array.isArray(data.tree) ? data.tree : [];
}

async function fetchGitHubContent(owner, repo, path, ref, token, fetchFn) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  const headers = { Accept: 'application/vnd.github.v3+json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchFn(url, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: GET ${path}`);
  const data = await res.json();
  if (data.encoding === 'base64') {
    return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
  }
  return String(data.content ?? '');
}

// ─── Regex Scanners ───────────────────────────────────────────────────────────

const SYMBOL_PATTERNS = [
  { kind: 'function', re: /(?:^|\n)(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)/g },
  { kind: 'class',    re: /(?:^|\n)(?:export\s+(?:default\s+)?)?class\s+(\w+)/g },
  { kind: 'const',    re: /(?:^|\n)(?:export\s+)?const\s+(\w+)/g },
  { kind: 'let',      re: /(?:^|\n)(?:export\s+)?let\s+(\w+)/g },
  { kind: 'var',      re: /(?:^|\n)(?:export\s+)?var\s+(\w+)/g },
];

/**
 * @param {string} filePath
 * @param {string} content
 * @param {SymbolIndex} symbolIndex
 */
function parseSymbols(filePath, content, symbolIndex) {
  const lines = content.split('\n');
  const entries = [];
  const seen = new Set();

  for (const { kind, re } of SYMBOL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      if (!name || seen.has(`${kind}:${name}`)) continue;
      seen.add(`${kind}:${name}`);
      // Find line number by counting newlines before match position
      const before = content.slice(0, m.index);
      const line = before.split('\n').length;
      entries.push({ name, kind, line });
    }
  }

  if (entries.length > 0) {
    symbolIndex.symbols.set(filePath, entries);
  }
}

/**
 * @param {string} filePath
 * @param {string} content
 * @param {ImportGraph} importGraph
 */
function parseImports(filePath, content, importGraph) {
  const imported = [];

  // ES module import: import ... from '...'
  const esImportRe = /(?:^|\n)\s*import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = esImportRe.exec(content)) !== null) {
    imported.push(m[1]);
  }

  // CommonJS require: require('...')
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = requireRe.exec(content)) !== null) {
    imported.push(m[1]);
  }

  const unique = [...new Set(imported)];
  if (unique.length > 0) {
    importGraph.imports.set(filePath, unique);
    for (const dep of unique) {
      const importers = importGraph.importedBy.get(dep) ?? [];
      if (!importers.includes(filePath)) importers.push(filePath);
      importGraph.importedBy.set(dep, importers);
    }
  }
}

// ─── BM25-ish Scoring ─────────────────────────────────────────────────────────

function tokenize(text) {
  return text.toLowerCase().split(/[\s./\\-_:]+/).filter(Boolean);
}

function bm25Score(queryTokens, docText, k1 = 1.5, b = 0.75, avgDocLen = 8) {
  const docTokens = tokenize(docText);
  if (docTokens.length === 0) return 0;
  const docLen = docTokens.length;
  const tf = new Map();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of queryTokens) {
    const freq = tf.get(term) ?? 0;
    if (freq > 0) {
      score += (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (docLen / avgDocLen)));
    }
  }
  return score;
}

// ─── Repo Map Rendering ───────────────────────────────────────────────────────

function buildDirTree(fileTree) {
  const root = {};
  for (const f of fileTree) {
    const parts = f.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node[part] = node[part] ?? {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = null;
  }
  return root;
}

function renderDirTree(node, indent = '') {
  const lines = [];
  const entries = Object.entries(node).sort(([a], [b]) => {
    // Directories (non-null values) before files
    const aIsDir = node[a] !== null;
    const bIsDir = node[b] !== null;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.localeCompare(b);
  });
  for (const [name, children] of entries) {
    if (children === null) {
      lines.push(`${indent}${name}`);
    } else {
      lines.push(`${indent}${name}/`);
      lines.push(...renderDirTree(children, indent + '  '));
    }
  }
  return lines;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a lightweight in-memory repo index.
 * Fetches file tree via GitHub API and eagerly scans JS/TS files for imports and symbols.
 *
 * @param {string} repoUrl - e.g. "https://github.com/owner/repo" or "owner/repo"
 * @param {string} branch
 * @param {string} [token]
 * @param {{ fetchFn?: Function }} [options]
 * @returns {Promise<RepoIndex>}
 */
export async function buildRepoIndex(repoUrl, branch, token = '', options = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (!fetchFn) throw new Error('fetch is not available — pass options.fetchFn');

  const { owner, repo } = parseRepoUrl(repoUrl);

  const tree = await fetchGitTree(owner, repo, branch, token, fetchFn);

  const fileTree = tree
    .filter((node) => node.type === 'blob')
    .map((node) => ({
      path: node.path,
      type: 'file',
      size: node.size ?? 0,
      sha: node.sha ?? '',
    }));

  const contentCache = new LRUCache(CONTENT_CACHE_MAX);
  const importGraph = { imports: new Map(), importedBy: new Map() };
  const symbolIndex = { symbols: new Map() };

  // Eagerly scan JS/TS files for imports and symbols (up to MAX_EAGER_SCAN_FILES)
  const jsFiles = fileTree.filter((f) => JS_TS_RE.test(f.path));
  const toScan = jsFiles.slice(0, MAX_EAGER_SCAN_FILES);

  await Promise.allSettled(
    toScan.map(async (file) => {
      try {
        const raw = await fetchGitHubContent(owner, repo, file.path, branch, token, fetchFn);
        const lines = raw.split('\n');
        const content = lines.length > MAX_FILE_CONTENT_LINES
          ? lines.slice(0, MAX_FILE_CONTENT_LINES).join('\n') +
            `\n[...truncated, ${lines.length} lines total]`
          : raw;
        contentCache.set(file.path, content);
        parseImports(file.path, content, importGraph);
        parseSymbols(file.path, content, symbolIndex);
      } catch {
        // Non-fatal: skip files that can't be fetched
      }
    })
  );

  return {
    repoUrl,
    branch,
    owner,
    repo,
    token,
    fileTree,
    contentCache,
    importGraph,
    symbolIndex,
    isReady: true,
    _fetchFn: fetchFn,
  };
}

/**
 * Get file content, using cache when available.
 * Caps at MAX_FILE_CONTENT_LINES lines.
 *
 * @param {RepoIndex} index
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function getFileContent(index, path) {
  const cached = index.contentCache.get(path);
  if (cached !== undefined) return cached;

  const raw = await fetchGitHubContent(
    index.owner, index.repo, path, index.branch, index.token, index._fetchFn
  );

  const lines = raw.split('\n');
  let content;
  if (lines.length > MAX_FILE_CONTENT_LINES) {
    content = lines.slice(0, MAX_FILE_CONTENT_LINES).join('\n') +
      `\n[...truncated, ${lines.length} lines total]`;
  } else {
    content = raw;
  }

  index.contentCache.set(path, content);
  return content;
}

/**
 * BM25-ish search over file paths and symbol names.
 * Returns top 20 results ordered by relevance.
 *
 * @param {RepoIndex} index
 * @param {string} query
 * @returns {Array<{path: string, score: number, snippet: string}>}
 */
export function searchFiles(index, query) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const results = [];

  for (const file of index.fileTree) {
    const pathScore = bm25Score(queryTokens, file.path);
    const symbols = index.symbolIndex.symbols.get(file.path) ?? [];
    const symbolStr = symbols.map((s) => s.name).join(' ');
    const symbolScore = symbolStr ? bm25Score(queryTokens, symbolStr) : 0;
    const score = pathScore + symbolScore * 0.5;

    if (score > 0) {
      const snippet = symbols.length > 0
        ? symbols.slice(0, 3).map((s) => `${s.kind} ${s.name}`).join(', ')
        : file.path.split('/').pop();
      results.push({ path: file.path, score, snippet });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, SEARCH_TOP_N);
}

/**
 * Returns files that import `path` and files that `path` imports.
 * Limits to RELATED_FILES_LIMIT total.
 *
 * @param {RepoIndex} index
 * @param {string} path
 * @returns {{ importers: string[], importees: string[] }}
 */
export function getRelatedFiles(index, path) {
  const importers = (index.importGraph.importedBy.get(path) ?? []).slice(0, RELATED_FILES_LIMIT);
  const rawImportees = index.importGraph.imports.get(path) ?? [];

  // Resolve relative import paths to actual file paths in fileTree
  const fileSet = new Set(index.fileTree.map((f) => f.path));
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const importees = rawImportees
    .map((dep) => {
      if (dep.startsWith('.')) {
        // Resolve relative paths
        const parts = (dir ? `${dir}/${dep}` : dep).split('/');
        const resolved = [];
        for (const p of parts) {
          if (p === '..') resolved.pop();
          else if (p !== '.') resolved.push(p);
        }
        const candidate = resolved.join('/');
        // Try with various extensions
        for (const ext of ['', '.js', '.jsx', '.ts', '.tsx', '/index.js', '/index.ts']) {
          if (fileSet.has(candidate + ext)) return candidate + ext;
        }
        return null;
      }
      return null; // skip node_modules
    })
    .filter(Boolean)
    .slice(0, RELATED_FILES_LIMIT);

  return { importers, importees };
}

/**
 * Returns an indented file tree string, truncated to fit maxTokens.
 *
 * @param {RepoIndex} index
 * @param {number} [maxTokens=1000]
 * @returns {string}
 */
export function getRepoMap(index, maxTokens = 1000) {
  const maxChars = maxTokens * 4;
  const tree = buildDirTree(index.fileTree);
  const lines = renderDirTree(tree);
  let result = lines.join('\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n[...truncated]';
  }
  return result;
}

/**
 * Returns symbols found in a file.
 *
 * @param {RepoIndex} index
 * @param {string} path
 * @returns {SymbolEntry[]}
 */
export function getSymbolsInFile(index, path) {
  return index.symbolIndex.symbols.get(path) ?? [];
}

/**
 * Remove a file from the content cache (call after write/edit).
 *
 * @param {RepoIndex} index
 * @param {string} path
 */
export function invalidateFile(index, path) {
  index.contentCache.delete(path);
}
