// Dogfooding: BLUSWAN works on a copy of its own repository.
//
// The agent never touches the checkout it is launched from. It gets a disposable git worktree (detached HEAD under the
// OS temp directory) with a seeded defect committed on top of the current commit, so the agent's diff is exactly its
// own change. Afterwards the primary checkout's HEAD, branches and working tree are verified unchanged. Nothing here
// pushes, fetches or touches a remote.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createAgentRuntime } from '../agent/runtime.js'
import { createNodeWorkspaceManager } from '../workspace/node.js'
import { sanitizedEnv } from '../workspace/git.js'
import { getRuntimeConfig } from '../config/runtimeConfig.js'

const call = (id, name, input) => ({ id, name, input })
const SEED_TEST = 'src/client/runtime/connection.test.mjs'

/** Tasks that seed a real defect into BLUSWAN's own source and ask the agent to repair it. */
export const DOGFOOD_TASKS = Object.freeze([
  {
    id: 'fix-backoff-schedule',
    title: "Repair a seeded defect in BLUSWAN's reconnect backoff",
    seed: { file: 'src/client/runtime/connectivity.js', from: 'schedule[Math.min(attempt, schedule.length - 1)]', to: 'schedule[Math.min(attempt + 1, schedule.length - 1)]' },
    prompt: `The reconnect backoff in this repository is wrong: the first retry waits 1 second instead of 0.5 seconds, and every later delay is one step too long. The test "backoff follows 0.5, 1, 2, 4, 8, 15 seconds" in ${SEED_TEST} fails. Find the defect (it is in src/client/runtime/), fix it with a minimal change, and re-run \`node --test ${SEED_TEST}\` to confirm everything passes. Do not edit the tests.`,
    expectedFiles: ['src/client/runtime/connectivity.js'],
    check: async (ws) => (await ws.runCommand(`node --test ${SEED_TEST}`)).exitCode === 0,
    reference: () => [
      { calls: [call('d1', 'grep', { pattern: 'backoffDelay', path: 'src/client/runtime' })] },
      { calls: [call('d2', 'read_file', { path: 'src/client/runtime/connectivity.js' })] },
      { calls: [call('d3', 'apply_patch', { patch: `--- a/src/client/runtime/connectivity.js\n+++ b/src/client/runtime/connectivity.js\n@@ -1,0 +1,0 @@\n` })] }, // replaced at run time with a patch built from the file's real line
      { text: 'Corrected the backoff index.' },
      { calls: [call('d4', 'shell', { command: `node --test ${SEED_TEST}` })] },
      { text: 'backoffDelay now indexes the schedule by attempt; the connection tests pass.' },
    ],
  },
])

export const dogfoodTaskById = (id) => DOGFOOD_TASKS.find(t => t.id === id) ?? null

const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: sanitizedEnv(), stdio: 'pipe' }).toString()

/** What "the primary checkout is untouched" means: same HEAD, same branches, same working-tree status. */
export function checkoutState(repoRoot) {
  return { head: git(repoRoot, 'rev-parse', 'HEAD').trim(), branches: git(repoRoot, 'branch', '--format=%(refname)').trim(), status: git(repoRoot, 'status', '--porcelain').trim() }
}

/**
 * Creates a disposable worktree of `repoRoot` with the task's defect committed. Returns { root, cleanup }.
 * Refuses to run anywhere inside the primary checkout.
 */
export async function createDogfoodWorktree({ repoRoot, task, base = os.tmpdir() }) {
  const primary = await fs.realpath(repoRoot)
  const parent = await fs.realpath(await fs.mkdtemp(path.join(base, 'bluswan-dogfood-')))
  if (parent === primary || parent.startsWith(primary + path.sep)) { await fs.rm(parent, { recursive: true, force: true }); throw new Error('The dogfood worktree must live outside the primary checkout.') }
  const root = path.join(parent, 'repo')
  git(primary, 'worktree', 'add', '--detach', root, 'HEAD')
  git(root, 'config', 'user.email', 'dogfood@example.invalid'); git(root, 'config', 'user.name', 'BLUSWAN dogfood'); git(root, 'config', 'commit.gpgsign', 'false')
  // No node_modules and no .env: the worktree holds only tracked files, so no provider key can reach it and the
  // primary checkout's ignore rules and dependencies are not shared. (The seeded task needs only `node --test`.)
  const cleanup = async () => {
    try { git(primary, 'worktree', 'remove', '--force', root) } catch { /* already gone */ }
    git(primary, 'worktree', 'prune')
    await fs.rm(parent, { recursive: true, force: true })
  }
  try {
    if (task.seed) {
      const file = path.join(root, task.seed.file)
      const text = await fs.readFile(file, 'utf8')
      if (!text.includes(task.seed.from)) throw new Error(`Cannot seed ${task.id}: expected text not found in ${task.seed.file}`)
      await fs.writeFile(file, text.replace(task.seed.from, task.seed.to))
      git(root, 'add', task.seed.file); git(root, 'commit', '-q', '-m', `dogfood: seed defect for ${task.id}`)
    }
  } catch (e) { await cleanup(); throw e }
  return { root, parent, cleanup }
}

/** The scripted reference needs the real seeded line to build its patch. */
async function scriptedTurns(task, worktreeRoot) {
  const turns = task.reference()
  const { file, from, to } = task.seed
  const lines = (await fs.readFile(path.join(worktreeRoot, file), 'utf8')).split('\n')
  const i = lines.findIndex(l => l.includes(to))
  const patch = `--- a/${file}\n+++ b/${file}\n@@ -${i + 1},1 +${i + 1},1 @@\n-${lines[i]}\n+${lines[i].replace(to, from)}\n`
  return turns.map(t => (t.calls?.[0]?.name === 'apply_patch' ? { calls: [call(t.calls[0].id, 'apply_patch', { patch })] } : t))
}
export { scriptedTurns }

/**
 * @param {{repoRoot:string, task:object, model:{provider:string,model:string}, providers?:object, config?:object, maxTurns?:number,
 *          timeoutMs?:number, keep?:boolean}} options
 * @returns {Promise<object>} report: task, outcome, files changed, validation, command results, and proof the primary checkout is untouched
 */
export async function runDogfood({ repoRoot, task, model, providers, config = getRuntimeConfig(), maxTurns = 16, timeoutMs = 300_000, keep = false }) {
  const before = checkoutState(repoRoot)
  const wt = await createDogfoodWorktree({ repoRoot, task })
  const started = Date.now()
  try {
    const workspaces = createNodeWorkspaceManager({ allowedRoots: [wt.parent] })
    // Focused, bounded validation only: a full `npm test` inside the worktree would run this very suite again.
    const runtime = createAgentRuntime({ ...(providers ? { providers: typeof providers === 'function' ? await providers(wt.root) : providers } : {}), workspaces, approvals: 'unattended',
      config: { ...config, maxTurns, permissionMode: 'full_auto', enableBroadValidation: false, enableAutomaticValidation: false } })
    const ws = await workspaces.openWorkspace({ root: wt.root })
    const session = runtime.startSession({ workspaceId: ws.id, model })
    const timer = setTimeout(() => runtime.cancelSession(session.id), timeoutMs)
    let done
    try { done = await runtime.sendMessage(session.id, task.prompt) } finally { clearTimeout(timer) }
    const changes = await ws.gitChanges()
    const changed = changes.files.map(f => f.path)
    const diff = git(wt.root, 'diff', '--stat').trim()
    const success = await Promise.resolve(task.check(ws)).catch(() => false)
    const after = checkoutState(repoRoot)
    const primaryUntouched = before.head === after.head && before.branches === after.branches && before.status === after.status
    const failure = done.events.find(e => e.type === 'session.failed')?.data.error
    return {
      task: task.id, title: task.title, provider: model.provider, model: model.model, prompt: task.prompt,
      outcome: success && primaryUntouched ? 'success' : 'failed', checkPassed: !!success, sessionStatus: done.status,
      filesChanged: changed, unexpectedFiles: changed.filter(p => !task.expectedFiles.includes(p)), diffStat: diff,
      toolCalls: done.toolCalls.length, turns: done.turns.length, tokens: { ...done.tokenUsage }, durationMs: Date.now() - started,
      validation: done.validation?.currentStatus ?? 'not run (disabled for dogfooding)',
      primaryCheckoutUntouched: primaryUntouched, worktree: keep ? wt.root : null, pushed: false,
      ...(failure ? { error: { code: failure.code, message: failure.message } } : {}),
    }
  } finally {
    if (!keep) await wt.cleanup()
  }
}

export function formatDogfood(r) {
  return [
    `Dogfood: ${r.task} — ${r.title}`, `  model: ${r.provider}/${r.model}`, `  outcome: ${r.outcome.toUpperCase()} (session ${r.sessionStatus}; objective check ${r.checkPassed ? 'passed' : 'FAILED'})`,
    `  files changed: ${r.filesChanged.join(', ') || 'none'}${r.unexpectedFiles.length ? `  (unexpected: ${r.unexpectedFiles.join(', ')})` : ''}`,
    `  turns ${r.turns} · tool calls ${r.toolCalls} · tokens ${r.tokens.total} · ${(r.durationMs / 1000).toFixed(1)}s`,
    `  primary checkout untouched: ${r.primaryCheckoutUntouched ? 'yes' : 'NO'} · pushed: no${r.worktree ? ` · worktree kept at ${r.worktree}` : ' · worktree removed'}`,
    ...(r.diffStat ? ['', r.diffStat.split('\n').map(l => `  ${l}`).join('\n')] : []),
    ...(r.error ? [`  error: [${r.error.code}] ${r.error.message}`] : []),
  ].join('\n')
}
