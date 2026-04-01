const STORAGE_KEY = 'icarus:memory-graph:v1'
const VECTOR_DIM = 128
const MAX_FILE_INGEST_CHARS = 4000

function nowIso() {
  return new Date().toISOString()
}

function tokenize(text = '') {
  return String(text).toLowerCase().replace(/[^a-z0-9_\-/\.\s]/g, ' ').split(/\s+/).filter(Boolean)
}

function stableHash(token) {
  let h = 2166136261
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

function embedText(text = '') {
  const vec = new Array(VECTOR_DIM).fill(0)
  const tokens = tokenize(text)
  for (const t of tokens) vec[stableHash(t) % VECTOR_DIM] += 1
  const mag = Math.sqrt(vec.reduce((sum, n) => sum + (n * n), 0)) || 1
  return vec.map(v => v / mag)
}

function cosineSimilarity(a = [], b = []) {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let score = 0
  for (let i = 0; i < n; i++) score += (a[i] || 0) * (b[i] || 0)
  return score
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function inferNodeType(path = '') {
  if (/\/api\//i.test(path) || /api\./i.test(path)) return 'api'
  if (/\/tests?\//i.test(path) || /\.test\./i.test(path) || /\.spec\./i.test(path)) return 'prior_fix'
  return 'module'
}

function shortSummary(content = '', maxLen = 280) {
  const clean = String(content).replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean
}

class MemoryGraphService {
  constructor() {
    this.nodes = new Map()
    this.edges = new Map()
    this.meta = {
      version: 2,
      updatedAt: nowIso(),
      repoKey: null,
      persistence: 'localStorage',
      sqlitePath: '.icarus/memory/graph.sqlite',
      vectorIndex: 'hashed-cosine:v1',
    }
    this._loaded = false
    this._dirty = false
    this._flushTimer = null
  }

  init() {
    if (this._loaded) return
    this._loadFromLocalStorage()
    this._loaded = true
    this._persistToDiskBestEffort()
  }

  _loadFromLocalStorage() {
    if (typeof localStorage === 'undefined') return
    const payload = safeJsonParse(localStorage.getItem(STORAGE_KEY) || '', null)
    if (!payload) return
    this.meta = { ...this.meta, ...(payload.meta || {}) }
    for (const node of payload.nodes || []) this.nodes.set(node.id, node)
    for (const edge of payload.edges || []) this.edges.set(edge.id, edge)
  }

  _scheduleFlush() {
    this._dirty = true
    clearTimeout(this._flushTimer)
    this._flushTimer = setTimeout(() => this._flush(), 100)
  }

  _flush() {
    if (!this._dirty) return
    const snapshot = this.snapshot()
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
      } catch {
        // noop
      }
    }
    this._persistToDiskBestEffort(snapshot)
    this._dirty = false
  }

  async _persistToDiskBestEffort(snapshot = this.snapshot()) {
    // Browser bundles may not support fs. This best-effort write targets local runtimes.
    try {
      const dynamicImport = (specifier) => Function('s', 'return import(s)')(specifier)
      const [{ mkdir, writeFile }, pathMod] = await Promise.all([
        dynamicImport('node:fs/promises'),
        dynamicImport('node:path'),
      ])
      const dir = pathMod.resolve(process.cwd(), '.icarus', 'memory')
      await mkdir(dir, { recursive: true })
      await writeFile(pathMod.join(dir, 'graph.json'), JSON.stringify(snapshot, null, 2), 'utf8')
    } catch {
      // noop in browser / restricted runtimes
    }
  }

  snapshot() {
    return {
      meta: { ...this.meta, updatedAt: nowIso() },
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    }
  }

  upsertNode(node) {
    this.init()
    const existing = this.nodes.get(node.id)
    const merged = {
      id: node.id,
      type: node.type || existing?.type || 'module',
      title: node.title || existing?.title || node.id,
      path: node.path ?? existing?.path ?? null,
      summary: node.summary ?? existing?.summary ?? '',
      tags: [...new Set([...(existing?.tags || []), ...(node.tags || [])])],
      evidence: [...new Set([...(existing?.evidence || []), ...(node.evidence || [])])].slice(-20),
      metadata: { ...(existing?.metadata || {}), ...(node.metadata || {}) },
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
      embedding: embedText(`${node.title || existing?.title || ''} ${node.summary || existing?.summary || ''} ${(node.tags || []).join(' ')}`),
    }
    this.nodes.set(merged.id, merged)
    this._scheduleFlush()
    return merged
  }

  upsertEdge(edge) {
    this.init()
    const id = edge.id || `${edge.from}->${edge.to}:${edge.type || 'dependency'}`
    const existing = this.edges.get(id)
    this.edges.set(id, {
      id,
      from: edge.from,
      to: edge.to,
      type: edge.type || 'dependency',
      weight: Number.isFinite(edge.weight) ? edge.weight : (existing?.weight ?? 1),
      evidence: [...new Set([...(existing?.evidence || []), ...(edge.evidence || [])])].slice(-20),
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
      metadata: { ...(existing?.metadata || {}), ...(edge.metadata || {}) },
    })
    this._scheduleFlush()
  }

  ingestFileChange({ path, action = 'edit', content = '', repoKey = null, source = 'agent_loop' }) {
    if (!path) return null
    this.init()
    if (repoKey) this.meta.repoKey = repoKey

    const node = this.upsertNode({
      id: `file:${path}`,
      type: inferNodeType(path),
      title: path.split('/').pop() || path,
      path,
      summary: shortSummary(content, 300) || `${action} on ${path}`,
      tags: [action, 'file-change'],
      metadata: { source, action },
      evidence: [`${nowIso()} ${source}: ${action}`],
    })

    this.upsertNode({
      id: `convention:path:${path.split('/')[0] || 'root'}`,
      type: 'convention',
      title: `Path convention ${path.split('/')[0] || 'root'}`,
      summary: `Files under ${path.split('/')[0] || 'root'} evolve together.`,
      tags: ['convention', 'path-prefix'],
    })

    this.upsertEdge({
      from: node.id,
      to: `convention:path:${path.split('/')[0] || 'root'}`,
      type: 'evolution',
      evidence: [`Observed ${action} in agent loop`],
      metadata: { source },
    })

    return node
  }

  ingestShadowContext(shadowContext, repoKey = null) {
    this.init()
    if (!shadowContext?.isReady) return { nodes: 0, edges: 0 }
    if (repoKey) this.meta.repoKey = repoKey

    let addedNodes = 0
    let addedEdges = 0

    const fileIndex = (shadowContext._fileIndex || []).slice(0, 1200)
    for (const file of fileIndex) {
      const full = String(shadowContext._contentIndex?.[file.path]?.full || '').slice(0, MAX_FILE_INGEST_CHARS)
      this.upsertNode({
        id: `file:${file.path}`,
        type: inferNodeType(file.path),
        title: file.name || file.path,
        path: file.path,
        summary: shortSummary(full) || `Indexed ${file.path}`,
        tags: ['repo-sync', file.ext || 'unknown-ext'],
        metadata: { ext: file.ext || null, repoKey: this.meta.repoKey },
      })
      addedNodes += 1
    }

    const importGraph = shadowContext.getImportGraph?.() || {}
    for (const [fromPath, deps] of Object.entries(importGraph)) {
      for (const depPath of deps || []) {
        this.upsertEdge({
          from: `file:${fromPath}`,
          to: `file:${depPath}`,
          type: 'dependency',
          evidence: ['shadowContext import graph'],
        })
        addedEdges += 1
      }
    }

    return { nodes: addedNodes, edges: addedEdges }
  }


  ingestReliabilityRun({ task = '', stateHistory = [], verification = null, rolledBack = false, rollback = null }) {
    this.init()
    const nodeId = `reliability:${stableHash(`${task}:${stateHistory.map(s => s.state).join('>')}`)}`
    const phaseDurationsMs = {}
    for (let i = 0; i < stateHistory.length - 1; i++) {
      const current = stateHistory[i]
      const next = stateHistory[i + 1]
      const delta = Date.parse(next.at || '') - Date.parse(current.at || '')
      if (current?.state && Number.isFinite(delta) && delta >= 0) phaseDurationsMs[current.state] = delta
    }
    return this.upsertNode({
      id: nodeId,
      type: 'reliability_run',
      title: rolledBack ? 'Reliability run (rolled back)' : 'Reliability run',
      summary: shortSummary(`${task} | states: ${stateHistory.map(s => s.state).join(' -> ')} | gates: ${(verification?.gates || []).map(g => `${g.id}:${g.passed ? 'pass' : 'fail'}`).join(', ')}`, 420),
      tags: ['reliability', rolledBack ? 'rolled-back' : 'passed'],
      metadata: {
        rolledBack,
        loopStates: stateHistory.map(row => row.state),
        phaseDurationsMs,
        failedGateIds: verification?.failedGateIds || [],
        rollbackStrategy: rollback?.strategy || null,
      },
      evidence: stateHistory.map(row => `${row.at || nowIso()} state=${row.state}`),
    })
  }

  ingestRollbackOutcome({ reason = '', passed = false, strategy = 'unknown', trace = [], errors = [] }) {
    this.init()
    return this.upsertNode({
      id: `rollback:${stableHash(`${reason}:${strategy}:${trace.length}`)}`,
      type: 'rollback_outcome',
      title: passed ? 'Rollback succeeded' : 'Rollback failed',
      summary: shortSummary(`reason=${reason} strategy=${strategy} touched=${trace.length} errors=${errors.join('; ')}`, 420),
      tags: ['rollback', passed ? 'passed' : 'failed'],
      metadata: { reason, strategy, traceLength: trace.length, errors },
    })
  }



  ingestBenchmarkRun(report = {}) {
    this.init()
    const suiteVersion = report.suiteVersion || `suite-${Date.now()}`
    const nodeId = `benchmark:${stableHash(suiteVersion)}`
    return this.upsertNode({
      id: nodeId,
      type: 'benchmark_run',
      title: `Benchmark ${suiteVersion}`,
      summary: shortSummary(`correctness=${report.correctnessRate} passRate=${report.testPassRate} t2gMs=${report.timeToGreenMs} costPerTask=${report.costPerTask} regressions=${(report.regressions || []).join(', ')}`),
      tags: ['benchmark', report.regressions?.length ? 'regression' : 'healthy'],
      metadata: {
        suiteVersion,
        baselineVersion: report.baselineVersion || null,
        correctnessRate: report.correctnessRate,
        astEditDistance: report.astEditDistance,
        testPassRate: report.testPassRate,
        timeToGreenMs: report.timeToGreenMs,
        costPerTask: report.costPerTask,
        regressions: report.regressions || [],
      },
      evidence: (report.tasks || []).map(task => `${task.name}:${task.correctness ? 'pass' : 'fail'}`),
    })
  }

  /**
   * Log a model-routing decision so future sessions can learn preferred
   * role→model pairings and avoid repeated fallback chains.
   *
   * @param {{
   *   task: string,
   *   role: string,
   *   confidence: number,
   *   strategy: string,
   *   modelId: string,
   *   modelName?: string,
   *   reasoning: string,
   *   usedFallback?: boolean,
   *   fallbackIndex?: number,
   *   scores?: Record<string,number>,
   *   durationMs?: number,
   * }} decision
   */
  logOrchestrationDecision({
    task = '',
    role = '',
    confidence = 0,
    strategy = 'single',
    modelId = '',
    modelName = '',
    reasoning = '',
    usedFallback = false,
    fallbackIndex = 0,
    scores = {},
    durationMs = null,
  }) {
    this.init()
    const nodeId = `orchestration:${stableHash(`${role}:${modelId}:${strategy}:${String(task).slice(0, 80)}`)}`
    return this.upsertNode({
      id: nodeId,
      type: 'orchestration_run',
      title: `Route ${role} → ${modelName || modelId}`,
      summary: shortSummary(
        `role=${role} conf=${confidence.toFixed(2)} model=${modelName || modelId} strategy=${strategy}` +
        (usedFallback ? ` fallbackIdx=${fallbackIndex}` : '') +
        ` | ${reasoning}`, 420
      ),
      tags: ['orchestration', role, strategy, usedFallback ? 'fallback' : 'primary'],
      metadata: {
        role,
        confidence,
        strategy,
        modelId,
        modelName,
        usedFallback,
        fallbackIndex,
        scores,
        durationMs,
      },
      evidence: [`${nowIso()} orchestration: ${reasoning}`],
    })
  }

  ingestCritiqueOutcome({ task = '', critiqueSummary = '', passed = true }) {
    this.init()
    const nodeId = `critique:${stableHash(`${task}:${critiqueSummary}`)}`
    return this.upsertNode({
      id: nodeId,
      type: 'critique_outcome',
      title: passed ? 'Critique passed' : 'Critique issue',
      summary: shortSummary(`${task} ${critiqueSummary}`, 420),
      tags: [passed ? 'passed' : 'issue', 'critique'],
      metadata: { passed },
    })
  }

  querySemantic({ query, limit = 8, types = null }) {
    this.init()
    if (!query?.trim()) return []
    const qVec = embedText(query)
    const qTokens = new Set(tokenize(query))

    const filtered = [...this.nodes.values()].filter(node => !types || types.includes(node.type))
    const scored = filtered.map(node => {
      const semantic = cosineSimilarity(qVec, node.embedding || [])
      const hay = `${node.title} ${node.summary} ${(node.tags || []).join(' ')}`.toLowerCase()
      const overlap = qTokens.size
        ? [...qTokens].filter(t => hay.includes(t)).length / qTokens.size
        : 0
      const recencyBoost = node.updatedAt ? Math.max(0, 1 - (Date.now() - Date.parse(node.updatedAt)) / (1000 * 60 * 60 * 24 * 30)) * 0.08 : 0
      return {
        ...node,
        score: (semantic * 0.72) + (overlap * 0.28) + recencyBoost,
      }
    })

    return scored
      .filter(row => row.score > 0.07)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(limit, 30)))
  }

  queryForPlanning(query, limit = 6) {
    const hits = this.querySemantic({ query, limit })
    return {
      query,
      hits,
      summary: hits.map((hit, idx) => `[#${idx + 1}] ${hit.path || hit.title} (${hit.type}, score ${hit.score.toFixed(3)})`).join('\n'),
    }
  }
}

export const memoryGraphService = new MemoryGraphService()
