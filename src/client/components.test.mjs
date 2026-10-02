// Component rendering (server-side, no DOM): structure, accessibility attributes and states.
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { importComponent, render, h } from './testing/renderJsx.mjs'
import { createClientStore } from './state/clientStore.js'
import { createSettingsStore } from './settings/settingsStore.js'
import { createAgentRuntime } from '../agent/runtime.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider, say } from '../agent/testing/fakeProvider.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'

let C
before(async () => {
  C = {
    sidebar: (await importComponent('sessions/SessionSidebar.jsx')).default,
    composer: (await importComponent('chat/ChatComposer.jsx')).default,
    perm: (await importComponent('permissions/PermissionPrompt.jsx')).default,
    group: (await importComponent('activity/ActivityGroup.jsx')).default,
    error: (await importComponent('shared/ErrorNotice.jsx')).default,
    empty: (await importComponent('shared/EmptyState.jsx')).default,
    messages: (await importComponent('chat/MessageList.jsx')).default,
    shell: (await importComponent('AppShell.jsx')).default,
    settings: (await importComponent('settings/SettingsPanel.jsx')).default,
    header: (await importComponent('status/ChatHeader.jsx')).default,
  }
})

const noop = () => {}
const sessions = [
  { id: 'a', title: 'Fix parser', running: true, status: 'working', lastActivityAt: Date.now(), workspaceName: 'repo' },
  { id: 'b', title: 'Add tests', running: false, status: 'completed', lastActivityAt: Date.now() - 7200_000, workspaceName: 'repo' },
]

describe('sidebar', () => {
  it('lists conversations, marks the active one and the running one', async () => {
    const html = await render(await h(C.sidebar, { sessions, activeId: 'b', onNew: noop, onSelect: noop, onDelete: noop }))
    assert.match(html, /New chat/)
    assert.match(html, /Fix parser/); assert.match(html, /Add tests/)
    assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1)
    assert.match(html, /is-running/); assert.match(html, /Working/)
    assert.match(html, /aria-label="Delete conversation: Fix parser"/)
  })
  it('renders an empty state', async () => {
    assert.match(await render(await h(C.sidebar, { sessions: [], activeId: null, onNew: noop, onSelect: noop, onDelete: noop })), /No conversations yet/)
  })
})

describe('composer', () => {
  it('is enabled when idle and has no Stop', async () => {
    const html = await render(await h(C.composer, { onSend: noop, onStop: noop }))
    assert.doesNotMatch(html, /<textarea[^>]*disabled/); assert.doesNotMatch(html, /Stop BLUSWAN/)
  })
  it('is disabled with a Stop button while running', async () => {
    const html = await render(await h(C.composer, { disabled: true, canStop: true, reason: 'BLUSWAN is working…', onSend: noop, onStop: noop }))
    assert.match(html, /<textarea[^>]*disabled/); assert.match(html, /aria-label="Stop BLUSWAN"/); assert.match(html, /BLUSWAN is working/)
  })
})

describe('permission prompt', () => {
  const request = { id: 'p1', tool: 'shell', effect: 'dependency_change', action: 'run', command: 'npm install zod', description: 'This changes project dependencies.' }
  it('shows the command, explanation and both choices accessibly', async () => {
    const html = await render(await h(C.perm, { request, status: 'pending', onApprove: noop, onDeny: noop }))
    assert.match(html, /npm install zod/); assert.match(html, /changes project dependencies/)
    assert.match(html, /Allow once/); assert.match(html, /Deny/); assert.match(html, /role="group"/)
  })
  it('hides the buttons once resolved', async () => {
    const html = await render(await h(C.perm, { request, status: 'approved', onApprove: noop, onDeny: noop }))
    assert.doesNotMatch(html, /Allow once/)
  })
})

describe('shared states', () => {
  it('error notice hides technical details by default', async () => {
    const html = await render(await h(C.error, { text: 'The model service is unavailable.', details: 'Error: ECONNRESET at stack' }))
    assert.match(html, /role="alert"/); assert.doesNotMatch(html, /ECONNRESET/)
    assert.match(await render(await h(C.error, { text: 'x', details: 'ECONNRESET', showTechnical: true })), /ECONNRESET/)
  })
  it('empty conversation names the repository', async () => {
    assert.match(await render(await h(C.empty, { repoName: 'acme' })), /acme/)
  })
})

describe('activity group', () => {
  it('renders a collapsed group with a readable header', async () => {
    const item = (id, p) => ({ id, tool: 'read_file', label: `Read ${p}`, status: 'done', details: [] })
    const group = { id: 'g', kind: 'activity', status: 'done', header: 'Read 2 files', items: [item('1', 'a.js'), item('2', 'b.js')] }
    const html = await render(await h(C.group, { group }))
    assert.match(html, /Read 2 files/); assert.match(html, /aria-expanded="false"/)
    assert.doesNotMatch(html, /read_file|a\.js/)
    const open = await render(await h(C.group, { group: { ...group, items: [item('1', 'a.js')] } }))
    assert.match(open, /Read a\.js/); assert.doesNotMatch(open, /read_file/)
  })
})

describe('whole shell', () => {
  async function shell() {
    const runtime = createAgentRuntime({ providers: createProviderRegistry([createFakeProvider({ respond: () => say('hi') })]), approvals: 'interactive', config: loadRuntimeConfig({}) })
    const settings = createSettingsStore({ storage: null })
    const store = createClientStore({ runtime, settings, selectModel: () => ({ provider: 'fake', model: 'm' }) })
    store.newSession()
    return { store, settings, html: await render(await h(C.shell, { store, settings, userEmail: 'u@example.com' })) }
  }
  it('is chat-first and free of legacy vocabulary', async () => {
    const { store, html } = await shell()
    assert.match(html, /What would you like to change/); assert.match(html, /Ask BLUSWAN/); assert.match(html, /New chat/)
    assert.match(html, /Permission mode/); assert.match(html, /Auto Edit/)
    assert.doesNotMatch(html, /\b(V1|V2|V3|engine|cycle|completion gate|migration|dashboard)\b/i)
    store.destroy()
  })
  it('settings panel masks credentials and lists the three permission modes', async () => {
    const settings = createSettingsStore({ storage: null }); settings.update({ apiKey: 'sk-secret-123' })
    const html = await render(await h(C.settings, { settings: settings.get(), onSave: noop, permissionMode: 'ask', onPermissionMode: noop, canOpenWorkspaces: false, onOpenWorkspace: noop, setup: { ready: false, message: 'Add an API key.' }, onClose: noop }))
    assert.doesNotMatch(html, /sk-secret-123/); assert.match(html, /Add an API key/)
    for (const m of ['Ask', 'Auto Edit', 'Full Auto']) assert.match(html, new RegExp(m))
    assert.match(html, /role="dialog"/)
  })
})
