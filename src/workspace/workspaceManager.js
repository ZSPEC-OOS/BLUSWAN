// Registry of open workspaces. Environment-agnostic: concrete workspace kinds
// are injected as factories, so this module (and the runtime that uses it)
// carries no Node dependencies. See ./node.js for the local-filesystem wiring.
import path from 'node:path'
import { WorkspaceError } from './errors.js'
import { assertWorkspace } from './workspace.js'
import { resolveLimits } from '../config/runtimeConfig.js'

/**
 * @param {{factories?:Record<string,(spec:object)=>Promise<object>>, allowedRoots?:string[]|null, limits?:object}} options
 *   `allowedRoots`: when set, workspaces may only be opened at or below these directories.
 */
export function createWorkspaceManager({ factories = {}, allowedRoots = null, limits } = {}) {
  const workspaces = new Map()
  const roots = allowedRoots ? allowedRoots.map(r => path.resolve(r)) : null

  function assertAllowed(root) {
    if (!roots) return
    const abs = path.resolve(root)
    if (!roots.some(r => abs === r || abs.startsWith(r.endsWith(path.sep) ? r : r + path.sep))) {
      throw new WorkspaceError('path_outside_workspace', `Workspace root is not within an allowed root: ${root}`)
    }
  }

  async function createWorkspace({ root, kind = 'local', id, name, ...rest } = {}) {
    const factory = factories[kind]
    if (!factory) throw new WorkspaceError('invalid_input', `Unsupported workspace kind: ${kind}`)
    assertAllowed(root)
    const ws = assertWorkspace(await factory({ root, id, name, limits: resolveLimits(limits), ...rest }))
    if (workspaces.has(ws.id)) {
      await ws.close()
      throw new WorkspaceError('already_exists', `Workspace already registered: ${ws.id}`)
    }
    workspaces.set(ws.id, ws)
    return ws
  }

  return {
    createWorkspace,

    /** Returns the registered workspace for this root (and kind), creating it if needed. */
    async openWorkspace(spec = {}) {
      const existing = [...workspaces.values()].find(w =>
        w.metadata.kind === (spec.kind ?? 'local') && w.root === path.resolve(spec.root ?? ''))
      return existing ?? createWorkspace(spec)
    },

    getWorkspace(id) { return workspaces.get(id) ?? null },

    listWorkspaces() {
      return [...workspaces.values()].map(w => ({ id: w.id, root: w.root, ...w.metadata }))
    },

    async closeWorkspace(id) {
      const ws = workspaces.get(id)
      if (!ws) return false
      workspaces.delete(id)
      await ws.close()
      return true
    },
  }
}
