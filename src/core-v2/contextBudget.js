/**
 * @module contextBudget
 * Strictly enforced token budget system for cycle context assembly.
 * Reserved space is sacred — it is never pruned, truncated, or competed for.
 */

// ─── JSDoc Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ReservedSpace
 * @property {number} systemPrompt
 * @property {number} planContract
 * @property {number} completionProtocol
 * @property {number} safetyBuffer
 */

/**
 * @typedef {Object} ContextTier
 * @property {number} max
 * @property {number} priority
 */

/**
 * @typedef {Object} ContextTiers
 * @property {ContextTier} cycleContext
 * @property {ContextTier} deliverables
 * @property {ContextTier} toolResults
 * @property {ContextTier} repoMap
 * @property {ContextTier} relevantFiles
 */

/**
 * @typedef {Object} ContextBudget
 * @property {number} totalWindow
 * @property {ReservedSpace} reserved
 * @property {number} available
 * @property {ContextTiers} tiers
 */

/**
 * @typedef {Object} TierAllocation
 * @property {number} granted
 * @property {number} remaining
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const RESERVED = Object.freeze({
  systemPrompt: 2000,
  planContract: 1500,
  completionProtocol: 500,
  safetyBuffer: 1000,
});

const TOTAL_RESERVED = Object.values(RESERVED).reduce((a, b) => a + b, 0); // 5000

const TIER_DEFAULTS = Object.freeze({
  cycleContext:   { max: 3000, priority: 1 },
  deliverables:   { max: 2000, priority: 2 },
  toolResults:    { max: 4000, priority: 3 },
  repoMap:        { max: 1500, priority: 4 },
  relevantFiles:  { max: 3000, priority: 5 },
});

const CHARS_PER_TOKEN = 4;

// ─── Custom Errors ────────────────────────────────────────────────────────────

export class ContextBudgetError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ContextBudgetError';
  }
}

export class ContextBudgetExceededError extends Error {
  /**
   * @param {{ requested: number, available: number, overflow: number, suggestion: string }} details
   */
  constructor(details) {
    super(
      `Context budget exceeded: requested ${details.requested}, available ${details.available} (overflow ${details.overflow})`
    );
    this.name = 'ContextBudgetExceededError';
    this.details = details;
  }
}

// ─── Core: Token Estimation ───────────────────────────────────────────────────

/**
 * The ONLY token estimation function in the system.
 * @param {string} text
 * @returns {number}
 */
export function computeTokenEstimate(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ─── Budget Creation ──────────────────────────────────────────────────────────

/**
 * Creates a ContextBudget for a given model window size.
 * Throws if the window is too small to fit reserved space.
 *
 * @param {number} totalWindow
 * @returns {ContextBudget}
 */
export function createContextBudget(totalWindow) {
  if (totalWindow < 6000) {
    throw new ContextBudgetError(
      `Window too small for reserved space: ${totalWindow} tokens (minimum 6000)`
    );
  }

  const available = totalWindow - TOTAL_RESERVED;

  return {
    totalWindow,
    reserved: { ...RESERVED },
    available,
    tiers: {
      cycleContext:  { ...TIER_DEFAULTS.cycleContext },
      deliverables:  { ...TIER_DEFAULTS.deliverables },
      toolResults:   { ...TIER_DEFAULTS.toolResults },
      repoMap:       { ...TIER_DEFAULTS.repoMap },
      relevantFiles: { ...TIER_DEFAULTS.relevantFiles },
    },
  };
}

// ─── Tier Allocation ──────────────────────────────────────────────────────────

/**
 * Allocates tokens for a tier. Never silently over-allocates.
 * If requestedTokens > tier max, caller must truncate.
 *
 * @param {ContextBudget} budget
 * @param {keyof ContextTiers} tierName
 * @param {number} requestedTokens
 * @returns {TierAllocation}
 */
export function allocateTier(budget, tierName, requestedTokens) {
  const tier = budget.tiers[tierName];
  if (!tier) {
    throw new ContextBudgetError(`Unknown tier: '${tierName}'`);
  }
  const granted = Math.min(requestedTokens, tier.max);
  const remaining = tier.max - granted;
  return { granted, remaining };
}

// ─── Budget Enforcement ───────────────────────────────────────────────────────

/**
 * Validates that messages fit within the available budget.
 * Throws ContextBudgetExceededError with actionable details if over budget.
 *
 * @param {ContextBudget} budget
 * @param {Array<{role: string, content: string}>} messages
 */
export function enforceBudget(budget, messages) {
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  const requested = computeTokenEstimate(messages.map((m) => m.content ?? '').join(''));

  if (requested > budget.available) {
    const overflow = requested - budget.available;
    // Find largest non-reserved tier by estimating which message is fattest
    const suggestion =
      `Reduce 'toolResults' tier (max ${budget.tiers.toolResults.max} tokens) ` +
      `or 'relevantFiles' tier (max ${budget.tiers.relevantFiles.max} tokens). ` +
      `Overflow: ${overflow} tokens.`;

    throw new ContextBudgetExceededError({
      requested,
      available: budget.available,
      overflow,
      suggestion,
    });
  }
}

// ─── String Truncation ────────────────────────────────────────────────────────

/**
 * Truncates content to fit within maxTokens. Always marks truncation.
 *
 * @param {string} content
 * @param {number} maxTokens
 * @returns {string}
 */
export function truncateToBudget(content, maxTokens) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (content.length <= maxChars) return content;

  const removed = content.length - maxChars;
  const suffix = `\n[...truncated, ${removed} chars removed]`;
  // Reserve space for suffix
  const keepChars = maxChars - suffix.length;
  if (keepChars <= 0) return suffix.trimStart();
  return content.slice(0, keepChars) + suffix;
}

// ─── Tool Result Summarization ────────────────────────────────────────────────

/**
 * Summarizes tool results within a token budget.
 * Priority: errors → mutations → reads (path only if over budget).
 *
 * @param {import('./cycleEngine.js').ToolResult[]} results
 * @param {number} maxTokens
 * @returns {string}
 */
export function summarizeToolResults(results, maxTokens) {
  if (!results || results.length === 0) return 'No tool results.';

  const errors    = results.filter((r) => r.error);
  const mutations = results.filter((r) => !r.error && ['write_file', 'edit_file', 'run_command'].includes(r.toolName));
  const reads     = results.filter((r) => !r.error && !mutations.includes(r));

  const lines = [];

  // Always include errors in full
  for (const r of errors) {
    lines.push(`[FAIL turn=${r.turnNumber}] ${r.toolName}: ${r.error}`);
  }

  // Mutations: include output but truncate to 200 chars each
  for (const r of mutations) {
    const out = r.output.length > 200 ? r.output.slice(0, 197) + '...' : r.output;
    lines.push(`[OK turn=${r.turnNumber}] ${r.toolName}(${r.input?.path ?? r.input?.command ?? '?'}): ${out}`);
  }

  const base = lines.join('\n');
  const baseTokens = computeTokenEstimate(base);

  if (baseTokens >= maxTokens) {
    return truncateToBudget(base, maxTokens);
  }

  // Add reads: full output if budget allows, path-only if tight
  const remaining = maxTokens - baseTokens;
  const readLines = [];
  for (const r of reads) {
    const fullLine = `[READ turn=${r.turnNumber}] ${r.toolName}(${r.input?.path ?? '?'}): ${r.output.slice(0, 300)}`;
    const pathLine = `[READ turn=${r.turnNumber}] ${r.toolName}(${r.input?.path ?? '?'})`;
    readLines.push({ fullLine, pathLine });
  }

  // Try full reads first
  const fullReadText = readLines.map((l) => l.fullLine).join('\n');
  if (computeTokenEstimate(base + '\n' + fullReadText) <= maxTokens) {
    return (base + '\n' + fullReadText).trim();
  }

  // Fall back to path-only reads
  const pathReadText = readLines.map((l) => l.pathLine).join('\n');
  const combined = (base + '\n' + pathReadText).trim();
  return truncateToBudget(combined, maxTokens);
}
