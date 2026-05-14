/**
 * tests/unit/featureFlags.test.mjs
 * Tests for src/config/featureFlags.js
 * Uses Node.js built-in test runner. Mocks browser globals before each test.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// ─── Browser Global Mocks ─────────────────────────────────────────────────────

class MockStorage {
  constructor() { this._store = {}; }
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._store, k) ? this._store[k] : null; }
  setItem(k, v) { this._store[k] = String(v); }
  removeItem(k) { delete this._store[k]; }
  clear() { this._store = {}; }
}

let mockStorage;

function setupBrowserGlobals(href = 'http://localhost/', storageData = {}) {
  mockStorage = new MockStorage();
  for (const [k, v] of Object.entries(storageData)) mockStorage.setItem(k, v);
  global.window = { location: { href } };
  global.localStorage = mockStorage;
}

function teardownBrowserGlobals() {
  delete global.window;
  delete global.localStorage;
}

// Dynamically re-import the module to pick up mutated globals
// We use a cache-busting approach by resetting state through the exported functions.
// The module is imported once; we test via exported functions only.
const FLAGS_KEY = 'bluswan_flags';

// Import module under test — node caches it, so globals must be set before first import
setupBrowserGlobals();
const { getFeatureFlags, setFeatureFlag, resetFeatureFlags, isV2FullyEnabled, getMigrationStatus, FEATURES } =
  await import('../../src/config/featureFlags.js');
teardownBrowserGlobals();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function withEnv(vars, fn) {
  // Temporarily set import.meta.env values — not possible in tests;
  // instead we test via URL params and localStorage which are controllable.
  return fn();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getFeatureFlags', () => {
  beforeEach(() => setupBrowserGlobals());
  after(() => teardownBrowserGlobals());

  it('returns all boolean flags as false by default (except enableTelemetry)', () => {
    const f = getFeatureFlags();
    assert.equal(f.useV2Engine, false);
    assert.equal(f.useV2UI, false);
    assert.equal(f.useV2Context, false);
    assert.equal(f.useV2LoopPrevention, false);
    assert.equal(f.useV2Reliability, false);
    assert.equal(f.useV2Executor, false);
    assert.equal(f.enablePlanReview, false);
    assert.equal(f.enableCycleReview, false);
    assert.equal(f.enableTelemetry, true); // only flag that defaults to true
  });

  it('returns correct numeric defaults', () => {
    const f = getFeatureFlags();
    assert.equal(f.maxCycles, 3);
    assert.equal(f.maxTurnsPerCycle, 25);
    assert.equal(f.contextWindow, 128000);
    assert.equal(f.remediationBudget, 100);
  });

  it('URL param ?v2=true enables useV2Engine', () => {
    setupBrowserGlobals('http://localhost/?v2=true');
    const f = getFeatureFlags();
    assert.equal(f.useV2Engine, true);
    assert.equal(f.useV2UI, false); // unrelated flag unaffected
  });

  it('URL param ?v2ui=true enables useV2UI', () => {
    setupBrowserGlobals('http://localhost/?v2ui=true');
    const f = getFeatureFlags();
    assert.equal(f.useV2UI, true);
  });

  it('localStorage stored flag enables useV2Engine', () => {
    setupBrowserGlobals('http://localhost/', { [FLAGS_KEY]: JSON.stringify({ useV2Engine: true }) });
    const f = getFeatureFlags();
    assert.equal(f.useV2Engine, true);
  });

  it('URL param overrides localStorage for useV2Engine', () => {
    // localStorage says false (absent), URL says true
    setupBrowserGlobals('http://localhost/?v2=true', { [FLAGS_KEY]: JSON.stringify({ useV2Engine: false }) });
    const f = getFeatureFlags();
    assert.equal(f.useV2Engine, true);
  });

  it('localStorage numeric value overrides default for maxCycles', () => {
    setupBrowserGlobals('http://localhost/', { [FLAGS_KEY]: JSON.stringify({ maxCycles: 7 }) });
    const f = getFeatureFlags();
    assert.equal(f.maxCycles, 7);
  });

  it('gracefully handles corrupt localStorage JSON', () => {
    setupBrowserGlobals('http://localhost/', { [FLAGS_KEY]: 'NOT_JSON{{{' });
    assert.doesNotThrow(() => getFeatureFlags());
    const f = getFeatureFlags();
    assert.equal(f.useV2Engine, false); // falls back to default
  });
});

describe('setFeatureFlag', () => {
  beforeEach(() => setupBrowserGlobals());
  after(() => teardownBrowserGlobals());

  it('persists boolean flag to localStorage', () => {
    setFeatureFlag('useV2Engine', true);
    const stored = JSON.parse(mockStorage.getItem(FLAGS_KEY));
    assert.equal(stored.useV2Engine, true);
  });

  it('persists numeric flag as number', () => {
    setFeatureFlag('maxCycles', 5);
    const stored = JSON.parse(mockStorage.getItem(FLAGS_KEY));
    assert.equal(typeof stored.maxCycles, 'number');
    assert.equal(stored.maxCycles, 5);
  });

  it('merges with existing stored flags', () => {
    mockStorage.setItem(FLAGS_KEY, JSON.stringify({ useV2UI: true }));
    setFeatureFlag('useV2Engine', true);
    const stored = JSON.parse(mockStorage.getItem(FLAGS_KEY));
    assert.equal(stored.useV2UI, true);
    assert.equal(stored.useV2Engine, true);
  });

  it('throws on unknown flag key', () => {
    assert.throws(() => setFeatureFlag('nonExistentFlag', true), /Unknown feature flag/);
  });
});

describe('resetFeatureFlags', () => {
  beforeEach(() => setupBrowserGlobals('http://localhost/', { [FLAGS_KEY]: JSON.stringify({ useV2Engine: true }) }));
  after(() => teardownBrowserGlobals());

  it('removes bluswan_flags from localStorage', () => {
    assert.notEqual(mockStorage.getItem(FLAGS_KEY), null);
    resetFeatureFlags();
    assert.equal(mockStorage.getItem(FLAGS_KEY), null);
  });

  it('causes getFeatureFlags to return defaults after reset', () => {
    resetFeatureFlags();
    const f = getFeatureFlags();
    assert.equal(f.useV2Engine, false);
  });
});

describe('isV2FullyEnabled', () => {
  beforeEach(() => setupBrowserGlobals());
  after(() => teardownBrowserGlobals());

  it('returns false when all flags are default (false)', () => {
    assert.equal(isV2FullyEnabled(), false);
  });

  it('returns false when only some core flags are set', () => {
    setupBrowserGlobals('http://localhost/?v2=true&v2ui=true');
    assert.equal(isV2FullyEnabled(), false); // missing executor/context/loop/reliability
  });

  it('returns true when all six core flags are enabled via URL + localStorage', () => {
    setupBrowserGlobals(
      'http://localhost/?v2=true&v2ui=true',
      { [FLAGS_KEY]: JSON.stringify({ useV2Executor: true, useV2Context: true, useV2LoopPrevention: true, useV2Reliability: true }) }
    );
    assert.equal(isV2FullyEnabled(), true);
  });
});

describe('getMigrationStatus', () => {
  beforeEach(() => setupBrowserGlobals());
  after(() => teardownBrowserGlobals());

  it('returns v1_only when all flags are false', () => {
    assert.equal(getMigrationStatus(), 'v1_only');
  });

  it('returns v2_partial when only engine is on', () => {
    setupBrowserGlobals('http://localhost/?v2=true');
    assert.equal(getMigrationStatus(), 'v2_partial');
  });

  it('returns v2_mixed when engine and UI are on but not all subsystems', () => {
    setupBrowserGlobals('http://localhost/?v2=true&v2ui=true');
    assert.equal(getMigrationStatus(), 'v2_mixed');
  });

  it('returns v2_full when all six core flags are enabled', () => {
    setupBrowserGlobals(
      'http://localhost/?v2=true&v2ui=true',
      { [FLAGS_KEY]: JSON.stringify({ useV2Executor: true, useV2Context: true, useV2LoopPrevention: true, useV2Reliability: true }) }
    );
    assert.equal(getMigrationStatus(), 'v2_full');
  });
});

describe('FEATURES backward-compat export', () => {
  it('FEATURES is an object with at least useV2Engine and useV2UI', () => {
    assert.ok(typeof FEATURES === 'object' && FEATURES !== null);
    assert.ok('useV2Engine' in FEATURES);
    assert.ok('useV2UI' in FEATURES);
  });
});
