// Autosave: observes the runtime's canonical events and writes each session through the persistence adapter.
//  • critical state (a user message, a completed assistant message / tool / validation, a file change, a run
//    boundary) is saved immediately;
//  • high-frequency events (tool.started, validation.started, reasoning status) are coalesced into one debounced save;
//  • text deltas are never a reason to write — a message is stored once, when it completes;
//  • a draft with no user message is not stored (no empty records from opening and closing chats);
//  • failures never reach the run: the session stays in memory, saves retry with bounded backoff and the status
//    is reported (saved / saving / failed / conflict) so the UI can say so honestly;
//  • writes carry the expected revision, so a stale writer is refused rather than overwriting newer data.
import { serializeSession } from '../persistence/serializer.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('autosave')

const IMMEDIATE = new Set([
  'user.message', 'assistant.text.completed', 'tool.completed', 'tool.failed', 'file.changed', 'file.reverted', 'validation.completed',
  'command.completed', 'permission.resolved', 'session.completed', 'session.failed', 'session.cancelled', 'session.interrupted',
  'context.compacted', 'completion.warning',
])
const IGNORED = new Set(['assistant.text.delta', 'command.output'])
const SNAPSHOT_ON = new Set(['validation.completed', 'session.completed', 'session.failed', 'session.cancelled', 'session.interrupted', 'file.reverted'])

/**
 * @param {{runtime:object, adapter:object, ownerOf:(sessionId:string)=>string|null,
 *          snapshotFor?:(sessionId:string)=>Promise<object|null>, debounceMs?:number, retry?:{attempts:number, baseMs:number},
 *          sleep?:(ms:number)=>Promise<void>, onStatus?:(sessionId:string, status:string)=>void, now?:()=>number}} options
 */
export function createSessionAutosave({
  runtime, adapter, ownerOf, snapshotFor = null, debounceMs = 800, retry = { attempts: 4, baseMs: 400 },
  sleep = (ms) => new Promise(r => setTimeout(r, ms)), onStatus = () => {}, now = () => Date.now(),
}) {
  const state = new Map() // sessionId → { revision, timer, saving, dirty, status, snapshot, needsSnapshot, titleOverride }
  const metrics = { saves: 0, failures: 0, conflicts: 0, retries: 0, totalLatencyMs: 0, maxLatencyMs: 0, lastError: null }
  let unsubscribe = null

  const entry = (id) => {
    let s = state.get(id)
    if (!s) { s = { revision: 0, timer: null, saving: null, dirty: false, status: 'unsaved', snapshot: null, needsSnapshot: false, title: null, stopped: false }; state.set(id, s) }
    return s
  }
  const setStatus = (id, s, status) => { if (s.status !== status) { s.status = status; try { onStatus(id, status) } catch { /* UI hook must not break saving */ } } }

  const hasUserMessage = (session) => session.messages.some(m => m.role === 'user')

  async function writeOnce(id, s) {
    const owner = ownerOf(id)
    const exported = runtime.exportSession(id)
    if (!owner || !exported || !hasUserMessage(exported.session)) return 'skipped'
    if (s.needsSnapshot && snapshotFor) {
      s.needsSnapshot = false
      try { s.snapshot = await snapshotFor(id) } catch { /* a missing snapshot only makes later reconciliation more conservative */ }
    }
    const record = serializeSession(exported.session, { userId: owner, commands: exported.commands, workspaceSnapshot: s.snapshot, revision: s.revision, title: s.title })
    const t0 = now()
    const saved = await adapter.saveSession(owner, record, { expectedRevision: s.revision })
    const ms = now() - t0
    metrics.saves += 1; metrics.totalLatencyMs += ms; metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, ms)
    s.revision = saved.revision
    return 'saved'
  }

  /** One logical save with bounded retries. Coalesces: events arriving during a save trigger exactly one follow-up. */
  function flushNow(id) {
    const s = entry(id)
    if (s.stopped) return Promise.resolve()
    clearTimeout(s.timer); s.timer = null
    if (s.saving) { s.dirty = true; return s.saving }
    s.dirty = false
    setStatus(id, s, 'saving')
    s.saving = (async () => {
      let lastError
      for (let attempt = 0; attempt < retry.attempts; attempt++) {
        try {
          const r = await writeOnce(id, s)
          setStatus(id, s, r === 'saved' ? 'saved' : s.status === 'saving' ? 'unsaved' : s.status)
          return
        } catch (e) {
          lastError = e
          if (e?.code === 'persistence_conflict') break // never retry into someone else's newer data
          metrics.retries += 1
          if (attempt < retry.attempts - 1) await sleep(retry.baseMs * 2 ** attempt)
        }
      }
      if (lastError?.code === 'persistence_conflict') { metrics.conflicts += 1; s.stopped = true; setStatus(id, s, 'conflict') }
      else { metrics.failures += 1; setStatus(id, s, 'failed') }
      metrics.lastError = lastError?.code ?? 'error'
      log.warn('session not saved', { sessionId: id, code: lastError?.code }) // never the content
    })().finally(() => {
      s.saving = null
      if (s.dirty && !s.stopped) { s.dirty = false; flushNow(id) }
    })
    return s.saving
  }

  function schedule(id) {
    const s = entry(id)
    if (s.stopped || s.timer) return
    s.timer = setTimeout(() => { s.timer = null; flushNow(id) }, debounceMs)
  }

  function onEvent(event) {
    const id = event.sessionId
    if (IGNORED.has(event.type) || !ownerOf(id)) return
    const s = entry(id)
    if (SNAPSHOT_ON.has(event.type)) s.needsSnapshot = true
    if (event.type === 'session.started') return // drafts are persisted once the first user message exists
    if (IMMEDIATE.has(event.type)) flushNow(id)
    else schedule(id)
  }

  return {
    attach() { if (!unsubscribe) unsubscribe = runtime.subscribe((event) => onEvent(event)); return this },
    detach() { unsubscribe?.(); unsubscribe = null; for (const s of state.values()) clearTimeout(s.timer) },
    /** Adopt a revision loaded elsewhere (hydration) so the next write is checked against it. */
    adopt(sessionId, { revision, snapshot = null, title = null }) { const s = entry(sessionId); s.revision = revision; s.snapshot = snapshot; s.title = title; s.status = 'saved'; s.stopped = false },
    setTitle(sessionId, title) { entry(sessionId).title = title; return flushNow(sessionId) },
    /** Resolves when pending writes for the session (or all sessions) are done. */
    async flush(sessionId = null) {
      const ids = () => (sessionId ? [sessionId] : [...state.keys()])
      for (let round = 0; round < 50; round++) { // events can keep arriving while a save is in flight: settle until quiet
        const busy = ids().filter(id => entry(id).timer || entry(id).dirty || entry(id).saving)
        if (!busy.length) return
        await Promise.all(busy.map(id => (entry(id).saving ?? flushNow(id))))
      }
    },
    /** Explicit retry after a failure or conflict-free pause. */
    retry: (sessionId) => { entry(sessionId).stopped = false; return flushNow(sessionId) },
    async remove(sessionId) {
      const s = entry(sessionId)
      clearTimeout(s.timer); s.stopped = true
      await s.saving
      const owner = ownerOf(sessionId)
      state.delete(sessionId)
      return owner ? adapter.deleteSession(owner, sessionId) : false // true when a stored record was removed
    },
    status: (sessionId) => state.get(sessionId)?.status ?? 'unsaved',
    revisionOf: (sessionId) => state.get(sessionId)?.revision ?? 0,
    metrics: () => ({ ...metrics, avgLatencyMs: metrics.saves ? Math.round(metrics.totalLatencyMs / metrics.saves) : 0 }),
  }
}
