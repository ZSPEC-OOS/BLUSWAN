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
  it('settings panel lists the three permission modes and shows setup problems', async () => {
    const settings = createSettingsStore({ storage: null })
    const html = await render(await h(C.settings, { settings: settings.get(), onSave: noop, permissionMode: 'ask', onPermissionMode: noop, canOpenWorkspaces: false, onOpenWorkspace: noop, setup: { ready: false, message: 'The model provider is not configured on the server.' }, onClose: noop }))
    assert.match(html, /not configured on the server/)
    for (const m of ['Ask', 'Auto Edit', 'Full Auto']) assert.match(html, new RegExp(m))
    assert.match(html, /role="dialog"/)
  })
})

describe('persistence and restore UI', () => {
  let M
  before(async () => {
    M = {
      save: (await importComponent('status/SaveIndicator.jsx')).default,
      reconnect: (await importComponent('workspace/ReconnectWorkspace.jsx')).default,
      conversation: (await importComponent('chat/ConversationView.jsx')).default,
      settings: (await importComponent('settings/SettingsPanel.jsx')).default,
    }
  })
  it('save indicator is quiet: nothing for drafts, honest about failures', async () => {
    assert.equal(await render(await h(M.save, { status: 'saved', hasMessages: false })), '')
    assert.match(await render(await h(M.save, { status: 'saving', hasMessages: true })), /Saving…/)
    assert.match(await render(await h(M.save, { status: 'saved', hasMessages: true })), />Saved</)
    assert.match(await render(await h(M.save, { status: 'failed', hasMessages: true })), /isn.{1,6}t synced yet/)
    assert.match(await render(await h(M.save, { status: 'conflict', hasMessages: true })), /Changed elsewhere/)
  })
  it('reconnect form explains that the conversation is intact', async () => {
    const html = await render(await h(M.reconnect, { name: 'acme', reason: 'The repository folder no longer exists.', onReconnect: noop }))
    assert.match(html, /Workspace unavailable: acme/); assert.match(html, /Conversation restored\. Reconnect this repository to continue coding/); assert.match(html, /Reconnect workspace/)
  })
  const active = (o = {}) => ({ id: 's', view: { entries: [], status: 'ready', pendingPermission: null }, composer: { disabled: false, canStop: false, busy: false, reason: null }, workspace: { name: 'acme', available: true }, ...o })
  const convo = async (props) => render(await h(M.conversation, { active: active(), notice: null, setup: { ready: true }, canOpenWorkspaces: true, onSend: noop, onStop: noop, onApprove: noop, onDeny: noop, onOpenSettings: noop, onDismissNotice: noop, ...props }))
  it('conversation shows restoring, restore failure, offline and missing-workspace states', async () => {
    assert.match(await convo({ active: active({ loading: true, composer: { disabled: true, reason: 'Restoring this conversation…' } }) }), /Restoring this conversation/)
    assert.match(await convo({ active: active({ loadError: 'The server is unreachable.' }), onRetryLoad: noop }), /couldn.{1,6}t be restored[\s\S]*Try again/)
    assert.match(await convo({ connection: { state: 'reconnecting', offlineIndex: false } }), /Connection lost — reconnecting/)
    assert.match(await convo({ connection: { state: 'offline', offlineIndex: true } }), /Offline — showing your saved session list/)
    assert.doesNotMatch(await convo({ connection: { state: 'online' } }), /banner-offline/)
    assert.match(await convo({ active: active({ workspaceMissing: true, workspace: { name: 'acme', available: false } }), onReconnectWorkspace: noop }), /Workspace unavailable: acme/)
  })
  it('settings panel reports provider status without any key field', async () => {
    const html = await render(await h(M.settings, { settings: { model: '' }, providers: [{ provider: 'deepseek', label: 'DeepSeek', configured: true, model: 'deepseek-chat' }], onSave: noop, permissionMode: 'ask', onPermissionMode: noop, canOpenWorkspaces: true, onOpenWorkspace: noop, setup: { ready: true }, onClose: noop }))
    assert.match(html, /DeepSeek<\/strong> configured/); assert.match(html, /never sent to this browser/)
    assert.doesNotMatch(html, /type="password"|placeholder="Paste/i); assert.equal((html.match(/<input/g) ?? []).length, 5, 'model, three permission modes, repository path — and no credential field')
    assert.match(await render(await h(M.settings, { settings: { model: '' }, providers: [{ provider: 'deepseek', label: 'DeepSeek', configured: false }], onSave: noop, permissionMode: 'ask', onPermissionMode: noop, canOpenWorkspaces: true, onOpenWorkspace: noop, setup: { ready: false }, onClose: noop })), /not configured[\s\S]*administrator/)
  })
})

describe('model selection', () => {
  let S
  before(async () => { S = { selector: (await importComponent('status/ModelSelector.jsx')).default, sel: await importComponent('models/modelSelection.js') } })
  const models = [
    { provider: 'deepseek', id: 'deepseek-chat', displayName: 'DeepSeek Chat', configured: true, codingCapable: true, capabilities: { reasoning: false } },
    { provider: 'openai', id: 'gpt-5', displayName: 'GPT-5', configured: true, codingCapable: true, capabilities: { reasoning: true } },
    { provider: 'anthropic', id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', configured: false, codingCapable: true, capabilities: {} },
    { provider: 'kimi', id: 'chat-only', displayName: 'Chat only', configured: true, codingCapable: false, capabilities: {} },
  ]
  it('groups by provider, labels capabilities, and disables models that cannot be used', () => {
    const groups = S.sel.modelGroups(models)
    assert.deepEqual(groups.map(g => g.label), ['DeepSeek', 'OpenAI', 'Anthropic', 'Kimi'])
    const by = Object.fromEntries(groups.flatMap(g => g.options).map(o => [o.model, o]))
    assert.deepEqual([by['deepseek-chat'].disabled, by['gpt-5'].label], [false, 'GPT-5 · reasoning'])
    assert.match(by['claude-sonnet-5-5'].label, /not configured/); assert.equal(by['claude-sonnet-5-5'].disabled, true)
    assert.match(by['chat-only'].label, /no tool support/); assert.equal(by['chat-only'].disabled, true)
  })
  it('keeps an unlisted current model visible', () => {
    const groups = S.sel.modelGroups(models, { provider: 'openai', model: 'gpt-custom' })
    assert.ok(groups.find(g => g.provider === 'openai').options.some(o => o.model === 'gpt-custom'))
  })
  it('picks the saved choice only while it is usable, else the server default', () => {
    const def = { provider: 'deepseek', model: 'deepseek-chat' }
    assert.deepEqual(S.sel.pickModel({ settings: { provider: 'openai', model: 'gpt-5' }, models, defaultModel: def }), { provider: 'openai', model: 'gpt-5' })
    for (const bad of [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'kimi', model: 'chat-only' }, { provider: 'x', model: 'y' }, {}]) assert.deepEqual(S.sel.pickModel({ settings: bad, models, defaultModel: def }), def)
    assert.deepEqual(S.sel.pickModel({ settings: {}, models: [], defaultModel: { provider: '', model: '' } }), { provider: '', model: '' })
  })
  it('renders a labelled select with optgroups, disabled while a run is active', async () => {
    const html = await render(await h(S.selector, { models, current: { provider: 'openai', model: 'gpt-5' }, onChange: noop }))
    assert.match(html, /aria-label="Model"/); assert.match(html, /<optgroup label="OpenAI">/); assert.match(html, /<option value="openai:gpt-5" selected="">GPT-5 · reasoning/)
    assert.match(html, /<option value="anthropic:claude-sonnet-5-5" disabled="">[^<]*not configured/)
    assert.match(await render(await h(S.selector, { models, current: { provider: 'openai', model: 'gpt-5' }, disabled: true, onChange: noop })), /<select[^>]*disabled/)
    assert.doesNotMatch(html, /adapter|chatCompletions|responses api/i, 'internal adapter names are not shown')
  })
})
