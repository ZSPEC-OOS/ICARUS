// ─── FNV-1a 32-bit hash utilities ─────────────────────────────────────────────
// Shared hash primitives used by memoryGraphService, cacheService, and
// toolLoader.  Centralised here so algorithm constants live in one place and
// callers don't have to re-implement the same loop.
//
// All functions accept a string and return a *signed* 32-bit integer (the
// natural output of Math.imul).  Callers that need unsigned should apply
// `>>> 0`; callers that need a non-negative index should apply `Math.abs`.

// ── Primary FNV-1a constants (standard algorithm) ─────────────────────────────
const FNV_OFFSET = 2166136261  // 0x811c9dc5 — FNV offset basis
const FNV_PRIME  = 16777619    // 0x01000193 — FNV prime

/**
 * FNV-1a 32-bit hash of a string (signed result).
 *
 * Callers that need an unsigned value: `fnv1a32(s) >>> 0`
 * Callers that need a non-negative index: `Math.abs(fnv1a32(s))`
 *
 * @param {string} str
 * @returns {number}  Signed 32-bit integer.
 */
export function fnv1a32(str) {
  let h = FNV_OFFSET
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h  = Math.imul(h, FNV_PRIME)
  }
  return h
}

// ── Alternate-seed FNV variant ─────────────────────────────────────────────────
// Uses a different offset and prime to produce an independent hash stream.
// Used by memoryGraphService alongside fnv1a32 to halve collision density when
// projecting tokens into low-dimensional embedding buckets.

const FNV_ALT_OFFSET = 0x84222325
const FNV_ALT_PRIME  = 0x45d9f3b

/**
 * Second independent FNV-variant hash (signed result).
 * Paired with fnv1a32 to provide two statistically independent projections.
 *
 * @param {string} str
 * @returns {number}  Signed 32-bit integer.
 */
export function fnv1a32Alt(str) {
  let h = FNV_ALT_OFFSET
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h  = Math.imul(h, FNV_ALT_PRIME)
  }
  return h
}
