// Git access through the local `git` executable (no shell, argv only).
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { WorkspaceError } from './errors.js'
import { summarizeDiff } from './diff.js'

const GIT_TIMEOUT_MS = 30_000
const MAX_UNTRACKED_DIFFS = 200

/** Environment for git subprocesses: inherited env minus repository-redirecting variables. */
export function sanitizedEnv(extra = {}) {
  const env = { ...process.env, ...extra, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[k]
  return env
}

function runGit(cwd, args, { okCodes = [0], maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['--literal-pathspecs', '-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      { cwd, env: sanitizedEnv(), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr })
        if (err.code === 'ENOENT') return reject(new WorkspaceError('git_error', 'git executable not found'))
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return reject(new WorkspaceError('output_limit_exceeded', 'git output exceeded the buffer limit'))
        }
        if (typeof err.code === 'number' && okCodes.includes(err.code)) return resolve({ code: err.code, stdout, stderr })
        const message = (stderr || err.message || '').trim().slice(0, 500)
        const code = /not a git repository/i.test(message) ? 'git_not_repository' : 'git_error'
        reject(new WorkspaceError(code, `git ${args[0]} failed: ${message}`))
      })
  })
}

function truncateAtLine(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  let cut = Buffer.from(text).subarray(0, maxBytes).toString('utf8')
  const nl = cut.lastIndexOf('\n')
  if (nl > 0) cut = cut.slice(0, nl + 1)
  return { text: cut, truncated: true }
}

export function parseStatusPorcelain(raw) {
  const tokens = raw.split('\0')
  const result = { staged: [], modified: [], deleted: [], untracked: [], conflicted: [], renamed: [], entries: [] }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.length < 4) continue
    const x = t[0]
    const y = t[1]
    const file = t.slice(3)
    if (x === 'R' || x === 'C') {
      result.renamed.push({ from: tokens[i + 1], to: file })
      i++
    }
    result.entries.push({ path: file, index: x, worktree: y })
    if (x === '?' && y === '?') { result.untracked.push(file); continue }
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) { result.conflicted.push(file); continue }
    if (x !== ' ') result.staged.push(file)
    if (y === 'M' || y === 'T') result.modified.push(file)
    if (y === 'D') result.deleted.push(file)
  }
  return result
}

export function createGit({ root, rootReal = root, limits }) {
  const run = (args, opts) => runGit(root, args, opts)

  async function isRepository() {
    try {
      const { stdout } = await run(['rev-parse', '--show-toplevel'])
      return (await fs.realpath(stdout.trim())) === rootReal
    } catch (e) {
      if (e.code === 'git_not_repository' || e.code === 'git_error') return false
      throw e
    }
  }

  async function requireRepository() {
    if (!(await isRepository())) {
      throw new WorkspaceError('git_not_repository', 'Workspace root is not the top level of a git repository')
    }
  }

  async function info() {
    if (!(await isRepository())) return { isGitRepository: false, branch: null, headSha: null }
    const branchRes = await run(['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [0, 1] })
    const headRes = await run(['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] })
    return {
      isGitRepository: true,
      branch: branchRes.code === 0 ? branchRes.stdout.trim() : 'HEAD',
      headSha: headRes.code === 0 ? headRes.stdout.trim() : null,
    }
  }

  async function status() {
    await requireRepository()
    const [{ branch, headSha }, res] = await Promise.all([
      info(), run(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ])
    const parsed = parseStatusPorcelain(res.stdout)
    return { branch, headSha, clean: parsed.entries.length === 0, ...parsed }
  }

  /** Untracked files are included in unstaged diffs (as additions) so the diff reflects the full working tree. */
  async function diff({ path: rel = '', staged = false, includeUntracked = true } = {}) {
    await requireRepository()
    const pathArgs = rel ? ['--', rel] : []
    const base = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']
    let text = (await run([...base, ...(staged ? ['--cached'] : []), ...pathArgs])).stdout

    if (!staged && includeUntracked) {
      const { untracked } = parseStatusPorcelain(
        (await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...pathArgs])).stdout)
      for (const file of untracked.slice(0, MAX_UNTRACKED_DIFFS)) {
        if (Buffer.byteLength(text) > limits.maxDiffBytes * 2) break
        const res = await run([...base, '--no-index', '--', '/dev/null', file], { okCodes: [0, 1] })
        text += res.stdout
      }
    }
    const summary = summarizeDiff(text)
    const cut = truncateAtLine(text, limits.maxDiffBytes)
    return {
      diff: cut.text, truncated: cut.truncated, staged,
      files: summary.files, additions: summary.additions, deletions: summary.deletions,
    }
  }

  return { isRepository, info, status, diff, run }
}
