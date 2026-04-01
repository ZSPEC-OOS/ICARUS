// ─── web-search tool ──────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'web-search',
  name: 'Web Search',
  version: '1.0.0',
  description: 'Search the web for up-to-date information using Tavily. Requires a Tavily API key in Settings.',
  category: 'utility',
  author: 'ICARUS',
}

export async function execute(input, config = {}) {
  const { query, max_results = 5, include_domains } = input
  if (!query) throw new Error('query is required')

  const { tavilyKey } = config
  if (!tavilyKey) throw new Error('Tavily API key not configured — add it in Settings → Web Search')

  const body = { query, max_results: Math.min(max_results, 10), api_key: tavilyKey }
  if (include_domains?.length) body.include_domains = include_domains

  const res = await fetch('/api/proxy/tavily/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Tavily error: ${res.status}`)
  const data = await res.json()

  return {
    query,
    answer: data.answer || '',
    results: (data.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content })),
  }
}

export async function test() {
  const failures = []

  // Trial 1: missing tavilyKey throws with setup guidance
  try {
    await execute({ query: 'React hooks' }, {})
    failures.push('Trial 1: should throw for missing tavilyKey')
  } catch (e) {
    if (!e.message.includes('Tavily')) failures.push(`Trial 1: error should mention Tavily, got: "${e.message}"`)
    if (!e.message.includes('Settings')) failures.push(`Trial 1: error should mention Settings, got: "${e.message}"`)
  }

  // Trial 2: missing query throws
  try {
    await execute({}, { tavilyKey: 'tvly-test' })
    failures.push('Trial 2: should throw for missing query')
  } catch (e) {
    if (!e.message.includes('query')) failures.push(`Trial 2: wrong error: ${e.message}`)
  }

  // Trial 3: max_results is capped at 10 (validate body construction)
  // We intercept the fetch to inspect the request body
  const origFetch = globalThis.fetch
  let capturedBody = null
  globalThis.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts?.body || '{}')
    return { ok: true, json: async () => ({ answer: 'ok', results: [] }) }
  }

  try {
    await execute({ query: 'test', max_results: 99 }, { tavilyKey: 'tvly-test' })
    if (capturedBody?.max_results !== 10) {
      failures.push(`Trial 3: max_results should be capped at 10, got ${capturedBody?.max_results}`)
    }
  } catch (e) {
    failures.push(`Trial 3: unexpected error: ${e.message}`)
  }

  // Trial 4: include_domains forwarded when provided
  capturedBody = null
  try {
    await execute(
      { query: 'React', max_results: 3, include_domains: ['react.dev', 'github.com'] },
      { tavilyKey: 'tvly-test' },
    )
    if (!capturedBody?.include_domains?.includes('react.dev')) {
      failures.push('Trial 4: include_domains not forwarded')
    }
  } catch (e) {
    failures.push(`Trial 4: unexpected error: ${e.message}`)
  }

  // Trial 5: include_domains omitted when empty
  capturedBody = null
  try {
    await execute({ query: 'React', include_domains: [] }, { tavilyKey: 'tvly-test' })
    if ('include_domains' in (capturedBody || {})) {
      failures.push('Trial 5: include_domains should not be sent when empty')
    }
  } catch (e) {
    failures.push(`Trial 5: unexpected error: ${e.message}`)
  }

  // Trial 6: result shape — query echoed, results is array
  let searchResult = null
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        answer: 'React is a JS library',
        results: [{ title: 'React Docs', url: 'https://react.dev', content: 'Learn React here' }],
      }),
    })
    searchResult = await execute({ query: 'what is react' }, { tavilyKey: 'tvly-test' })
  } catch (e) {
    failures.push(`Trial 6: unexpected error: ${e.message}`)
  }
  if (searchResult?.query !== 'what is react')          failures.push('Trial 6: query not echoed')
  if (!Array.isArray(searchResult?.results))             failures.push('Trial 6: results should be array')
  if (searchResult?.results[0]?.title !== 'React Docs') failures.push('Trial 6: result title missing')
  if (!searchResult?.results[0]?.url)                   failures.push('Trial 6: result url missing')
  if (!searchResult?.results[0]?.snippet)               failures.push('Trial 6: result snippet missing')

  // Trial 7: Tavily HTTP error propagates
  try {
    globalThis.fetch = async () => ({ ok: false, status: 401 })
    await execute({ query: 'test' }, { tavilyKey: 'tvly-invalid' })
    failures.push('Trial 7: should throw on HTTP error')
  } catch (e) {
    if (!e.message.includes('401') && !e.message.includes('Tavily')) {
      failures.push(`Trial 7: wrong error: ${e.message}`)
    }
  } finally {
    globalThis.fetch = origFetch
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 7 trials passed (key guard, query guard, max_results cap, domain forwarding, result shape, HTTP error handling).' }
}
