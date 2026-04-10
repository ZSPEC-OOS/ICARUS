// ─── Time utilities ────────────────────────────────────────────────────────────
// Shared date/time helpers used across service modules.

/**
 * Returns the current UTC time as an ISO 8601 string.
 * Centralised here so all trace and graph entries use identical formatting
 * and callers don't define their own one-liner.
 *
 * @returns {string}  e.g. "2026-04-10T11:09:00.000Z"
 */
export function nowIso() {
  return new Date().toISOString()
}
