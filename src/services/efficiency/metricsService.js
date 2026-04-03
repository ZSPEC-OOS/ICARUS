class EfficiencyMetricsService {
  constructor() {
    this.window = []
    this.latestByTask = new Map()
    this.maxWindow = 200
  }

  record(entry = {}) {
    const normalized = {
      taskId: entry.taskId || 'global',
      stage: entry.stage || 'unspecified',
      ts: entry.ts || Date.now(),
      latencyMs: Number(entry.latencyMs || 0),
      inputTokens: Number(entry.inputTokens || 0),
      outputTokens: Number(entry.outputTokens || 0),
      cacheHit: Boolean(entry.cacheHit),
      meta: entry.meta || {},
    }
    this.window.push(normalized)
    if (this.window.length > this.maxWindow) this.window.shift()
    this.latestByTask.set(normalized.taskId, normalized)
  }

  snapshot() {
    const rows = this.window
    const total = rows.length || 1
    const tokenTotal = rows.reduce((acc, row) => acc + row.inputTokens + row.outputTokens, 0)
    const latencyTotal = rows.reduce((acc, row) => acc + row.latencyMs, 0)
    const cacheHits = rows.filter(r => r.cacheHit).length
    return {
      totals: {
        samples: rows.length,
        tokens: tokenTotal,
        latencyMs: latencyTotal,
        cacheHits,
      },
      averages: {
        tokensPerTask: tokenTotal / total,
        latencyMsPerTask: latencyTotal / total,
        cacheHitRate: cacheHits / total,
      },
      latest: [...this.latestByTask.values()].slice(-15),
    }
  }
}

export const efficiencyMetricsService = new EfficiencyMetricsService()

export function getMetricsDashboard() {
  return {
    generatedAt: new Date().toISOString(),
    ...efficiencyMetricsService.snapshot(),
  }
}
