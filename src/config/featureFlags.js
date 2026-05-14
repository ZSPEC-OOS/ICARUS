/**
 * Feature flag system for BLUSWAN V1/V2 migration.
 *
 * Priority order (highest wins):
 *   1. Environment variables (VITE_*)
 *   2. URL query params (?v2=true)
 *   3. localStorage (user preference)
 *   4. Default values
 *
 * Flags are resolved once per getFeatureFlags() call.
 * Changing flags requires a page refresh — no runtime switching.
 */

/**
 * @typedef {Object} FeatureFlags
 * @property {boolean} useV2Engine
 * @property {boolean} useV2UI
 * @property {boolean} useV2Context
 * @property {boolean} useV2LoopPrevention
 * @property {boolean} useV2Reliability
 * @property {boolean} useV2Executor
 * @property {boolean} enablePlanReview
 * @property {boolean} enableCycleReview
 * @property {boolean} enableTelemetry
 * @property {number} maxCycles
 * @property {number} maxTurnsPerCycle
 * @property {number} contextWindow
 * @property {number} remediationBudget
 */

// Guards for Node.js test environments
const _env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : {};
const _getUrl = () => {
  if (typeof window === 'undefined') return new URL('http://localhost/');
  try { return new URL(window.location.href); } catch { return new URL('http://localhost/'); }
};
const _getStorage = () => (typeof localStorage !== 'undefined' ? localStorage : null);

const KNOWN_FLAGS = new Set([
  'useV2Engine', 'useV2UI', 'useV2Context', 'useV2LoopPrevention',
  'useV2Reliability', 'useV2Executor', 'enablePlanReview', 'enableCycleReview',
  'enableTelemetry', 'maxCycles', 'maxTurnsPerCycle', 'contextWindow', 'remediationBudget',
]);

const NUMERIC_FLAGS = new Set(['maxCycles', 'maxTurnsPerCycle', 'contextWindow', 'remediationBudget']);

const STORAGE_KEY = 'bluswan_flags';

// ─── Core Function ────────────────────────────────────────────────────────────

/**
 * Resolves the full set of feature flags with priority-ordered sources.
 * @returns {FeatureFlags}
 */
export function getFeatureFlags() {
  const url = _getUrl();
  const storage = _getStorage();
  const stored = (() => {
    try { return storage ? JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') : {}; }
    catch { return {}; }
  })();

  const bool = (envKey, urlKey, storedKey, def = false) =>
    _env[envKey] === 'true' ||
    (urlKey && url.searchParams.get(urlKey) === 'true') ||
    stored[storedKey] === true ||
    def;

  const num = (envKey, storedKey, def) => {
    const e = parseInt(_env[envKey]);
    if (!isNaN(e)) return e;
    const s = stored[storedKey];
    if (typeof s === 'number' && !isNaN(s)) return s;
    return def;
  };

  return {
    useV2Engine:         bool('VITE_V2_ENGINE',        'v2',    'useV2Engine'),
    useV2UI:             bool('VITE_V2_UI',            'v2ui',  'useV2UI'),
    useV2Context:        bool('VITE_V2_CONTEXT',       null,    'useV2Context'),
    useV2LoopPrevention: bool('VITE_V2_LOOP',          null,    'useV2LoopPrevention'),
    useV2Reliability:    bool('VITE_V2_RELIABILITY',   null,    'useV2Reliability'),
    useV2Executor:       bool('VITE_V2_EXECUTOR',      null,    'useV2Executor'),
    enablePlanReview:    bool('VITE_PLAN_REVIEW',      null,    'enablePlanReview'),
    enableCycleReview:   bool('VITE_CYCLE_REVIEW',     null,    'enableCycleReview'),
    enableTelemetry:     bool('VITE_TELEMETRY',        null,    'enableTelemetry', true),
    maxCycles:           num('VITE_MAX_CYCLES',        'maxCycles',        3),
    maxTurnsPerCycle:    num('VITE_MAX_TURNS',         'maxTurnsPerCycle', 25),
    contextWindow:       num('VITE_CONTEXT_WINDOW',    'contextWindow',    128000),
    remediationBudget:   num('VITE_REMEDIATION_BUDGET','remediationBudget',100),
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Persists a single flag to localStorage. Requires page refresh to take effect.
 * @param {keyof FeatureFlags} key
 * @param {boolean|number} value
 */
export function setFeatureFlag(key, value) {
  if (!KNOWN_FLAGS.has(key)) throw new Error(`Unknown feature flag: ${key}`);
  const storage = _getStorage();
  if (!storage) return;
  try {
    const stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
    stored[key] = NUMERIC_FLAGS.has(key) ? Number(value) : Boolean(value);
    storage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch { /* storage full or blocked */ }
}

/**
 * Clears all persisted flag overrides, reverting to env/default values.
 */
export function resetFeatureFlags() {
  const storage = _getStorage();
  if (storage) {
    try { storage.removeItem(STORAGE_KEY); } catch { /* blocked */ }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true only when all six core V2 subsystems are enabled.
 * @returns {boolean}
 */
export function isV2FullyEnabled() {
  const f = getFeatureFlags();
  return f.useV2Engine && f.useV2UI && f.useV2Executor && f.useV2Context && f.useV2LoopPrevention && f.useV2Reliability;
}

/**
 * Returns a string describing the current migration posture.
 * @returns {'v1_only'|'v2_full'|'v2_partial'|'v2_mixed'}
 */
export function getMigrationStatus() {
  const f = getFeatureFlags();
  if (isV2FullyEnabled()) return 'v2_full';
  if (!f.useV2Engine && !f.useV2UI) return 'v1_only';
  if (f.useV2Engine && f.useV2UI) return 'v2_mixed';
  return 'v2_partial';
}

// ─── Backward-Compatible Export ───────────────────────────────────────────────
// agentLoop.js and fsm.js import { FEATURES } at module load time.
// They only need useV2Engine and useV2UI, which are stable after page load.

export const FEATURES = getFeatureFlags();
