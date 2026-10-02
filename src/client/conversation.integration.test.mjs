// Acceptance: one conversation through the real runtime, tools, workspace, validation, permission
// flow and client store. Only the model is scripted.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createClientStore } from './state/clientStore.js'
import { createSettingsStore } from './settings/settingsStore.js'
import { createAgentRuntime } from '../agent/runtime.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createFakeProvider, say, call, reply } from '../agent/testing/fakeProvider.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { createFixtureRepo, FIX_ADD_PATCH } from '../workspace/testing/fixtureRepo.js'
import { loadRuntimeConfig } from '../config/runtimeConfig.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const until = async (pred, ms = 8000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)) } }
const scripted = (...turns) => { let n = 0; return (req) => turns[n++]?.(req) ?? reply(say('done')) }

async function setup(respond, mode = 'auto_edit') {
  const fx = await createFixtureRepo(); cleanups.push(() => fx.cleanup())
  const provider = createFakeProvider({ respond })
  const runtime = createAgentRuntime({
    providers: createProviderRegistry([provider]), workspaces: createNodeWorkspaceManager(), approvals: 'interactive', sleep: async () => {},
    config: { ...loadRuntimeConfig({}), permissionMode: mode },
  })
  const store = createClientStore({ runtime, settings: createSettingsStore({ storage: null }), selectModel: () => ({ provider: 'fake', model: 'm' }) })
  cleanups.push(() => store.destroy())
  await store.openWorkspace({ root: fx.root })
  return { fx, store, view: () => store.getSnapshot().active.view, snap: () => store.getSnapshot() }
}

describe('Acceptance conversation', () => {
  it('inspect → edit → validate → approve an install → follow-up, all visible as projected activity', async () => {
    const h = await setup(scripted(
      () => reply(say('Let me look. '), call('s', 'grep', { pattern: 'add', path: 'src' }), call('r', 'read_file', { path: 'src/math.js' })),
      () => reply(call('p', 'apply_patch', { patch: FIX_ADD_PATCH })),
      () => reply(say('Fixed add(). Checking dependencies next.'), call('i', 'shell', { command: 'npm install --help' })),
      () => reply(say('The fix is in place.')), // the runtime then validates automatically (passes)
      () => reply(say('The fix is in place and the tests pass.')), // grounded in the validation result
      () => reply(say('Yes — only src/math.js changed.')),
    ), 'ask')

    // Ask mode: the edit itself needs approval, nothing runs before the user decides.
    const first = h.store.sendMessage('Fix the failing add test')
    assert.equal(first.ok, true)
    assert.equal(h.view().entries[0].kind, 'user')
    await until(() => h.view().pendingPermission)
    assert.equal(await fs.readFile(path.join(h.fx.root, 'src/math.js'), 'utf8').then(t => t.includes('a - b')), true, 'unchanged while waiting')
    assert.equal(h.view().status, 'waiting')
    h.store.approvePermission(h.view().pendingPermission.id)

    await until(() => h.view().pendingPermission) // the shell call is a separate decision
    assert.equal(h.view().pendingPermission.action, 'run')
    h.store.approvePermission(h.view().pendingPermission.id)
    await first.done

    const v = h.view()
    assert.equal(v.status, 'completed')
    assert.equal(v.pendingPermission, null)
    const assistants = v.entries.filter(e => e.kind === 'assistant')
    assert.ok(assistants.every(a => !a.streaming))
    assert.equal(assistants.at(-1).text, 'The fix is in place and the tests pass.')
    const labels = v.entries.filter(e => e.kind === 'activity').flatMap(g => g.items.map(i => i.label))
    assert.ok(labels.some(l => /math\.js/.test(l)), labels.join('|'))
    assert.ok(labels.every(l => !/\b(grep|read_file|apply_patch|shell)\b/.test(l)), 'raw tool names are not shown in labels')
    assert.ok(v.entries.some(e => e.kind === 'activity' && e.items.some(i => i.tool === 'validation')), 'validation appears as activity')
    assert.equal(h.snap().sessions[0].title, 'Fix the failing add test')
    assert.equal(h.snap().active.changedFiles.length, 1)
    assert.equal(await fs.readFile(path.join(h.fx.root, 'src/math.js'), 'utf8').then(t => t.includes('a + b')), true)

    // Follow-up uses the same conversation and workspace.
    const second = h.store.sendMessage('Did anything else change?')
    await second.done
    assert.equal(h.snap().sessions.length, 1)
    assert.equal(h.view().entries.filter(e => e.kind === 'user').length, 2)
    assert.equal(h.view().entries.filter(e => e.kind === 'assistant').at(-1).text, 'Yes — only src/math.js changed.')
  })

  it('prohibited commands never prompt in any mode and are shown as blocked', async () => {
    for (const mode of ['ask', 'auto_edit', 'full_auto']) {
      const h = await setup(scripted(
        () => reply(call('x', 'shell', { command: 'sudo rm -rf /' })),
        (req) => { assert.match(req.messages.at(-1).content, /blocked by workspace safety policy/); return reply(say('I will not do that.')) },
      ), mode)
      const sent = h.store.sendMessage('wipe the disk')
      await sent.done
      assert.equal(h.view().entries.some(e => e.kind === 'permission'), false, `${mode}: no prompt`)
      const item = h.view().entries.filter(e => e.kind === 'activity').flatMap(g => g.items)[0]
      assert.equal(item.status, 'failed'); assert.match(item.label, /blocked by workspace safety policy/)
      assert.equal(h.view().status, 'completed')
    }
  })

  it('Full Auto still asks before external effects', async () => {
    const h = await setup(scripted(() => reply(call('x', 'shell', { command: 'curl https://example.com' })), () => reply(say('ok'))), 'full_auto')
    const sent = h.store.sendMessage('fetch a page')
    await until(() => h.view().pendingPermission)
    assert.equal(h.view().pendingPermission.effect, 'external_effect')
    h.store.denyPermission(h.view().pendingPermission.id)
    await sent.done
    assert.equal(h.view().entries.find(e => e.kind === 'permission').status, 'denied')
  })
})
