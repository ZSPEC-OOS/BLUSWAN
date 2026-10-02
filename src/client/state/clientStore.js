// Framework-free client state: projects runtime sessions/events into what the UI renders and exposes
// the user's actions. React reads it through useSyncExternalStore; nothing here calls providers or
// tools — every action goes through the runtime interface (startSession, sendMessage, cancelSession,
// approvePermission, denyPermission, …).
import { createProjector, statusFromRuntime } from '../activity/projectEvents.js'
import { friendlyError } from '../activity/friendlyError.js'
import { deriveTitle } from '../sessions/sessionTitle.js'
import { createWorkspaceStore } from '../workspace/workspaceStore.js'

const BUSY = new Set(['working', 'waiting'])

/**
 * @param {{runtime:object, settings?:object|null, selectModel?:()=>({provider:string,model:string}|undefined)}} options
 */
export function createClientStore({ runtime, settings = null, selectModel = () => undefined, workspaceStorage, debounceMs }) {
  const projectors = new Map()
  const listeners = new Set()
  let snapshot = null
  let activeId = null
  let currentWorkspaceId = null
  let notice = null
  let scheduled = false

  function attach(session) {
    const p = createProjector()
    for (const e of session.events) p.push(e)
    projectors.set(session.id, p)
    return p
  }
  const ensure = (session) => projectors.get(session.id) ?? attach(session)

  const invalidate = () => {
    snapshot = null
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; for (const fn of [...listeners]) fn() }) // coalesce bursts (streaming deltas)
  }

  const ws = createWorkspaceStore({ runtime, notify: invalidate, ...(workspaceStorage !== undefined ? { storage: workspaceStorage } : {}), ...(debounceMs !== undefined ? { debounceMs } : {}) })
  for (const s of runtime.listSessions()) attach(s)
  const unsubscribe = runtime.subscribe((event, session) => {
    if (session.loadReplaced) { // the full transcript just arrived (or was re-synced): rebuild the projection from it
      session.loadReplaced = false
      projectors.delete(session.id); attach(session)
      ws.refresh(session.id, { immediate: true })
      invalidate()
      return
    }
    const existing = projectors.get(session.id)
    if (existing) existing.push(event)
    else attach(session) // snapshot already includes this event
    ws.handleEvent(event)
    invalidate()
  })

  function workspaceInfo(workspaceId) {
    if (!workspaceId) return null
    const ws = runtime.listWorkspaces().find(w => w.id === workspaceId)
    if (!ws) return { id: workspaceId, available: false, name: 'Unavailable repository', branch: null }
    if (ws.available === false) return { id: ws.id, available: false, name: ws.name ?? 'Unavailable repository', branch: ws.repository?.branch ?? null, needsReconnect: true }
    return { id: ws.id, available: true, name: ws.repository?.name ?? ws.name ?? 'Repository', branch: ws.repository?.branch ?? null, isGitRepository: !!ws.repository?.isGitRepository }
  }

  function listItem(session) {
    const p = ensure(session)
    const view = p.getView()
    return {
      id: session.id,
      title: p.firstUserText() ? deriveTitle(p.firstUserText()) : (session.title || 'New chat'),
      status: view.entries.length || view.status !== 'ready' ? view.status : statusFromRuntime(session.status),
      running: BUSY.has(view.status),
      lastActivityAt: view.lastAt ?? session.updatedAt,
      changedCount: session.changedCount ?? session.changedFiles.length,
      persistence: runtime.getPersistenceStatus?.(session.id) ?? 'saved',
      workspaceName: workspaceInfo(session.workspaceId)?.name ?? null,
    }
  }

  function compute() {
    const all = runtime.listSessions()
    const sessions = all.map(listItem).sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    let active = null
    const session = activeId ? runtime.getSession(activeId) : null
    if (session) {
      const view = ensure(session).getView()
      const busy = BUSY.has(view.status)
      const workspace = workspaceInfo(session.workspaceId)
      const review = ws.view(session.id, view.entries)
      active = {
        id: session.id,
        title: projectors.get(session.id).firstUserText() ? deriveTitle(projectors.get(session.id).firstUserText()) : (session.title || 'New chat'),
        view,
        loading: !!session.loading,
        loadError: session.loadError ? friendlyError(session.loadError) : null,
        persistence: runtime.getPersistenceStatus?.(session.id) ?? 'saved',
        interrupted: view.status === 'interrupted',
        model: session.model,
        workspace,
        changedFiles: session.changedFiles,
        tokenUsage: session.tokenUsage,
        composer: { disabled: busy || !!session.loading || (workspace && !workspace.available), canStop: busy, busy, reason: session.loading ? 'Restoring this conversation…' : busy ? (view.status === 'waiting' ? 'Waiting for your approval…' : 'BLUSWAN is working…') : workspace && !workspace.available ? 'This workspace is no longer available. Reconnect the repository to continue.' : null },
        workspaceMissing: !!workspace && !workspace.available,
        review,
        changedCount: review.loaded ? review.diffSummary.files : (session.changedCount ?? session.changedFiles.length),
      }
    }
    const model = selectModel() ?? session?.model ?? { provider: 'deepseek', model: '' }
    const readiness = runtime.checkModel ? runtime.checkModel(model) : { ok: true }
    return {
      sessions, activeId, active, notice,
      connection: runtime.getConnection?.() ?? { state: 'online', offlineIndex: false, reconnects: 0 },
      providerStatus: runtime.getProviderStatus?.() ?? [],
      workspace: workspaceInfo(session?.workspaceId ?? currentWorkspaceId),
      workspaces: runtime.listWorkspaces(),
      canOpenWorkspaces: runtime.canOpenWorkspaces?.() ?? false,
      permissionMode: runtime.getPermissionMode?.() ?? 'auto_edit',
      providers: runtime.listProviders?.() ?? [],
      model,
      setup: readiness.ok ? { ready: true } : { ready: false, reason: readiness.reason, message: readiness.message },
    }
  }

  const setNotice = (n) => { notice = n; invalidate() }

  const store = {
    getSnapshot: () => (snapshot ??= compute()),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    destroy() { unsubscribe(); ws.destroy(); listeners.clear() },

    /** Review workspace actions, bound to the active conversation. */
    workspace: {
      selectFile: (path, o) => activeId && ws.selectFile(activeId, path, o),
      stepFile: (d) => activeId && ws.stepFile(activeId, d),
      clearSelection: () => activeId && ws.clearSelection(activeId),
      selectTab: (t) => activeId && ws.selectTab(activeId, t),
      openCommand: (id) => activeId && ws.openCommand(activeId, id),
      openValidation: (id) => activeId && ws.openValidation(activeId, id),
      openChanges: () => activeId && ws.openChanges(activeId),
      closeDetail: () => activeId && ws.closeDetail(activeId),
      closeSheet: () => activeId && ws.closeSheet(activeId),
      refresh: () => activeId && ws.refresh(activeId),
      getCommand: (id) => (activeId ? ws.getCommand(activeId, id) : null),
      requestRevert: (path) => activeId && ws.requestRevert(activeId, path),
      cancelRevert: () => activeId && ws.cancelRevert(activeId),
      confirmRevert: () => (activeId ? ws.confirmRevert(activeId) : Promise.resolve({ ok: false })),
      setPanelOpen: ws.setPanelOpen, togglePanel: ws.togglePanel, setWidth: ws.setWidth, idle: ws.idle,
    },

    newSession({ workspaceId = currentWorkspaceId } = {}) {
      const session = runtime.startSession({ workspaceId: workspaceId ?? null, model: selectModel() })
      attach(session)
      activeId = session.id
      currentWorkspaceId = session.workspaceId
      notice = null
      ws.refresh(session.id, { immediate: true })
      invalidate()
      return session.id
    },

    /** Switching views never touches a running session; its work continues in the runtime. */
    selectSession(id) {
      const session = runtime.getSession(id)
      if (!session) return false
      activeId = id
      currentWorkspaceId = session.workspaceId
      notice = null
      runtime.loadSession?.(id) // lazy hydration: the transcript is fetched when a conversation is opened
      ws.refresh(id, { immediate: true })
      invalidate()
      return true
    },

    /** @returns {{ok:true, done:Promise}|{ok:false, reason:string}} */
    sendMessage(text) {
      const value = String(text ?? '')
      if (!activeId) return { ok: false, reason: 'no_session' }
      if (!value.trim()) return { ok: false, reason: 'empty' }
      const view = ensure(runtime.getSession(activeId)).getView()
      if (BUSY.has(view.status)) return { ok: false, reason: 'busy' }
      notice = null
      const id = activeId
      const done = runtime.sendMessage(id, value).catch((e) => {
        setNotice({ kind: 'error', text: friendlyError(e), details: e?.message }) // never silently drop a failed request
        return null
      })
      invalidate()
      return { ok: true, done }
    },

    /** Stop: real runtime cancellation (provider stream, running tools, pending approvals). */
    cancel() {
      if (!activeId) return false
      runtime.cancelSession(activeId)
      return true
    },

    approvePermission: (permissionId) => !!activeId && runtime.approvePermission(activeId, permissionId),
    denyPermission: (permissionId) => !!activeId && runtime.denyPermission(activeId, permissionId),

    /** Deleting a running session needs `force`, which stops it first. Repository files are never touched. */
    async deleteSession(id, { force = false } = {}) {
      const session = runtime.getSession(id)
      if (!session) return { ok: false, reason: 'unknown' }
      if (BUSY.has(ensure(session).getView().status)) {
        if (!force) return { ok: false, reason: 'running', requiresConfirmation: true }
        runtime.cancelSession(id)
        for (let i = 0; i < 200 && BUSY.has(ensure(runtime.getSession(id)).getView().status); i++) await new Promise(r => setTimeout(r, 10))
      }
      await runtime.deleteSession(id)
      projectors.delete(id)
      ws.forget(id)
      if (activeId === id) activeId = store.getSnapshot().sessions[0]?.id ?? null
      invalidate()
      return { ok: true }
    },

    setPermissionMode(mode) {
      runtime.setPermissionMode(mode)
      settings?.update({ permissionMode: mode })
      invalidate()
    },

    /** Opening a different repository creates a session for it; existing sessions keep their own workspace. */
    async openWorkspace(spec) {
      try {
        const ws = await runtime.openWorkspace(spec)
        currentWorkspaceId = ws.id
        return { ok: true, sessionId: store.newSession({ workspaceId: ws.id }) }
      } catch (e) {
        setNotice({ kind: 'error', text: e?.message ? `Couldn't open that repository: ${e.message}` : "Couldn't open that repository.", details: e?.code })
        return { ok: false }
      }
    },

    /** Re-attach a repository that is not available on this host (moved, or opened from another machine). */
    async reconnectWorkspace(root) {
      const id = activeId ? runtime.getSession(activeId)?.workspaceId : null
      if (!id || !runtime.reconnectWorkspace) return { ok: false }
      try { await runtime.reconnectWorkspace(id, root); invalidate(); ws.refresh(activeId, { immediate: true }); return { ok: true } } catch (e) {
        setNotice({ kind: 'error', text: e?.message || "Couldn't reconnect that repository.", details: e?.code })
        return { ok: false }
      }
    },
    async saveSettings(patch) { try { await runtime.saveSettings?.(patch) } catch (e) { setNotice({ kind: 'error', text: e?.message || "Couldn't save settings.", details: e?.code }) } invalidate() },
    retryLoad: () => { if (activeId) runtime.loadSession?.(activeId, { force: true }) },
    dismissNotice: () => setNotice(null),
    refresh: invalidate,
  }

  const first = runtime.listSessions().sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (first) { activeId = first.id; currentWorkspaceId = first.workspaceId; runtime.loadSession?.(first.id); ws.refresh(first.id, { immediate: true }) }
  return store
}
