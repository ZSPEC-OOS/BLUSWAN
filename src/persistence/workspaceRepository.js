// Workspace identity persisted per user. A local folder is remembered as a reference bound to the host that
// owns it: an absolute path is only meaningful on that machine, so it is never offered on another host.
import { assertAdapter } from './persistence.js'

export function toWorkspaceRecord({ userId, workspace, hostId, now = Date.now(), previous = null }) {
  const repo = workspace.metadata?.repository ?? {}
  return {
    id: workspace.id, userId, kind: workspace.metadata?.kind ?? 'local', name: repo.name ?? workspace.metadata?.name ?? 'Repository',
    rootReference: { type: 'host-path', hostId, path: workspace.root },
    repository: { name: repo.name ?? null, branch: repo.branch ?? null, isGitRepository: !!repo.isGitRepository },
    baselineCommit: previous?.baselineCommit ?? repo.headSha ?? null,
    lastKnownHead: repo.headSha ?? null,
    createdAt: previous?.createdAt ?? now, updatedAt: now,
  }
}

export function createWorkspaceRepository(adapter, { userId }) {
  assertAdapter(adapter)
  return {
    save: (record) => adapter.saveWorkspace(userId, record),
    get: (id) => adapter.loadWorkspace(userId, id),
    list: () => adapter.listWorkspaces(userId),
    remove: (id) => adapter.deleteWorkspace(userId, id),
  }
}
