// Workspace backed by a real local directory. Node-only.
import fs from 'node:fs/promises'
import path from 'node:path'
import { WorkspaceError } from './errors.js'
import { normalizeRelativePath, resolveInWorkspace } from './pathSafety.js'
import { createFileIndex, DEFAULT_IGNORE } from './fileIndex.js'
import { createFileOps } from './fileOps.js'
import { searchPaths, grepFiles } from './search.js'
import { applyPatchAtomically } from './patchApply.js'
import { createGit } from './git.js'
import { runShell, buildShellEnv } from './shell.js'
import { detectRepository } from './repository.js'
import { resolveLimits } from '../config/runtimeConfig.js'
import { newId } from '../protocol/schemas.js'

/**
 * @param {{root:string, id?:string, name?:string, limits?:object, ignore?:string[]}} options
 */
export async function createLocalWorkspace({ root, id = `ws_${newId()}`, name, limits: limitOverrides, ignore = DEFAULT_IGNORE } = {}) {
  if (typeof root !== 'string' || root === '') throw new WorkspaceError('invalid_input', 'Workspace root is required')
  let rootReal
  try {
    rootReal = await fs.realpath(path.resolve(root))
    if (!(await fs.stat(rootReal)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new WorkspaceError('workspace_not_found', `Workspace root does not exist or is not a directory: ${root}`)
  }

  const limits = resolveLimits(limitOverrides)
  const resolve = (rel, opts) => resolveInWorkspace(rootReal, rel, opts)
  const index = createFileIndex({ root: rootReal, ignore, maxFiles: limits.maxIndexedFiles })
  const files = createFileOps({ resolve, limits, index })
  const git = createGit({ root: rootReal, rootReal, limits })

  const repository = await detectRepository({ root: rootReal, git, name })
  const initialStatus = repository.isGitRepository ? await git.status().catch(() => null) : null
  const metadata = Object.freeze({
    kind: 'local',
    name: repository.name,
    openedAt: Date.now(),
    repository,
    baseline: Object.freeze({ branch: repository.branch, headSha: repository.headSha, initialStatus }),
    limits,
  })

  return {
    id,
    root: rootReal,
    metadata,

    ...files,

    async searchFiles(query, { path: scope = '', limit } = {}) {
      const rel = normalizeRelativePath(scope)
      return searchPaths(await index.files(), query, {
        scope: rel, limit: Math.min(limit ?? limits.maxSearchResults, limits.maxSearchResults),
      })
    },

    async grep(pattern, { path: scope = '', regex = false, caseSensitive = false, limit } = {}) {
      const rel = normalizeRelativePath(scope)
      return grepFiles({
        root: rootReal, files: await index.files(), pattern, scope: rel, regex, caseSensitive,
        limit: Math.min(limit ?? limits.maxGrepResults, limits.maxGrepResults), limits,
      })
    },

    /** Indexed regular files (generated directories excluded), optionally under `path`. */
    async listFiles({ path: scope = '' } = {}) {
      const rel = normalizeRelativePath(scope)
      const snap = await index.snapshot()
      const files = rel === '' ? snap.files : snap.files.filter(f => f === rel || f.startsWith(`${rel}/`))
      return { files, truncated: snap.truncated }
    },

    async applyPatch(patch) {
      try {
        return await applyPatchAtomically({ patch, resolve, limits })
      } finally {
        index.invalidate()
      }
    },

    async runCommand(command, { timeoutMs, env, signal, cwd = '' } = {}) {
      if (typeof command !== 'string' || command.trim() === '') throw new WorkspaceError('invalid_input', 'command must not be empty')
      const relCwd = normalizeRelativePath(cwd)
      const absCwd = await resolve(relCwd)
      const timeout = Math.min(timeoutMs ?? limits.defaultShellTimeoutMs, limits.maxShellTimeoutMs)
      try {
        return await runShell({
          command, cwd: absCwd, timeoutMs: timeout, signal,
          env: buildShellEnv(env), maxOutputBytes: limits.maxShellOutputBytes,
        })
      } finally {
        index.invalidate() // commands may create or remove files
      }
    },

    gitStatus: () => git.status(),
    gitDiff: async opts => git.diff({ ...opts, path: opts?.path ? normalizeRelativePath(opts.path) : '' }),

    /** Fresh repository metadata (branch/HEAD may change while the workspace is open). */
    refreshRepository: () => detectRepository({ root: rootReal, git, name }),
    /** Cached file tree used by search; exposed for repository-awareness consumers. */
    fileTree: () => index.snapshot(),

    async close() { index.invalidate() },
  }
}
