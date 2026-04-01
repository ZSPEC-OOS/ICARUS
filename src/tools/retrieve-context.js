import { retrieveContext } from '../services/enhancers/ragService.js'

export const toolMeta = {
  id: 'retrieve-context',
  name: 'Retrieve Context',
  version: '1.0.0',
  description: 'Retrieve and rerank context chunks for grounding responses.',
  category: 'analysis',
  author: 'ICARUS',
}

export async function execute(input, config = {}) {
  const { query } = input || {}
  if (!query) throw new Error('query is required')
  const { shadowContext, enhancerConfig } = config
  if (!shadowContext) throw new Error('shadowContext not provided in config')

  return retrieveContext({
    query,
    shadowContext,
    config: enhancerConfig?.rag,
  })
}

export async function test() {
  const fake = {
    isReady: true,
    findRelevantFiles: () => [{ path: 'README.md', score: 0.7 }],
    search: () => [{ path: 'README.md', score: 0.6 }],
    contentIndex: new Map([['README.md', 'Project setup and execution guide']]),
  }
  const out = await execute({ query: 'setup guide' }, { shadowContext: fake, enhancerConfig: { rag: {} } })
  const ok = out.contexts?.length > 0 && out.promptContext.includes('README.md')
  return { passed: ok, message: ok ? 'Retrieve context self-test passed.' : 'Context retrieval returned no chunks.' }
}
