// ─── search-files tool ────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'search-files',
  name: 'Search Files',
  version: '1.0.0',
  description: 'Search the indexed repository for files relevant to a query. Returns scored file paths.',
  category: 'analysis',
  author: 'ICARUS',
}

export async function execute(input, config = {}) {
  const { query, limit = 8 } = input
  if (!query) throw new Error('query is required')

  const { shadowContext } = config
  if (!shadowContext) throw new Error('shadowContext not provided in config')

  const results = shadowContext.search?.(query, limit) || []
  return { query, results, count: results.length }
}

export async function test() {
  const failures = []

  // Simulated scored index — higher score = more relevant
  const INDEX = [
    { path: 'src/auth/login.js',       score: 0.95 },
    { path: 'src/auth/logout.js',      score: 0.88 },
    { path: 'src/auth/session.js',     score: 0.76 },
    { path: 'src/components/Form.jsx', score: 0.55 },
    { path: 'src/utils/helpers.js',    score: 0.42 },
    { path: 'README.md',               score: 0.30 },
    { path: 'package.json',            score: 0.20 },
    { path: 'vite.config.js',          score: 0.10 },
    { path: 'src/index.js',            score: 0.05 },
    { path: '.gitignore',              score: 0.01 },
  ]

  function makeCtx(results = INDEX) {
    return {
      search: (query, limit) => {
        // Real simulation: filter by query relevance and respect limit
        const q = query.toLowerCase()
        return results
          .filter(r => r.path.toLowerCase().includes(q) || q === 'all')
          .slice(0, limit)
      },
    }
  }

  // Trial 1: query is echoed in result
  const r1 = await execute({ query: 'auth' }, { shadowContext: makeCtx() })
  if (r1.query !== 'auth') failures.push('Trial 1: query not echoed')

  // Trial 2: results contain matching paths
  if (!r1.results.some(r => r.path.includes('auth'))) failures.push('Trial 2: auth files missing from results')

  // Trial 3: count matches results array length
  if (r1.count !== r1.results.length) failures.push(`Trial 3: count ${r1.count} !== results.length ${r1.results.length}`)

  // Trial 4: limit is respected — default 8
  const r4 = await execute({ query: 'all' }, { shadowContext: makeCtx() })
  if (r4.count > 8) failures.push(`Trial 4: default limit 8 exceeded, got ${r4.count}`)

  // Trial 5: custom limit is respected
  const r5 = await execute({ query: 'all', limit: 3 }, { shadowContext: makeCtx() })
  if (r5.count > 3) failures.push(`Trial 5: limit 3 exceeded, got ${r5.count}`)

  // Trial 6: limit of 1 returns exactly 1 result
  const r6 = await execute({ query: 'all', limit: 1 }, { shadowContext: makeCtx() })
  if (r6.count !== 1) failures.push(`Trial 6: limit 1 should return exactly 1, got ${r6.count}`)

  // Trial 7: no match returns empty results (not an error)
  const r7 = await execute({ query: 'xyzzy_no_match_ever' }, { shadowContext: makeCtx() })
  if (r7.count !== 0)               failures.push(`Trial 7: no-match should return 0, got ${r7.count}`)
  if (!Array.isArray(r7.results))   failures.push('Trial 7: results should still be array on no-match')

  // Trial 8: missing query throws
  try {
    await execute({}, { shadowContext: makeCtx() })
    failures.push('Trial 8: should throw for missing query')
  } catch (e) {
    if (!e.message.includes('query')) failures.push(`Trial 8: wrong error: ${e.message}`)
  }

  // Trial 9: missing shadowContext throws
  try {
    await execute({ query: 'auth' }, {})
    failures.push('Trial 9: should throw for missing shadowContext')
  } catch (e) {
    if (!e.message.includes('shadowContext')) failures.push(`Trial 9: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 9 trials passed (echo, matching, count, default/custom limits, no-match, error guards).' }
}
