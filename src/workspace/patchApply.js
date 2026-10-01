// Atomic multi-file patch application against a directory tree.
// Everything is computed in memory first; writes are rolled back on failure.
import fs from 'node:fs/promises'
import path from 'node:path'
import { WorkspaceError } from './errors.js'
import { parsePatch, applyFilePatch } from './patch.js'
import { normalizeRelativePath, assertMutablePath } from './pathSafety.js'

async function lstatOrNull(abs) {
  try { return await fs.lstat(abs) } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
    throw e
  }
}

async function plan(file, resolve, limits) {
  const rel = normalizeRelativePath(file.path, { allowRoot: false })
  assertMutablePath(rel)
  const abs = await resolve(rel)
  const st = await lstatOrNull(abs)
  if (file.op === 'create') {
    if (st) throw new WorkspaceError('already_exists', `Cannot create ${rel}: file already exists`)
    return { rel, abs, op: 'create', before: null, after: applyFilePatch('', file) }
  }
  if (!st) throw new WorkspaceError('file_not_found', `File not found: ${rel}`)
  if (!st.isFile()) throw new WorkspaceError('not_a_file', `Not a regular file: ${rel}`)
  if (st.size > limits.maxFileBytes) throw new WorkspaceError('output_limit_exceeded', `File too large to patch: ${rel}`)
  const before = await fs.readFile(abs)
  if (before.subarray(0, 8000).includes(0)) throw new WorkspaceError('binary_file', `Cannot patch binary file: ${rel}`)
  const after = applyFilePatch(before.toString('utf8'), file)
  return { rel, abs, op: file.op, mode: st.mode, before, after: file.op === 'delete' ? null : after }
}

async function write(step) {
  if (step.op === 'delete') { await fs.unlink(step.abs); return }
  if (step.op === 'create') step.createdDir = await fs.mkdir(path.dirname(step.abs), { recursive: true })
  await fs.writeFile(step.abs, step.after)
}

async function rollback(done) {
  for (const step of [...done].reverse()) {
    try {
      if (step.op === 'create') {
        await fs.rm(step.abs, { force: true })
        if (step.createdDir) await fs.rm(step.createdDir, { recursive: true, force: true }).catch(() => {})
      } else {
        await fs.writeFile(step.abs, step.before, { mode: step.mode })
      }
    } catch { /* best effort; the original failure is reported */ }
  }
}

/**
 * @param {{patch:string, resolve:(rel:string)=>Promise<string>, limits:object}} args
 * @returns {Promise<{changedFiles:string[], appliedHunks:number, files:{path:string,change:string}[]}>}
 */
export async function applyPatchAtomically({ patch, resolve, limits }) {
  if (typeof patch === 'string' && Buffer.byteLength(patch) > limits.maxPatchBytes) {
    throw new WorkspaceError('output_limit_exceeded', `Patch exceeds ${limits.maxPatchBytes} bytes`)
  }
  const parsed = parsePatch(patch)
  const steps = []
  for (const file of parsed.files) steps.push(await plan(file, resolve, limits))

  const done = []
  try {
    for (const step of steps) {
      await write(step)
      done.push(step)
    }
  } catch (e) {
    await rollback([...done, ...steps.filter(s => !done.includes(s) && s.createdDir !== undefined)])
    throw new WorkspaceError('patch_apply_failed', `Patch write failed and was rolled back: ${e.message}`, { cause: e })
  }
  const change = op => (op === 'create' ? 'created' : op === 'delete' ? 'deleted' : 'modified')
  return {
    changedFiles: steps.map(s => s.rel),
    appliedHunks: parsed.hunkCount,
    files: steps.map(s => ({ path: s.rel, change: change(s.op) })),
  }
}
