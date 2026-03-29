import { hybridSearch } from '../services/enhancers/ragService.js'

export const toolMeta = {
  id: 'hybrid-search',
  name: 'Hybrid Search',
  version: '1.0.0',
  description: 'Hybrid lexical + vector-like retrieval over indexed repository content.',
  category: 'analysis',
  author: 'LOGIK',
}

export async function execute(input, config = {}) {
  const { query, limit = 8 } = input || {}
  if (!query) throw new Error('query is required')
  const { shadowContext } = config
  if (!shadowContext) throw new Error('shadowContext not provided in config')

  const results = hybridSearch({ query, limit, shadowContext })
  return { query, results, count: results.length }
}

export async function test() {
  const fake = {
    isReady: true,
    findRelevantFiles: () => [{ path: 'src/services/agentLoop.js', score: 0.9 }],
    search: () => [{ path: 'src/services/agentLoop.js', score: 0.8 }],
    contentIndex: new Map([['src/services/agentLoop.js', 'agent loop orchestration']]),
  }
  const out = await execute({ query: 'agent loop', limit: 3 }, { shadowContext: fake })
  const ok = out.count === 1 && out.results[0]?.path === 'src/services/agentLoop.js'
  return { passed: ok, message: ok ? 'Hybrid search self-test passed.' : 'Unexpected hybrid search result.' }
}
