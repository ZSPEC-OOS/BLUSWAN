// Re-attaching a persisted workspace reference to a live workspace, and describing how the repository has
// moved since the session last saw it. Reality wins: persisted git status is never trusted.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'

/** Stable fingerprint of "which commit, which uncommitted files in which state". */
export function fingerprintOf({ headSha, files }) {
  const body = JSON.stringify({ h: headSha ?? null, f: files.map(f => `${f.status}:${f.path}`).sort() })
  return crypto.createHash('sha1').update(body).digest('hex')
}

/** Current repository state of an open workspace, as stored with the session on every run boundary. */
export async function snapshotWorkspace(workspace) {
  const repo = await workspace.refreshRepository().catch(() => workspace.metadata.repository)
  if (!repo?.isGitRepository || !workspace.gitChanges) {
    return { isGitRepository: false, branch: null, headSha: null, files: [], fingerprint: null, takenAt: Date.now() }
  }
  try {
    const ch = await workspace.gitChanges()
    const files = ch.files.map(f => ({ path: f.path, status: f.status }))
    return { isGitRepository: true, branch: ch.branch, headSha: ch.headSha, files, fingerprint: fingerprintOf({ headSha: ch.headSha, files }), takenAt: Date.now() }
  } catch {
    return { isGitRepository: true, branch: repo.branch ?? null, headSha: repo.headSha ?? null, files: [], fingerprint: null, takenAt: Date.now() }
  }
}

/**
 * @param {object|null} record persisted workspace record
 * @param {{workspaces:object, hostId:string}} deps
 * @returns {Promise<{status:'restored'|'unavailable'|'needs_reconnect'|'none', workspace:object|null, reason?:string}>}
 */
export async function restoreWorkspace(record, { workspaces, hostId }) {
  if (!record) return { status: 'none', workspace: null }
  const live = workspaces?.getWorkspace(record.id)
  if (live) return { status: 'restored', workspace: live }
  const ref = record.rootReference
  if (!workspaces || ref?.type !== 'host-path' || ref.hostId !== hostId) {
    return { status: 'needs_reconnect', workspace: null, reason: 'This repository lives on a different machine.' }
  }
  try {
    if (!(await fs.stat(ref.path)).isDirectory()) throw new Error('not a directory')
    const workspace = await workspaces.createWorkspace({ root: ref.path, id: record.id, kind: record.kind ?? 'local' })
    return { status: 'restored', workspace }
  } catch (e) {
    return { status: 'unavailable', workspace: null, reason: e?.code === 'ENOENT' || /not a directory/.test(e?.message) ? 'The repository folder no longer exists.' : 'The repository could not be opened.' }
  }
}

/**
 * Compares what the session last knew with what the workspace is now.
 * @returns {{changed:boolean, branchChanged:boolean, headChanged:boolean, branch:{from,to}, head:{from,to}, paths:string[], current:object}}
 */
export async function compareWithSnapshot(previous, workspace) {
  const current = await snapshotWorkspace(workspace)
  if (!previous || previous.fingerprint == null || current.fingerprint == null) {
    return { changed: true, known: false, branchChanged: false, headChanged: false, branch: { from: previous?.branch ?? null, to: current.branch }, head: { from: previous?.headSha ?? null, to: current.headSha }, paths: current.files.map(f => f.path), current }
  }
  const before = new Map((previous.files ?? []).map(f => [f.path, f.status]))
  const after = new Map(current.files.map(f => [f.path, f.status]))
  const paths = [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p))
  return {
    changed: previous.fingerprint !== current.fingerprint, known: true,
    branchChanged: previous.branch !== current.branch, headChanged: previous.headSha !== current.headSha,
    branch: { from: previous.branch, to: current.branch }, head: { from: previous.headSha, to: current.headSha }, paths, current,
  }
}
