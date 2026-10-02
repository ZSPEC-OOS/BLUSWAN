// Client-side state for the review workspace: changed files, selected diff, validation/command selection,
// revert confirmation and panel preferences. The runtime is the source of truth (git state, diffs, command
// output); this module fetches it through ONE refresh path, caches diffs by workspace revision, and keeps
// per-session UI state. It never runs git itself.
import { parseDiff } from './parseDiff.js'
import { sanitizeTerminalText } from './terminalText.js'
import { projectWorkspaceState, neighbourPath } from './projectWorkspaceState.js'

const PREFS_KEY = 'bluswan.workspace.prefs'
const DEFAULT_PREFS = Object.freeze({ open: false, width: 460 })
export const MIN_WIDTH = 320
export const MAX_WIDTH = 900
export const TABS = Object.freeze(['changes', 'validation', 'commands'])
const REFRESH_EVENTS = new Set(['file.changed', 'file.reverted', 'validation.completed', 'session.completed', 'session.cancelled', 'session.failed', 'command.completed'])
const IMMEDIATE = new Set(['session.completed', 'session.cancelled', 'session.failed', 'file.reverted'])

const freshUi = () => ({ tab: 'changes', selectedPath: null, selectedCommandId: null, selectedValidationId: null, detail: false, sheetOpen: false, revert: null })
const clampWidth = (w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(Number(w) || DEFAULT_PREFS.width)))

function readPrefs(storage) {
  try {
    const v = JSON.parse(storage?.getItem(PREFS_KEY) ?? 'null') ?? {}
    return { open: v.open === true, width: clampWidth(v.width ?? DEFAULT_PREFS.width) }
  } catch { return { ...DEFAULT_PREFS } }
}

/** @param {{runtime:object, storage?:Storage|null, debounceMs?:number, notify?:()=>void}} options */
export function createWorkspaceStore({ runtime, storage = globalThis.localStorage ?? null, debounceMs = 120, notify = () => {} }) {
  let prefs = readPrefs(storage)
  const sessions = new Map() // id → { ui, state, loading, error, diff, diffCache, token, timer }
  const inflight = new Set()

  function entry(id) {
    let s = sessions.get(id)
    if (!s) { s = { ui: freshUi(), state: null, loading: false, error: null, diff: { status: 'idle' }, diffCache: new Map(), token: 0, timer: null, diffToken: 0 }; sessions.set(id, s) }
    return s
  }
  const track = (p) => { inflight.add(p); p.finally(() => inflight.delete(p)); return p }
  const savePrefs = () => { try { storage?.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* private mode */ } }

  // ─── Refresh: the single place that reads workspace state ──────────────────

  function refresh(id, { immediate = false } = {}) {
    const s = entry(id)
    clearTimeout(s.timer)
    if (immediate || debounceMs <= 0) return track(doRefresh(id))
    return new Promise((resolve) => { s.timer = setTimeout(() => { s.timer = null; resolve(track(doRefresh(id))) }, debounceMs); s.pendingTimer = true })
  }

  async function doRefresh(id) {
    const s = entry(id)
    if (!runtime.getSession(id)) return
    const token = ++s.token
    s.loading = true
    notify()
    try {
      const state = await runtime.getWorkspaceState(id)
      if (token !== s.token) return // a newer refresh superseded this one
      const revisionChanged = s.state && s.state.revision !== state.revision
      s.state = state
      s.error = null
      // "Git wins": drop cached diffs that belong to another revision, close a selection that no longer exists.
      if (revisionChanged) s.diffCache.clear()
      if (s.ui.selectedPath && !state.files.some(f => f.path === s.ui.selectedPath)) { s.ui.selectedPath = null; s.ui.detail = false; s.diff = { status: 'idle' } }
      if (s.ui.selectedPath) await loadDiff(id, s.ui.selectedPath, { force: revisionChanged })
    } catch (e) {
      if (token === s.token) s.error = { message: 'Could not read the workspace state.', code: e?.code }
    } finally {
      if (token === s.token) { s.loading = false; notify() }
    }
  }

  // ─── Diffs: on demand, cached per revision ─────────────────────────────────

  async function loadDiff(id, path, { force = false } = {}) {
    const s = entry(id)
    const file = s.state?.files.find(f => f.path === path)
    const key = `${s.state?.workspaceId}|${s.state?.revision}|${path}`
    if (!force && s.diffCache.has(key)) { s.diff = s.diffCache.get(key); notify(); return }
    const myToken = ++s.diffToken
    s.diff = { status: 'loading', path }
    notify()
    try {
      const d = await runtime.getFileDiff(id, path, { from: file?.from })
      if (myToken !== s.diffToken) return
      const view = d.source === 'git'
        ? { status: 'ready', path, source: 'git', parsed: parseDiff(d.diff, { truncated: d.truncated }), truncated: d.truncated, binary: d.binary, empty: d.diff.trim() === '' }
        : { status: 'ready', path, source: 'session', contents: d.contents, deleted: !!d.deleted, truncated: !!d.truncated }
      s.diffCache.set(key, view)
      s.diff = view
    } catch (e) {
      if (myToken === s.diffToken) s.diff = { status: 'error', path, message: 'Could not load this diff.', code: e?.code }
    }
    notify()
  }

  // ─── Event handling ────────────────────────────────────────────────────────

  function handleEvent(event) {
    const id = event.sessionId
    if (!sessions.has(id)) return // only sessions the user has looked at are tracked
    if (REFRESH_EVENTS.has(event.type) || (event.type === 'tool.completed' && event.data?.tool === 'shell')) {
      refresh(id, { immediate: IMMEDIATE.has(event.type) })
    }
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  const ui = (id) => entry(id).ui
  const change = (fn) => { fn(); notify() }

  const actions = {
    handleEvent,
    refresh: (id, opts) => refresh(id, { immediate: true, ...opts }),
    /** Opens a changed file's diff (desktop: inline; mobile: drill-down). */
    selectFile(id, path, { openPanel = true } = {}) {
      change(() => {
        const u = ui(id)
        u.tab = 'changes'; u.selectedPath = path; u.detail = true
        if (openPanel) { prefs = { ...prefs, open: true }; savePrefs(); u.sheetOpen = true }
      })
      return track(loadDiff(id, path))
    },
    clearSelection(id) { change(() => { const u = ui(id); u.selectedPath = null; u.selectedCommandId = null; u.selectedValidationId = null; u.detail = false }) },
    stepFile(id, delta) {
      const s = entry(id)
      const next = neighbourPath(s.state?.files.filter(f => f.status !== 'conflicted') ?? [], s.ui.selectedPath, delta)
      return next ? actions.selectFile(id, next, { openPanel: false }) : null
    },
    selectTab(id, tab) { if (TABS.includes(tab)) change(() => { const u = ui(id); u.tab = tab; u.detail = false }) },
    openCommand(id, commandId) { change(() => { const u = ui(id); u.tab = 'commands'; u.selectedCommandId = commandId; u.detail = true; u.sheetOpen = true; prefs = { ...prefs, open: true }; savePrefs() }) },
    openValidation(id, validationId = null) { change(() => { const u = ui(id); u.tab = 'validation'; u.selectedValidationId = validationId; u.detail = !!validationId; u.sheetOpen = true; prefs = { ...prefs, open: true }; savePrefs() }) },
    openChanges(id) { change(() => { const u = ui(id); u.tab = 'changes'; u.detail = false; u.sheetOpen = true; prefs = { ...prefs, open: true }; savePrefs() }); return refresh(id, { immediate: true }) },
    closeDetail(id) { change(() => { ui(id).detail = false }) },
    closeSheet(id) { change(() => { ui(id).sheetOpen = false }) },
    setPanelOpen(open) { prefs = { ...prefs, open: !!open }; savePrefs(); notify() },
    togglePanel() { actions.setPanelOpen(!prefs.open) },
    setWidth(w) { prefs = { ...prefs, width: clampWidth(w) }; savePrefs(); notify() },
    getCommand: (id, commandId) => {
      const c = runtime.getCommand?.(id, commandId)
      return c ? { ...c, stdout: sanitizeTerminalText(c.stdout), stderr: sanitizeTerminalText(c.stderr) } : null
    },

    // Revert: confirm first; the runtime call is the only thing that touches files.
    requestRevert(id, path) { change(() => { ui(id).revert = { path, phase: 'confirm', message: null } }) },
    cancelRevert(id) { change(() => { ui(id).revert = null }) },
    async confirmRevert(id) {
      const u = ui(id)
      if (!u.revert || u.revert.phase === 'busy') return { ok: false }
      const { path } = u.revert
      change(() => { u.revert = { path, phase: 'busy', message: null } })
      try {
        await runtime.revertFile(id, path)
        change(() => { u.revert = null })
        await refresh(id, { immediate: true })
        return { ok: true }
      } catch (e) {
        change(() => { u.revert = { path, phase: 'error', message: e?.message ?? `Could not revert ${path}.` } })
        await refresh(id, { immediate: true }) // the workspace may have changed even though the revert failed
        return { ok: false }
      }
    },

    /** Everything the panels render for one session. */
    view(id, entries = []) {
      const s = entry(id)
      const commandMeta = runtime.listCommands?.(id) ?? []
      const model = projectWorkspaceState({ state: s.state, entries, commandMeta, ui: s.ui })
      return { ...model, ui: s.ui, loading: s.loading, loadError: s.error, diff: s.diff, prefs, loaded: !!s.state }
    },
    prefs: () => prefs,
    forget(id) { const s = sessions.get(id); if (s) clearTimeout(s.timer); sessions.delete(id) },
    /** Resolves when no refresh is scheduled or running (tests, shutdown). */
    async idle() {
      for (let i = 0; i < 50; i++) {
        const pending = [...sessions.values()].some(s => s.timer)
        if (!pending && !inflight.size) return
        await Promise.all([...inflight])
        await new Promise(r => setTimeout(r, Math.min(debounceMs, 20) + 1))
      }
    },
    destroy() { for (const s of sessions.values()) clearTimeout(s.timer); sessions.clear() },
  }
  return actions
}
