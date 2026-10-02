// GitHub workflow client state and components, with a scripted runtime.
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { createGithubStore, stageLabel } from './githubStore.js'
import { importComponent, render, h } from '../testing/renderJsx.mjs'

const until = async (pred, ms = 2000) => { const t0 = Date.now(); while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)) } }
function fakeRuntime(over = {}) {
  const calls = []; const listeners = new Set()
  const rec = (name, value) => async (...a) => { calls.push([name, ...a]); const v = typeof value === 'function' ? value(...a) : value; if (v instanceof Error) throw v; return v }
  const github = {
    status: rec('status', { configured: true, connected: true, login: 'octo', installations: [{ id: 1 }] }),
    connect: rec('connect', { url: 'https://github.com/apps/x/installations/new?state=s' }),
    completeConnection: rec('complete', { configured: true, connected: true, login: 'octo' }),
    disconnect: rec('disconnect', { connected: false }),
    repositories: rec('repositories', (p) => ({ items: [{ owner: 'acme', repo: 'widgets', fullName: 'acme/widgets', private: true, defaultBranch: 'main', cloned: false }].filter(r => !p.q || r.fullName.includes(p.q)), total: 1, nextPage: null, owners: ['acme'], page: 1 })),
    recent: rec('recent', { items: [] }),
    repository: rec('repository', { info: { owner: 'acme', repo: 'widgets', fullName: 'acme/widgets', defaultBranch: 'main', private: true }, local: { cloned: false } }),
    clone: rec('clone', { workspace: { id: 'ws1', github: { owner: 'acme', repo: 'widgets' } } }), open: rec('open', { workspace: { id: 'ws1' } }),
    git: rec('git', { stage: 'ready_for_task', state: { branch: 'main', files: [], staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, upstream: 'origin/main', detached: false }, github: { owner: 'acme', repo: 'widgets', defaultBranch: 'main' }, task: null, pushed: false }),
    branches: rec('branches', { branches: [] }), createBranch: rec('createBranch', { branch: 'bluswan/x' }), checkout: rec('checkout', {}), sync: rec('sync', { status: 'up_to_date', message: 'Already up to date.' }),
    commit: rec('commit', {}), push: rec('push', {}), pullRequest: rec('pullRequest', { pullRequest: { state: 'open' }, task: null }), cleanup: rec('cleanup', { done: true }),
    cancelOperation: rec('cancel', { cancelled: true }), subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) }, ...over,
  }
  return { runtime: { github }, calls, emit: (m) => listeners.forEach(fn => fn(m)), listeners }
}
const deps = (rt, o = {}) => ({ runtime: rt.runtime, workspaceId: () => 'ws1', canAct: () => true, runBusy: () => false, startTask: () => {}, navigate: () => {}, pollMs: 0, debounceMs: 5, ...o })

describe('githubStore', () => {
  it('loads status without flashing an error, then lists repositories when the panel opens', async () => {
    const rt = fakeRuntime(); const s = createGithubStore(deps(rt)); assert.equal(s.getSnapshot().status.phase, 'loading')
    s.openPanel(); await until(() => s.getSnapshot().repos.items.length === 1)
    assert.equal(s.getSnapshot().status.connected, true); assert.equal(s.getSnapshot().repos.items[0].fullName, 'acme/widgets'); s.destroy()
  })
  it('debounces search so typing does not hit the server per keystroke', async () => {
    const rt = fakeRuntime(); const s = createGithubStore(deps(rt, { debounceMs: 30 })); await s.loadStatus()
    for (const q of ['w', 'wi', 'wid']) s.search({ query: q })
    await until(() => !s.getSnapshot().repos.loading && rt.calls.some(c => c[0] === 'repositories'))
    assert.equal(rt.calls.filter(c => c[0] === 'repositories').length, 1); assert.equal(rt.calls.find(c => c[0] === 'repositories')[1].q, 'wid'); s.destroy()
  })
  it('clone & open starts a task in the new workspace and closes the panel', async () => {
    const rt = fakeRuntime(); const started = []; const s = createGithubStore(deps(rt, { startTask: (id) => started.push(id) }))
    await s.loadStatus(); await s.selectRepo('acme', 'widgets'); const ws = await s.cloneOrOpen('clone')
    assert.equal(ws.id, 'ws1'); assert.deepEqual(started, ['ws1']); assert.equal(s.getSnapshot().panel, null); s.destroy()
  })
  it('shows a recoverable error when cloning fails and keeps the repository selected', async () => {
    const rt = fakeRuntime({ clone: async () => { throw Object.assign(new Error('Git failed: boom'), { code: 'git_operation_failed' }) } }); const s = createGithubStore(deps(rt))
    await s.loadStatus(); await s.selectRepo('acme', 'widgets'); assert.equal(await s.cloneOrOpen('clone'), null)
    const r = s.getSnapshot().repo; assert.equal(r.working, false); assert.match(r.error.message, /boom/); assert.ok(r.info, 'still selected so Retry works'); s.destroy()
  })
  it('refuses mutating actions while the agent runs or while offline, with the reason', async () => {
    const rt = fakeRuntime(); let busy = true; let online = true
    const s = createGithubStore(deps(rt, { runBusy: () => busy, canAct: () => online })); await s.refreshGit()
    s.openDialog('commit'); await s.actions.commit({ message: 'm' })
    assert.match(s.getSnapshot().dialogError.message, /Stop the current task/); assert.equal(rt.calls.filter(c => c[0] === 'commit').length, 0)
    busy = false; online = false; await s.actions.commit({ message: 'm' }); assert.match(s.getSnapshot().dialogError.message, /offline/i)
    online = true; await s.actions.commit({ message: 'm' }); assert.equal(rt.calls.filter(c => c[0] === 'commit').length, 1); s.destroy()
  })
  it('turns server confirmations into a dialog state instead of acting', async () => {
    const rt = fakeRuntime({ cleanup: async () => ({ needsConfirmation: 'force_delete', message: 'x', branch: 'b' }) }); const s = createGithubStore(deps(rt)); await s.refreshGit(); s.openDialog('cleanup')
    await s.actions.cleanup({ branch: 'b' }); assert.equal(s.getSnapshot().dialog.confirm.needsConfirmation, 'force_delete'); s.clearConfirm(); assert.equal(s.getSnapshot().dialog.confirm, null); s.destroy()
  })
  it('tracks operation progress from the stream and refreshes on repository change notices', async () => {
    const rt = fakeRuntime(); const s = createGithubStore(deps(rt)); await s.refreshGit()
    rt.emit({ kind: 'operation', operation: { id: 'o1', name: 'push', status: 'running', steps: [{ step: 'Pushing b', status: 'running' }] } })
    assert.equal(s.getSnapshot().op.steps[0].step, 'Pushing b')
    const before = rt.calls.filter(c => c[0] === 'git').length
    rt.emit({ kind: 'github', event: 'pull_request', workspaceId: 'ws1' }); await until(() => rt.calls.filter(c => c[0] === 'git').length > before)
    rt.emit({ kind: 'github', event: 'push', workspaceId: 'other' }); await new Promise(r => setTimeout(r, 250)); assert.equal(rt.calls.filter(c => c[0] === 'git').length, before + 1, 'other repositories are ignored')
    s.destroy(); assert.equal(rt.listeners.size, 0)
  })
  it('polls only while a pull request is waiting and stops when it merges', async () => {
    const gitData = (stage) => ({ stage, state: { branch: 'b', files: [], ahead: 0, behind: 0, detached: false }, github: { defaultBranch: 'main' }, task: { pullRequest: { number: 1, state: stage === 'merged' ? 'merged' : 'open' } } })
    let stage = 'waiting_for_merge'; let rt
    const rt0 = fakeRuntime({ git: async () => gitData(stage), pullRequest: async () => { rt.calls.push(['pullRequest']); return { pullRequest: { state: stage === 'merged' ? 'merged' : 'open' }, task: gitData(stage).task } } }); rt = rt0
    const s = createGithubStore(deps(rt, { pollMs: 20 })); await s.refreshGit()
    await until(() => rt.calls.filter(c => c[0] === 'pullRequest').length >= 3); stage = 'merged'
    await until(() => s.getSnapshot().stage === 'merged'); const n = rt.calls.filter(c => c[0] === 'pullRequest').length
    await new Promise(r => setTimeout(r, 120)); assert.ok(rt.calls.filter(c => c[0] === 'pullRequest').length <= n + 1); s.destroy()
  })
  it('completes the GitHub redirect once and removes the parameters from the address bar', async () => {
    const rt = fakeRuntime(); const s = createGithubStore(deps(rt)); const replaced = []
    const loc = { search: '?code=c1&installation_id=42&state=st&setup_action=install&keep=1', pathname: '/', hash: '' }
    assert.equal(await s.completeFromLocation(loc, { replaceState: (_a, _b, url) => replaced.push(url) }), true)
    assert.deepEqual(replaced, ['/?keep=1']); assert.deepEqual(rt.calls.find(c => c[0] === 'complete')[1], { code: 'c1', installationId: '42', state: 'st' })
    assert.equal(await s.completeFromLocation({ search: '', pathname: '/' }, { replaceState() {} }), false); s.destroy()
  })
  it('never holds credentials: nothing in state looks like a token', async () => {
    const rt = fakeRuntime(); const s = createGithubStore(deps(rt)); s.openPanel(); await s.refreshGit(); await until(() => s.getSnapshot().repos.items.length)
    assert.doesNotMatch(JSON.stringify(s.getSnapshot()), /ghs_|ghp_|"token"|secret|privateKey|BEGIN/i); s.destroy()
  })
  it('has a label for every workflow stage', () => { for (const st of ['ready_for_task', 'has_changes', 'ready_to_push', 'ready_for_pr', 'waiting_for_merge', 'merged', 'closed_unmerged', 'conflicts', 'detached']) assert.notEqual(stageLabel(st), 'Repository', st) })
})

describe('GitHub components', () => {
  let C
  before(async () => { C = { provider: (await importComponent('github/GithubContext.js')).GithubProvider, bar: (await importComponent('github/WorkflowBar.jsx')).default, panel: (await importComponent('github/GithubPanel.jsx')).default, dialogs: (await importComponent('github/GithubDialogs.jsx')).default } })
  const gitFor = (stage, extra = {}) => ({ stage, state: { branch: stage === 'ready_for_task' ? 'main' : 'bluswan/fix', detached: false, files: stage === 'has_changes' ? [{ path: 'a.js' }, { path: 'b.js' }] : [], staged: 1, unstaged: 1, untracked: 0, conflicts: 0, ahead: 1, behind: 0, upstream: 'origin/bluswan/fix' }, github: { owner: 'acme', repo: 'widgets', defaultBranch: 'main' }, pushed: stage !== 'ready_to_push' && stage !== 'has_changes', task: ['waiting_for_merge', 'merged', 'closed_unmerged'].includes(stage) ? { pullRequest: { number: 7, state: stage === 'merged' ? 'merged' : stage === 'closed_unmerged' ? 'closed' : 'open', url: 'https://github.com/acme/widgets/pull/7', checks: { status: 'passed' } } } : null, ...extra })
  async function mount(stage, props = {}, rtOver = {}) {
    const rt = fakeRuntime({ git: async () => gitFor(stage), ...rtOver }); const store = createGithubStore(deps(rt)); await store.refreshGit()
    return { store, html: await render(await h(C.provider, { store, children: await h(C.bar, props) })) }
  }
  it('leads with the right call to action for each stage', async () => {
    const cases = { ready_for_task: /Create Task Branch/, has_changes: /Commit Changes/, ready_to_push: /Push Branch/, ready_for_pr: /Create Pull Request/, waiting_for_merge: /Open Pull Request[\s\S]*Refresh Status/, merged: /Sync Main &amp; Clean Up/, closed_unmerged: /CLOSED WITHOUT MERGE[\s\S]*Create New PR[\s\S]*Abandon Task/ }
    for (const [stage, re] of Object.entries(cases)) { const { html, store } = await mount(stage); assert.match(html, re, stage); store.destroy() }
  })
  it('shows repository, branch, status chips with accessible labels, counts and ahead/behind', async () => {
    const { html, store } = await mount('has_changes')
    assert.match(html, /acme\/widgets/); assert.match(html, /bluswan\/fix/); assert.match(html, /aria-label="Local only, not pushed"/); assert.match(html, /aria-label="2 uncommitted changes"/); assert.match(html, />DIRTY</); assert.match(html, /2 changed files · 1 staged · 1 unstaged/); assert.match(html, /aria-label="1 commits ahead, 0 behind"/)
    store.destroy()
    const m = await mount('merged'); assert.match(m.html, /aria-label="Pull request merged"/); assert.match(m.html, /CHECKS PASSING/); assert.match(m.html, /Merged\. Your changes are now on main\./); m.store.destroy()
  })
  it('disables actions with the reason while the agent runs, while offline, and links only to https GitHub URLs', async () => {
    const busy = await mount('has_changes', { busy: true }); assert.match(busy.html, /<button[^>]*disabled[^>]*title="Stop the current task first\."[^>]*>Commit Changes/); busy.store.destroy()
    const off = await mount('ready_for_pr', { offline: true }); assert.match(off.html, /disabled[^>]*title="You are offline\."/); off.store.destroy()
    const bad = await mount('waiting_for_merge', {}, { git: async () => { const g = gitFor('waiting_for_merge'); g.task.pullRequest.url = 'javascript:alert(1)'; return g } }); assert.doesNotMatch(bad.html, /javascript:/); assert.doesNotMatch(bad.html, /Open Pull Request/); bad.store.destroy()
  })
  it('explains conflicts, detached HEAD and remote mismatch instead of offering unsafe actions', async () => {
    const c = await mount('conflicts'); assert.match(c.html, /Repository sync needs attention/); assert.doesNotMatch(c.html, /Push Branch|Commit Changes/); c.store.destroy()
    const d = await mount('detached'); assert.match(d.html, /detached HEAD/); assert.match(d.html, /Switch to main/); d.store.destroy()
    const r = await mount('remote_mismatch'); assert.match(r.html, /does not match the connected GitHub repository/); r.store.destroy()
  })
  it('the repository panel: unavailable, disconnected and connected states', async () => {
    const render1 = async (statusValue) => { const rt = fakeRuntime({ status: async () => statusValue }); const store = createGithubStore(deps(rt)); await store.loadStatus(); store.openPanel(); const html = await render(await h(C.provider, { store, children: await h(C.panel, {}) })); store.destroy(); return html }
    assert.match(await render1({ configured: false }), /GitHub integration is unavailable[\s\S]*Open Local Repository/)
    assert.match(await render1({ configured: true, connected: false }), /Connect your GitHub account to open repositories[\s\S]*Connect GitHub/)
    const connected = await render1({ configured: true, connected: true, login: 'octo' }); assert.match(connected, /GitHub connected/); assert.match(connected, /octo/); assert.match(connected, /aria-label="Search repositories"/)
  })
  it('dialogs spell out consequences: commit is not a push, cleanup lists what it will delete', async () => {
    const rt = fakeRuntime({ git: async () => gitFor('merged', { task: { taskBranch: 'bluswan/fix', pullRequest: { number: 7, state: 'merged' } } }) }); const store = createGithubStore(deps(rt)); await store.refreshGit()
    store.openDialog('cleanup'); const html = await render(await h(C.provider, { store, children: await h(C.dialogs, {}) }))
    for (const re of [/switch to <strong>main<\/strong>/, /pull latest changes/, /delete local branch/, /delete the remote branch if it still exists/, /merged commit will remain/, /Sync &amp; Clean Up/, /role="dialog"/]) assert.match(html, re)
    store.openDialog('commit'); assert.match(await render(await h(C.provider, { store, children: await h(C.dialogs, {}) })), /not on GitHub/); store.destroy()
  })
})
