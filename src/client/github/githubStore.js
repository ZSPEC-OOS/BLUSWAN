// Framework-free state for the GitHub workflow UI. It asks the runtime (which talks to GitHub); it holds no
// credential, executes no git, and trusts nothing it cannot show. Errors are the server's normalized messages.
const BLOCKING_STAGES = new Set(['ready_for_task'])

const LABELS = {
  ready_for_task: 'Ready to start a task', protected_dirty: 'Changes on the default branch', working: 'Working on a task', has_changes: 'Uncommitted changes', ready_to_push: 'Committed — not pushed',
  ready_for_pr: 'Pushed — ready for review', waiting_for_merge: 'Waiting for merge', merged: 'Merged', closed_unmerged: 'Closed without merge', conflicts: 'Needs attention: conflicts',
  detached: 'Detached HEAD', remote_mismatch: 'Remote does not match', local: 'Local repository',
}
export const stageLabel = (stage) => LABELS[stage] ?? 'Repository'

/**
 * @param {{runtime:object, workspaceId:()=>string|null, canAct:()=>boolean, runBusy:()=>boolean, startTask:(workspaceId:string)=>void,
 *          navigate?:(url:string)=>void, now?:()=>number, pollMs?:number, debounceMs?:number}} deps
 */
export function createGithubStore({ runtime, workspaceId, canAct = () => true, runBusy = () => false, startTask = () => {}, navigate = (u) => globalThis.location?.assign(u), pollMs = 60_000, debounceMs = 300 }) {
  const api = runtime.github
  const listeners = new Set()
  let snapshot = null
  let s = {
    available: !!api,
    status: { phase: 'loading' },
    panel: null, // null | { view: 'home' | 'repo' }
    repos: { items: [], total: 0, page: 1, nextPage: null, loading: false, error: null, query: '', owner: '', visibility: '', owners: [] },
    recent: [], repo: null, op: null, git: { workspaceId: null, loading: false, data: null, error: null },
    branches: null, dialog: null, dialogBusy: false, dialogError: null, notice: null, lastResult: null, tasks: [],
  }
  let searchTimer = null; let pollTimer = null; let opClear = null; let refreshTimer = null; let destroyed = false
  const emit = () => { snapshot = null; for (const fn of [...listeners]) fn() }
  const set = (patch) => { s = { ...s, ...patch }; emit() }
  const errOf = (e) => ({ code: e?.code ?? 'unknown', message: e?.message ?? 'Something went wrong.', retryable: !!e?.retryable })

  function guard(kind) {
    if (!canAct()) return 'You are offline. Reconnect to use GitHub actions.'
    if (kind === 'mutating' && runBusy()) return 'Stop the current task before changing branches or repository state.'
    return null
  }

  // ─── connection ───────────────────────────────────────────────────────────────────────────────────────────────
  async function loadStatus() {
    if (!api) return
    try { const st = await api.status(); if (!destroyed) set({ status: { phase: 'ready', ...st } }) } catch (e) { if (!destroyed) set({ status: { phase: 'error', error: errOf(e) } }) }
  }
  async function startConnect() {
    const blocked = guard(); if (blocked) return set({ notice: { kind: 'error', text: blocked } })
    try { const { url } = await api.connect(); navigate(url) } catch (e) { set({ notice: { kind: 'error', text: errOf(e).message } }) }
  }
  /** Finishes a GitHub redirect (?code&installation_id&state) and removes the parameters from the address bar. */
  async function completeFromLocation(loc = globalThis.location, hist = globalThis.history) {
    if (!api || !loc) return false
    const q = new URLSearchParams(loc.search)
    if (!q.get('state') || !(q.get('installation_id') || q.get('code'))) return false
    const body = { code: q.get('code'), installationId: q.get('installation_id'), state: q.get('state') }
    for (const k of ['code', 'installation_id', 'state', 'setup_action']) q.delete(k)
    hist?.replaceState?.({}, '', `${loc.pathname}${q.toString() ? `?${q}` : ''}${loc.hash ?? ''}`)
    try { const st = await api.completeConnection(body); set({ status: { phase: 'ready', ...st }, panel: { view: 'home' }, notice: { kind: 'ok', text: 'GitHub connected.' } }); loadRepos({ reset: true }); return true } catch (e) { set({ panel: { view: 'home' }, notice: { kind: 'error', text: errOf(e).message } }); return false }
  }
  async function disconnect() {
    try { await api.disconnect(); set({ status: { phase: 'ready', configured: true, connected: false }, repos: { ...s.repos, items: [], total: 0 }, notice: { kind: 'ok', text: 'GitHub disconnected. Your local repositories and conversations were kept.' } }) } catch (e) { set({ notice: { kind: 'error', text: errOf(e).message } }) }
  }

  // ─── repositories ─────────────────────────────────────────────────────────────────────────────────────────────
  async function loadRepos({ reset = false, refresh = false } = {}) {
    if (!api) return
    const r = s.repos; const page = reset ? 1 : r.nextPage ?? 1
    set({ repos: { ...r, loading: true, error: null, ...(reset ? { items: [], nextPage: null } : {}) } })
    try {
      const res = await api.repositories({ page, perPage: 30, q: s.repos.query, owner: s.repos.owner, visibility: s.repos.visibility, refresh: refresh ? 1 : undefined })
      set({ repos: { ...s.repos, items: page === 1 ? res.items : [...s.repos.items, ...res.items], total: res.total, nextPage: res.nextPage, page, owners: res.owners, loading: false, error: null } })
    } catch (e) { set({ repos: { ...s.repos, loading: false, error: errOf(e) } }) }
  }
  function search(patch) { // debounced: typing does not hit the server on every keystroke
    set({ repos: { ...s.repos, ...patch } })
    clearTimeout(searchTimer); searchTimer = setTimeout(() => loadRepos({ reset: true }), debounceMs)
  }
  async function loadRecent() { try { set({ recent: (await api.recent()).items }) } catch { /* optional */ } }
  async function selectRepo(owner, repo) {
    set({ panel: { view: 'repo' }, repo: { owner, repo, loading: true, info: null, local: null, error: null } })
    try { const r = await api.repository(owner, repo); set({ repo: { owner, repo, loading: false, ...r, error: null } }) } catch (e) { set({ repo: { owner, repo, loading: false, info: null, local: null, error: errOf(e) } }) }
  }
  async function cloneOrOpen(mode) {
    const r = s.repo; if (!r?.info) return null
    const blocked = guard(); if (blocked) { set({ repo: { ...r, error: { message: blocked } } }); return null }
    set({ repo: { ...r, error: null, working: true } })
    try {
      const res = await (mode === 'open' ? api.open(r.info.owner, r.info.repo) : api.clone(r.info.owner, r.info.repo))
      startTask(res.workspace.id)
      set({ panel: null, repo: null, notice: { kind: 'ok', text: `${r.info.fullName} is ready.` } })
      loadRepos({ reset: true }); loadRecent(); setTimeout(refreshGit, 0)
      return res.workspace
    } catch (e) { set({ repo: { ...s.repo, working: false, error: errOf(e) } }); return null }
  }
  async function openRecent(owner, repo) {
    try { const res = await api.open(owner, repo); startTask(res.workspace.id); set({ panel: null }); setTimeout(refreshGit, 0) } catch (e) { set({ notice: { kind: 'error', text: errOf(e).message } }) }
  }

  // ─── workspace git state ──────────────────────────────────────────────────────────────────────────────────────
  async function refreshGit() {
    const id = workspaceId(); if (!api || destroyed) return
    if (!id) return set({ git: { workspaceId: null, loading: false, data: null, error: null } })
    if (!canAct()) return
    set({ git: { ...s.git, workspaceId: id, loading: !s.git.data || s.git.workspaceId !== id, error: null } })
    try {
      const data = await api.git(id)
      if (workspaceId() !== id) return
      set({ git: { workspaceId: id, loading: false, data, error: null } })
      schedulePoll(data)
      if (data.stage === 'waiting_for_merge' && data.task?.pullRequest) refreshPr(true)
    } catch (e) { set({ git: { workspaceId: id, loading: false, data: s.git.workspaceId === id ? s.git.data : null, error: errOf(e) } }) }
  }
  function schedulePoll(data) { // lightweight: only while a pull request is waiting, and never in a hidden tab
    clearTimeout(pollTimer)
    if (data?.stage === 'waiting_for_merge' && pollMs > 0) pollTimer = setTimeout(() => { if (globalThis.document?.visibilityState !== 'hidden') refreshPr(false); else schedulePoll(s.git.data) }, pollMs)
  }
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshGit, 150) }
  async function refreshPr(quiet) {
    const id = workspaceId(); const d = s.git.data; if (!id || !d?.task?.pullRequest) return
    try {
      const r = await api.pullRequest(id)
      if (workspaceId() !== id) return
      const task = r.task ?? d.task
      const stage = r.pullRequest?.state === 'merged' ? 'merged' : r.pullRequest?.state === 'closed' ? 'closed_unmerged' : d.stage
      set({ git: { ...s.git, data: { ...d, task, stage } } }); schedulePoll({ stage })
    } catch (e) { if (!quiet) set({ notice: { kind: 'error', text: errOf(e).message } }) }
  }

  // ─── dialogs and actions ──────────────────────────────────────────────────────────────────────────────────────
  function openDialog(kind, data = {}) {
    set({ dialog: { kind, ...data }, dialogError: null, dialogBusy: false, lastResult: null })
    if (kind === 'branch') loadBranches()
  }
  const closeDialog = () => set({ dialog: null, dialogError: null, dialogBusy: false })
  async function loadBranches() { const id = workspaceId(); if (!id) return; try { set({ branches: await api.branches(id) }) } catch (e) { set({ dialogError: errOf(e) }) } }

  /** Runs one dialog action: busy state, normalized error, then a fresh read of the repository. */
  async function act(kind, fn, { close = true } = {}) {
    const blocked = guard(kind === 'read' ? undefined : 'mutating'); if (blocked) return set({ dialogError: { message: blocked } }) || null
    set({ dialogBusy: true, dialogError: null })
    try {
      const res = await fn()
      if (res?.needsConfirmation) { set({ dialogBusy: false, dialog: { ...s.dialog, confirm: res } }); return res }
      set({ dialogBusy: false, lastResult: res, ...(close ? { dialog: null } : {}) }); await refreshGit(); return res
    } catch (e) { set({ dialogBusy: false, dialogError: errOf(e) }); refreshGit(); return null }
  }
  const id = () => workspaceId()
  const actions = {
    createBranch: (o) => act('mutating', () => api.createBranch(id(), o)),
    switchBranch: (branch) => act('mutating', () => api.checkout(id(), branch)),
    sync: async () => { const r = await act('mutating', () => api.sync(id()), { close: false }); if (r) set({ notice: { kind: r.status === 'up_to_date' ? 'ok' : 'ok', text: r.message } }); return r },
    commit: (o) => act('mutating', () => api.commit(id(), o)),
    push: () => act('network', () => api.push(id())),
    createPullRequest: (o) => act('network', () => api.createPullRequest(id(), o)),
    cleanup: (o) => act('mutating', () => api.cleanup(id(), o), { close: false }),
    abandon: (o) => act('mutating', () => api.abandon(id(), o), { close: false }),
    removeLocal: (o) => act('mutating', () => api.removeLocalCopy(id(), o), { close: false }),
  }
  async function prepareCommit(task) { try { const m = await api.suggestCommit(id(), task); const d = s.git.data; set({ dialog: { ...s.dialog, message: m.message, files: d?.state.files ?? [] } }) } catch (e) { set({ dialogError: errOf(e) }) } }
  async function preparePr(sessionId) { try { const d = await api.prDraft(id(), { sessionId }); set({ dialog: { ...s.dialog, draft: d } }) } catch (e) { set({ dialogError: errOf(e) }) } }
  async function loadCommits() { try { return (await api.commits(id())).commits } catch { return [] } }
  async function loadTasks() { try { set({ tasks: (await api.allTasks()).tasks }) } catch { /* history decoration only */ } }

  // ─── stream events ────────────────────────────────────────────────────────────────────────────────────────────
  const unsub = api?.subscribe((msg) => {
    if (msg.kind === 'operation') {
      clearTimeout(opClear)
      set({ op: msg.operation })
      if (msg.operation.status !== 'running') opClear = setTimeout(() => { if (s.op?.id === msg.operation.id && s.op.status === 'done') set({ op: null }) }, 3500)
    } else if (msg.kind === 'github' && (!msg.workspaceId || msg.workspaceId === workspaceId())) scheduleRefresh()
  })

  return {
    getSnapshot: () => (snapshot ??= { ...s, stage: s.git.data?.stage ?? null }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    destroy() { destroyed = true; unsub?.(); clearTimeout(searchTimer); clearTimeout(pollTimer); clearTimeout(opClear); clearTimeout(refreshTimer); listeners.clear() },
    loadStatus, startConnect, completeFromLocation, disconnect,
    openPanel(view = 'home') { set({ panel: { view } }); if (s.status.phase !== 'ready') loadStatus().then(() => s.status.connected && loadRepos({ reset: true })); else if (s.status.connected && !s.repos.items.length) loadRepos({ reset: true }); loadRecent() },
    closePanel: () => set({ panel: null, repo: null }),
    backToList: () => set({ panel: { view: 'home' }, repo: null }),
    search, loadMore: () => (s.repos.nextPage ? loadRepos({}) : null), refreshRepos: () => loadRepos({ reset: true, refresh: true }),
    selectRepo, cloneOrOpen, openRecent, loadRecent,
    refreshGit, refreshPr: () => refreshPr(false), loadCommits, loadTasks,
    openDialog, closeDialog, loadBranches, prepareCommit, preparePr, actions,
    cancelOperation: () => (s.op?.status === 'running' ? api.cancelOperation(s.op.id).catch(() => {}) : null),
    dismissNotice: () => set({ notice: null }),
    clearConfirm: () => set({ dialog: s.dialog ? { ...s.dialog, confirm: null } : null }),
    setDialogField: (patch) => set({ dialog: { ...s.dialog, ...patch } }),
    notifyContextChanged: scheduleRefresh,
    isBlockingStage: (st) => BLOCKING_STAGES.has(st),
  }
}
