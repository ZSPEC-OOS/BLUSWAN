// The BLUSWAN application service: everything the web client can ask for, independent of HTTP.
//
// One runtime per signed-in user (own sessions, permission mode, workspaces, command logs), so a user's data
// is structurally unreachable from another user's requests; ids are never looked up globally. Provider
// credentials come from the server's credential store and are used only inside provider adapters.
// Persistence is an injected adapter (file / memory / Firestore): sessions autosave, and are hydrated on demand.
import os from 'node:os'
import { createAgentRuntime } from '../agent/runtime.js'
import { createSessionManager } from '../sessions/sessionManager.js'
import { createSessionAutosave } from '../sessions/sessionStore.js'
import { createSessionHydrator } from '../sessions/sessionHydrator.js'
import { deriveTitle } from '../sessions/title.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createDeepSeekProvider } from '../providers/deepseek.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { snapshotWorkspace, restoreWorkspace } from '../workspace/workspaceRestore.js'
import { createSettingsRepository } from '../persistence/settingsRepository.js'
import { createWorkspaceRepository, toWorkspaceRecord } from '../persistence/workspaceRepository.js'
import { getRuntimeConfig, getProviderConfig } from '../config/runtimeConfig.js'
import { createError, isBluswanError } from '../protocol/schemas.js'
import { isPermissionMode } from '../tools/permissionModes.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('service')
const SENDABLE = new Set(['idle', 'completed', 'cancelled', 'error', 'waiting_user', 'interrupted'])

/** Everything a client needs to render a session's status without the transcript. */
export const liteSession = (s) => ({
  id: s.id, status: s.status, workspaceId: s.workspaceId, model: s.model, changedFiles: s.changedFiles,
  validation: s.validation, tokenUsage: s.tokenUsage, startedAt: s.startedAt, updatedAt: s.updatedAt,
})

const indexFromLive = (s, userId, persistenceStatus) => ({
  id: s.id, userId, title: deriveTitle(s.messages.find(m => m.role === 'user')?.content ?? ''), workspaceId: s.workspaceId, status: s.status,
  outcome: s.runs.at(-1)?.outcome ?? null, lastActivityAt: s.updatedAt, createdAt: s.startedAt, changedCount: s.changedFiles.length,
  messageCount: s.messages.length, model: s.model, persistence: persistenceStatus,
})

/**
 * @param {{persistence:object, credentials:object, hostId?:string, allowedRoots?:string[]|null, config?:object,
 *          providerFactory?:(user:object, credentials:object)=>object, autosave?:object}} deps
 */
export function createBluswanService({ persistence, credentials, hostId = os.hostname(), allowedRoots = null, config = getRuntimeConfig(), providerFactory = null, autosave: autosaveOptions = {} }) {
  const contexts = new Map() // userId → Promise<context>
  const metrics = { hydrations: 0, hydrationMsTotal: 0, hydrationMsMax: 0, invalidRecords: 0, schemaUnsupported: 0 } // counts and timings only, never content

  function buildContext(user) {
    return (async () => {
      const settingsRepo = createSettingsRepository(persistence, { userId: user.id })
      const stored = await persistence.loadSettings(user.id).catch(() => null)
      const settings = stored ? await settingsRepo.load() : { permissionMode: config.permissionMode, provider: 'deepseek', model: '' }
      const workspaces = createNodeWorkspaceManager({ allowedRoots })
      const provider = providerFactory ? providerFactory(user, credentials) : createDeepSeekProvider({
        getConfig: () => ({ ...getProviderConfig('deepseek', config), ...(credentials.hasCredential('deepseek', user) ? credentials.getCredential('deepseek', user) : { apiKey: '' }) }),
      })
      const runtime = createAgentRuntime({
        providers: createProviderRegistry([provider]), sessions: createSessionManager(), workspaces, approvals: 'interactive',
        config: { ...config, permissionMode: settings.permissionMode },
      })
      const listeners = new Set()
      const hydrating = new Map()
      const broadcast = (msg) => { for (const fn of [...listeners]) { try { fn(msg) } catch (e) { log.warn('stream listener failed', { message: e?.message }) } } }
      const autosave = createSessionAutosave({
        runtime, adapter: persistence, ownerOf: (id) => (runtime.getSession(id) ? user.id : null),
        snapshotFor: async (id) => { const ws = workspaces.getWorkspace(runtime.getSession(id)?.workspaceId); return ws ? snapshotWorkspace(ws) : null },
        onStatus: (sessionId, status) => broadcast({ kind: 'persistence', sessionId, status }), ...autosaveOptions,
      }).attach()
      runtime.subscribe((event, snapshot) => broadcast({ kind: 'event', sessionId: event.sessionId, event, session: liteSession(snapshot) }))
      const hydrator = createSessionHydrator({ adapter: persistence, runtime, workspaces, hostId })
      const workspaceRepo = createWorkspaceRepository(persistence, { userId: user.id })
      // repositories this user opened on this host come back attached; others stay listed as "reconnect"
      await Promise.all((await workspaceRepo.list().catch(() => [])).map(r => restoreWorkspace(r, { workspaces, hostId }).catch(() => null)))
      return { user, runtime, workspaces, autosave, hydrator, hydrating, listeners, broadcast, settings, settingsRepo, workspaceRepo }
    })()
  }
  const ctxOf = (user) => {
    if (!contexts.has(user.id)) contexts.set(user.id, buildContext(user))
    return contexts.get(user.id)
  }

  const notFound = (what = 'session') => createError({ code: 'not_found', message: `That ${what} was not found.` })

  /** The live session, hydrating it from storage if needed. Unknown ids — including other users' — are "not found". */
  async function requireSession(ctx, id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(id) || id === '.' || id === '..') throw notFound()
    const live = ctx.runtime.getSession(id)
    if (live) return live
    // concurrent requests for the same stored session (transcript, workspace state, …) share one hydration
    if (!ctx.hydrating.has(id)) {
      ctx.hydrating.set(id, (async () => {
        const t0 = Date.now()
        const h = await ctx.hydrator.hydrate(ctx.user.id, id).catch((e) => {
          if (e?.code === 'persistence_invalid_record') metrics.invalidRecords += 1
          if (e?.code === 'persistence_schema_unsupported') metrics.schemaUnsupported += 1
          throw e
        })
        if (!h) return null
        const ms = Date.now() - t0
        metrics.hydrations += 1; metrics.hydrationMsTotal += ms; metrics.hydrationMsMax = Math.max(metrics.hydrationMsMax, ms)
        if (h.record) ctx.autosave.adopt(id, { revision: h.record.revision, snapshot: h.record.workspaceSnapshot ?? null, title: h.record.title })
        return ctx.runtime.getSession(id)
      })().finally(() => ctx.hydrating.delete(id)))
    }
    const session = await ctx.hydrating.get(id)
    if (!session) throw notFound()
    return session
  }

  const workspaceInfo = (w) => ({ id: w.id, name: w.repository?.name ?? w.name ?? 'Repository', available: true, repository: w.repository, kind: w.kind })

  async function listWorkspaces(ctx) {
    const live = ctx.runtime.listWorkspaces().map(workspaceInfo)
    const liveIds = new Set(live.map(w => w.id))
    const persisted = (await ctx.workspaceRepo.list().catch(() => [])).filter(w => !liveIds.has(w.id))
      .map(w => ({ id: w.id, name: w.name, available: false, repository: w.repository, kind: w.kind, needsReconnect: true }))
    return [...live, ...persisted]
  }

  const service = {
    hostId,

    async bootstrap(user) {
      const ctx = await ctxOf(user)
      return {
        user, hostId, providers: credentials.describe(user), settings: ctx.settings, permissionMode: ctx.runtime.getPermissionMode(),
        workspaces: await listWorkspaces(ctx), canOpenWorkspaces: true, sessions: await service.listSessions(user, {}),
      }
    },

    providers: (user) => credentials.describe(user),
    async checkModel(user, model) { return (await ctxOf(user)).runtime.checkModel(model) },

    async listSessions(user, { cursor = null, limit = 50 } = {}) {
      const ctx = await ctxOf(user)
      const page = await persistence.listSessions(user.id, { cursor, limit })
      const items = new Map(page.items.map(i => [i.id, i]))
      for (const s of ctx.runtime.listSessions()) { // live state wins, and includes sessions not yet written
        if (!s.messages.some(m => m.role === 'user')) continue
        if (!cursor || items.has(s.id)) items.set(s.id, indexFromLive(s, user.id, ctx.autosave.status(s.id)))
      }
      return { items: [...items.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt), nextCursor: page.nextCursor }
    },

    async createSession(user, { workspaceId = null, model, id } = {}) {
      const ctx = await ctxOf(user)
      if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(id) || ctx.runtime.getSession(id) || await persistence.loadSession(user.id, id).catch(() => null))) {
        throw createError({ code: 'invalid_request', message: 'That session id is not available.' })
      }
      if (workspaceId && !ctx.workspaces.getWorkspace(workspaceId)) throw createError({ code: 'workspace_not_found', message: 'That repository is not connected.' })
      const credential = { model: credentials.describe(user).find(p => p.provider === 'deepseek')?.model ?? '' }
      const chosen = model?.model ? model : { provider: 'deepseek', model: ctx.settings.model || credential.model || config.defaultModel || '' }
      const s = ctx.runtime.startSession({ workspaceId, model: chosen, id })
      return { session: service.snapshot(s), persistence: 'unsaved' }
    },

    /** Full client snapshot of one session (the client rebuilds the transcript from events). */
    snapshot: (s) => ({ ...liteSession(s), events: s.events }),

    async getSession(user, id) {
      const ctx = await ctxOf(user)
      const s = await requireSession(ctx, id)
      const workspace = s.workspaceId ? (ctx.workspaces.getWorkspace(s.workspaceId) ? 'ok' : 'unavailable') : 'none'
      return { session: service.snapshot(s), commands: ctx.runtime.listCommands(id), workspace, persistence: ctx.autosave.status(id), pendingPermissions: ctx.runtime.getPendingPermissions(id) }
    },

    async sendMessage(user, id, content) {
      const ctx = await ctxOf(user)
      const s = await requireSession(ctx, id)
      if (typeof content !== 'string' || !content.trim()) throw createError({ code: 'invalid_request', message: 'Write a message first.' })
      if (!SENDABLE.has(s.status)) throw createError({ code: 'session_busy', message: `Session is ${s.status}; wait for it to finish or stop it.` })
      ctx.runtime.sendMessage(id, content).catch(e => log.warn('run failed to start', { sessionId: id, code: isBluswanError(e) ? e.code : 'error' }))
      return { accepted: true }
    },

    async cancel(user, id) { const ctx = await ctxOf(user); await requireSession(ctx, id); return { cancelled: ctx.runtime.cancelSession(id) !== false } },
    async approve(user, id, permissionId) { const ctx = await ctxOf(user); await requireSession(ctx, id); return { ok: ctx.runtime.approvePermission(id, permissionId) } },
    async deny(user, id, permissionId) { const ctx = await ctxOf(user); await requireSession(ctx, id); return { ok: ctx.runtime.denyPermission(id, permissionId) } },

    async deleteSession(user, id) {
      const ctx = await ctxOf(user)
      if (typeof id !== 'string' || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(id)) throw notFound()
      const live = !!ctx.runtime.getSession(id)
      if (live) await ctx.runtime.deleteSession(id) // refuses while running
      const removed = await ctx.autosave.remove(id)
      const stored = await persistence.deleteSession(user.id, id)
      if (!live && !removed && !stored) throw notFound()
      return { deleted: true }
    },

    async getSettings(user) { return { ...(await ctxOf(user)).settings, permissionMode: (await ctxOf(user)).runtime.getPermissionMode() } },
    async saveSettings(user, patch) {
      const ctx = await ctxOf(user)
      const next = { ...ctx.settings, ...(patch.model !== undefined ? { model: String(patch.model) } : {}), ...(isPermissionMode(patch.permissionMode) ? { permissionMode: patch.permissionMode } : {}) }
      if (isPermissionMode(patch.permissionMode)) ctx.runtime.setPermissionMode(patch.permissionMode)
      await ctx.settingsRepo.save(next)
      ctx.settings = await ctx.settingsRepo.load()
      return ctx.settings
    },

    // ─── workspaces ──────────────────────────────────────────────────────────
    async listWorkspaces(user) { return listWorkspaces(await ctxOf(user)) },
    async openWorkspace(user, { root } = {}) {
      const ctx = await ctxOf(user)
      if (typeof root !== 'string' || !root.trim()) throw createError({ code: 'invalid_request', message: 'Enter the path of a repository.' })
      let ws
      try { ws = await ctx.workspaces.openWorkspace({ root }) } catch (e) {
        throw createError({ code: e?.code === 'path_outside_workspace' ? 'forbidden' : 'workspace_not_found', message: e?.code === 'path_outside_workspace' ? 'That folder is outside the locations this server may open.' : 'That folder could not be opened.' })
      }
      const previous = await ctx.workspaceRepo.get(ws.id)
      await ctx.workspaceRepo.save(toWorkspaceRecord({ userId: user.id, workspace: ws, hostId, previous }))
      return workspaceInfo({ id: ws.id, ...ws.metadata })
    },
    async reconnectWorkspace(user, id, { root } = {}) {
      const ctx = await ctxOf(user)
      const record = await ctx.workspaceRepo.get(id)
      if (!record) throw notFound('repository')
      if (ctx.workspaces.getWorkspace(id)) return workspaceInfo({ id, ...ctx.workspaces.getWorkspace(id).metadata })
      let ws
      try { ws = await ctx.workspaces.createWorkspace({ root, id, kind: record.kind ?? 'local' }) } catch (e) {
        throw createError({ code: e?.code === 'path_outside_workspace' ? 'forbidden' : 'workspace_not_found', message: 'That folder could not be opened.' })
      }
      await ctx.workspaceRepo.save(toWorkspaceRecord({ userId: user.id, workspace: ws, hostId, previous: record }))
      for (const s of ctx.runtime.listSessions()) if (s.workspaceId === id) ctx.runtime.reconcileSession(s.id, { workspaceChanged: true })
      return workspaceInfo({ id, ...ws.metadata })
    },

    async workspaceState(user, id) { const ctx = await ctxOf(user); await requireSession(ctx, id); return ctx.runtime.getWorkspaceState(id) },
    async fileDiff(user, id, path, from) { const ctx = await ctxOf(user); await requireSession(ctx, id); return ctx.runtime.getFileDiff(id, path, { from }) },
    async revertFile(user, id, path) { const ctx = await ctxOf(user); await requireSession(ctx, id); return ctx.runtime.revertFile(id, path) },
    async commands(user, id) { const ctx = await ctxOf(user); await requireSession(ctx, id); return ctx.runtime.listCommands(id) },
    async command(user, id, commandId) {
      const ctx = await ctxOf(user); await requireSession(ctx, id)
      const c = ctx.runtime.getCommand(id, commandId)
      if (!c) throw notFound('command')
      return c
    },

    // ─── streaming ───────────────────────────────────────────────────────────
    /** @returns {Promise<()=>void>} unsubscribe */
    async subscribe(user, listener) {
      const ctx = await ctxOf(user)
      ctx.listeners.add(listener)
      return () => ctx.listeners.delete(listener)
    },

    persistenceMetrics: async (user) => ({ ...(await ctxOf(user)).autosave.metrics(), ...metrics, hydrationMsAvg: metrics.hydrations ? Math.round(metrics.hydrationMsTotal / metrics.hydrations) : 0 }),
    async flush(user) { if (contexts.has(user.id)) await (await ctxOf(user)).autosave.flush() },

    /** Sign-out: stop streams and drop the in-memory runtime. Stored sessions are kept. */
    async dispose(user) {
      if (!contexts.has(user.id)) return
      const ctx = await ctxOf(user)
      for (const s of ctx.runtime.listSessions()) if (s.status === 'running' || s.status === 'waiting_permission') ctx.runtime.cancelSession(s.id)
      await ctx.autosave.flush().catch(() => {})
      ctx.autosave.detach(); ctx.listeners.clear()
      for (const w of ctx.runtime.listWorkspaces()) await ctx.workspaces.closeWorkspace(w.id).catch(() => {})
      contexts.delete(user.id)
    },
  }
  return service
}
