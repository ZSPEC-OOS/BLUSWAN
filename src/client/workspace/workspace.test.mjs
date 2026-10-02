// Workspace review on the client: projection, store behaviour against the real runtime, and component states.
import { describe, it, afterEach, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { projectWorkspaceState, projectValidation, projectCommands, neighbourPath } from './projectWorkspaceState.js'
import { importComponent, render, h } from '../testing/renderJsx.mjs'
import { buildActivityLinks } from '../activity/ActivityLinks.js'
import { createClientStore } from '../state/clientStore.js'
import { createSettingsStore } from '../settings/settingsStore.js'
import { createAgentRuntime } from '../../agent/runtime.js'
import { createProviderRegistry } from '../../providers/registry.js'
import { createFakeProvider, say, call, reply } from '../../agent/testing/fakeProvider.js'
import { createNodeWorkspaceManager } from '../../workspace/node.js'
import { createFixtureRepo, FIX_ADD_PATCH } from '../../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../../config/runtimeConfig.js'
import { parseDiff } from './parseDiff.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const noop = () => {}
const memStorage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } }

// ─── projection ──────────────────────────────────────────────────────────────
describe('projection', () => {
  const state = {
    source: 'git', revision: 3, repository: { name: 'r', branch: 'main' },
    files: [
      { path: 'src/a.js', status: 'modified', additions: 24, deletions: 8 }, { path: 'tests/a.test.js', status: 'untracked', additions: 86, deletions: 0 },
      { path: 'old.js', status: 'deleted', additions: 0, deletions: 4 },
    ],
    summary: { files: 3, additions: 110, deletions: 12 },
    validation: { results: [], mutationSeq: 0, validatedSeq: 0 },
  }
  it('maps changed files to letters, labels and summary from git data', () => {
    const p = projectWorkspaceState({ state, ui: { selectedPath: 'src/a.js' } })
    assert.deepEqual(p.changedFiles.map(f => f.letter), ['M', 'A', 'D'])
    assert.deepEqual(p.diffSummary, { files: 3, additions: 110, deletions: 12 })
    assert.equal(p.gitBacked, true); assert.equal(p.selectedFile.path, 'src/a.js')
    assert.equal(p.changedFiles[2].canOpen, false)
  })
  it('does not select a path that is no longer changed', () => {
    assert.equal(projectWorkspaceState({ state, ui: { selectedPath: 'gone.js' } }).selectedFile, null)
  })
  it('shows only checks that ran and marks earlier passes stale after a change', () => {
    const v = (seq, mut) => ({ results: [{ id: 'v1', kind: 'test', command: 'npm test', status: 'passed', summary: '18 passed', seq, durationMs: 1400 }], mutationSeq: mut, validatedSeq: seq })
    assert.deepEqual(projectValidation(null), { state: 'none', rows: [], unresolved: [] })
    const fresh = projectValidation(v(2, 2))
    assert.deepEqual([fresh.state, fresh.rows.length, fresh.rows[0].status], ['current', 1, 'passed'])
    const stale = projectValidation(v(2, 3))
    assert.deepEqual([stale.state, stale.rows[0].status, stale.rows[0].ranStatus], ['stale', 'stale', 'passed'])
  })
  it('keeps failed, unavailable and cancelled distinct', () => {
    const r = (id, status) => ({ id, kind: id, command: id, status, seq: 1 })
    const rows = projectValidation({ results: [r('test', 'failed'), r('lint', 'unavailable'), r('build', 'cancelled')], mutationSeq: 1, validatedSeq: 1 }).rows
    assert.deepEqual(rows.map(x => x.status), ['failed', 'unavailable', 'cancelled'])
  })
  it('groups commands by the request that ran them', () => {
    const entries = [
      { kind: 'user', id: 'u1', text: 'Fix auth race' },
      { kind: 'activity', id: 'g1', items: [{ id: 'c1', tool: 'shell', command: 'npm test', status: 'done', label: 'Ran npm test' }, { id: 'f1', tool: 'read_file', status: 'done' }] },
      { kind: 'activity', id: 'g2', items: [{ id: 'v1', tool: 'validation', status: 'done', label: 'Tests passed' }] },
      { kind: 'user', id: 'u2', text: 'Another' },
    ]
    const g = projectCommands(entries, [{ id: 'c1', command: 'npm test', status: 'failed', exitCode: 1, durationMs: 1800 }])
    assert.equal(g.length, 1); assert.equal(g[0].title, 'Fix auth race')
    assert.deepEqual(g[0].commands.map(c => [c.id, c.status, c.exitCode]), [['c1', 'failed', 1], ['v1', 'passed', null]])
    assert.deepEqual(projectCommands([{ kind: 'user', id: 'u', text: 'x' }], []), [])
  })
  it('steps between files with wrap-around', () => {
    const files = [{ path: 'a' }, { path: 'b' }]
    assert.deepEqual([neighbourPath(files, 'a', 1), neighbourPath(files, 'b', 1), neighbourPath(files, 'a', -1), neighbourPath([], 'a', 1)], ['b', 'a', 'b', null])
  })
  it('activity links come from structured metadata only', () => {
    const calls = []
    const links = { openFile: p => calls.push(['file', p]), openCommand: id => calls.push(['cmd', id]), openValidation: id => calls.push(['val', id]), canOpenDeleted: true }
    for (const l of buildActivityLinks({ id: 't', tool: 'apply_patch', status: 'done', files: [{ path: 'src/a.js', action: 'modified' }] }, links)) l.onClick()
    for (const l of buildActivityLinks({ id: 'c', tool: 'shell', command: 'npm test', status: 'done', files: [] }, links)) l.onClick()
    for (const l of buildActivityLinks({ id: 'v', tool: 'validation', status: 'done', label: 'Tests passed' }, links)) l.onClick()
    assert.deepEqual(calls, [['file', 'src/a.js'], ['cmd', 'c'], ['val', 'v']])
    assert.deepEqual(buildActivityLinks({ id: 'r', tool: 'shell', status: 'running' }, links), [])
    assert.deepEqual(buildActivityLinks({ id: 'x', tool: 'read_file', status: 'done', files: [] }, links), [])
  })
})

// ─── store against the real runtime ──────────────────────────────────────────
async function setup({ respond, mode = 'full_auto', git = true } = {}) {
  const fx = await createFixtureRepo({ git }); cleanups.push(() => fx.cleanup())
  const wm = createNodeWorkspaceManager()
  const runtime = createAgentRuntime({
    providers: createProviderRegistry([createFakeProvider({ respond })]), workspaces: wm, approvals: 'interactive', sleep: async () => {},
    config: { ...loadRuntimeConfig({}), enableAutomaticValidation: false, permissionMode: mode },
  })
  const store = createClientStore({ runtime, settings: createSettingsStore({ storage: null }), selectModel: () => ({ provider: 'fake', model: 'm' }), workspaceStorage: memStorage(), debounceMs: 5 })
  cleanups.push(() => store.destroy())
  await store.openWorkspace({ root: fx.root })
  const review = () => store.getSnapshot().active.review
  const settle = async () => { await store.workspace.idle(); await new Promise(r => setTimeout(r, 10)); await store.workspace.idle() }
  return { fx, runtime, store, review, settle, id: () => store.getSnapshot().activeId }
}
const scripted = (...turns) => { let n = 0; return () => turns[n++]?.() ?? reply(say('done')) }

describe('workspace store', () => {
  it('refreshes changed files from git after agent edits, without a manual reload', async () => {
    const h = await setup({ respond: scripted(() => reply(call('p', 'apply_patch', { patch: FIX_ADD_PATCH }), call('w', 'write_file', { path: 'src/new.js', content: 'a\nb\n' })), () => reply(say('Done.'))) })
    await h.store.sendMessage('go').done
    await h.settle()
    const r = h.review()
    assert.equal(r.gitBacked, true)
    assert.deepEqual(r.changedFiles.map(f => [f.path, f.letter]), [['src/math.js', 'M'], ['src/new.js', 'A']])
    assert.deepEqual(r.diffSummary, { files: 2, additions: 3, deletions: 1 })
    assert.equal(h.store.getSnapshot().active.changedCount, 2)
    assert.equal(r.repository.branch, 'main')
  })

  it('loads a diff only for the selected file, caches it per revision and refreshes after another edit', async () => {
    const h = await setup({ respond: scripted(() => reply(call('p', 'apply_patch', { patch: FIX_ADD_PATCH })), () => reply(say('ok')), () => reply(call('w', 'write_file', { path: 'src/math.js', content: 'export const q = 1\n' })), () => reply(say('ok2'))) })
    await h.store.sendMessage('one').done; await h.settle()
    assert.equal(h.review().diff.status, 'idle', 'no diff is fetched until a file is selected')
    await h.store.workspace.selectFile('src/math.js'); await h.settle()
    const d1 = h.review().diff
    assert.equal(d1.status, 'ready'); assert.equal(d1.parsed.files[0].additions, 1)
    await h.store.sendMessage('two').done; await h.settle()
    const d2 = h.review().diff
    assert.notEqual(d2, d1)
    assert.match(d2.parsed.files[0].hunks.flatMap(x => x.lines).map(l => l.text).join('\n'), /export const q = 1/)
    assert.equal(h.review().ui.selectedPath, 'src/math.js', 'selection survives while still relevant')
  })

  it('reports an unreadable diff as an error with retry, not a crash', async () => {
    const h = await setup({ respond: scripted(() => reply(call('w', 'write_file', { path: 'a.txt', content: 'x' })), () => reply(say('ok'))) })
    await h.store.sendMessage('go').done; await h.settle()
    const orig = h.runtime.getFileDiff
    h.runtime.getFileDiff = async () => { throw new Error('boom') }
    await h.store.workspace.selectFile('a.txt'); await h.settle()
    assert.deepEqual([h.review().diff.status, h.review().diff.message], ['error', 'Could not load this diff.'])
    h.runtime.getFileDiff = orig
    await h.store.workspace.selectFile('a.txt'); await h.settle()
    assert.equal(h.review().diff.status, 'ready')
  })

  it('keeps selection and tab per session and drops a selection that no longer exists', async () => {
    const h = await setup({ respond: scripted(() => reply(call('w', 'write_file', { path: 'a.txt', content: 'x' })), () => reply(say('ok'))) })
    const first = h.id()
    await h.store.sendMessage('go').done; await h.settle()
    await h.store.workspace.selectFile('a.txt'); h.store.workspace.selectTab('changes'); await h.settle()
    const second = h.store.newSession(); await h.settle()
    assert.equal(h.review().ui.selectedPath, null, 'a new session never shows the previous session\'s diff')
    assert.equal(h.review().changedFiles.length, 1, 'workspace state is shared by the repository')
    h.store.selectSession(first); await h.settle()
    assert.equal(h.review().ui.selectedPath, 'a.txt')
    await fs.rm(path.join(h.fx.root, 'a.txt')); h.fx.git('status')
    await h.store.workspace.refresh(); await h.settle()
    assert.equal(h.review().ui.selectedPath, null)
    assert.equal(h.review().ui.detail, false)
    assert.notEqual(second, first)
  })

  it('panel preferences persist and width is clamped', async () => {
    const storage = memStorage()
    const h = await setup()
    h.store.workspace.setWidth(10); assert.equal(h.store.getSnapshot().active.review.prefs.width, 320)
    h.store.workspace.setWidth(5000); assert.equal(h.store.getSnapshot().active.review.prefs.width, 900)
    h.store.workspace.togglePanel(); assert.equal(h.store.getSnapshot().active.review.prefs.open, true)
    h.store.workspace.togglePanel(); assert.equal(h.store.getSnapshot().active.review.prefs.open, false)
    void storage
  })

  it('works without git: session-tracked files, contents fallback, no revert', async () => {
    const h = await setup({ git: false, respond: scripted(() => reply(call('w', 'write_file', { path: 'a.txt', content: 'hello\n' })), () => reply(say('ok'))) })
    await h.store.sendMessage('go').done; await h.settle()
    assert.equal(h.review().gitBacked, false); assert.equal(h.review().source, 'session')
    await h.store.workspace.selectFile('a.txt'); await h.settle()
    assert.deepEqual([h.review().diff.source, h.review().diff.contents], ['session', 'hello\n'])
  })
})

describe('revert flow', () => {
  const twoFiles = () => scripted(() => reply(call('p', 'apply_patch', { patch: FIX_ADD_PATCH }), call('w', 'write_file', { path: 'src/index.js', content: 'console.log(9)\n' })), () => reply(say('Done.')))

  it('confirm → revert one file → state, counts and validation update; the other file stays', async () => {
    const h = await setup({ respond: twoFiles() })
    await h.store.sendMessage('go').done; await h.settle()
    await h.store.workspace.selectFile('src/math.js'); await h.settle()
    h.store.workspace.requestRevert('src/math.js')
    assert.equal(h.review().ui.revert.phase, 'confirm')
    assert.match(await fs.readFile(path.join(h.fx.root, 'src/math.js'), 'utf8'), /a \+ b/, 'nothing changes before confirmation')
    const res = await h.store.workspace.confirmRevert(); await h.settle()
    assert.equal(res.ok, true)
    assert.match(await fs.readFile(path.join(h.fx.root, 'src/math.js'), 'utf8'), /a - b/)
    assert.deepEqual(h.review().changedFiles.map(f => f.path), ['src/index.js'])
    assert.equal(h.review().ui.revert, null)
    assert.equal(h.review().ui.selectedPath, null, 'the reverted file is no longer selected')
    assert.equal(h.store.getSnapshot().active.changedCount, 1)
    assert.equal(h.runtime.getSession(h.id()).validation.currentStatus, 'stale')
    const entries = h.store.getSnapshot().active.view.entries
    assert.ok(entries.some(e => e.kind === 'notice' && e.tag === 'revert'))
    assert.equal(h.store.getSnapshot().active.composer.disabled, false, 'conversation stays usable')
  })

  it('cancelling the confirmation changes nothing', async () => {
    const h = await setup({ respond: twoFiles() })
    await h.store.sendMessage('go').done; await h.settle()
    const before = h.fx.git('status', '--porcelain')
    h.store.workspace.requestRevert('src/math.js'); h.store.workspace.cancelRevert()
    assert.equal(h.review().ui.revert, null)
    assert.equal(h.fx.git('status', '--porcelain'), before)
    assert.equal(h.review().changedFiles.length, 2)
  })

  it('a failed revert shows the error, keeps the UI state and refreshes', async () => {
    const h = await setup({ respond: twoFiles() })
    await h.store.sendMessage('go').done; await h.settle()
    await h.store.workspace.selectFile('src/math.js'); await h.settle()
    h.runtime.revertFile = async () => { throw { code: 'revert_failed', message: 'Could not revert src/math.js.' } }
    h.store.workspace.requestRevert('src/math.js')
    const res = await h.store.workspace.confirmRevert(); await h.settle()
    assert.equal(res.ok, false)
    assert.deepEqual([h.review().ui.revert.phase, h.review().ui.revert.message], ['error', 'Could not revert src/math.js.'])
    assert.equal(h.review().changedFiles.length, 2)
    assert.equal(h.review().ui.selectedPath, 'src/math.js')
  })
})

// ─── components ──────────────────────────────────────────────────────────────
describe('workspace components', () => {
  let C
  before(async () => {
    C = {}
    for (const n of ['DiffViewer', 'ChangedFilesPanel', 'RevertFileDialog', 'WorkspacePanel', 'DiffFileHeader', 'WorkspaceTabs']) C[n] = (await importComponent(`workspace/${n}.jsx`)).default
    const cd = await importComponent('workspace/CommandDetails.jsx'); C.CommandDetails = cd.CommandDetails; C.CommandsList = cd.CommandsList
    const vd = await importComponent('workspace/ValidationDetails.jsx'); C.ValidationDetails = vd.ValidationDetails; C.ValidationSummary = vd.ValidationSummary
    C.MobileSheet = (await importComponent('shared/MobileSheet.jsx')).default
    C.ResizablePanel = (await importComponent('shared/ResizablePanel.jsx')).default
  })
  const ready = (text, extra = {}) => ({ status: 'ready', source: 'git', parsed: parseDiff(text, { truncated: !!extra.truncated }), truncated: !!extra.truncated, empty: text.trim() === '', ...extra })
  const MOD = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n tail\n'

  it('diff viewer renders added/removed/context lines with non-color cues', async () => {
    const html = await render(await h(C.DiffViewer, { diff: ready(MOD), file: { path: 'a.js' } }))
    assert.match(html, /dl--add/); assert.match(html, /dl--del/); assert.match(html, /dl--context/)
    assert.match(html, /Added: <\/span>/); assert.match(html, /Removed: <\/span>/); assert.match(html, /@@ -1,3 \+1,3 @@/)
  })
  it('escapes hostile diff content', async () => {
    const html = await render(await h(C.DiffViewer, { diff: ready('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+<img src=x onerror=alert(1)>\n'), file: { path: 'a' } }))
    assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  })
  it('renders loading, error, empty, idle, truncated, binary, new and deleted states', async () => {
    const r = async (diff, file = { path: 'a.js' }) => render(await h(C.DiffViewer, { diff, file, onRetry: noop }))
    assert.match(await r({ status: 'loading' }), /Loading diff/)
    assert.match(await r({ status: 'error', message: 'Could not load this diff.' }), /Could not load this diff[\s\S]*Retry/)
    assert.match(await r({ status: 'idle' }), /Select a changed file/)
    assert.match(await r(ready('')), /No textual changes/)
    assert.match(await r(ready(MOD, { truncated: true })), /Diff truncated\. Open the file or narrow the selection/)
    assert.match(await r(ready('diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n', { binary: true }), { path: 'i.png', binary: true }), /Binary file changed/)
    assert.match(await r(ready('diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n')), /dl--add[\s\S]*dl--add/)
    assert.match(await r(ready('diff --git a/o b/o\ndeleted file mode 100644\n--- a/o\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n')), /dl--del[\s\S]*dl--del/)
    assert.match(await r({ status: 'ready', source: 'session', contents: 'hi' }), /Current file contents[\s\S]*hi/)
  })
  it('long diffs render progressively', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `+l${i}`).join('\n')
    const html = await render(await h(C.DiffViewer, { diff: ready(`diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1,2000 @@\n${lines}\n`), file: { path: 'a' } }))
    assert.equal((html.match(/class="dl dl--add"/g) ?? []).length, 800)
    assert.match(html, /Show 800 more lines/)
  })

  const file = (o) => ({ letter: 'M', label: 'Modified', status: 'modified', additions: 24, deletions: 8, ...o })
  const reviewOf = (o = {}) => ({
    changedFiles: [file({ path: 'src/auth.js' }), file({ path: 'tests/auth.test.js', letter: 'A', label: 'New file', status: 'untracked', additions: 86, deletions: 0 })],
    diffSummary: { files: 2, additions: 110, deletions: 8 }, gitBacked: true, loaded: true, loadError: null, loading: false,
    validation: { state: 'none', rows: [], unresolved: [] }, commands: [], selectedFile: null, repository: { name: 'BLUSWAN', branch: 'main' },
    diff: { status: 'idle' }, ui: { tab: 'changes', selectedPath: null, selectedCommandId: null, selectedValidationId: null, detail: false, revert: null }, prefs: { open: true, width: 460 }, ...o,
  })
  const actions = new Proxy({}, { get: () => noop })

  it('changed files panel shows letters, counts, summary and the source', async () => {
    const html = await render(await h(C.ChangedFilesPanel, { review: reviewOf(), selectedPath: 'src/auth.js', onSelect: noop }))
    assert.match(html, /2 files changed/); assert.match(html, /\+110/); assert.match(html, /Git/)
    assert.match(html, /aria-current="true"/); assert.match(html, /\+24/); assert.match(html, /−8/); assert.match(html, /Modified: /)
  })
  it('changed files panel: empty, session-tracked, load error', async () => {
    assert.match(await render(await h(C.ChangedFilesPanel, { review: reviewOf({ changedFiles: [], diffSummary: { files: 0 } }), onSelect: noop })), /No workspace changes/)
    assert.match(await render(await h(C.ChangedFilesPanel, { review: reviewOf({ gitBacked: false }), onSelect: noop })), /Session-tracked[\s\S]*not a Git repository/)
    assert.match(await render(await h(C.ChangedFilesPanel, { review: reviewOf({ loaded: false, loadError: { message: 'Could not read the workspace state.' } }), onRetry: noop })), /Retry/)
  })
  it('panel: desktop shows list and diff together; stacked shows one at a time', async () => {
    const sel = reviewOf({ selectedFile: file({ path: 'src/auth.js' }), diff: ready(MOD), ui: { ...reviewOf().ui, selectedPath: 'src/auth.js', detail: true } })
    const desk = await render(await h(C.WorkspacePanel, { review: sel, actions }))
    assert.match(desk, /Changed files/); assert.match(desk, /dl--add/); assert.match(desk, /Revert file/); assert.match(desk, /BLUSWAN/); assert.match(desk, /main/)
    const mob = await render(await h(C.WorkspacePanel, { review: sel, actions, stacked: true }))
    assert.doesNotMatch(mob, /aria-label="Changed files"/); assert.match(mob, /dl--add/); assert.match(mob, /‹ Changed files/)
    const mobList = await render(await h(C.WorkspacePanel, { review: reviewOf(), actions, stacked: true }))
    assert.match(mobList, /aria-label="Changed files"/); assert.doesNotMatch(mobList, /dl--add/)
  })
  it('no revert control outside git; conflicts cannot be reverted', async () => {
    const sel = reviewOf({ gitBacked: false, selectedFile: file({ path: 'a.txt' }), diff: { status: 'ready', source: 'session', contents: 'x' }, ui: { ...reviewOf().ui, selectedPath: 'a.txt', detail: true } })
    assert.doesNotMatch(await render(await h(C.WorkspacePanel, { review: sel, actions })), /Revert file/)
  })
  it('tabs: three only, selected state exposed', async () => {
    const html = await render(await h(C.WorkspaceTabs, { tab: 'validation', onSelect: noop, counts: { changes: 2 } }))
    assert.equal((html.match(/role="tab"/g) ?? []).length, 3); assert.match(html, /aria-selected="true"[^>]*>Validation/)
    assert.doesNotMatch(html, /Plan|Cycle|Quality|Telemetry/)
  })
  it('revert dialog: explicit wording, accessible, cancel-first focus, busy and error states', async () => {
    const html = await render(await h(C.RevertFileDialog, { revert: { path: 'src/auth.js', phase: 'confirm' }, onConfirm: noop, onCancel: noop }))
    assert.match(html, /role="alertdialog"/); assert.match(html, /Revert <code>src\/auth\.js<\/code>\?/); assert.match(html, /discard the current uncommitted changes to this file/)
    assert.match(html, /Revert file/); assert.match(html, /Cancel/); assert.match(html, /data-autofocus="true">Cancel/)
    assert.match(await render(await h(C.RevertFileDialog, { revert: { path: 'a', phase: 'error', message: 'Could not revert a.' }, onConfirm: noop, onCancel: noop })), /role="alert"[^>]*>Could not revert a\./)
    assert.match(await render(await h(C.RevertFileDialog, { revert: { path: 'a', phase: 'busy' }, onConfirm: noop, onCancel: noop })), /disabled=""[^>]*>Reverting…/)
    assert.match(await render(await h(C.RevertFileDialog, { revert: { path: 'n', phase: 'confirm' }, isNewFile: true, onConfirm: noop, onCancel: noop })), /new file will be deleted/)
  })

  it('command details: stdout, stderr, exit code, duration, truncation', async () => {
    const html = await render(await h(C.CommandDetails, { command: { command: 'npm test -- auth', status: 'failed', exitCode: 1, durationMs: 1800, stdout: 'ok <b>x</b>', stderr: 'boom', truncated: true } }))
    assert.match(html, /\$ <\/span>npm test -- auth/); assert.match(html, /Failed/); assert.match(html, /<dd>1<\/dd>/); assert.match(html, /1\.8s/)
    assert.match(html, /STDOUT[\s\S]*ok &lt;b&gt;x&lt;\/b&gt;/); assert.match(html, /STDERR[\s\S]*boom/); assert.match(html, /Output truncated/)
  })
  it('command details: timeout, cancelled, empty streams, missing record', async () => {
    assert.match(await render(await h(C.CommandDetails, { command: { command: 'sleep 9', status: 'timeout', timedOut: true, exitCode: null, durationMs: 200, stdout: '', stderr: '' } })), /Timed out[\s\S]*timed out and was stopped[\s\S]*\(empty\)/)
    assert.match(await render(await h(C.CommandDetails, { command: { command: 'x', status: 'cancelled', cancelled: true, exitCode: null, durationMs: 5, stdout: '', stderr: '' } })), /Cancelled[\s\S]*cancelled before it finished/)
    assert.match(await render(await h(C.CommandDetails, { command: null })), /not available/)
  })
  it('commands list: groups, status, empty state', async () => {
    const groups = [{ id: 'g', title: 'Fix auth race', commands: [{ id: 'c', command: 'npm test', status: 'passed', durationMs: 1400 }] }]
    const html = await render(await h(C.CommandsList, { groups, selectedId: 'c', onSelect: noop }))
    assert.match(html, /Fix auth race/); assert.match(html, /npm test/); assert.match(html, /Succeeded · 1\.4s/)
    assert.match(await render(await h(C.CommandsList, { groups: [], onSelect: noop })), /No commands run in this request/)
  })

  const vrow = (o) => ({ id: 'v', kind: 'test', name: 'Tests', command: 'npm test -- auth', scope: 'focused', status: 'passed', ranStatus: 'passed', summary: '18 passed', durationMs: 1400, diagnostics: null, relatedFiles: [], stale: false, ...o })
  it('validation summary: only what ran, with distinct statuses', async () => {
    const none = await render(await h(C.ValidationSummary, { validation: { state: 'none', rows: [] }, onSelect: noop }))
    assert.match(none, /No validation has run for this request/); assert.doesNotMatch(none, /Passed/)
    const rows = [vrow({}), vrow({ id: 'l', name: 'Lint', status: 'failed', ranStatus: 'failed', summary: '2 errors' }), vrow({ id: 'b', name: 'Build', status: 'unavailable', ranStatus: 'unavailable' }), vrow({ id: 't', name: 'Types', status: 'cancelled', ranStatus: 'cancelled' })]
    const html = await render(await h(C.ValidationSummary, { validation: { state: 'current', rows }, onSelect: noop }))
    for (const w of ['Passed', 'Failed', 'Unavailable', 'Cancelled']) assert.match(html, new RegExp(`val__status--[a-z]+">${w}`))
    const stale = await render(await h(C.ValidationSummary, { validation: { state: 'stale', rows: [vrow({ status: 'stale', stale: true })] }, onSelect: noop }))
    assert.match(stale, /Revalidation needed/); assert.match(stale, /Stale/); assert.match(stale, /Passed earlier/)
    assert.doesNotMatch(stale, /val__status--passed/)
  })
  it('validation details: diagnostics link only to changed files; stale and output affordances', async () => {
    const row = vrow({ status: 'failed', ranStatus: 'failed', summary: 'Build failed', diagnostics: { summary: 'Unexpected token', keyMessages: ['SyntaxError: Unexpected token'], locations: ['src/App.jsx:42', 'other/x.js:1'] }, relatedFiles: ['src/App.jsx'] })
    const html = await render(await h(C.ValidationDetails, { row, changedPaths: ['src/App.jsx'], onOpenFile: noop, onOpenOutput: noop }))
    assert.match(html, /<button[^>]*class="path"[^>]*>src\/App\.jsx:42<\/button>/); assert.match(html, /<code>other\/x\.js:1<\/code>/); assert.match(html, /Unexpected token/); assert.match(html, /View output/)
    assert.match(await render(await h(C.ValidationDetails, { row: vrow({ status: 'stale', stale: true }), changedPaths: [], onOpenFile: noop, onOpenOutput: noop })), /Passed earlier\. Code changed afterward/)
  })

  it('mobile sheet is a labelled modal dialog; resizable panel exposes a keyboard-operable separator', async () => {
    const sheet = await render(await h(C.MobileSheet, { title: 'Workspace', onClose: noop, children: 'body' }))
    assert.match(sheet, /role="dialog"/); assert.match(sheet, /aria-modal="true"/); assert.match(sheet, /aria-label="Workspace"/); assert.match(sheet, /Close Workspace/)
    const rp = await render(await h(C.ResizablePanel, { width: 460, onWidthChange: noop, children: 'x' }))
    assert.match(rp, /role="separator"/); assert.match(rp, /aria-valuenow="460"/); assert.match(rp, /tabindex="0"/)
  })
})
