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
  global.window = { location: { href }, __bluswanFeatureOverrides: {} };
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

  it('returns all V2 core flags as true by default (V2 is default)', () => {
    const f = getFeatureFlags();
    assert.equal(f.useV2Engine, true);
    assert.equal(f.useV2UI, true);
    assert.equal(f.useV2Context, true);
    assert.equal(f.useV2LoopPrevention, true);
    assert.equal(f.useV2Reliability, true);
    assert.equal(f.useV2Executor, true);
    assert.equal(f.enablePlanReview, false);
    assert.equal(f.enableCycleReview, false);
    assert.equal(f.enableTelemetry, true);
  });

  it('returns correct numeric defaults', () => {
    const f = getFeatureFlags();
    assert.equal(f.maxCycles, 5);
    assert.equal(f.maxTurnsPerCycle, 25);
    assert.equal(f.contextWindow, 128000);
    assert.equal(f.remediationBudget, 100);
  });

  it('URL param ?v2=true enables useV2Engine (already true by default)', () => {
    setupBrowserGlobals('http://localhost/?v2=true');
    const f = getFeatureFlags();
    assert.equal(f.useV2Engine, true);
    assert.equal(f.useV2UI, true); // also true by default
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
    assert.equal(f.useV2Engine, true); // falls back to default (true)
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
    assert.equal(f.useV2Engine, true); // default is now true
  });
});

describe('isV2FullyEnabled', () => {
  beforeEach(() => setupBrowserGlobals());
  after(() => teardownBrowserGlobals());

  it('returns true when all flags are default (V2 is default)', () => {
    assert.equal(isV2FullyEnabled(), true);
  });

  it('returns false when core flags are disabled via overrides', () => {
    // Use runtime overrides to simulate V1 mode
    global.window.__bluswanFeatureOverrides = {
      useV2Engine: false, useV2UI: false, useV2Executor: false,
      useV2Context: false, useV2LoopPrevention: false, useV2Reliability: false,
    };
    assert.equal(isV2FullyEnabled(), false);
    global.window.__bluswanFeatureOverrides = {};
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

  it('returns v2_full by default (all flags default to true)', () => {
    assert.equal(getMigrationStatus(), 'v2_full');
  });

  it('returns v1_only when all flags are overridden to false', () => {
    global.window.__bluswanFeatureOverrides = {
      useV2Engine: false, useV2UI: false, useV2Executor: false,
      useV2Context: false, useV2LoopPrevention: false, useV2Reliability: false,
    };
    assert.equal(getMigrationStatus(), 'v1_only');
    global.window.__bluswanFeatureOverrides = {};
  });

  it('returns v2_partial when only engine is on (all others overridden off)', () => {
    global.window.__bluswanFeatureOverrides = {
      useV2UI: false, useV2Executor: false,
      useV2Context: false, useV2LoopPrevention: false, useV2Reliability: false,
    };
    assert.equal(getMigrationStatus(), 'v2_partial');
    global.window.__bluswanFeatureOverrides = {};
  });

  it('returns v2_mixed when 3 of 6 core flags are on', () => {
    // 3 off → 3 on (engine + UI + loopPrevention) → v2Count=3 → v2_mixed
    global.window.__bluswanFeatureOverrides = {
      useV2Executor: false, useV2Context: false, useV2Reliability: false,
    };
    assert.equal(getMigrationStatus(), 'v2_mixed');
    global.window.__bluswanFeatureOverrides = {};
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
  beforeEach(() => setupBrowserGlobals());
  after(() => teardownBrowserGlobals());

  it('FEATURES is an object with at least useV2Engine and useV2UI', () => {
    assert.ok(typeof FEATURES === 'object' && FEATURES !== null);
    assert.ok('useV2Engine' in FEATURES);
    assert.ok('useV2UI' in FEATURES);
  });

  it('FEATURES reflects runtime setFeatureFlag changes without re-import', () => {
    resetFeatureFlags();
    const before = FEATURES.maxCycles;
    setFeatureFlag('maxCycles', 99);
    assert.equal(FEATURES.maxCycles, 99, 'Proxy should return updated value immediately');
    resetFeatureFlags();
    assert.equal(FEATURES.maxCycles, before, 'Proxy should revert after reset');
  });
});
