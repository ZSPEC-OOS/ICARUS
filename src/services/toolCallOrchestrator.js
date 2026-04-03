// ─── toolCallOrchestrator.js ──────────────────────────────────────────────────
// Manages tool call lifecycle: ID pool, concurrency semaphore, FIFO queue,
// TTL cache, retry logic, timeout, circuit breaker, event bus, metrics.

// ── UUID v4 ───────────────────────────────────────────────────────────────────
function uuidv4() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidUUIDv4(id) {
  return UUID_RE.test(id)
}

// ── EventBus ─────────────────────────────────────────────────────────────────
export class EventBus {
  constructor() { this._subs = {} }

  on(event, fn) {
    ;(this._subs[event] = this._subs[event] || []).push(fn)
    return () => { this._subs[event] = (this._subs[event] || []).filter(f => f !== fn) }
  }

  emit(event, data) {
    for (const fn of (this._subs[event] || [])) {
      try { fn(data) } catch { /* subscriber errors should not break the bus */ }
    }
  }

  subscriberCount(event) {
    return (this._subs[event] || []).length
  }

  drainEvents(event, handler) {
    // Returns count of subscribers that received the event
    const subs = this._subs[event] || []
    let received = 0
    for (const fn of subs) {
      try { fn(data); received++ } catch {}
    }
    return received
  }
}

// ── ToolCallOrchestrator ──────────────────────────────────────────────────────
export const DEFAULT_CONFIG = {
  maxConcurrent:            5,
  timeout:               10000,   // ms
  retryDelay:             1000,   // ms between retries
  maxRetries:                3,
  callDelay:               100,   // ms minimum gap between calls
  cacheTTL:             300000,   // ms (300s)
  maxCacheEntries:        1000,
  idPoolSize:             1000,
  queueBufferSize:         100,
  partialFailureThreshold:  20,   // % of failures before alert
  circuitBreakerThreshold:   5,   // failures before open
  circuitBreakerReset:   30000,   // ms cooldown
}

export class ToolCallOrchestrator {
  /**
   * @param {object}   config       — Override DEFAULT_CONFIG values
   * @param {function} executeTool  — async (toolId, input, toolConfig) => result
   */
  constructor(config = {}, executeTool = null) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this._executeTool = executeTool

    this._activeCount  = 0
    this._queue        = []             // pending call items
    this._cache        = new Map()      // cacheKey → { result, expiresAt }
    this._idPool       = []             // pre-generated UUID pool
    this._usedIds      = new Set()      // for collision detection (bounded)
    this._idTracker    = []             // [{ id, toolId, status, time }] max 200

    this._metrics = {
      total: 0, success: 0, failed: 0, cacheHits: 0,
      latencies: [],   // last 1000
      errors: [],      // last 50
      retries: 0,
    }

    this._circuit = { failCount: 0, openUntil: 0, state: 'closed' }

    this.events = new EventBus()

    this._fillIdPool()
  }

  // ── ID Pool ─────────────────────────────────────────────────────────────────

  _fillIdPool() {
    const target = Math.max(50, this.config.idPoolSize)
    let added = 0
    while (this._idPool.length < target) {
      this._idPool.push(uuidv4())
      added++
    }
    this.events.emit('pool:fill', { size: this._idPool.length, added })
  }

  generateCallId() {
    if (this._idPool.length < 10) this._fillIdPool()

    const candidate = this._idPool.pop()

    // Detect collision (astronomically rare with UUIDv4, but handled)
    if (this._usedIds.has(candidate)) {
      const replacement = uuidv4()
      this.events.emit('id:collision', { original: candidate, replacement })
      this._trackId(replacement, 'generated', '_pool')
      return replacement
    }

    this._usedIds.add(candidate)
    // Keep _usedIds bounded to last 5000
    if (this._usedIds.size > 5000) {
      const oldest = this._usedIds.values().next().value
      this._usedIds.delete(oldest)
    }

    this._trackId(candidate, 'generated', '_pool')
    return candidate
  }

  // ── Cache ───────────────────────────────────────────────────────────────────

  _cacheKey(toolId, input) {
    return `${toolId}:${JSON.stringify(input)}`
  }

  _cacheGet(key) {
    const entry = this._cache.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) { this._cache.delete(key); return undefined }
    return entry.result
  }

  _cacheSet(key, result) {
    // Evict oldest on capacity
    if (this._cache.size >= this.config.maxCacheEntries) {
      this._cache.delete(this._cache.keys().next().value)
    }
    this._cache.set(key, { result, expiresAt: Date.now() + this.config.cacheTTL, cachedAt: Date.now() })
  }

  invalidateCache(key) { this._cache.delete(key) }

  expireCacheEntry(key) {
    const entry = this._cache.get(key)
    if (entry) { entry.expiresAt = 0 }
  }

  // ── Circuit Breaker ─────────────────────────────────────────────────────────

  _circuitOpen() {
    if (this._circuit.state === 'open') {
      if (Date.now() > this._circuit.openUntil) {
        this._circuit.state = 'half-open'
        this.events.emit('circuit:half-open', {})
        return false
      }
      return true
    }
    return false
  }

  _onCallSuccess() {
    this._circuit.failCount = 0
    if (this._circuit.state === 'half-open') {
      this._circuit.state = 'closed'
      this.events.emit('circuit:closed', {})
    }
  }

  _onCallFailure() {
    this._circuit.failCount++
    if (this._circuit.failCount >= this.config.circuitBreakerThreshold) {
      this._circuit.state = 'open'
      this._circuit.openUntil = Date.now() + this.config.circuitBreakerReset
      this.events.emit('circuit:open', { openUntil: this._circuit.openUntil, failCount: this._circuit.failCount })
    }
  }

  // ── ID Tracker ──────────────────────────────────────────────────────────────

  _trackId(id, status, toolId) {
    this._idTracker.push({ id, status, toolId, time: Date.now() })
    if (this._idTracker.length > 200) this._idTracker.shift()
  }

  getRecentIds(n = 20) {
    return [...this._idTracker].reverse().slice(0, n)
  }

  // ── Queue Processing ────────────────────────────────────────────────────────

  _processQueue() {
    while (this._activeCount < this.config.maxConcurrent && this._queue.length > 0) {
      this._runItem(this._queue.shift())
    }
  }

  async _runItem({ toolId, input, toolConfig, callId, attempt, startedAt, resolve, reject }) {
    this._activeCount++
    this.events.emit('call:start', { callId, toolId, attempt, activeCount: this._activeCount, queueDepth: this._queue.length })

    let timeoutId = null

    const doExecute = async () => {
      if (this.config.callDelay > 0 && attempt === 0) {
        await new Promise(r => setTimeout(r, this.config.callDelay))
      }
      if (!this._executeTool) throw new Error('No executeTool function provided to orchestrator')
      return this._executeTool(toolId, input, toolConfig)
    }

    const withTimeout = new Promise((res, rej) => {
      timeoutId = setTimeout(
        () => rej(new Error(`Timeout: tool "${toolId}" exceeded ${this.config.timeout}ms`)),
        this.config.timeout,
      )
      doExecute().then(res, rej)
    })

    try {
      const result = await withTimeout
      clearTimeout(timeoutId)

      const latency = Date.now() - startedAt
      this._metrics.total++
      this._metrics.success++
      this._metrics.latencies.push(latency)
      if (this._metrics.latencies.length > 1000) this._metrics.latencies.shift()
      this._onCallSuccess()
      this._trackId(callId, 'success', toolId)
      this.events.emit('call:success', { callId, toolId, latency, activeCount: this._activeCount - 1 })

      resolve(result)
    } catch (err) {
      clearTimeout(timeoutId)
      const isTimeout = err.message.startsWith('Timeout:')

      // Retry if not a timeout and attempts remain
      if (!isTimeout && attempt < this.config.maxRetries) {
        this._metrics.retries++
        this._activeCount--
        this.events.emit('call:retry', { callId, toolId, attempt: attempt + 1, error: err.message })
        await new Promise(r => setTimeout(r, this.config.retryDelay))
        this._queue.unshift({ toolId, input, toolConfig, callId, attempt: attempt + 1, startedAt, resolve, reject })
        this._processQueue()
        return
      }

      // Final failure
      this._metrics.total++
      this._metrics.failed++
      this._onCallFailure()
      this._trackId(callId, 'error', toolId)

      const finalErr = attempt > 0
        ? new Error(`Retry exhausted (${attempt}/${this.config.maxRetries}): ${err.message}`)
        : err

      this._metrics.errors.push({ time: Date.now(), callId, toolId, message: finalErr.message })
      if (this._metrics.errors.length > 50) this._metrics.errors.shift()

      this.events.emit('call:error', { callId, toolId, error: finalErr.message, attempt })
      reject(finalErr)
    } finally {
      this._activeCount--
      this.events.emit('call:end', { callId, activeCount: this._activeCount, queueDepth: this._queue.length })
      this._processQueue()
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Schedule a tool call.
   * @param {string}  toolId     — registered tool id
   * @param {object}  input      — tool input params
   * @param {object}  toolConfig — passed through to executeTool (GitHub token, etc.)
   * @param {string}  [callId]   — provide to reuse an existing ID (retry)
   */
  async call(toolId, input, toolConfig = {}, callId = null) {
    const id = callId || this.generateCallId()
    const cacheKey = this._cacheKey(toolId, input)

    // Cache hit
    if (this.config.cacheTTL > 0) {
      const cached = this._cacheGet(cacheKey)
      if (cached !== undefined) {
        this._metrics.cacheHits++
        this._trackId(id, 'cache-hit', toolId)
        this.events.emit('call:cache-hit', { callId: id, toolId })
        return cached
      }
    }

    // Circuit breaker
    if (this._circuitOpen()) {
      throw new Error(
        `Circuit breaker open — resets at ${new Date(this._circuit.openUntil).toLocaleTimeString()}`,
      )
    }

    return new Promise((resolve, reject) => {
      const item = {
        toolId, input, toolConfig, callId: id, attempt: 0,
        startedAt: Date.now(),
        resolve: result => {
          if (this.config.cacheTTL > 0) this._cacheSet(cacheKey, result)
          resolve(result)
        },
        reject,
      }

      if (this._activeCount < this.config.maxConcurrent) {
        this._runItem(item)
      } else {
        if (this._queue.length >= this.config.queueBufferSize) {
          reject(new Error(`Queue full (${this.config.queueBufferSize} items max)`))
          return
        }
        this._queue.push(item)
        this.events.emit('call:queued', { callId: id, toolId, queueDepth: this._queue.length })
      }
    })
  }

  // ── Metrics & State ─────────────────────────────────────────────────────────

  getMetrics() {
    const latencies = this._metrics.latencies
    const avgLatency = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0
    const successRate = this._metrics.total
      ? +(this._metrics.success / this._metrics.total * 100).toFixed(1)
      : 100

    return {
      total:        this._metrics.total,
      success:      this._metrics.success,
      failed:       this._metrics.failed,
      cacheHits:    this._metrics.cacheHits,
      retries:      this._metrics.retries,
      avgLatency,
      successRate,
      activeCount:  this._activeCount,
      queueDepth:   this._queue.length,
      cacheSize:    this._cache.size,
      idPoolSize:   this._idPool.length,
      circuit:      this._circuit.state,
      lastError:    this._metrics.errors[this._metrics.errors.length - 1] || null,
    }
  }

  getErrors() { return [...this._metrics.errors] }

  // ── Maintenance ─────────────────────────────────────────────────────────────

  forceGC() {
    const before = this._cache.size
    const now = Date.now()
    for (const [key, entry] of this._cache) {
      if (now > entry.expiresAt) this._cache.delete(key)
    }
    this._idTracker = this._idTracker.slice(-200)
    const freed = before - this._cache.size
    this.events.emit('system:gc', { freed, cacheSize: this._cache.size })
    return freed
  }

  reset() {
    // Drain queue
    for (const item of this._queue) item.reject(new Error('System reset'))
    this._queue        = []
    this._cache.clear()
    this._idPool       = []
    this._usedIds.clear()
    this._idTracker    = []
    this._activeCount  = 0
    this._circuit      = { failCount: 0, openUntil: 0, state: 'closed' }
    this._metrics      = { total: 0, success: 0, failed: 0, cacheHits: 0, latencies: [], errors: [], retries: 0 }
    this.events.emit('system:reset', {})
    this._fillIdPool()
  }

  updateConfig(partial) {
    this.config = { ...this.config, ...partial }
    if (partial.idPoolSize && this._idPool.length < partial.idPoolSize) this._fillIdPool()
  }
}
