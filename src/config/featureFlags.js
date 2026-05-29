/**
 * Feature flag system for BLUSWAN V1/V2 migration.
 *
 * Priority order (highest wins):
 *   1. window.__bluswanFeatureOverrides (runtime switching via EngineToggle)
 *   2. Environment variables (VITE_*)
 *   3. URL query params (?v2=true)
 *   4. localStorage (user preference)
 *   5. Default values (V2 is default as of 2.0.0)
 *
 * Use setFeatureFlag() for runtime switching — no page reload required.
 * Use subscribeToFlags() to react to changes across components.
 */

/**
 * @typedef {Object} FeatureFlags
 * @property {boolean} useV2Engine
 * @property {boolean} useV2UI
 * @property {boolean} useV2Context
 * @property {boolean} useV2LoopPrevention
 * @property {boolean} useV2Reliability
 * @property {boolean} useV2Executor
 * @property {boolean} enablePlanReview
 * @property {boolean} enableCycleReview
 * @property {boolean} enableTelemetry
 * @property {number} maxCycles
 * @property {number} maxTurnsPerCycle
 * @property {number} contextWindow
 * @property {number} remediationBudget
 */

// Guards for Node.js test environments
const _env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : {};
const _getUrl = () => {
  if (typeof window === 'undefined') return new URL('http://localhost/');
  try { return new URL(window.location.href); } catch { return new URL('http://localhost/'); }
};
const _getStorage = () => (typeof localStorage !== 'undefined' ? localStorage : null);
const _getWindow = () => (typeof window !== 'undefined' ? window : null);

export const DEFAULT_FLAGS = {
  useV2Engine:         true,
  useV2UI:             true,
  useV2Context:        true,
  useV2LoopPrevention: true,
  useV2Reliability:    true,
  useV2Executor:       true,
  enablePlanReview:    false,
  enableCycleReview:   false,
  enableTelemetry:     true,
  maxCycles:           3,
  maxTurnsPerCycle:    25,
  contextWindow:       128000,
  remediationBudget:   100,
};

const KNOWN_FLAGS = new Set(Object.keys(DEFAULT_FLAGS));
const NUMERIC_FLAGS = new Set(['maxCycles', 'maxTurnsPerCycle', 'contextWindow', 'remediationBudget']);
const STORAGE_KEY = 'bluswan_flags';

// ─── Core Function ────────────────────────────────────────────────────────────

/**
 * Resolves the full set of feature flags with priority-ordered sources.
 * @returns {FeatureFlags}
 */
export function getFeatureFlags() {
  const overrides = _getWindow()?.__bluswanFeatureOverrides ?? {};
  const url = _getUrl();
  const storage = _getStorage();
  const stored = (() => {
    try { return storage ? JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') : {}; }
    catch { return {}; }
  })();

  const bool = (envKey, urlKey, key) => {
    if (overrides[key] !== undefined) return Boolean(overrides[key]);
    if (_env[envKey] !== undefined) return _env[envKey] === 'true' || _env[envKey] === true;
    if (urlKey && url.searchParams.has(urlKey)) return url.searchParams.get(urlKey) === 'true';
    if (stored[key] !== undefined) return Boolean(stored[key]);
    return DEFAULT_FLAGS[key];
  };

  const num = (envKey, key) => {
    if (overrides[key] !== undefined) return Number(overrides[key]);
    const e = parseInt(_env[envKey]);
    if (!isNaN(e)) return e;
    const s = stored[key];
    if (typeof s === 'number' && !isNaN(s)) return s;
    return DEFAULT_FLAGS[key];
  };

  return {
    useV2Engine:         bool('VITE_V2_ENGINE',         'v2',    'useV2Engine'),
    useV2UI:             bool('VITE_V2_UI',             'v2ui',  'useV2UI'),
    useV2Context:        bool('VITE_V2_CONTEXT',        null,    'useV2Context'),
    useV2LoopPrevention: bool('VITE_V2_LOOP',           null,    'useV2LoopPrevention'),
    useV2Reliability:    bool('VITE_V2_RELIABILITY',    null,    'useV2Reliability'),
    useV2Executor:       bool('VITE_V2_EXECUTOR',       null,    'useV2Executor'),
    enablePlanReview:    bool('VITE_PLAN_REVIEW',       null,    'enablePlanReview'),
    enableCycleReview:   bool('VITE_CYCLE_REVIEW',      null,    'enableCycleReview'),
    enableTelemetry:     bool('VITE_TELEMETRY',         null,    'enableTelemetry'),
    maxCycles:           num('VITE_MAX_CYCLES',         'maxCycles'),
    maxTurnsPerCycle:    num('VITE_MAX_TURNS',          'maxTurnsPerCycle'),
    contextWindow:       num('VITE_CONTEXT_WINDOW',     'contextWindow'),
    remediationBudget:   num('VITE_REMEDIATION_BUDGET', 'remediationBudget'),
  };
}

// ─── Runtime Switching ────────────────────────────────────────────────────────

/**
 * Sets a feature flag at runtime. Updates window.__bluswanFeatureOverrides,
 * persists to localStorage, and dispatches 'featureflagschange' so subscribed
 * components re-render without a page reload.
 * @param {keyof FeatureFlags} key
 * @param {boolean|number} value
 */
export function setFeatureFlag(key, value) {
  if (!KNOWN_FLAGS.has(key)) throw new Error(`Unknown feature flag: ${key}`);
  const coerced = NUMERIC_FLAGS.has(key) ? Number(value) : Boolean(value);

  const win = _getWindow();
  if (win) {
    if (!win.__bluswanFeatureOverrides) win.__bluswanFeatureOverrides = {};
    win.__bluswanFeatureOverrides[key] = coerced;
  }

  const storage = _getStorage();
  if (storage) {
    try {
      const stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
      stored[key] = coerced;
      storage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch { /* storage full or blocked */ }
  }

  if (win?.dispatchEvent && typeof CustomEvent !== 'undefined') {
    win.dispatchEvent(new CustomEvent('featureflagschange', {
      detail: { key, value: coerced, flags: getFeatureFlags() },
    }));
  }
}

/**
 * Clears all persisted flag overrides, reverting to env/default values.
 * Dispatches 'featureflagschange' so subscribed components re-render.
 */
export function resetFeatureFlags() {
  const win = _getWindow();
  if (win) win.__bluswanFeatureOverrides = {};
  const storage = _getStorage();
  if (storage) {
    try { storage.removeItem(STORAGE_KEY); } catch { /* blocked */ }
  }
  if (win?.dispatchEvent && typeof CustomEvent !== 'undefined') {
    win.dispatchEvent(new CustomEvent('featureflagschange', {
      detail: { reset: true, flags: getFeatureFlags() },
    }));
  }
}

/**
 * Subscribes to flag changes dispatched by setFeatureFlag / resetFeatureFlags.
 * @param {Function} callback - receives the CustomEvent detail object
 * @returns {Function} Unsubscribe function
 */
export function subscribeToFlags(callback) {
  const win = _getWindow();
  if (!win?.addEventListener) return () => {};
  const handler = (e) => callback(e.detail);
  win.addEventListener('featureflagschange', handler);
  return () => win.removeEventListener('featureflagschange', handler);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true only when all six core V2 subsystems are enabled.
 * @returns {boolean}
 */
export function isV2FullyEnabled() {
  const f = getFeatureFlags();
  return f.useV2Engine && f.useV2UI && f.useV2Executor && f.useV2Context && f.useV2LoopPrevention && f.useV2Reliability;
}

/**
 * Returns a string describing the current migration posture.
 * @returns {'v1_only'|'v2_full'|'v2_partial'|'v2_mixed'}
 */
export function getMigrationStatus() {
  const f = getFeatureFlags();
  const v2Count = [f.useV2Engine, f.useV2UI, f.useV2Executor,
    f.useV2Context, f.useV2LoopPrevention, f.useV2Reliability]
    .filter(Boolean).length;
  if (v2Count === 0) return 'v1_only';
  if (v2Count === 6) return 'v2_full';
  if (v2Count < 3) return 'v2_partial';
  return 'v2_mixed';
}

// ─── Backward-Compatible Export ───────────────────────────────────────────────
// FEATURES is a live Proxy so that runtime setFeatureFlag() calls are reflected
// immediately in every consumer (agentLoop.js, fsm.js, etc.) without a page reload.
// Each property access calls getFeatureFlags() fresh from the priority-ordered sources.

export const FEATURES = new Proxy(/** @type {FeatureFlags} */ ({}), {
  get(_, key) { return getFeatureFlags()[key]; },
  has(_, key) { return key in getFeatureFlags(); },
});
