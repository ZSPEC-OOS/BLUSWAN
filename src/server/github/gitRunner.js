// Git subprocesses for the GitHub workflow: argv only (no shell), repository hooks disabled, bounded output, secrets
// never in argv, files or logs. Transport credentials travel in the child's environment for that one command.
import { execFile } from 'node:child_process'
import { createError } from '../../protocol/schemas.js'
import { sanitizedEnv } from '../../workspace/git.js'
import { redactGithub } from './redact.js'

const MAX_OUTPUT = 8_000
export const TIMEOUTS = Object.freeze({ local: 30_000, network: 120_000, clone: 300_000 })

/** One scoped HTTP auth header for the GitHub host; nothing is written to .git/config and no helper is consulted. */
export function transportEnv({ token, webUrl }) {
  if (!token) return {}
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `http.${webUrl.replace(/\/+$/, '')}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '',
  }
}

export function classifyGitFailure(stderr, { timedOut = false, aborted = false } = {}) {
  const text = redactGithub(stderr).slice(0, 600)
  if (aborted) return createError({ code: 'operation_cancelled', message: 'The operation was cancelled.' })
  if (timedOut) return createError({ code: 'git_timeout', message: 'The Git operation timed out.', retryable: true })
  if (/non-fast-forward|fetch first|\[rejected\]|failed to push some refs|stale info/i.test(text)) return createError({ code: 'git_push_rejected', message: 'The remote rejected the push because it has commits you do not have. Sync, then push again. BLUSWAN never force-pushes.' })
  if (/protected branch|GH006|GH013|refusing to allow/i.test(text)) return createError({ code: 'git_push_rejected', message: 'GitHub rejected the push (branch protection or repository rules).' })
  if (/authentication failed|could not read (username|password)|invalid credentials|HTTP 40[13]|403|401/i.test(text)) return createError({ code: 'git_auth_rejected', message: 'GitHub rejected the credentials for this repository. Reconnect GitHub or check the app installation.' })
  if (/could not resolve host|unable to access|connection (refused|timed out|reset)|network is unreachable|early EOF|RPC failed/i.test(text)) return createError({ code: 'github_api_error', message: 'GitHub could not be reached over the network.', retryable: true })
  if (/no space left/i.test(text)) return createError({ code: 'git_operation_failed', message: 'The disk is full on the runtime host.' })
  if (/CONFLICT|Automatic merge failed|unmerged/i.test(text)) return createError({ code: 'git_conflicts', message: 'Git reported conflicts.' })
  if (/not possible to fast-forward|diverged|Not possible to fast-forward/i.test(text)) return createError({ code: 'git_branch_diverged', message: 'The branch has diverged from its remote.' })
  return createError({ code: 'git_operation_failed', message: `Git failed: ${text.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300) || 'unknown error'}` })
}

/**
 * @param {string|null} cwd
 * @param {string[]} args
 * @param {{token?:string, webUrl?:string, signal?:AbortSignal, timeoutMs?:number, okCodes?:number[], env?:object, input?:string}} options
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function git(cwd, args, { token, webUrl = 'https://github.com', signal, timeoutMs = TIMEOUTS.local, okCodes = [0], env = {}, identity } = {}) {
  const prefix = ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'commit.gpgsign=false', '-c', 'core.quotepath=off', '-c', 'color.ui=false',
    ...(identity ? ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`] : [])]
  return new Promise((resolve, reject) => {
    execFile('git', [...prefix, ...args], { cwd: cwd ?? undefined, env: sanitizedEnv({ ...transportEnv({ token, webUrl }), ...env }), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, signal, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr })
      if (typeof err.code === 'number' && okCodes.includes(err.code)) return resolve({ code: err.code, stdout, stderr })
      if (err.code === 'ENOENT') return reject(createError({ code: 'git_operation_failed', message: 'The git executable was not found on the runtime host.' }))
      reject(classifyGitFailure(`${stderr}\n${err.message}`, { timedOut: err.killed && err.signal === 'SIGTERM' && !signal?.aborted, aborted: err.name === 'AbortError' || !!signal?.aborted }))
    })
  })
}

export const bounded = (text) => redactGithub(String(text ?? '')).slice(-MAX_OUTPUT)
