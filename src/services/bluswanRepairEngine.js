// ─── BLUSWAN Repair Engine ──────────────────────────────────────────────────────
//
// Adaptive error classification and repair pathway system for BLUSWAN.
// Ensures that BLUSWAN is never in a complete halt position — every error has a
// tiered repair strategy that degrades gracefully from fix → warn → fallback.
//
// Design principles
//   1. Never throw — the repair engine itself must be error-proof.
//   2. Tier repairs: attempt auto-fix first, then warn, then degrade gracefully.
//   3. Track repair history to detect oscillation and escalate appropriately.
//   4. Scope halts to the individual file, never the whole session.
//   5. Always reset state flags so the UI never freezes.
//
// Usage
//   import { repairEngine } from './bluswanRepairEngine'
//
//   // Classify an error (call from any catch block)
//   const info = repairEngine.classify(error)
//   // → { category, code, severity, message, retryable }
//
//   // Execute the repair pathway for an error in a given context
//   const result = repairEngine.repair(error, context)
//   // → { action, message, resetFlags, shouldRetry, fallbackData }
//
//   // Access the diagnostic log
//   const log = repairEngine.getLog()
//
// ─────────────────────────────────────────────────────────────────────────────

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_REPAIR_ATTEMPTS = 3   // per error code per session before escalation
const MAX_REPAIR_LOG_SIZE = 200  // diagnostic log entries retained

// ── Severity levels ───────────────────────────────────────────────────────────
// fatal      → halt this file only; surface error; no auto-retry
// critical   → halt this file; allow manual retry via UI button
// recoverable→ auto-retry with modified strategy; surface warning
// degraded   → proceed with reduced capability; log warning
// info       → no user-visible action; log only

const SEVERITY = {
  FATAL:       'fatal',
  CRITICAL:    'critical',
  RECOVERABLE: 'recoverable',
  DEGRADED:    'degraded',
  INFO:        'info',
}

// ── Actions the repair engine can prescribe ───────────────────────────────────
// surface-error       → show error message, reset state, stop this file
// retry-with-backoff  → pause then retry same call
// retry-modified      → retry with adjusted parameters (shorter prompt, etc.)
// fallback-plan       → replace failed sub-system output with a safe default
// reset-state         → reset all isGenerating/isPlanning/etc. flags
// degrade-gracefully  → continue without the failed component
// halt-file           → stop this specific file, continue others
// escalate            → stop all generation after too many repair failures

const ACTION = {
  SURFACE_ERROR:      'surface-error',
  RETRY_BACKOFF:      'retry-with-backoff',
  RETRY_MODIFIED:     'retry-modified',
  FALLBACK_PLAN:      'fallback-plan',
  RESET_STATE:        'reset-state',
  DEGRADE_GRACEFULLY: 'degrade-gracefully',
  HALT_FILE:          'halt-file',
  ESCALATE:           'escalate',
}

// ── Error registry ────────────────────────────────────────────────────────────
// Maps error codes to their classification and repair tiers.
// Tiers are tried in order; once a tier succeeds it stops escalating.

const ERROR_REGISTRY = {

  // ── API / Network ─────────────────────────────────────────────────────────
  'no-api-key': {
    category:  'api',
    severity:  SEVERITY.FATAL,
    message:   'No API key configured. Open Settings to add one.',
    retryable: false,
    tiers: [
      { action: ACTION.SURFACE_ERROR, resetFlags: ['isGenerating', 'isPlanning', 'isAmplifying'] },
    ],
  },
  'api-401': {
    category:  'api',
    severity:  SEVERITY.FATAL,
    message:   'API key rejected (401 Unauthorised). Check your key in Settings.',
    retryable: false,
    tiers: [
      { action: ACTION.SURFACE_ERROR, resetFlags: ['isGenerating'] },
    ],
  },
  'api-403': {
    category:  'api',
    severity:  SEVERITY.FATAL,
    message:   'Access forbidden (403). Verify API key permissions.',
    retryable: false,
    tiers: [
      { action: ACTION.SURFACE_ERROR, resetFlags: ['isGenerating'] },
    ],
  },
  'api-429': {
    category:  'api',
    severity:  SEVERITY.RECOVERABLE,
    message:   'Rate limit reached (429). Retrying with exponential backoff…',
    retryable: true,
    tiers: [
      { action: ACTION.RETRY_BACKOFF,  delayMs: 2000,  resetFlags: [] },
      { action: ACTION.RETRY_BACKOFF,  delayMs: 4000,  resetFlags: [] },
      { action: ACTION.RETRY_BACKOFF,  delayMs: 8000,  resetFlags: [] },
      { action: ACTION.RETRY_BACKOFF,  delayMs: 16000, resetFlags: [] },
      { action: ACTION.SURFACE_ERROR,  resetFlags: ['isGenerating'] },
    ],
  },
  'api-500-stream': {
    category:  'api',
    severity:  SEVERITY.CRITICAL,
    message:   'Server error during streaming (500). Partial output preserved.',
    retryable: true,
    tiers: [
      { action: ACTION.RETRY_BACKOFF,  delayMs: 3000,  resetFlags: [] },
      { action: ACTION.HALT_FILE,      resetFlags: ['isGenerating'] },
    ],
  },
  'network-disconnect': {
    category:  'api',
    severity:  SEVERITY.RECOVERABLE,
    message:   'Network disconnected mid-stream. Partial output preserved.',
    retryable: true,
    tiers: [
      { action: ACTION.RETRY_BACKOFF,  delayMs: 2000,  resetFlags: [] },
      { action: ACTION.HALT_FILE,      resetFlags: ['isGenerating'] },
    ],
  },
  'context-overflow': {
    category:  'api',
    severity:  SEVERITY.CRITICAL,
    message:   'Context window exceeded. Try a smaller prompt or reduce ambient context.',
    retryable: true,
    tiers: [
      { action: ACTION.RETRY_MODIFIED, note: 'strip-ambient-context', resetFlags: [] },
      { action: ACTION.SURFACE_ERROR,  resetFlags: ['isGenerating'] },
    ],
  },
  'provider-non-json': {
    category:  'api',
    severity:  SEVERITY.CRITICAL,
    message:   'Unexpected API response format — server returned non-JSON.',
    retryable: false,
    tiers: [
      { action: ACTION.SURFACE_ERROR, resetFlags: ['isGenerating'] },
    ],
  },

  // ── Planner ───────────────────────────────────────────────────────────────
  'planner-json-error': {
    category:  'planner',
    severity:  SEVERITY.RECOVERABLE,
    message:   'Planner returned invalid JSON — using single-file fallback plan.',
    retryable: false,
    tiers: [
      { action: ACTION.FALLBACK_PLAN, resetFlags: ['isPlanning'], note: 'single-file-plan' },
    ],
  },
  'planner-schema-error': {
    category:  'planner',
    severity:  SEVERITY.DEGRADED,
    message:   'Planner response missing required fields — applying defaults.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, resetFlags: [], note: 'apply-schema-defaults' },
    ],
  },
  'planner-empty': {
    category:  'planner',
    severity:  SEVERITY.CRITICAL,
    message:   'Planner returned an empty file plan. Nothing to generate.',
    retryable: true,
    tiers: [
      { action: ACTION.RETRY_MODIFIED, note: 'retry-planner-with-simpler-prompt', resetFlags: [] },
      { action: ACTION.SURFACE_ERROR,  resetFlags: ['isPlanning', 'isGenerating'] },
    ],
  },
  'planner-sync-throw': {
    category:  'planner',
    severity:  SEVERITY.CRITICAL,
    message:   'Planner threw unexpectedly. Resetting state.',
    retryable: false,
    tiers: [
      { action: ACTION.RESET_STATE, resetFlags: ['isPlanning', 'isGenerating'] },
    ],
  },

  // ── Generation / Per-file ─────────────────────────────────────────────────
  'per-file-error': {
    category:  'generation',
    severity:  SEVERITY.CRITICAL,
    message:   'File generation failed. Use the retry button (↺) to regenerate this file.',
    retryable: true,
    tiers: [
      { action: ACTION.HALT_FILE, resetFlags: [] },
    ],
  },
  'all-files-error': {
    category:  'generation',
    severity:  SEVERITY.CRITICAL,
    message:   'All files in the plan failed to generate. Check model and API key.',
    retryable: true,
    tiers: [
      { action: ACTION.SURFACE_ERROR, resetFlags: ['isGenerating'] },
    ],
  },
  'empty-ai-response': {
    category:  'generation',
    severity:  SEVERITY.CRITICAL,
    message:   'AI returned an empty response for this file.',
    retryable: true,
    tiers: [
      { action: ACTION.RETRY_MODIFIED, note: 'add-explicit-output-instruction', resetFlags: [] },
      { action: ACTION.HALT_FILE,      resetFlags: [] },
    ],
  },
  'continuation-catch': {
    category:  'generation',
    severity:  SEVERITY.DEGRADED,
    message:   'Continuation failed — using partial output.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'use-partial-output', resetFlags: [] },
    ],
  },
  'abort-mid': {
    category:  'generation',
    severity:  SEVERITY.INFO,
    message:   'Generation aborted by user.',
    retryable: false,
    tiers: [
      { action: ACTION.RESET_STATE, resetFlags: ['isGenerating', 'isGenTests'] },
    ],
  },

  // ── State ─────────────────────────────────────────────────────────────────
  'isGenTests-stuck': {
    category:  'state',
    severity:  SEVERITY.RECOVERABLE,
    message:   'Test generation appeared stuck — forcing state reset.',
    retryable: false,
    tiers: [
      { action: ACTION.RESET_STATE, resetFlags: ['isGenTests'] },
    ],
  },
  'watchdog': {
    category:  'state',
    severity:  SEVERITY.CRITICAL,
    message:   '⚠ Watchdog: generation timed out. All state flags reset.',
    retryable: false,
    tiers: [
      { action: ACTION.RESET_STATE, resetFlags: ['isGenerating', 'isGenTests', 'isPlanning', 'isAmplifying'] },
    ],
  },
  'unmount-mid-generation': {
    category:  'state',
    severity:  SEVERITY.INFO,
    message:   'Component unmounted during generation — aborting cleanly.',
    retryable: false,
    tiers: [
      { action: ACTION.RESET_STATE, resetFlags: ['isGenerating', 'isGenTests', 'isPlanning'] },
    ],
  },

  // ── GitHub / Push ─────────────────────────────────────────────────────────
  'push-401': {
    category:  'github',
    severity:  SEVERITY.FATAL,
    message:   'GitHub push failed (401) — check your Personal Access Token.',
    retryable: false,
    tiers: [
      { action: ACTION.SURFACE_ERROR, resetFlags: ['isPushing'] },
    ],
  },
  'push-403': {
    category:  'github',
    severity:  SEVERITY.FATAL,
    message:   'Insufficient GitHub permissions (403) — check PAT scopes (need repo).',
    retryable: false,
    tiers: [
      { action: ACTION.SURFACE_ERROR, resetFlags: ['isPushing'] },
    ],
  },
  'push-404': {
    category:  'github',
    severity:  SEVERITY.FATAL,
    message:   'Repository not found (404) — verify owner and repo name in Settings.',
    retryable: false,
    tiers: [
      { action: ACTION.SURFACE_ERROR, resetFlags: ['isPushing'] },
    ],
  },
  'push-conflict': {
    category:  'github',
    severity:  SEVERITY.RECOVERABLE,
    message:   'Push conflict — file was modified remotely. Refreshing SHA and retrying.',
    retryable: true,
    tiers: [
      { action: ACTION.RETRY_MODIFIED, note: 'refresh-sha', resetFlags: [] },
      { action: ACTION.SURFACE_ERROR,  resetFlags: ['isPushing'] },
    ],
  },

  // ── Agent ─────────────────────────────────────────────────────────────────
  'agent-tool-error': {
    category:  'agent',
    severity:  SEVERITY.DEGRADED,
    message:   'Agent tool call returned an error — agent will continue with error result.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'pass-error-as-tool-result', resetFlags: [] },
    ],
  },
  'agent-max-turns': {
    category:  'agent',
    severity:  SEVERITY.CRITICAL,
    message:   'Agent reached maximum turn limit. Session ended.',
    retryable: false,
    tiers: [
      { action: ACTION.SURFACE_ERROR, resetFlags: ['isAgentRunning'] },
    ],
  },
  'agent-abort': {
    category:  'agent',
    severity:  SEVERITY.INFO,
    message:   'Agent session aborted by user.',
    retryable: false,
    tiers: [
      { action: ACTION.RESET_STATE, resetFlags: ['isAgentRunning'] },
    ],
  },
  'agent-overwrite-critical': {
    category:  'agent',
    severity:  SEVERITY.CRITICAL,
    message:   'Agent attempted to overwrite an existing file. Confirm in permission dialog.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'require-permission-confirmation', resetFlags: [] },
    ],
  },
  'kimi-thinking': {
    category:  'agent',
    severity:  SEVERITY.RECOVERABLE,
    message:   'Kimi reasoning_content issue detected — stripping from prior turns.',
    retryable: true,
    tiers: [
      { action: ACTION.RETRY_MODIFIED, note: 'strip-reasoning-content', resetFlags: [] },
      { action: ACTION.SURFACE_ERROR,  resetFlags: ['isGenerating', 'isAgentRunning'] },
    ],
  },

  // ── Malformed Responses ───────────────────────────────────────────────────
  'amplifier-json-error': {
    category:  'malformed',
    severity:  SEVERITY.DEGRADED,
    message:   'IntentAmplifier parse failed — using original prompt.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'use-original-prompt', resetFlags: ['isAmplifying'] },
    ],
  },
  'extract-code-multi-block': {
    category:  'malformed',
    severity:  SEVERITY.INFO,
    message:   'Multiple code blocks detected — using first block.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'use-first-block', resetFlags: [] },
    ],
  },

  // ── ShadowContext ─────────────────────────────────────────────────────────
  'ambient-context-fail': {
    category:  'shadowctx',
    severity:  SEVERITY.DEGRADED,
    message:   '⚠ Context index unavailable — generating without repo context.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'generate-without-context', resetFlags: [] },
    ],
  },
  'storage-quota': {
    category:  'shadowctx',
    severity:  SEVERITY.DEGRADED,
    message:   'SessionStorage quota exceeded — cache write skipped. Continuing in-memory.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'skip-cache-write', resetFlags: [] },
    ],
  },

  // ── Remediation ───────────────────────────────────────────────────────────
  'remediation-oscillation': {
    category:  'remediation',
    severity:  SEVERITY.DEGRADED,
    message:   'No progress between remediation passes — stopping early.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'present-code-as-is', resetFlags: [] },
    ],
  },
  'remediation-max-attempts': {
    category:  'remediation',
    severity:  SEVERITY.DEGRADED,
    message:   'Auto-remediation: max attempts reached. Code presented with warnings.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'present-code-with-lint-warnings', resetFlags: [] },
    ],
  },
  'eslint-unavailable': {
    category:  'remediation',
    severity:  SEVERITY.DEGRADED,
    message:   'eslint unavailable — skipping lint check, using static hints only.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'use-checklist-remediation', resetFlags: [] },
    ],
  },
  'pyodide-load-fail': {
    category:  'remediation',
    severity:  SEVERITY.DEGRADED,
    message:   'Pyodide unavailable — using static analysis hints for Python.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'use-checklist-remediation', resetFlags: [] },
    ],
  },

  // ── Edit Blocks ───────────────────────────────────────────────────────────
  'editblock-no-match': {
    category:  'editblock',
    severity:  SEVERITY.DEGRADED,
    message:   'Edit block search not found — appended at end of file.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'append-edit-content', resetFlags: [] },
    ],
  },
  'editblock-unclosed': {
    category:  'editblock',
    severity:  SEVERITY.DEGRADED,
    message:   'Unclosed EDIT_START block detected — falling back to whole-file replacement.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'whole-file-fallback', resetFlags: [] },
    ],
  },

  // ── Streaming ─────────────────────────────────────────────────────────────
  'stream-malformed-event': {
    category:  'streaming',
    severity:  SEVERITY.DEGRADED,
    message:   'Malformed SSE event skipped — continuing stream.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'skip-bad-event', resetFlags: [] },
    ],
  },
  'stream-stall': {
    category:  'streaming',
    severity:  SEVERITY.CRITICAL,
    message:   '⚠ Stream stalled — saving partial output.',
    retryable: true,
    tiers: [
      { action: ACTION.RETRY_BACKOFF,  delayMs: 5000,  resetFlags: [] },
      { action: ACTION.HALT_FILE,      resetFlags: ['isGenerating'] },
    ],
  },
  'stream-callback-error': {
    category:  'streaming',
    severity:  SEVERITY.DEGRADED,
    message:   'Streaming callback threw — error logged, stream continues.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'continue-stream-without-callback', resetFlags: [] },
    ],
  },

  // ── Repair engine internal ────────────────────────────────────────────────
  'repair-max-attempts': {
    category:  'repair',
    severity:  SEVERITY.CRITICAL,
    message:   'Repair engine exhausted all attempts for this file.',
    retryable: false,
    tiers: [
      { action: ACTION.HALT_FILE, resetFlags: [] },
    ],
  },

  // ── Abort handling (from bug audit) ──────────────────────────────────────
  'abort-in-fetch-retry': {
    category:  'abort',
    severity:  SEVERITY.INFO,
    message:   'Generation aborted by user.',
    retryable: false,
    tiers: [
      // AbortError now propagates immediately from fetchWithRetry — no retry delay
      { action: ACTION.RESET_STATE, resetFlags: ['isGenerating', 'isPlanning', 'isAmplifying', 'isGenTests'] },
    ],
  },
  'agent-abort-no-done-event': {
    category:  'agent',
    severity:  SEVERITY.CRITICAL,
    message:   'Agent abort did not emit done event — forcing isAgentRunning reset.',
    retryable: false,
    tiers: [
      { action: ACTION.RESET_STATE, resetFlags: ['isAgentRunning'] },
    ],
  },

  // ── Edit block precision (from bug audit) ─────────────────────────────────
  'editblock-multi-occurrence': {
    category:  'editblock',
    severity:  SEVERITY.DEGRADED,
    message:   '⚠ Edit block matched multiple locations — applied to first occurrence only.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'first-occurrence-applied-warn-user', resetFlags: [] },
    ],
  },
  'editblock-empty-old': {
    category:  'editblock',
    severity:  SEVERITY.DEGRADED,
    message:   'EDIT block has empty OLD section — prepending new content.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'prepend-new-content', resetFlags: [] },
    ],
  },

  // ── Agent / Tool edge cases (from bug audit) ──────────────────────────────
  'agent-tool-json-parse-error': {
    category:  'agent',
    severity:  SEVERITY.DEGRADED,
    message:   'Malformed tool JSON in stream — tool call skipped, agent continues.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'skip-malformed-tool-call', resetFlags: [] },
    ],
  },
  'prune-messages-guard': {
    category:  'agent',
    severity:  SEVERITY.DEGRADED,
    message:   'Message history too short to prune — using full history.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'return-full-history', resetFlags: [] },
    ],
  },
  'conventions-null-guard': {
    category:  'agent',
    severity:  SEVERITY.INFO,
    message:   'Conventions not available — system prompt generated without project context.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'omit-conventions-block', resetFlags: [] },
    ],
  },

  // ── Provider / API response edge cases (from bug audit) ──────────────────
  'provider-response-parse-catch': {
    category:  'api',
    severity:  SEVERITY.CRITICAL,
    message:   'API returned non-JSON response — cannot parse. Check API key and base URL.',
    retryable: false,
    tiers: [
      { action: ACTION.SURFACE_ERROR, resetFlags: ['isGenerating', 'isAgentRunning'] },
    ],
  },
  'kimi-reasoning-size-cap': {
    category:  'provider',
    severity:  SEVERITY.DEGRADED,
    message:   'Kimi reasoning_content exceeded size cap — remainder discarded.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'cap-reasoning-content', resetFlags: [] },
    ],
  },
  'tool-blocks-growth-guard': {
    category:  'streaming',
    severity:  SEVERITY.DEGRADED,
    message:   'Tool block index grew unexpectedly — pruning stale entries.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'prune-tool-blocks', resetFlags: [] },
    ],
  },

  // ── Planner deep edge cases (from bug audit) ──────────────────────────────
  'fallback-plan-language-detection': {
    category:  'planner',
    severity:  SEVERITY.DEGRADED,
    message:   'Planner fallback using language detected from prompt — conventions unavailable.',
    retryable: false,
    tiers: [
      { action: ACTION.FALLBACK_PLAN, note: 'detect-language-from-prompt', resetFlags: ['isPlanning'] },
    ],
  },

  // ── ShadowContext deep edge cases (from bug audit) ────────────────────────
  'context-expansion-cap': {
    category:  'shadowctx',
    severity:  SEVERITY.INFO,
    message:   'Context file expansion capped at CONTEXT_FILES_LIMIT.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'cap-context-files', resetFlags: [] },
    ],
  },
  'convention-detection-dominant': {
    category:  'shadowctx',
    severity:  SEVERITY.INFO,
    message:   'Mixed naming conventions detected — using majority pattern.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'use-dominant-convention', resetFlags: [] },
    ],
  },

  // ── Conversation / Memory (from bug audit) ────────────────────────────────
  'conversation-malformed-load': {
    category:  'state',
    severity:  SEVERITY.RECOVERABLE,
    message:   'Conversation history contained invalid entries — starting fresh.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'drop-malformed-messages', resetFlags: [] },
    ],
  },

  // ── Exec bridge (from bug audit) ──────────────────────────────────────────
  'bridge-availability-re-probe': {
    category:  'execbridge',
    severity:  SEVERITY.DEGRADED,
    message:   'Exec bridge unavailable — lint checking disabled. Restart dev server and re-probe.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'disable-lint-checks', resetFlags: [] },
    ],
  },
  'exec-bridge-data-field-guard': {
    category:  'execbridge',
    severity:  SEVERITY.INFO,
    message:   'Exec bridge stream event missing data field — using empty string.',
    retryable: false,
    tiers: [
      { action: ACTION.DEGRADE_GRACEFULLY, note: 'default-empty-data', resetFlags: [] },
    ],
  },
}

// ── Default fallback entry (for unknown error codes) ──────────────────────────
const DEFAULT_REPAIR = {
  category:  'unknown',
  severity:  SEVERITY.CRITICAL,
  message:   'An unexpected error occurred.',
  retryable: false,
  tiers: [
    { action: ACTION.RESET_STATE, resetFlags: ['isGenerating', 'isPlanning', 'isAmplifying', 'isGenTests', 'isPushing', 'isAgentRunning'] },
    { action: ACTION.SURFACE_ERROR, resetFlags: [] },
  ],
}

// ── HTTP status → error code mapping ─────────────────────────────────────────
const HTTP_STATUS_MAP = {
  401: 'api-401',
  403: 'api-403',
  404: 'push-404',
  409: 'push-conflict',
  429: 'api-429',
  500: 'api-500-stream',
  503: 'api-500-stream',
}

// ── Repair Engine ─────────────────────────────────────────────────────────────

class BluswanRepairEngine {
  constructor() {
    // Per-code attempt counter — tracks how many times a code has been repaired
    this._attempts  = {}
    // Diagnostic log — circular buffer
    this._log       = []
    // Tier cursor per error code — which tier we're currently on
    this._tierCursor = {}
  }

  // ── classify(error) ────────────────────────────────────────────────────────
  // Determines the error code, category, severity and message from an Error
  // object or a plain string code.
  //
  // Returns: { code, category, severity, message, retryable }
  classify(errorOrCode) {
    try {
      let code = null

      if (typeof errorOrCode === 'string') {
        code = errorOrCode
      } else if (errorOrCode && typeof errorOrCode === 'object') {
        // 1. Explicit code set by throw site
        if (errorOrCode.bluswanCode) {
          code = errorOrCode.bluswanCode
        }
        // 2. HTTP status on a fetch response
        else if (errorOrCode.status && HTTP_STATUS_MAP[errorOrCode.status]) {
          code = HTTP_STATUS_MAP[errorOrCode.status]
        }
        // 3. AbortError from AbortController
        else if (errorOrCode.name === 'AbortError') {
          code = 'abort-mid'
        }
        // 4. Network errors
        else if (errorOrCode.name === 'TypeError' && errorOrCode.message?.includes('fetch')) {
          code = 'network-disconnect'
        }
        // 5. JSON parse errors from planner
        else if (errorOrCode instanceof SyntaxError && errorOrCode._source === 'planner') {
          code = 'planner-json-error'
        }
        // 6. JSON parse errors from amplifier
        else if (errorOrCode instanceof SyntaxError && errorOrCode._source === 'amplifier') {
          code = 'amplifier-json-error'
        }
        // 7. Generic SyntaxError
        else if (errorOrCode instanceof SyntaxError) {
          code = 'planner-json-error'  // most likely origin
        }
        // 8. Message-based heuristics as last resort
        else {
          const msg = (errorOrCode.message || '').toLowerCase()
          if (msg.includes('401') || msg.includes('unauthorized'))   code = 'api-401'
          else if (msg.includes('403') || msg.includes('forbidden')) code = 'api-403'
          else if (msg.includes('429') || msg.includes('rate limit'))code = 'api-429'
          else if (msg.includes('404') || msg.includes('not found')) code = 'push-404'
          else if (msg.includes('quota'))                            code = 'storage-quota'
          else if (msg.includes('context') && msg.includes('window'))code = 'context-overflow'
          else if (msg.includes('watchdog'))                         code = 'watchdog'
          else if (msg.includes('max turn'))                         code = 'agent-max-turns'
        }
      }

      const entry = (code && ERROR_REGISTRY[code]) ? ERROR_REGISTRY[code] : DEFAULT_REPAIR
      return { code: code || 'unknown', ...entry }
    } catch {
      // classify() must never itself throw
      return { code: 'unknown', ...DEFAULT_REPAIR }
    }
  }

  // ── repair(errorOrCode, context) ───────────────────────────────────────────
  // Selects and applies the appropriate repair tier for the given error.
  // Returns a repair result object that the caller uses to update state.
  //
  // context: {
  //   filePath?:   string   — the file being generated (if applicable)
  //   partialCode?:string   — partial code accumulated so far
  //   attemptNum?: number   — caller's own attempt counter (for remediation)
  // }
  //
  // Returns: {
  //   action:      string   — what to do (see ACTION constants)
  //   code:        string   — the error code
  //   message:     string   — human-readable description
  //   severity:    string   — severity level
  //   resetFlags:  string[] — state flag names to reset (caller must act on these)
  //   shouldRetry: boolean  — true if caller should retry the operation
  //   delayMs:     number   — wait before retry (0 if not applicable)
  //   note:        string   — optional implementation hint for the caller
  //   fallbackData:any      — optional data the caller can use as a fallback
  //   exhausted:   boolean  — true if all repair tiers were tried
  // }
  repair(errorOrCode, context = {}) {
    try {
      const info = this.classify(errorOrCode)
      const { code, severity, message, tiers } = info

      // Initialise attempt tracking for this code
      if (!this._attempts[code]) this._attempts[code] = 0
      if (!this._tierCursor[code]) this._tierCursor[code] = 0

      const cursorIdx = this._tierCursor[code]
      const tier      = tiers[Math.min(cursorIdx, tiers.length - 1)]

      // Check if we've exceeded max repair attempts for this code
      this._attempts[code]++
      const isExhausted = this._attempts[code] > MAX_REPAIR_ATTEMPTS && tiers.length > 0

      if (isExhausted && cursorIdx < tiers.length - 1) {
        // Escalate: jump to last tier (most conservative)
        this._tierCursor[code] = tiers.length - 1
      } else if (!isExhausted) {
        // Advance tier cursor for next call
        this._tierCursor[code] = Math.min(cursorIdx + 1, tiers.length - 1)
      }

      const result = {
        action:      tier.action,
        code,
        message,
        severity,
        resetFlags:  tier.resetFlags || [],
        shouldRetry: tier.action === ACTION.RETRY_BACKOFF || tier.action === ACTION.RETRY_MODIFIED,
        delayMs:     tier.delayMs || 0,
        note:        tier.note || '',
        fallbackData: this._buildFallbackData(code, context),
        exhausted:   isExhausted,
      }

      // Record to diagnostic log
      this._appendLog({
        timestamp:  Date.now(),
        errorCode:  code,
        filePath:   context.filePath || null,
        action:     tier.action,
        severity,
        resolved:   tier.action !== ACTION.SURFACE_ERROR && tier.action !== ACTION.ESCALATE,
        tierUsed:   cursorIdx,
        exhausted:  isExhausted,
      })

      return result
    } catch {
      // repair() itself must never throw — return a safe default
      return {
        action:      ACTION.RESET_STATE,
        code:        'unknown',
        message:     'Repair engine encountered an internal error. State has been reset.',
        severity:    SEVERITY.CRITICAL,
        resetFlags:  ['isGenerating', 'isPlanning', 'isAmplifying', 'isGenTests', 'isPushing', 'isAgentRunning'],
        shouldRetry: false,
        delayMs:     0,
        note:        '',
        fallbackData: null,
        exhausted:   true,
      }
    }
  }

  // ── repairAsync(errorOrCode, context) ──────────────────────────────────────
  // Async variant that automatically applies the delay for retry-with-backoff.
  async repairAsync(errorOrCode, context = {}) {
    const result = this.repair(errorOrCode, context)
    if (result.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, result.delayMs))
    }
    return result
  }

  // ── resetAttempts(code) ────────────────────────────────────────────────────
  // Resets the repair attempt counter for a specific error code.
  // Call this after a successful operation to allow fresh repair cycles.
  resetAttempts(code) {
    try {
      if (code) {
        delete this._attempts[code]
        delete this._tierCursor[code]
      }
    } catch { /* safe to ignore */ }
  }

  // ── resetAll() ────────────────────────────────────────────────────────────
  // Resets all attempt counters. Call at the start of a new generation run.
  resetAll() {
    try {
      this._attempts   = {}
      this._tierCursor = {}
    } catch { /* safe to ignore */ }
  }

  // ── getLog() ──────────────────────────────────────────────────────────────
  // Returns a copy of the diagnostic log.
  getLog() {
    return [...this._log]
  }

  // ── clearLog() ────────────────────────────────────────────────────────────
  clearLog() {
    this._log = []
  }

  // ── getSummary() ──────────────────────────────────────────────────────────
  // Returns a summary of errors encountered this session.
  getSummary() {
    const counts = {}
    for (const entry of this._log) {
      counts[entry.errorCode] = (counts[entry.errorCode] || 0) + 1
    }
    return {
      totalErrors: this._log.length,
      byCodes:     counts,
      unresolved:  this._log.filter(e => !e.resolved).length,
    }
  }

  // ── buildFallbackPlan(filePath) ────────────────────────────────────────────
  // Generates a minimal single-file plan as a planner fallback.
  // Exported so callers can use it directly without going through repair().
  buildFallbackPlan(filePath = 'src/index.js') {
    return [
      { path: filePath, action: 'create', purpose: 'Fallback single-file plan (planner failed)' },
    ]
  }

  // ── normalisePlannerSchema(rawPlan) ──────────────────────────────────────
  // Applies defaults to a partially-invalid planner response.
  normalisePlannerSchema(rawPlan) {
    if (!Array.isArray(rawPlan)) return []
    return rawPlan
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        path:    item.path    || item.file || 'src/unknown.js',
        action:  ['create', 'modify'].includes(item.action) ? item.action : 'create',
        purpose: item.purpose || item.description || 'Generated file',
      }))
      .filter((item, idx, arr) =>
        // Deduplicate by path
        arr.findIndex(x => x.path === item.path) === idx
      )
      .filter(item =>
        // Strip dangerous paths
        !item.path.startsWith('/') &&
        !item.path.includes('..') &&
        // eslint-disable-next-line no-control-regex
        !/[\x00-\x1f]/.test(item.path)
      )
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  _buildFallbackData(code, context) {
    if (code === 'planner-json-error' || code === 'planner-schema-error') {
      return { fallbackPlan: this.buildFallbackPlan(context.filePath) }
    }
    if (code === 'continuation-catch' || code === 'stream-stall' || code === 'network-disconnect') {
      return { partialCode: context.partialCode || '' }
    }
    if (code === 'amplifier-json-error') {
      return { originalPrompt: context.originalPrompt || '' }
    }
    return null
  }

  _appendLog(entry) {
    try {
      this._log.push(entry)
      // Keep log within size limit (drop oldest entries)
      if (this._log.length > MAX_REPAIR_LOG_SIZE) {
        this._log.splice(0, this._log.length - MAX_REPAIR_LOG_SIZE)
      }
    } catch { /* safe to ignore */ }
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────
// Import `repairEngine` for use in Bluswan.jsx and services.
export const repairEngine = new BluswanRepairEngine()

// ── Named exports for constants ───────────────────────────────────────────────
export { SEVERITY, ACTION, MAX_REPAIR_ATTEMPTS, MAX_REPAIR_LOG_SIZE }

// ── Convenience: wrap a generation phase with repair ─────────────────────────
//
// Usage:
//   const result = await withRepair(
//     () => runPrompt(model, prompt),
//     'api',                   // error category hint (optional)
//     { filePath: 'src/x.js' } // context (optional)
//   )
//
// Returns: { ok: true, value } on success
//          { ok: false, repairResult } on exhaustion
export async function withRepair(fn, _categoryHint, context = {}) {
  let lastError = null
  for (let i = 0; i < MAX_REPAIR_ATTEMPTS; i++) {
    try {
      const value = await fn()
      return { ok: true, value }
    } catch (err) {
      lastError = err
      const result = await repairEngine.repairAsync(err, context)
      if (!result.shouldRetry || result.exhausted) {
        return { ok: false, repairResult: result }
      }
      // delayMs already applied by repairAsync
    }
  }
  // Final fallback after all attempts
  const finalResult = repairEngine.repair(lastError, context)
  return { ok: false, repairResult: finalResult }
}

export default repairEngine
