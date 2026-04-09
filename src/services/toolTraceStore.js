import { schemaVersion } from '../tools/contracts.js'
import { MAX_TRACE_LINES, TRACE_MAX_AGE_DAYS } from '../config/constants.js'

const TRACE_STORAGE_KEY = 'icarus:tool-traces:jsonl'
let activeLoopState = null

function nowIso() {
  return new Date().toISOString()
}

function makeId() {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function safeJson(value) {
  try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
}

function readLines() {
  try {
    const raw = localStorage.getItem(TRACE_STORAGE_KEY) || ''
    return raw.split('\n').filter(Boolean)
  } catch (e) {
    console.warn('[ToolTraceStore] failed to read traces from localStorage:', e.message)
    return []
  }
}

// Drop entries older than TRACE_MAX_AGE_DAYS. Called inside writeLines so
// stale data is pruned on every write without a separate scheduled job.
function pruneByAge(lines) {
  const cutoff = Date.now() - TRACE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  return lines.filter(line => {
    try {
      const entry = JSON.parse(line)
      if (!entry?.timestamp) return true   // keep entries without a timestamp
      return Date.parse(entry.timestamp) >= cutoff
    } catch {
      return false   // drop malformed lines
    }
  })
}

function writeLines(lines) {
  try {
    const aged    = pruneByAge(lines)
    const trimmed = aged.slice(-MAX_TRACE_LINES)
    localStorage.setItem(TRACE_STORAGE_KEY, trimmed.join('\n'))
  } catch (e) {
    console.warn('[ToolTraceStore] failed to persist traces (localStorage quota exceeded?):', e.message)
  }
}

function appendLine(entry) {
  const lines = readLines()
  lines.push(JSON.stringify(entry))
  writeLines(lines)
}

export function beginToolTrace(toolName, input) {
  const traceId = makeId()
  const startedAt = performance.now()
  const entry = {
    traceId,
    type: 'tool_call',
    schemaVersion: schemaVersion(),
    toolName,
    input: safeJson(input),
    loopState: safeJson(activeLoopState),
    timestamp: nowIso(),
    status: 'started',
  }
  appendLine(entry)
  return { traceId, startedAt }
}

export function endToolTrace({ traceId, toolName, input, output, error, startedAt }) {
  const durationMs = Math.round(performance.now() - startedAt)
  appendLine({
    traceId,
    type: 'tool_call',
    schemaVersion: schemaVersion(),
    toolName,
    input: safeJson(input),
    loopState: safeJson(activeLoopState),
    output: safeJson(output),
    error: error ? String(error) : null,
    durationMs,
    timestamp: nowIso(),
    status: error ? 'error' : 'ok',
  })
}

export function setTraceLoopState(loopState = null) {
  activeLoopState = loopState ? safeJson(loopState) : null
}

export function getTraceById(traceId) {
  const lines = readLines()
  const entries = lines
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
    .filter(entry => entry.traceId === traceId)

  if (!entries.length) return null

  const final = [...entries].reverse().find(entry => entry.status === 'ok' || entry.status === 'error') || entries[entries.length - 1]
  return final
}

export async function replayTrace(traceId, executeTool) {
  const trace = getTraceById(traceId)
  if (!trace) throw new Error(`Trace not found: ${traceId}`)
  const output = await executeTool(trace.toolName, trace.input)
  return {
    replayed: true,
    traceId,
    toolName: trace.toolName,
    originalTimestamp: trace.timestamp,
    schemaVersion: trace.schemaVersion,
    input: trace.input,
    output,
  }
}

/**
 * Record a single orchestration routing decision as a self-contained trace entry.
 *
 * @param {{
 *   taskSnippet: string,
 *   role: string,
 *   confidence: number,
 *   strategy: string,
 *   modelId: string,
 *   reasoning: string,
 *   scores: Record<string,number>,
 *   durationMs?: number,
 * }} decision
 * @returns {string} traceId
 */
export function traceOrchestrationDecision(decision) {
  const traceId = makeId()
  appendLine({
    traceId,
    type: 'orchestration_decision',
    schemaVersion: schemaVersion(),
    loopState: safeJson(activeLoopState),
    taskSnippet: String(decision.taskSnippet || '').slice(0, 200),
    role: decision.role,
    confidence: decision.confidence,
    strategy: decision.strategy,
    modelId: decision.modelId,
    reasoning: decision.reasoning,
    scores: safeJson(decision.scores || {}),
    durationMs: decision.durationMs ?? null,
    timestamp: nowIso(),
    status: 'ok',
  })
  return traceId
}

/**
 * Record a fallback trigger — emitted when a primary model fails and the router
 * falls back to the next candidate.
 *
 * @param {{
 *   role: string,
 *   fromModelId: string,
 *   toModelId: string,
 *   error: string,
 *   fallbackIndex: number,
 * }} event
 */
export function traceOrchestrationFallback(event) {
  appendLine({
    traceId: makeId(),
    type: 'orchestration_fallback',
    schemaVersion: schemaVersion(),
    loopState: safeJson(activeLoopState),
    role: event.role,
    fromModelId: event.fromModelId,
    toModelId: event.toModelId,
    error: event.error,
    fallbackIndex: event.fallbackIndex,
    timestamp: nowIso(),
    status: 'ok',
  })
}
