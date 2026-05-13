/**
 * @module contextPacker
 * Deterministic context assembly for each cycle.
 * Assembly order is strict and never deviates from the spec.
 */

import {
  computeTokenEstimate,
  truncateToBudget,
  summarizeToolResults,
  ContextBudgetError,
} from './contextBudget.js';

// ─── JSDoc Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} LLMMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string} content
 * @property {string} [tool_call_id]
 */

/**
 * @typedef {Object} PackMetadata
 * @property {number} totalTokensEstimated
 * @property {number} reservedTokens
 * @property {number} dynamicTokens
 * @property {string[]} includedTiers
 * @property {string[]} droppedTiers
 * @property {number} toolResultsSummarized
 */

/**
 * @typedef {Object} PackedContext
 * @property {LLMMessage[]} messages
 * @property {PackMetadata} metadata
 */

// ─── Static Content ───────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are BLUSWAN, an AI developer assistant.
Execute tasks precisely. Follow the plan. Only use the tools listed in your tool restriction notice.
When you have completed all target deliverables, emit the completion token exactly as specified.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @param {import('./planContract.js').Deliverable[]} deliverables
 * @param {string[]} targetIds
 * @returns {string}
 */
function buildDeliverableTable(deliverables, targetIds) {
  const targetSet = new Set(targetIds);
  const header = 'ID | Type | Path | Status | Acceptance Criteria';
  const separator = '---|------|------|--------|--------------------';
  const rows = deliverables.map((d) => {
    const marker = targetSet.has(d.id) ? '★ ' : '  ';
    const status = d.completed ? 'done' : 'pending';
    const path = d.path ?? '—';
    return `${marker}${d.id} | ${d.type} | ${path} | ${status} | ${d.acceptanceCriteria}`;
  });
  return [header, separator, ...rows].join('\n');
}

/**
 * @param {import('./planContract.js').ExecutionPlan} plan
 * @param {string[]} targetIds
 * @returns {string}
 */
function buildPlanContractMessage(plan, targetIds) {
  return [
    `Task goal: ${plan.goal}`,
    `Task ID: ${plan.taskId}`,
    '',
    'Deliverables:',
    buildDeliverableTable(plan.deliverables, targetIds),
    '',
    `Current cycle targets: ${targetIds.join(', ')}`,
  ].join('\n');
}

/**
 * Assembles the system message (reserved slot 1).
 * @param {import('./cycleEngine.js').ExecutionCycle} cycle
 * @returns {string}
 */
function buildSystemMessage(cycle) {
  return [
    BASE_SYSTEM_PROMPT,
    '',
    '--- Completion Protocol ---',
    `Emit exactly '${cycle.completionProtocol.completionToken}' when done.`,
    `Required sections in final message: ${cycle.completionProtocol.requiredSections.join(', ')}`,
    '',
    `--- Tool Restriction ---`,
    `You may only use: ${cycle.allowedTools.join(', ')}`,
  ].join('\n');
}

/**
 * Tries to fit content within maxTokens, returns null if it won't fit after truncation.
 * For mandatory tiers (1-2), caller should throw on null.
 *
 * @param {string} content
 * @param {number} maxTokens
 * @param {boolean} mandatory
 * @returns {string|null}
 */
function fitContent(content, maxTokens, mandatory) {
  const tokens = computeTokenEstimate(content);
  if (tokens <= maxTokens) return content;
  if (mandatory) return truncateToBudget(content, maxTokens);
  // Non-mandatory: truncate if it gets close, drop if too far over
  if (tokens <= maxTokens * 1.5) return truncateToBudget(content, maxTokens);
  return null; // drop this tier
}

// ─── Repo Map Helper (inline — avoids importing from repoIndex.js) ───────────

/**
 * Renders an indented file tree from a flat fileTree array, capped at maxTokens.
 * @param {Array<{path: string}>} fileTree
 * @param {number} maxTokens
 * @returns {string}
 */
function _renderRepoMap(fileTree, maxTokens) {
  const maxChars = maxTokens * 4;
  const root = {};
  for (const f of fileTree) {
    const parts = f.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node[part] = node[part] ?? {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = null;
  }
  const lines = [];
  function walk(node, indent) {
    const entries = Object.entries(node).sort(([a, va], [b, vb]) => {
      if ((va === null) !== (vb === null)) return va === null ? 1 : -1;
      return a.localeCompare(b);
    });
    for (const [name, children] of entries) {
      lines.push(`${indent}${name}${children !== null ? '/' : ''}`);
      if (children !== null) walk(children, indent + '  ');
    }
  }
  walk(root, '');
  let result = lines.join('\n');
  if (result.length > maxChars) result = result.slice(0, maxChars) + '\n[...truncated]';
  return result;
}

// ─── Main Assembly ────────────────────────────────────────────────────────────

/**
 * Assembles the full cycle context for an LLM turn.
 *
 * The 5th parameter accepts either:
 *   - A RepoIndex object (has `fileTree` + `contentCache` properties): uses getRepoMap() for
 *     Tier 4 and contentCache lookups for Tier 5.
 *   - A legacy options object: `{ repoMap?, relevantFileContents?, remediationBudgetRemaining? }`
 *   - null/undefined: Tier 4 and Tier 5 are skipped.
 *
 * @param {import('./contextBudget.js').ContextBudget} budget
 * @param {import('./cycleEngine.js').ExecutionCycle} cycle
 * @param {import('./planContract.js').Deliverable[]} deliverables
 * @param {import('./cycleEngine.js').ToolResult[]} toolResults
 * @param {Object|null} [repoIndexOrOptions]
 * @returns {PackedContext}
 */
export function packCycleContext(budget, cycle, deliverables, toolResults, repoIndexOrOptions = null) {
  // Detect whether 5th arg is a RepoIndex instance or legacy options object
  let repoIndex = null;
  let options = {};
  if (repoIndexOrOptions !== null && typeof repoIndexOrOptions === 'object') {
    if ('fileTree' in repoIndexOrOptions || 'contentCache' in repoIndexOrOptions) {
      repoIndex = repoIndexOrOptions;
    } else {
      options = repoIndexOrOptions;
    }
  }
  const messages = [];
  const includedTiers = [];
  const droppedTiers = [];
  let reservedTokens = 0;
  let dynamicTokens = 0;
  let toolResultsSummarized = 0;

  // ── Tier 0a: System message (reserved, mandatory) ─────────────────────────
  const systemContent = buildSystemMessage(cycle);
  const systemFitted = fitContent(systemContent, budget.reserved.systemPrompt, true);
  if (computeTokenEstimate(systemFitted) > budget.reserved.systemPrompt + 200) {
    throw new ContextBudgetError('System message exceeds reserved system prompt space');
  }
  messages.push({ role: 'system', content: systemFitted });
  reservedTokens += computeTokenEstimate(systemFitted);
  includedTiers.push('systemPrompt');

  // ── Tier 0b: Plan contract (reserved, mandatory) ──────────────────────────
  const planContent = buildPlanContractMessage(
    { deliverables, goal: cycle.goal, taskId: 'active' },
    cycle.targetDeliverables
  );
  const planFitted = fitContent(planContent, budget.reserved.planContract, true);
  if (computeTokenEstimate(planFitted) > budget.reserved.planContract + 200) {
    throw new ContextBudgetError('Plan contract exceeds reserved plan contract space');
  }
  messages.push({ role: 'system', content: planFitted });
  reservedTokens += computeTokenEstimate(planFitted);
  includedTiers.push('planContract');

  // ── Tier 1: Cycle context (mandatory) ────────────────────────────────────
  const remedBudget = options.remediationBudgetRemaining ?? '?';
  const cycleContextContent = [
    `Current cycle goal: ${cycle.goal}`,
    `Target deliverables: ${cycle.targetDeliverables.join(', ')}`,
    `Allowed tools: ${cycle.allowedTools.join(', ')}`,
    `Max turns this cycle: ${cycle.maxTurns}`,
    `Remedy budget remaining: ${remedBudget}`,
  ].join('\n');

  const cycleContentFitted = fitContent(cycleContextContent, budget.tiers.cycleContext.max, true);
  if (!cycleContentFitted) {
    throw new ContextBudgetError('Tier 1 (cycleContext) cannot fit within budget');
  }
  messages.push({ role: 'user', content: cycleContentFitted });
  dynamicTokens += computeTokenEstimate(cycleContentFitted);
  includedTiers.push('cycleContext');

  // ── Tier 2: Deliverable status (mandatory) ───────────────────────────────
  const delivStatusContent = [
    '--- Deliverable Status ---',
    buildDeliverableTable(deliverables, cycle.targetDeliverables),
    '',
    `Targets this cycle: ${cycle.targetDeliverables.join(', ')} (marked with ★)`,
  ].join('\n');

  const delivFitted = fitContent(delivStatusContent, budget.tiers.deliverables.max, true);
  if (!delivFitted) {
    throw new ContextBudgetError('Tier 2 (deliverables) cannot fit within budget');
  }
  messages.push({ role: 'user', content: delivFitted });
  dynamicTokens += computeTokenEstimate(delivFitted);
  includedTiers.push('deliverables');

  // ── Tier 3: Tool results (mandatory) ─────────────────────────────────────
  let toolContent;
  if (!toolResults || toolResults.length === 0) {
    toolContent = 'No tool results yet. Begin execution.';
  } else {
    toolResultsSummarized = toolResults.length;
    toolContent = summarizeToolResults(toolResults, budget.tiers.toolResults.max);
  }
  const toolFitted = fitContent(toolContent, budget.tiers.toolResults.max, true);
  if (!toolFitted) {
    throw new ContextBudgetError('Tier 3 (toolResults) cannot fit within budget');
  }
  messages.push({ role: 'user', content: toolFitted });
  dynamicTokens += computeTokenEstimate(toolFitted);
  includedTiers.push('toolResults');

  // ── Tier 4: Repo map (best-effort) ───────────────────────────────────────
  // Source: repoIndex.fileTree (new path) or options.repoMap (legacy)
  let repoMapSource = null;
  if (repoIndex) {
    repoMapSource = _renderRepoMap(repoIndex.fileTree, budget.tiers.repoMap.max);
  } else if (options.repoMap) {
    repoMapSource = options.repoMap;
  }

  if (repoMapSource) {
    const repoFitted = fitContent(repoMapSource, budget.tiers.repoMap.max, false);
    if (repoFitted) {
      messages.push({ role: 'user', content: `--- Repository Map ---\n${repoFitted}` });
      dynamicTokens += computeTokenEstimate(repoFitted);
      includedTiers.push('repoMap');
    } else {
      droppedTiers.push('repoMap');
    }
  }

  // ── Tier 5: Relevant file contents (best-effort) ─────────────────────────
  // Source: repoIndex content cache for files read in toolResults (new path) or options.relevantFileContents (legacy)
  let relevantFileContents = null;
  if (repoIndex) {
    const filesRead = (toolResults ?? [])
      .filter((r) => r.toolName === 'read_file' && r.input?.path)
      .map((r) => r.input.path)
      .filter((p, i, arr) => arr.indexOf(p) === i) // dedupe
      .slice(0, 5);
    if (filesRead.length > 0) {
      relevantFileContents = new Map();
      for (const p of filesRead) {
        const cached = repoIndex.contentCache.get(p);
        if (cached !== undefined) relevantFileContents.set(p, cached);
      }
    }
  } else if (options.relevantFileContents) {
    relevantFileContents = options.relevantFileContents;
  }

  if (relevantFileContents && relevantFileContents.size > 0) {
    const fileLines = [];
    for (const [path, content] of relevantFileContents) {
      fileLines.push(`=== ${path} ===\n${content}`);
    }
    const filesContent = fileLines.join('\n\n');
    const filesFitted = fitContent(filesContent, budget.tiers.relevantFiles.max, false);
    if (filesFitted) {
      messages.push({ role: 'user', content: `--- Relevant Files ---\n${filesFitted}` });
      dynamicTokens += computeTokenEstimate(filesFitted);
      includedTiers.push('relevantFiles');
    } else {
      droppedTiers.push('relevantFiles');
    }
  }

  const totalTokensEstimated = reservedTokens + dynamicTokens;

  return {
    messages,
    metadata: {
      totalTokensEstimated,
      reservedTokens,
      dynamicTokens,
      includedTiers,
      droppedTiers,
      toolResultsSummarized,
    },
  };
}

/**
 * Assembles context for the plan review phase (human checkpoint).
 *
 * @param {import('./contextBudget.js').ContextBudget} budget
 * @param {import('./planContract.js').ExecutionPlan} plan
 * @returns {PackedContext}
 */
export function packPlanReviewContext(budget, plan) {
  const messages = [];
  const includedTiers = ['systemPrompt', 'planContract'];

  // System
  messages.push({
    role: 'system',
    content: `${BASE_SYSTEM_PROMPT}\n\nYou are in plan review mode. Present the plan for human approval.`,
  });

  // Full plan contract
  const planJson = JSON.stringify(plan, null, 2);
  const planContent = truncateToBudget(planJson, budget.reserved.planContract + budget.tiers.cycleContext.max);
  messages.push({ role: 'system', content: planContent });

  // Human-readable summary
  const summary = [
    `--- Plan Summary ---`,
    `Goal: ${plan.goal}`,
    `Estimated cycles: ${plan.estimatedCycles}`,
    `Deliverables (${plan.deliverables.length}):`,
    ...plan.deliverables.map((d, i) => `  ${i + 1}. [${d.type}] ${d.description} — ${d.acceptanceCriteria}`),
    `Dependencies: ${plan.dependencies?.length ?? 0} file(s) required`,
  ].join('\n');

  messages.push({ role: 'user', content: summary });
  messages.push({ role: 'user', content: 'Approve this plan? [Yes] [Edit] [Reject]' });

  const totalTokensEstimated = messages.reduce(
    (sum, m) => sum + computeTokenEstimate(m.content),
    0
  );

  return {
    messages,
    metadata: {
      totalTokensEstimated,
      reservedTokens: computeTokenEstimate(messages[0].content + messages[1].content),
      dynamicTokens: computeTokenEstimate(messages[2].content + messages[3].content),
      includedTiers,
      droppedTiers: [],
      toolResultsSummarized: 0,
    },
  };
}
