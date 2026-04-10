// ─── Storage key registry ─────────────────────────────────────────────────────
// Single source of truth for every localStorage / sessionStorage key used by
// BLUSWAN.  Importing from here instead of hardcoding strings eliminates typos,
// makes namespace collisions visible, and lets grep find all storage usage in
// one step.
//
// Naming convention:
//   KEYS.LS.*  — localStorage   (persists across tab/browser restarts)
//   KEYS.SS.*  — sessionStorage (cleared when the tab/browser closes)
//
// The 'wrkflow:' prefix on AI-service keys is intentional and must not be
// changed — existing users have encrypted key backups stored under those names.

export const KEYS = Object.freeze({
  // ── localStorage ────────────────────────────────────────────────────────────
  LS: Object.freeze({
    /** Workspace settings (model choices, repo config, UI prefs). */
    SETTINGS:           'bluswan:settings',
    /** Prompt history entries shown in the input dropdown. */
    HISTORY:            'bluswan:history',
    /** Override Firebase project config (power-user / self-hosted deployments). */
    FIREBASE_CONFIG:    'bluswan:firebase',
    /** Enhancer feature-flag overrides (RAG weights, critique mode, etc.). */
    ENHANCER_CONFIG:    'bluswan:enhancers-config',
    /** Model-router fallback preferences (populated after a primary model fails). */
    ROUTER_FALLBACKS:   'bluswan:router:fallback-prefs',
    /** Semantic memory graph snapshot (nodes + edges). */
    MEMORY_GRAPH:       'bluswan:memory-graph:v2',
    /** Tool execution trace log (JSONL). */
    TOOL_TRACES:        'bluswan:tool-traces:jsonl',
    /** User-installed modular tool bundles. */
    USER_TOOLS:         'bluswan:user-tools',
    /** GitHub write permission mode: 'ask' | 'manual'. */
    PERM_MODE:          'bluswan:permMode',
    /** Multi-turn conversation history (JSON array). */
    CONV:               'bluswan:conv',
    /** Onboarding wizard progress. */
    ONBOARDING:         'bluswan:onboarding',
    /** Which manual onboarding steps the user has confirmed. */
    ONBOARDING_MANUAL:  'bluswan:onboarding:manual',
    /** Simple-mode feature flag. */
    SIMPLE_MODE:        'bluswan:simpleMode',
    /** AI model configurations (provider, base URL, display name — no API keys). */
    AI_MODELS:          'wrkflow:models',
    /** AES-GCM-encrypted API key backup for iOS resilience (primary: sessionStorage). */
    AI_KEYS_BACKUP:     'wrkflow:keysbak',
  }),

  // ── sessionStorage ───────────────────────────────────────────────────────────
  SS: Object.freeze({
    /** Primary GitHub token for the active session. */
    GH_TOKEN:           'bluswan:ghtoken',
    /** Secondary GitHub token (e.g. second account / source repo). */
    GH_TOKEN_2:         'bluswan:ghtoken2',
    /** Tavily web-search API key (cleared on tab close). */
    SEARCH_KEY:         'bluswan:searchkey',
    /** AES-GCM-encrypted API keys for all configured providers. */
    AI_KEYS:            'wrkflow:keys',
    /** 32-byte random AES-GCM session key, base64-encoded. */
    AI_SESSION_KEY:     'wrkflow:sk',
  }),
})
