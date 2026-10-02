// Turns a persisted record back into a live, runtime-safe session:
// load → migrate/validate → normalize stale active states → re-attach the workspace → reconcile with reality.
import { toRuntimeSession } from '../persistence/serializer.js'
import { createSessionRepository } from '../persistence/sessionRepository.js'
import { createWorkspaceRepository } from '../persistence/workspaceRepository.js'
import { restoreWorkspace, compareWithSnapshot } from '../workspace/workspaceRestore.js'

/**
 * @param {{adapter:object, runtime:object, workspaces?:object|null, hostId:string, now?:()=>number}} deps
 */
export function createSessionHydrator({ adapter, runtime, workspaces = null, hostId, now = () => Date.now() }) {
  /**
   * @returns {Promise<{session:object, record:object, workspace:{status:string,reason?:string}, drift:object|null, interrupted:boolean}|null>}
   *          null when the user has no such session. Throws normalized persistence_* errors for corrupt records.
   */
  async function hydrate(userId, sessionId) {
    const live = runtime.getSession(sessionId)
    if (live) return { session: live, record: null, workspace: { status: 'restored' }, drift: null, interrupted: live.status === 'interrupted' }

    const sessionsRepo = createSessionRepository(adapter, { userId })
    const record = await sessionsRepo.getSessionRecord(sessionId)
    if (!record) return null
    const session = toRuntimeSession(record)
    const interrupted = session.status === 'running' || session.status === 'waiting_permission'

    // workspace association → live workspace (or an explicit reason it is unavailable)
    let ws = { status: 'none', workspace: null }
    let drift = null
    let changedFiles = session.changedFiles
    let workspaceChanged = false
    let changedPaths = []
    if (record.workspaceId) {
      const wsRecord = await createWorkspaceRepository(adapter, { userId }).get(record.workspaceId)
      ws = await restoreWorkspace(wsRecord ?? { id: record.workspaceId, rootReference: null }, { workspaces, hostId })
      if (ws.workspace) {
        const cmp = await compareWithSnapshot(record.workspaceSnapshot, ws.workspace)
        drift = cmp
        workspaceChanged = cmp.changed
        changedPaths = cmp.paths
        if (cmp.current.isGitRepository) { // git wins: keep only files that are still actually changed
          const still = new Set(cmp.current.files.map(f => f.path))
          changedFiles = session.changedFiles.filter(f => still.has(f.path))
        }
      } else {
        workspaceChanged = true // cannot verify: earlier evidence is not proof of anything
      }
    }

    const note = {
      workspace: ws.status === 'restored' || ws.status === 'none' ? 'ok' : ws.status,
      ...(ws.reason ? { workspaceReason: ws.reason } : {}),
      ...(drift?.branchChanged ? { branchChanged: drift.branch } : {}),
      ...(drift?.headChanged ? { headChanged: true } : {}),
      ...(drift?.known && drift.changed ? { workspaceChanged: true } : {}),
    }
    const interesting = note.workspace !== 'ok' || note.branchChanged || note.headChanged || note.workspaceChanged
    const restored = runtime.restoreSession({ session, commands: record.commands }, { note: interesting ? note : null }) // viewing a session must not reorder the list
    runtime.reconcileSession(sessionId, { changedFiles, workspaceChanged, changedPaths })
    return { session: runtime.getSession(sessionId) ?? restored, record, workspace: { status: ws.status, reason: ws.reason }, drift, interrupted, at: now() }
  }
  return { hydrate }
}
