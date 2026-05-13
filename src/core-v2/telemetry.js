/**
 * @module telemetry
 * Unified structured event system for the V2 execution pipeline.
 * Replaces scattered console.log and the efficiency/ subsystem.
 * Passive: never blocks execution. In-memory only unless onFlush provided.
 */

// ─── JSDoc Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {'task.start'|'task.phase_change'|'task.cycle_start'|'task.cycle_end'|'task.completion_gate'|'task.done'|'task.failed'|'task.halted'|'tool.call'|'tool.result'|'tool.error'|'context.budget_usage'|'context.prune_event'|'loop.guard_trigger'|'loop.halt'|'remediation.spend'|'validation.run'|'quality.signal'|'api.call'|'api.error'} TelemetryEventType
 */

/**
 * @typedef {Object} TelemetryEvent
 * @property {string} id
 * @property {TelemetryEventType} type
 * @property {number} timestamp
 * @property {string} taskId
 * @property {number} [cycleNumber]
 * @property {number} [turnNumber]
 * @property {Object} payload
 */

/**
 * @typedef {Object} TelemetrySink
 * @property {(type: TelemetryEventType, taskId: string, payload?: Object, ctx?: {cycleNumber?: number, turnNumber?: number}) => void} emit
 * @property {() => TelemetryEvent[]} flush
 * @property {(filter?: {taskId?: string, type?: TelemetryEventType, since?: number, until?: number}) => TelemetryEvent[]} getEvents
 * @property {(taskId: string) => Object} exportReport
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates a telemetry sink. Passive — all operations are synchronous and
 * never throw. Circular buffer: oldest events dropped when bufferSize exceeded.
 *
 * @param {Object} [options]
 * @param {number} [options.bufferSize=1000]
 * @param {number} [options.flushIntervalMs=5000]
 * @param {((events: TelemetryEvent[]) => void)} [options.onFlush]
 * @returns {TelemetrySink}
 */
export function createTelemetrySink(options = {}) {
  const bufferSize = options.bufferSize ?? 1000;
  const onFlush = options.onFlush ?? null;
  const flushIntervalMs = options.flushIntervalMs ?? 5000;

  /** @type {TelemetryEvent[]} */
  let buffer = [];
  let flushTimer = null;

  // Auto-flush only when onFlush callback is provided
  if (onFlush && flushIntervalMs > 0 && typeof setInterval !== 'undefined') {
    flushTimer = setInterval(() => {
      if (buffer.length > 0) {
        const events = flush();
        try { onFlush(events); } catch { /* never block */ }
      }
    }, flushIntervalMs);
    // Don't keep process alive (Node.js)
    if (flushTimer?.unref) flushTimer.unref();
  }

  /**
   * @param {TelemetryEventType} type
   * @param {string} taskId
   * @param {Object} [payload={}]
   * @param {{cycleNumber?: number, turnNumber?: number}} [ctx={}]
   */
  function emit(type, taskId, payload = {}, ctx = {}) {
    try {
      const event = {
        id: generateId(),
        type,
        timestamp: Date.now(),
        taskId: String(taskId ?? ''),
        ...(ctx.cycleNumber !== undefined ? { cycleNumber: ctx.cycleNumber } : {}),
        ...(ctx.turnNumber !== undefined ? { turnNumber: ctx.turnNumber } : {}),
        payload: payload ?? {},
      };

      if (buffer.length >= bufferSize) {
        // Circular: drop oldest
        buffer.shift();
      }
      buffer.push(event);
    } catch { /* never throw */ }
  }

  /** @returns {TelemetryEvent[]} */
  function flush() {
    const events = buffer.slice();
    buffer = [];
    return events;
  }

  /**
   * @param {{taskId?: string, type?: string, since?: number, until?: number}} [filter={}]
   * @returns {TelemetryEvent[]}
   */
  function getEvents(filter = {}) {
    try {
      return buffer.filter((e) => {
        if (filter.taskId !== undefined && e.taskId !== filter.taskId) return false;
        if (filter.type !== undefined && e.type !== filter.type) return false;
        if (filter.since !== undefined && e.timestamp < filter.since) return false;
        if (filter.until !== undefined && e.timestamp > filter.until) return false;
        return true;
      });
    } catch {
      return [];
    }
  }

  /**
   * Aggregates all events for a taskId into a structured report.
   *
   * @param {string} taskId
   * @returns {Object}
   */
  function exportReport(taskId) {
    try {
      const taskEvents = buffer.filter((e) => e.taskId === taskId);

      // Duration
      const startEvent = taskEvents.find((e) => e.type === 'task.start');
      const endEvent = taskEvents.find(
        (e) => e.type === 'task.done' || e.type === 'task.failed' || e.type === 'task.halted'
      );
      const durationMs = startEvent && endEvent
        ? endEvent.timestamp - startEvent.timestamp
        : 0;

      // Phases
      const phaseEvents = taskEvents.filter((e) => e.type === 'task.phase_change');
      const phases = phaseEvents.map((e, i) => ({
        phase: e.payload.to,
        enteredAt: e.timestamp,
        exitedAt: phaseEvents[i + 1]?.timestamp ?? null,
      }));

      // Cycles
      const cycleStarts = taskEvents.filter((e) => e.type === 'task.cycle_start');
      const cycleEnds = taskEvents.filter((e) => e.type === 'task.cycle_end');
      const cycles = cycleStarts.map((s) => {
        const end = cycleEnds.find((e) => e.payload.cycleNumber === s.payload.cycleNumber);
        return {
          cycleNumber: s.payload.cycleNumber,
          turnsUsed: end?.payload.turnsUsed ?? null,
          status: end?.payload.status ?? null,
          haltReason: end?.payload.haltReason ?? undefined,
        };
      });

      // Tools — aggregate by name
      const toolCallEvents = taskEvents.filter((e) => e.type === 'tool.call');
      const toolResultEvents = taskEvents.filter((e) => e.type === 'tool.result');
      const toolErrorEvents = taskEvents.filter((e) => e.type === 'tool.error');

      const toolMap = new Map();
      const getOrCreate = (name) => {
        if (!toolMap.has(name)) {
          toolMap.set(name, { name, callCount: 0, errorCount: 0, totalDurationMs: 0, resultCount: 0 });
        }
        return toolMap.get(name);
      };

      for (const e of toolCallEvents) getOrCreate(e.payload.name).callCount++;
      for (const e of toolResultEvents) {
        const t = getOrCreate(e.payload.name);
        t.totalDurationMs += e.payload.durationMs ?? 0;
        t.resultCount++;
      }
      for (const e of toolErrorEvents) getOrCreate(e.payload.name).errorCount++;

      const tools = [...toolMap.values()].map((t) => ({
        name: t.name,
        callCount: t.callCount,
        errorCount: t.errorCount,
        avgDurationMs: t.resultCount > 0 ? Math.round(t.totalDurationMs / t.resultCount) : 0,
      }));

      // Context budget
      const budgetEvents = taskEvents.filter((e) => e.type === 'context.budget_usage');
      const pruneEvents = taskEvents.filter((e) => e.type === 'context.prune_event');
      const maxBudgetUsed = budgetEvents.reduce((max, e) => Math.max(max, e.payload.usedTokens ?? 0), 0);

      // Loops
      const loopEvents = taskEvents.filter(
        (e) => e.type === 'loop.guard_trigger' || e.type === 'loop.halt'
      );
      const loops = loopEvents.map((e) => ({
        guardType: e.payload.guardType,
        turnNumber: e.payload.turnNumber ?? e.turnNumber,
        cycleNumber: e.payload.cycleNumber ?? e.cycleNumber,
      }));

      // Remediation
      const remediationEvents = taskEvents.filter((e) => e.type === 'remediation.spend');
      const byCategory = {};
      let remediationSpent = 0;
      let remediationBudget = 0;
      for (const e of remediationEvents) {
        remediationSpent += e.payload.cost ?? 0;
        if (e.payload.category) {
          byCategory[e.payload.category] = (byCategory[e.payload.category] ?? 0) + (e.payload.cost ?? 0);
        }
        if (e.payload.remaining !== undefined) {
          remediationBudget = remediationSpent + e.payload.remaining;
        }
      }

      // Validation
      const validationEvents = taskEvents.filter((e) => e.type === 'validation.run');
      const validationPassCount = validationEvents.filter((e) => e.payload.passed).length;
      const validationFailCount = validationEvents.filter((e) => !e.payload.passed).length;

      // Quality
      const qualityEvents = taskEvents.filter((e) => e.type === 'quality.signal');
      const qualitySignals = qualityEvents.map((e) => ({
        name: e.payload.name,
        status: e.payload.status,
      }));

      return {
        taskId,
        durationMs,
        phases,
        cycles,
        tools,
        context: {
          maxBudgetUsed,
          pruneEvents: pruneEvents.length,
          budgetExceededEvents: 0,
        },
        loops,
        remediation: {
          totalBudget: remediationBudget,
          spent: remediationSpent,
          byCategory,
        },
        validation: {
          stepsRun: validationEvents.length,
          passCount: validationPassCount,
          failCount: validationFailCount,
        },
        quality: {
          signals: qualitySignals,
        },
      };
    } catch {
      return { taskId, durationMs: 0, phases: [], cycles: [], tools: [], context: {}, loops: [], remediation: {}, validation: {}, quality: {} };
    }
  }

  return { emit, flush, getEvents, exportReport };
}
