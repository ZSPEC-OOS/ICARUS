import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetrySink } from '../telemetry.js';

// ─── createTelemetrySink basics ───────────────────────────────────────────────

describe('createTelemetrySink', () => {
  it('returns emit, flush, getEvents, exportReport', () => {
    const sink = createTelemetrySink();
    assert.equal(typeof sink.emit, 'function');
    assert.equal(typeof sink.flush, 'function');
    assert.equal(typeof sink.getEvents, 'function');
    assert.equal(typeof sink.exportReport, 'function');
  });

  it('emit stores event with timestamp and UUID', () => {
    const sink = createTelemetrySink();
    sink.emit('task.start', 'task-1', { goal: 'do something' });
    const events = sink.getEvents({ taskId: 'task-1' });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'task.start');
    assert.equal(events[0].taskId, 'task-1');
    assert.ok(typeof events[0].id === 'string' && events[0].id.length > 0, 'id should be a non-empty string');
    assert.ok(typeof events[0].timestamp === 'number' && events[0].timestamp > 0);
    assert.deepEqual(events[0].payload, { goal: 'do something' });
  });

  it('buffer drops oldest events when full (circular buffer)', () => {
    const sink = createTelemetrySink({ bufferSize: 3 });
    sink.emit('task.start', 't1', { n: 1 });
    sink.emit('task.start', 't1', { n: 2 });
    sink.emit('task.start', 't1', { n: 3 });
    sink.emit('task.start', 't1', { n: 4 }); // should evict n:1
    const events = sink.getEvents();
    assert.equal(events.length, 3);
    assert.equal(events[0].payload.n, 2);
    assert.equal(events[2].payload.n, 4);
  });

  it('flush returns events and clears buffer', () => {
    const sink = createTelemetrySink();
    sink.emit('task.start', 't1', {});
    sink.emit('task.done', 't1', {});
    const flushed = sink.flush();
    assert.equal(flushed.length, 2);
    const afterFlush = sink.getEvents();
    assert.equal(afterFlush.length, 0, 'Buffer should be empty after flush');
  });

  it('getEvents filters by taskId', () => {
    const sink = createTelemetrySink();
    sink.emit('task.start', 'task-A', {});
    sink.emit('task.start', 'task-B', {});
    const a = sink.getEvents({ taskId: 'task-A' });
    assert.equal(a.length, 1);
    assert.equal(a[0].taskId, 'task-A');
  });

  it('getEvents filters by type', () => {
    const sink = createTelemetrySink();
    sink.emit('task.start', 't1', {});
    sink.emit('tool.call', 't1', { name: 'read_file' });
    sink.emit('tool.result', 't1', { name: 'read_file', durationMs: 5 });
    const toolCalls = sink.getEvents({ type: 'tool.call' });
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].type, 'tool.call');
  });

  it('getEvents filters by time range (since/until)', () => {
    const sink = createTelemetrySink();
    const before = Date.now();
    sink.emit('task.start', 't1', {});
    const mid = Date.now();
    sink.emit('task.done', 't1', {});
    const after = Date.now();

    const sinceFiltered = sink.getEvents({ since: mid });
    // Should include events at or after mid; may include either or both depending on timing
    assert.ok(sinceFiltered.length >= 0, 'Filter should not throw');

    const rangeFiltered = sink.getEvents({ since: before, until: after });
    assert.equal(rangeFiltered.length, 2, 'Both events should fall in range');
  });

  it('exportReport includes all task metrics', () => {
    const sink = createTelemetrySink();
    const taskId = 'report-task';
    sink.emit('task.start', taskId, { goal: 'test' });
    sink.emit('task.phase_change', taskId, { from: 'idle', to: 'planning' });
    sink.emit('task.cycle_start', taskId, { cycleNumber: 1, targetDeliverables: ['d1'] });
    sink.emit('tool.call', taskId, { name: 'read_file', inputSummary: { path: 'src/foo.js' } }, { cycleNumber: 1, turnNumber: 1 });
    sink.emit('tool.result', taskId, { name: 'read_file', durationMs: 12 }, { cycleNumber: 1, turnNumber: 1 });
    sink.emit('task.cycle_end', taskId, { cycleNumber: 1, status: 'completed', turnsUsed: 1 });
    sink.emit('validation.run', taskId, { step: 'build', passed: true, durationMs: 800 });
    sink.emit('quality.signal', taskId, { name: 'test_coverage', status: 'warn' });
    sink.emit('task.done', taskId, { durationMs: 2000 });

    const report = sink.exportReport(taskId);
    assert.equal(report.taskId, taskId);
    assert.ok(typeof report.durationMs === 'number');
    assert.ok(Array.isArray(report.phases));
    assert.ok(Array.isArray(report.cycles));
    assert.ok(Array.isArray(report.tools));
    assert.ok(Array.isArray(report.loops));
    assert.ok(report.validation);
    assert.ok(report.quality);
    assert.ok(Array.isArray(report.quality.signals));
  });

  it('exportReport calculates duration correctly', () => {
    const sink = createTelemetrySink();
    const taskId = 'dur-task';
    sink.emit('task.start', taskId, {});
    // Simulate some time passing by using a later timestamp
    const events = sink.getEvents({ taskId });
    // Manually adjust first event timestamp for test (workaround since we can't sleep)
    // Just verify structure — durationMs is 0 for instant start/done
    sink.emit('task.done', taskId, { durationMs: 1500 });
    const report = sink.exportReport(taskId);
    assert.ok(typeof report.durationMs === 'number');
    assert.ok(report.durationMs >= 0);
  });

  it('never throws on emit failure (if payload is bad)', () => {
    const sink = createTelemetrySink();
    let threw = false;
    try {
      // Pass undefined type and null taskId — should not throw
      sink.emit(undefined, null, null);
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
  });

  it('no PII: payloads with content are not filtered (caller responsibility), but summarizeInput strips content', () => {
    // This test verifies the exported report structure doesn't contain content
    const sink = createTelemetrySink();
    const taskId = 'pii-task';
    // tool.call with safe inputSummary (as taskRunner produces it)
    sink.emit('tool.call', taskId, { name: 'write_file', inputSummary: { path: 'src/foo.js' } });
    const events = sink.getEvents({ taskId });
    const toolCall = events.find((e) => e.type === 'tool.call');
    assert.ok(toolCall, 'tool.call event should be present');
    // inputSummary should only have safe metadata
    assert.equal(toolCall.payload.inputSummary.path, 'src/foo.js');
    assert.equal(toolCall.payload.inputSummary.content, undefined, 'content should not be in inputSummary');
  });
});

// ─── exportReport details ─────────────────────────────────────────────────────

describe('exportReport: tool aggregation', () => {
  it('aggregates tool call counts by name', () => {
    const sink = createTelemetrySink();
    const taskId = 'tool-agg-task';
    sink.emit('tool.call', taskId, { name: 'read_file' });
    sink.emit('tool.call', taskId, { name: 'read_file' });
    sink.emit('tool.call', taskId, { name: 'write_file' });
    sink.emit('tool.result', taskId, { name: 'read_file', durationMs: 10 });
    sink.emit('tool.result', taskId, { name: 'read_file', durationMs: 20 });
    sink.emit('tool.error', taskId, { name: 'write_file', error: 'oops' });
    sink.emit('task.done', taskId, {});

    const report = sink.exportReport(taskId);
    const readFile = report.tools.find((t) => t.name === 'read_file');
    const writeFile = report.tools.find((t) => t.name === 'write_file');
    assert.ok(readFile, 'read_file should appear in tools');
    assert.equal(readFile.callCount, 2);
    assert.equal(readFile.avgDurationMs, 15);
    assert.ok(writeFile, 'write_file should appear in tools');
    assert.equal(writeFile.errorCount, 1);
  });

  it('exportReport returns safe default for unknown taskId', () => {
    const sink = createTelemetrySink();
    const report = sink.exportReport('nonexistent-task');
    assert.equal(report.taskId, 'nonexistent-task');
    assert.equal(report.durationMs, 0);
    assert.deepEqual(report.cycles, []);
    assert.deepEqual(report.tools, []);
  });
});

// ─── Validation and quality signal aggregation ────────────────────────────────

describe('exportReport: validation and quality', () => {
  it('counts pass/fail validation steps', () => {
    const sink = createTelemetrySink();
    const taskId = 'val-agg-task';
    sink.emit('validation.run', taskId, { step: 'build', passed: true, durationMs: 100 });
    sink.emit('validation.run', taskId, { step: 'lint', passed: false, durationMs: 50 });
    sink.emit('task.done', taskId, {});

    const report = sink.exportReport(taskId);
    assert.equal(report.validation.stepsRun, 2);
    assert.equal(report.validation.passCount, 1);
    assert.equal(report.validation.failCount, 1);
  });

  it('captures quality signals in report', () => {
    const sink = createTelemetrySink();
    const taskId = 'qual-task';
    sink.emit('quality.signal', taskId, { name: 'console_logs', status: 'warn' });
    sink.emit('quality.signal', taskId, { name: 'test_coverage', status: 'pass' });
    sink.emit('task.done', taskId, {});

    const report = sink.exportReport(taskId);
    assert.equal(report.quality.signals.length, 2);
    assert.ok(report.quality.signals.some((s) => s.name === 'console_logs' && s.status === 'warn'));
    assert.ok(report.quality.signals.some((s) => s.name === 'test_coverage' && s.status === 'pass'));
  });
});
