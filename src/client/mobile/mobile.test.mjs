// Phase 12 phone surfaces: pure presentation over existing state and actions (server-rendered, no DOM).
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { importComponent, render, h } from '../testing/renderJsx.mjs'

let M
before(async () => { M = {
  header: (await importComponent('mobile/MobileHeader.jsx')).default,
  workspace: (await importComponent('mobile/MobileWorkspace.jsx')).default,
  settingsMod: await importComponent('mobile/MobileSettings.jsx'),
} })
const noop = () => {}
const sessions = [{ id: 's1', title: 'Fix add', status: 'completed', running: false, lastActivityAt: Date.now() }]

describe('MobileHeader', () => {
  it('shows ☰, BLUSWAN, repository · branch and ⚙ with accessible names and 44px-class buttons', async () => {
    const html = await render(await h(M.header, { repository: 'BLUSWAN', branch: 'main', onOpenWorkspace: noop, onOpenSettings: noop }))
    assert.match(html, /aria-label="Open workspace menu"/); assert.match(html, /aria-label="Open settings"/); assert.match(html, /aria-haspopup="dialog"/); assert.match(html, /aria-expanded="false"/)
    assert.match(html, />BLUSWAN</); assert.match(html, /mhead__repo">BLUSWAN</); assert.match(html, /mhead__branch">main</)
  })
  it('says "No repository" when nothing is open', async () => {
    const html = await render(await h(M.header, { onOpenWorkspace: noop, onOpenSettings: noop }))
    assert.match(html, /No repository/); assert.doesNotMatch(html, /mhead__branch/)
  })
  it('reflects open state, work in progress, unavailable repositories and attention without relying on colour', async () => {
    const html = await render(await h(M.header, { repository: 'r', branch: 'b', unavailable: true, working: true, attention: 'Merged', workspaceOpen: true, settingsOpen: true }))
    assert.match(html, /aria-expanded="true"/); assert.match(html, /BLUSWAN is working/); assert.match(html, /unavailable/); assert.match(html, /Open workspace menu — Merged/)
  })
  it('long names are text inside truncating elements (layout is asserted in the browser suite)', async () => {
    const long = 'a'.repeat(120)
    const html = await render(await h(M.header, { repository: long, branch: `feature/${long}` }))
    assert.match(html, new RegExp(`mhead__repo">${long}<`)); assert.match(html, /mhead__branch/)
  })
  it('only save problems appear in the header', async () => {
    assert.doesNotMatch(await render(await h(M.header, { saveStatus: 'saved', hasMessages: true })), /Saved/)
    assert.match(await render(await h(M.header, { saveStatus: 'failed', hasMessages: true })), /synced yet/)
  })
})

describe('MobileWorkspace', () => {
  const base = { sessions, activeId: 's1', onSelect: noop, onNew: noop, onDelete: noop, onClose: noop, onBrowseGithub: noop, onOpenLocal: noop }
  it('is a labelled modal dialog with Current, Repositories and Conversations, and no Git without a repository', async () => {
    const html = await render(await h(M.workspace, { ...base, hasGithub: true, canOpenWorkspaces: true }))
    assert.match(html, /role="dialog" aria-modal="true" aria-label="Workspace"/); assert.match(html, /aria-label="Close workspace"/)
    for (const t of ['Current', 'Repositories', 'Conversations']) assert.match(html, new RegExp(`>${t}<`))
    assert.match(html, /No repository/); assert.match(html, /Browse GitHub/); assert.match(html, /Open Local Repository/); assert.doesNotMatch(html, />Git</)
    assert.match(html, /aria-label="Conversation list"/); assert.match(html, /Fix add/)
  })
  it('only lists repository actions that exist', async () => {
    const none = await render(await h(M.workspace, { ...base, hasGithub: false, canOpenWorkspaces: false }))
    assert.doesNotMatch(none, />Repositories</); assert.doesNotMatch(none, /Browse GitHub|Open Local Repository/)
    const local = await render(await h(M.workspace, { ...base, hasGithub: false, canOpenWorkspaces: true }))
    assert.doesNotMatch(local, /Browse GitHub/); assert.match(local, /Open Local Repository/)
  })
  it('with a repository: current repo/branch, the existing workflow node and Changes with a count', async () => {
    const html = await render(await h(M.workspace, { ...base, hasGithub: true, canOpenWorkspaces: true, repository: 'widgets', branch: 'bluswan/fix', changedCount: 3, onChanges: noop, workflow: await h('div', { className: 'wf-stub', children: 'WORKFLOW' }) }))
    assert.match(html, />Git</); assert.match(html, /widgets/); assert.match(html, /⎇ bluswan\/fix/); assert.match(html, /WORKFLOW/); assert.match(html, /Changes[\s\S]*3 files/)
    assert.doesNotMatch(html, /Choose a repository to start coding/)
  })
  it('rows are full-width buttons (touch targets come from the stylesheet)', async () => {
    const html = await render(await h(M.workspace, { ...base, hasGithub: true, canOpenWorkspaces: true }))
    assert.ok((html.match(/class="mrow"/g) ?? []).length >= 2); assert.match(html, /type="button"/)
  })
})

describe('MobileSettings', () => {
  const props = (o = {}) => ({
    models: [{ provider: 'deepseek', id: 'deepseek-chat', displayName: 'DeepSeek Chat', configured: true, codingCapable: true, capabilities: {} }], model: { provider: 'deepseek', model: 'deepseek-chat' },
    onChooseModel: noop, permissionMode: 'auto_edit', onPermissionMode: noop, connection: { state: 'online' }, github: { status: { phase: 'ready', configured: true, connected: true, login: 'octo' } },
    onGithub: noop, diagnose: async () => ({}), onClose: noop, onAllSettings: noop, userEmail: 'a@b.c', onSignOut: noop, ...o })
  it('groups the existing model, edit mode, GitHub and runtime state', async () => {
    const html = await render(await h(M.settingsMod.default, props()))
    assert.match(html, /role="dialog" aria-modal="true" aria-label="Settings"/)
    for (const t of ['AI', 'Editing', 'Connections', 'Runtime', 'Account']) assert.match(html, new RegExp(`>${t}<`))
    assert.match(html, /aria-label="Model"/); assert.match(html, /<option value="auto_edit" selected/); assert.match(html, /Connected as octo/); assert.match(html, /● Connected/); assert.match(html, /Diagnostics/)
  })
  it('omits the GitHub row when the runtime has no GitHub support, and says what each state is in words', async () => {
    assert.doesNotMatch(await render(await h(M.settingsMod.default, props({ github: null }))), />Connections</)
    const { githubLabel, runtimeLabel } = M.settingsMod
    assert.equal(githubLabel({ phase: 'loading' }), '◌ Checking…'); assert.equal(githubLabel({ phase: 'ready', configured: false }), '○ Unavailable on this server'); assert.equal(githubLabel({ phase: 'ready', configured: true, connected: false }), '○ Not connected')
    assert.match(runtimeLabel('reconnecting'), /Reconnecting/); assert.match(runtimeLabel('offline_cached'), /Offline/); assert.match(runtimeLabel('server_unreachable'), /Cannot reach/)
  })
})
