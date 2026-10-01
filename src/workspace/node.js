// Node-only wiring: a workspace manager that can open local directories.
import { createWorkspaceManager } from './workspaceManager.js'
import { createLocalWorkspace } from './localWorkspace.js'

export function createNodeWorkspaceManager(options = {}) {
  return createWorkspaceManager({ ...options, factories: { local: createLocalWorkspace, ...options.factories } })
}
