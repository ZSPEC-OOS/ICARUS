// ─── annas tool ───────────────────────────────────────────────────────────────
// Searches Anna's Archive via an (unofficial) API endpoint and returns normalized
// metadata for quick browsing inside BLUSWAN.

export const toolMeta = {
  id: 'annas',
  name: 'Annas Archive Search',
  version: '1.0.0',
  description: 'Search Anna\'s Archive for books and papers by topic.',
  category: 'utility',
  author: 'BLUSWAN',
}

function normalizeInput(input) {
  if (typeof input === 'string') {
    return { topic: input.trim(), limit: 8 }
  }
  const obj = input && typeof input === 'object' ? input : {}
  return {
    topic: String(obj.topic || obj.query || '').trim(),
    limit: Number.isFinite(obj.limit) ? Number(obj.limit) : 8,
    endpoint: obj.endpoint,
  }
}

function normalizeResults(raw) {
  const list = Array.isArray(raw?.results)
    ? raw.results
    : Array.isArray(raw?.data)
      ? raw.data
      : []

  return list.map((item, i) => ({
    rank: i + 1,
    title: item.title || item.name || 'Untitled',
    author: item.author || item.authors || null,
    year: item.year || item.publish_year || null,
    language: item.language || item.lang || null,
    format: item.format || item.file_type || null,
    size: item.size || item.filesize || null,
    url: item.url || item.link || item.href || null,
    raw: item,
  }))
}

export async function execute(input, _config = {}) {
  const { topic, limit, endpoint } = normalizeInput(input)
  if (!topic) throw new Error('topic (or query) is required')

  const capped = Math.min(Math.max(limit || 8, 1), 20)
  const base = endpoint || 'https://annas-archive.org/api/1.0/search'
  const url = `${base}?q=${encodeURIComponent(topic)}&limit=${capped}`

  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })

  if (!res.ok) {
    const detail = res.status === 404
      ? 'Endpoint unavailable (known issue with unofficial Anna\'s API).'
      : `HTTP ${res.status}`
    throw new Error(`Anna's search failed: ${detail}`)
  }

  const data = await res.json()
  const results = normalizeResults(data)

  return {
    topic,
    count: results.length,
    results,
    notes: [
      'Anna\'s Archive API endpoint is unofficial and may intermittently fail or return empty results.',
      'If results are empty, retry later or configure a mirror/proxy endpoint using the `endpoint` input.',
    ],
  }
}

export async function test() {
  const failures = []
  const origFetch = globalThis.fetch

  try {
    // Trial 1: missing topic validation
    try {
      await execute({})
      failures.push('Trial 1: expected missing topic error')
    } catch (e) {
      if (!String(e.message).includes('topic')) failures.push(`Trial 1: wrong error: ${e.message}`)
    }

    // Trial 2: string input normalization
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ results: [{ title: 'Test Book', author: 'Author A' }] }),
    })
    const out = await execute('machine learning')
    if (out.topic !== 'machine learning') failures.push('Trial 2: topic not normalized from string input')
    if (!Array.isArray(out.results) || out.results.length !== 1) failures.push('Trial 2: result normalization failed')

    // Trial 3: 404 handled with known issue guidance
    globalThis.fetch = async () => ({ ok: false, status: 404 })
    try {
      await execute({ topic: 'quantum' })
      failures.push('Trial 3: expected 404 failure')
    } catch (e) {
      if (!String(e.message).includes('known issue')) failures.push(`Trial 3: expected known issue hint, got: ${e.message}`)
    }
  } finally {
    globalThis.fetch = origFetch
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 3 trials passed (validation, normalization, 404 handling).' }
}
