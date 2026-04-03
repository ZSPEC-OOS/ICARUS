// ─── RAG retrieval service (hybrid lexical + vector-like scoring) ───────────
// Plugs into existing shadowContext indexing with lightweight metadata-rich
// chunking and reranking. This implementation avoids introducing heavy infra
// and can be swapped for a real vector DB backend later.
import { memoryGraphService } from '../memoryGraphService.js'
import { semanticCacheService } from '../efficiency/cacheService.js'
import { efficiencyMetricsService } from '../efficiency/metricsService.js'

/**
 * @typedef {{
 *   id:string,
 *   path:string,
 *   text:string,
 *   metadata:{source:string,date:string|null,section:string,owner:string|null},
 *   lexicalScore:number,
 *   vectorScore:number,
 *   score:number
 * }} RetrievalChunk
 */

/**
 * @param {{query:string,limit?:number,shadowContext:any,weights?:{bm25:number,vector:number},minScore?:number}} input
 * @returns {RetrievalChunk[]}
 */
export function hybridSearch(input) {
  const {
    query,
    limit = 8,
    shadowContext,
    weights = { bm25: 0.45, vector: 0.55 },
    minScore = 0.12,
  } = input || {}

  if (!query?.trim()) throw new Error('query is required')

  const graphHits = memoryGraphService.querySemantic({ query, limit: Math.max(limit * 2, 12) })
  const lexical = shadowContext?.isReady
    ? (shadowContext.findRelevantFiles?.(query, Math.max(limit * 2, 10)) || [])
    : []
  const vectorLike = shadowContext?.isReady
    ? (shadowContext.search?.(query, Math.max(limit * 2, 10)) || lexical)
    : lexical

  const byPath = new Map()

  for (const hit of graphHits) {
    const path = hit.path || hit.id
    const entry = byPath.get(path) || initChunk(path)
    entry.vectorScore = Math.max(entry.vectorScore, normalizeScore(hit.score))
    entry.text = hit.summary || entry.text
    entry.metadata = {
      source: hit.path || hit.id,
      date: hit.updatedAt || null,
      section: hit.type || 'memory',
      owner: hit.metadata?.owner || null,
    }
    byPath.set(path, entry)
  }

  for (const row of lexical) {
    const path = row.path
    const entry = byPath.get(path) || initChunk(path)
    entry.lexicalScore = normalizeScore(row.score)
    byPath.set(path, entry)
  }

  for (const row of vectorLike) {
    const path = row.path
    const entry = byPath.get(path) || initChunk(path)
    entry.vectorScore = normalizeScore(row.score)
    byPath.set(path, entry)
  }

  const chunks = [...byPath.values()].map(chunk => {
    chunk.score = (chunk.lexicalScore * weights.bm25) + (chunk.vectorScore * weights.vector)
    chunk.text = chunk.text || loadChunkPreview(shadowContext, chunk.path)
    chunk.metadata = { ...inferMetadata(chunk.path), ...(chunk.metadata || {}) }
    return chunk
  })

  return chunks
    .filter(c => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Simple reranker that boosts chunks with direct term overlap.
 * @param {{query:string,chunks:RetrievalChunk[],topK?:number}} input
 * @returns {RetrievalChunk[]}
 */
export function rerankChunks(input) {
  const { query = '', chunks = [], topK = 6 } = input || {}
  const qTokens = query.toLowerCase().split(/\W+/).filter(Boolean)

  return [...chunks]
    .map(chunk => {
      const text = `${chunk.path} ${chunk.text}`.toLowerCase()
      const overlap = qTokens.length
        ? qTokens.filter(t => text.includes(t)).length / qTokens.length
        : 0
      return { ...chunk, score: chunk.score + overlap * 0.35 }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

/**
 * @param {{query:string,shadowContext:any,config?:{bm25Weight:number,vectorWeight:number,rerankTopK:number,injectTopK:number,minScore:number}}} input
 */
export function retrieveContext(input) {
  const { query, shadowContext, config = {} } = input || {}
  const cacheKey = {
    query,
    config,
    ready: Boolean(shadowContext?.isReady),
    corpusSize: shadowContext?.contentIndex?.size || shadowContext?._contentIndex?.size || 0,
  }
  const cached = semanticCacheService.get('rag_result', cacheKey)
  if (cached) {
    efficiencyMetricsService.record({
      taskId: query?.slice(0, 64) || 'rag',
      stage: 'rag_retrieve',
      cacheHit: true,
      meta: { cached: true, totalCandidates: cached.totalCandidates || 0 },
    })
    return cached
  }

  const startedAt = Date.now()
  const hybrid = hybridSearch({
    query,
    shadowContext,
    limit: config.rerankTopK || 12,
    minScore: config.minScore ?? 0.12,
    weights: {
      bm25: config.bm25Weight ?? 0.45,
      vector: config.vectorWeight ?? 0.55,
    },
  })

  const reranked = rerankChunks({ query, chunks: hybrid, topK: config.injectTopK || 6 })
  const result = {
    query,
    totalCandidates: hybrid.length,
    contexts: reranked,
    promptContext: reranked.map((c, idx) => `[#${idx + 1}] ${c.path}\n${c.text}`).join('\n\n'),
  }
  semanticCacheService.set('rag_result', cacheKey, result, config.cacheTtlMs || 120000)
  efficiencyMetricsService.record({
    taskId: query?.slice(0, 64) || 'rag',
    stage: 'rag_retrieve',
    latencyMs: Date.now() - startedAt,
    cacheHit: false,
    meta: { totalCandidates: hybrid.length, returned: reranked.length },
  })
  return result
}

function initChunk(path) {
  return {
    id: `chunk:${path}`,
    path,
    text: '',
    metadata: { source: path, date: null, section: inferSection(path), owner: inferOwner(path) },
    lexicalScore: 0,
    vectorScore: 0,
    score: 0,
  }
}

function normalizeScore(score) {
  const n = Number(score)
  if (!Number.isFinite(n)) return 0
  if (n <= 1) return Math.max(0, n)
  return Math.max(0, Math.min(1, n / 100))
}

function loadChunkPreview(shadowContext, path) {
  const fileMap = shadowContext?.contentIndex || shadowContext?._contentIndex || null
  const content = fileMap?.get?.(path) || ''
  if (!content) return `Context preview unavailable for ${path}.`
  return String(content).slice(0, 900)
}

function inferSection(path = '') {
  const parts = path.split('/')
  return parts.length > 1 ? parts[0] : 'root'
}

function inferOwner(path = '') {
  if (path.startsWith('src/components/')) return 'frontend'
  if (path.startsWith('src/services/')) return 'platform'
  if (path.startsWith('tests/')) return 'qa'
  return null
}

function inferMetadata(path) {
  return {
    source: path,
    date: null,
    section: inferSection(path),
    owner: inferOwner(path),
  }
}
