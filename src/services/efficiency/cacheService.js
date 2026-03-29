const DEFAULT_TTL_MS = 5 * 60 * 1000

function stableSerialize(value) {
  if (value == null) return ''
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(k => `${k}:${stableSerialize(value[k])}`).join(',')}}`
}

function hashValue(value = '') {
  let h = 2166136261
  const str = String(value)
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

function canonicalizePayload(payload) {
  if (typeof payload === 'string') return payload.trim()
  return stableSerialize(payload)
}

class SemanticCacheService {
  constructor() {
    this.store = new Map()
    this.stats = {
      hits: 0,
      misses: 0,
      writes: 0,
      evictions: 0,
      deduplicatedWrites: 0,
    }
  }

  makeKey(namespace, key) {
    return `${namespace}:${hashValue(canonicalizePayload(key))}`
  }

  get(namespace, key) {
    const finalKey = this.makeKey(namespace, key)
    const entry = this.store.get(finalKey)
    if (!entry) {
      this.stats.misses += 1
      return null
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(finalKey)
      this.stats.evictions += 1
      this.stats.misses += 1
      return null
    }
    this.stats.hits += 1
    return entry.value
  }

  set(namespace, key, value, ttlMs = DEFAULT_TTL_MS) {
    const finalKey = this.makeKey(namespace, key)
    const nextHash = hashValue(canonicalizePayload(value))
    const prev = this.store.get(finalKey)
    if (prev?.valueHash === nextHash && prev.expiresAt > Date.now()) {
      this.stats.deduplicatedWrites += 1
      return value
    }
    this.store.set(finalKey, {
      value,
      valueHash: nextHash,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    })
    this.stats.writes += 1
    return value
  }

  clearNamespace(namespace) {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(`${namespace}:`)) this.store.delete(key)
    }
  }

  snapshot() {
    const totalLookups = this.stats.hits + this.stats.misses
    return {
      ...this.stats,
      size: this.store.size,
      hitRate: totalLookups ? this.stats.hits / totalLookups : 0,
    }
  }
}

export const semanticCacheService = new SemanticCacheService()
