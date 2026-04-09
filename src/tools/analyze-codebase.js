// ─── analyze-codebase tool ────────────────────────────────────────────────────
export const toolMeta = {
  id: 'analyze-codebase',
  name: 'Analyze Codebase',
  version: '1.0.0',
  description: 'Produce an architecture-level summary using ShadowContext metadata (conventions, hotspots, and symbol map).',
  category: 'analysis',
  author: 'BLUSWAN',
}

function topImportHubs(importGraph = {}, limit = 12) {
  const inDegree = {}
  for (const deps of Object.values(importGraph)) {
    for (const dep of deps || []) inDegree[dep] = (inDegree[dep] || 0) + 1
  }
  return Object.entries(inDegree)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([path, degree]) => ({ path, degree }))
}

export async function execute(input = {}, config = {}) {
  const { shadowContext } = config
  if (!shadowContext) throw new Error('shadowContext not provided in config')

  const ready = !!shadowContext.isReady
  const conventions = shadowContext.getConventions?.() || null
  const repoMap = shadowContext.buildRepoMap?.(Math.max(1200, Math.min(input.max_chars || 3000, 8000))) || null
  const importGraph = shadowContext.getImportGraph?.() || {}
  const topHubs = topImportHubs(importGraph, Math.max(3, Math.min(input.top_hubs || 10, 20)))
  const indexedFiles = shadowContext.indexedFileCount?.() || 0

  if (!ready) {
    return {
      ready: false,
      indexedFiles,
      message: 'Codebase index is not ready yet. Try again after indexing completes.',
    }
  }

  const recommendations = []
  if (topHubs.length > 0) recommendations.push('Prioritize high-degree import hubs when assessing cross-cutting changes.')
  if (conventions?.framework === 'react') recommendations.push('Validate component boundaries and hooks usage across src/components and src/core/hooks.')
  if (indexedFiles < 100) recommendations.push('Index appears small; verify excluded directories are intentional.')

  return {
    ready: true,
    indexedFiles,
    conventions,
    topImportHubs: topHubs,
    repoMap,
    recommendations,
  }
}

export async function test() {
  const fakeShadow = {
    isReady: true,
    getConventions: () => ({ framework: 'react', language: 'JavaScript' }),
    buildRepoMap: () => 'src/App.jsx: App\nsrc/services/agentLoop.js: runAgentLoop',
    getImportGraph: () => ({
      'src/App.jsx': ['src/services/agentLoop.js'],
      'src/main.jsx': ['src/App.jsx', 'src/services/agentLoop.js'],
    }),
    indexedFileCount: () => 200,
  }
  const result = await execute({}, { shadowContext: fakeShadow })
  if (!result.ready) return { passed: false, message: 'Expected ready=true' }
  if (!result.topImportHubs?.length) return { passed: false, message: 'Expected import hubs' }
  if (!result.repoMap?.includes('src/App.jsx')) return { passed: false, message: 'Expected repo map output' }
  return { passed: true, message: 'analyze-codebase self-test passed.' }
}
