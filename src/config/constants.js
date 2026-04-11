// ─── Central constants ────────────────────────────────────────────────────────
// All magic numbers live here. Edit this file to tune agent behaviour,
// timeouts, and capability caps — changes propagate everywhere automatically.

// ── Agent loop ────────────────────────────────────────────────────────────────
export const AGENT_MAX_TURNS          = 100       // safety ceiling; prevents runaway loops
export const AGENT_KEEP_TURNS         = 10        // message turns to retain (older pruned)
export const AGENT_LOOP_WINDOW        = 3         // recent turns checked for repeat-tool-call loops

// ── Diff viewer ───────────────────────────────────────────────────────────────
export const DIFF_MAX_LINES           = 600       // max lines per side for LCS diff

// ── Exec bridge ───────────────────────────────────────────────────────────────
export const EXEC_BRIDGE_TIMEOUT_MS   = 60_000    // default shell command timeout (ms)
export const EXEC_TOOL_PROBE_TIMEOUT  = 5_000     // tool version-probe timeout (ms)
export const EXEC_LINT_TIMEOUT        = 15_000    // eslint/ts-node stdin timeout (ms)

// ── ShadowContext indexer ─────────────────────────────────────────────────────
export const SHADOW_MAX_FILES         = 5_000     // max repo files to index
export const SHADOW_MAX_DEPTH         = 15        // max directory crawl depth
export const SHADOW_MAX_CONTENT_FILES = 800       // max files to fetch content for
export const SHADOW_MAX_CONTENT_SIZE  = 100_000   // max file size in bytes to index
export const SHADOW_CACHE_TTL_MS      = 60 * 60 * 1000  // 1 hour session-storage TTL
export const SHADOW_BATCH_SIZE        = 10        // files per content-fetch batch
export const SHADOW_CONTENT_CAP       = 6_000     // chars per file stored in content index
export const SHADOW_PREVIEW_CAP       = 1_200     // chars for quick relevance preview

// ── Persistence ───────────────────────────────────────────────────────────────
export const CONV_MAX_MESSAGES        = 20        // conversation messages to persist
export const HISTORY_MAX_ITEMS        = 60        // prompt history entries to keep
export const MAX_TRACE_LINES          = 2000      // max JSONL lines kept in tool trace localStorage store

// ── Memory graph ──────────────────────────────────────────────────────────────
export const MEMORY_VECTOR_DIM        = 128       // hash-embedding vector dimensions
export const MEMORY_MAX_INGEST_CHARS  = 4000      // max chars ingested per file node
export const MEMORY_MAX_NODES         = 2000      // LRU cap: evict oldest nodes beyond this limit
export const MEMORY_MAX_EDGES         = 5000      // LRU cap: evict oldest edges beyond this limit

// ── Trace store ───────────────────────────────────────────────────────────────
export const TRACE_MAX_AGE_DAYS       = 7         // evict trace entries older than this many days

// ── Streaming ─────────────────────────────────────────────────────────────────
export const STREAM_CHUNK_TIMEOUT_MS  = 30_000    // abort stream if no chunk arrives within this window (ms)

// ── Generation / remediation ─────────────────────────────────────────────────
export const AUTOFIX_MAX_ATTEMPTS     = 5         // auto-remediation AI fix passes
export const PLAN_MAX_FILES           = 20        // max files in a planner execution plan
export const CONTEXT_FILES_LIMIT      = 8         // ambient context files injected per generation
export const FILE_CONTENT_CAP_CHARS   = 20_000    // max existing file chars injected into prompt
export const BLUSWAN_MD_CAP             = 8_000     // max BLUSWAN.md chars injected into prompts

// ── Sandbox timeouts ─────────────────────────────────────────────────────────
export const SANDBOX_JS_TIMEOUT_MS    = 5_000     // JS iframe execution budget (ms)
export const SANDBOX_PY_TIMEOUT_MS    = 20_000    // Python/Pyodide execution budget (ms)
export const SANDBOX_JS_GUARD_MS      = 9_000     // outer JS guard to clean up listeners
export const SANDBOX_PY_GUARD_MS      = 25_000    // outer Python guard

// ── Python sandbox ────────────────────────────────────────────────────────────
export const PYODIDE_VERSION          = '0.27.3'  // update here to upgrade the Python sandbox

// ── NLU / creativity enhancements ────────────────────────────────────────────
export const STYLE_EXAMPLES_LIMIT     = 3         // codebase style excerpts injected per generation
export const STYLE_EXCERPT_LINES      = 20        // lines per style excerpt
export const THINKING_BUDGET_TOKENS   = 8000      // Anthropic extended-thinking token budget
export const DEFAULT_TEMPERATURE      = 0.7       // default generation temperature

// ── Task Decomposer (Phase 1) ─────────────────────────────────────────────────
export const DECOMPOSE_COMPLEXITY_THRESHOLD = 4   // min complexity score to trigger decomposition
export const DECOMPOSE_MAX_SUBTASKS         = 5   // max subtasks per decomposition

// ── Code Intelligence (Phase 1) ───────────────────────────────────────────────
export const CODE_INTEL_MAX_SYMBOLS_PER_FILE = 200 // max symbols extracted per file
export const CODE_INTEL_CALL_GRAPH_DEPTH     = 3   // max call graph traversal depth

// ── Patch Validator (Phase 1) ─────────────────────────────────────────────────
export const PATCH_VALIDATOR_FUZZY_THRESHOLD    = 0.65 // min line similarity to flag nearest match
export const PATCH_VALIDATOR_MAX_CONTEXT_LINES  = 8    // context lines shown in match excerpts

// ── TDD Loop (Phase 1) ────────────────────────────────────────────────────────
export const TDD_MAX_ITERATIONS  = 5              // max fix cycles before declaring red
export const TDD_TEST_TIMEOUT_MS = 60_000         // per-run test command timeout (ms)
