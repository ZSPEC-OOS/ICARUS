// ─── libraryContextService ────────────────────────────────────────────────────
// Detects npm / pip packages mentioned in a task string, fetches their metadata
// from public registries, and returns a formatted context block ready for
// injection into the agent loop before the first model call.
//
// Registry endpoints (no auth required, CORS-enabled):
//   npm:  https://registry.npmjs.org/<pkg>/latest  (JSON)
//   PyPI: https://pypi.org/pypi/<pkg>/json          (JSON)
//
// The service is intentionally non-fatal — any network failure silently returns
// an empty result so the agent loop is never blocked.

// ── In-memory cache (10 min TTL) ─────────────────────────────────────────────
const PKG_CACHE = new Map()   // key: 'npm:<name>' | 'pypi:<name>'
const CACHE_TTL_MS = 10 * 60 * 1000

// ── Package name validation ───────────────────────────────────────────────────
// Covers: plain names (axios), hyphenated (react-query), scoped (@tanstack/react-query)
const PKG_NAME_RE = /^(@[\w-]+\/[\w-]+|[\w][\w-]{1,50})$/

// Common English words that look like package names but aren't
const STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'from', 'into', 'some', 'more', 'just', 'only', 'new', 'all',
  'any', 'each', 'both', 'few', 'same', 'main', 'base', 'core', 'app',
  'async', 'await', 'function', 'const', 'let', 'var', 'class', 'return',
  'import', 'export', 'default', 'module', 'component', 'service', 'hook',
  'file', 'test', 'tests', 'type', 'interface', 'utils', 'helper', 'lib',
  'react', 'node', 'browser', 'server', 'client', 'api', 'env', 'config',
  'index', 'routes', 'store', 'auth', 'user', 'data', 'error', 'state',
])

// Node.js built-in modules (never need fetching)
const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'url', 'crypto', 'http', 'https', 'stream', 'events',
  'util', 'child_process', 'cluster', 'net', 'dns', 'tls', 'readline',
  'buffer', 'querystring', 'string_decoder', 'timers', 'assert', 'vm', 'zlib',
])

// ── Package detection ─────────────────────────────────────────────────────────

/**
 * Extract candidate package names from a free-text task description.
 * Returns an array of { name, ecosystem } objects (deduplicated, max 6).
 *
 * @param {string} taskText
 * @returns {{ name: string, ecosystem: 'npm'|'pypi' }[]}
 */
export function detectPackages(taskText) {
  const found = new Map()   // name → ecosystem
  const text  = taskText || ''

  function addPkg(name, ecosystem) {
    const root = name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')
    if (!root || root.startsWith('.') || root.startsWith('/')) return
    if (!PKG_NAME_RE.test(root)) return
    if (STOPWORDS.has(root.toLowerCase())) return
    if (NODE_BUILTINS.has(root)) return
    if (!found.has(root)) found.set(root, ecosystem)
  }

  // ── 1. Explicit npm/yarn/pnpm install lines ─────────────────────────────
  for (const m of text.matchAll(/\b(?:npm\s+install|yarn\s+add|pnpm\s+add)\s+((?:[@\w][\w\-./]*(?:\s+|$))+)/gi)) {
    for (const tok of m[1].trim().split(/\s+/)) addPkg(tok, 'npm')
  }

  // ── 2. Explicit pip install lines ────────────────────────────────────────
  for (const m of text.matchAll(/\bpip\s+install\s+((?:[\w][\w\-.]*(?:\s+|$))+)/gi)) {
    for (const tok of m[1].trim().split(/\s+/)) addPkg(tok, 'pypi')
  }

  // ── 3. ES module imports: from 'pkg' ─────────────────────────────────────
  for (const m of text.matchAll(/\bfrom\s+['"](@?[\w][\w\-./]*)['"][;\s]/gi)) {
    addPkg(m[1], 'npm')
  }

  // ── 4. CommonJS require('pkg') ───────────────────────────────────────────
  for (const m of text.matchAll(/\brequire\s*\(\s*['"](@?[\w][\w\-./]*)['"]/) ) {
    addPkg(m[1], 'npm')
  }

  // ── 5. Scoped packages mentioned anywhere (high-confidence: always explicit) ─
  for (const m of text.matchAll(/@[\w-]+\/[\w-]+/g)) {
    addPkg(m[0], 'npm')
  }

  return [...found.entries()].slice(0, 6).map(([name, ecosystem]) => ({ name, ecosystem }))
}

// ── Registry fetchers ─────────────────────────────────────────────────────────

/**
 * Fetch npm package metadata from registry.npmjs.org.
 * Returns a normalised meta object or null on failure.
 *
 * @param {string} name
 * @param {number} [maxReadmeChars=800]
 */
export async function fetchNpmMeta(name, maxReadmeChars = 800) {
  const cacheKey = `npm:${name}`
  const hit = PKG_CACHE.get(cacheKey)
  if (hit && Date.now() - hit._at < CACHE_TTL_MS) return hit

  let res
  try {
    res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
  } catch { return null }
  if (!res.ok) return null

  let d
  try { d = await res.json() } catch { return null }

  const readmeRaw = (d.readme || d.description || '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/```[\s\S]*?```/g, '[code block]')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const meta = {
    _at:           Date.now(),
    ecosystem:     'npm',
    name:          d.name  || name,
    version:       d.version || '?',
    description:   d.description || '',
    keywords:      (d.keywords || []).slice(0, 6).join(', '),
    homepage:      d.homepage || (d.repository?.url ? d.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') : ''),
    hasTypes:      !!(d.types || d.typings || d.exports),
    license:       d.license || '',
    readmeExcerpt: readmeRaw.slice(0, maxReadmeChars),
  }
  PKG_CACHE.set(cacheKey, meta)
  return meta
}

/**
 * Fetch PyPI package metadata.
 * Returns a normalised meta object or null on failure.
 *
 * @param {string} name
 * @param {number} [maxDescChars=600]
 */
async function fetchPypiMeta(name, maxDescChars = 600) {
  const cacheKey = `pypi:${name}`
  const hit = PKG_CACHE.get(cacheKey)
  if (hit && Date.now() - hit._at < CACHE_TTL_MS) return hit

  let res
  try {
    res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
  } catch { return null }
  if (!res.ok) return null

  let d
  try { d = await res.json() } catch { return null }
  const info = d.info || {}

  const descRaw = (info.description || info.summary || '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const meta = {
    _at:           Date.now(),
    ecosystem:     'pypi',
    name:          info.name    || name,
    version:       info.version || '?',
    description:   info.summary || '',
    keywords:      info.keywords || '',
    homepage:      info.home_page || info.project_url || '',
    hasTypes:      false,
    license:       info.license || '',
    readmeExcerpt: descRaw.slice(0, maxDescChars),
  }
  PKG_CACHE.set(cacheKey, meta)
  return meta
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Detect packages from a task string, fetch their registry metadata in
 * parallel, and return a formatted Markdown context block for injection.
 *
 * @param {string}  taskText
 * @param {{ maxPackages?: number, maxReadmeChars?: number }} [opts]
 * @returns {Promise<{ packages: string[], contextBlock: string }>}
 */
export async function fetchLibraryContext(taskText, opts = {}) {
  const { maxPackages = 4, maxReadmeChars = 800 } = opts
  const detected = detectPackages(taskText).slice(0, maxPackages)
  if (detected.length === 0) return { packages: [], contextBlock: '' }

  const settled = await Promise.allSettled(
    detected.map(({ name, ecosystem }) =>
      ecosystem === 'pypi'
        ? fetchPypiMeta(name, maxReadmeChars)
        : fetchNpmMeta(name, maxReadmeChars)
    )
  )

  const metas = settled
    .map(r => (r.status === 'fulfilled' ? r.value : null))
    .filter(Boolean)

  if (metas.length === 0) return { packages: [], contextBlock: '' }

  const sections = metas.map(m => {
    const header   = `### ${m.name} v${m.version} (${m.ecosystem}${m.license ? ` · ${m.license}` : ''})`
    const desc     = m.description ? m.description : null
    const keywords = m.keywords    ? `Keywords: ${m.keywords}` : null
    const types    = m.hasTypes    ? 'TypeScript types: yes' : null
    const docs     = m.homepage    ? `Docs: ${m.homepage}` : null
    const readme   = m.readmeExcerpt ? `\n${m.readmeExcerpt}` : null
    return [header, desc, keywords, types, docs, readme].filter(Boolean).join('\n')
  })

  return {
    packages:     metas.map(m => m.name),
    contextBlock: sections.join('\n\n---\n\n'),
  }
}
