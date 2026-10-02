// Shell command runner: process-group isolation, timeout, cancellation,
// head+tail output capture. Never leaves the command's process tree running.
import { spawn } from 'node:child_process'
import { WorkspaceError } from './errors.js'
import { createCommandResult } from './commandResult.js'

const KILL_GRACE_MS = 1000
const IS_WINDOWS = process.platform === 'win32'
const SECRET_ENV = /(API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)/i

/** Child environment: inherited env minus secrets and test-runner plumbing, plus explicit overrides. */
export function buildShellEnv(overrides = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV.test(k) || k.startsWith('NODE_TEST_') || k.startsWith('VITE_')) continue
    env[k] = v
  }
  return { ...env, ...overrides }
}

/** Keeps the first and last halves of the output; reports how much was dropped. */
function createCollector(maxBytes) {
  const headMax = Math.ceil(maxBytes / 2)
  const tailMax = Math.floor(maxBytes / 2)
  let head = Buffer.alloc(0)
  let tail = Buffer.alloc(0)
  let total = 0
  return {
    push(chunk) {
      total += chunk.length
      if (head.length < headMax) {
        const take = Math.min(headMax - head.length, chunk.length)
        head = Buffer.concat([head, chunk.subarray(0, take)])
        chunk = chunk.subarray(take)
      }
      if (chunk.length) {
        tail = Buffer.concat([tail, chunk])
        if (tail.length > tailMax * 2 + 1) tail = tail.subarray(tail.length - tailMax)
      }
    },
    finish() {
      if (tail.length > tailMax) tail = tail.subarray(tail.length - tailMax)
      const omitted = total - head.length - tail.length
      if (omitted <= 0) return { text: Buffer.concat([head, tail]).toString('utf8'), truncated: false }
      return {
        text: `${head.toString('utf8')}\n…[${omitted} bytes omitted]…\n${tail.toString('utf8')}`,
        truncated: true,
      }
    },
  }
}

function killTree(child, signal) {
  if (child.pid === undefined) return
  try {
    if (IS_WINDOWS) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

/**
 * @param {{command:string,cwd:string,timeoutMs:number,env?:object,signal?:AbortSignal,maxOutputBytes:number}} opts
 */
export function runShell({ command, cwd, timeoutMs, env, signal, maxOutputBytes }) {
  const started = Date.now()
  const base = { command, cwd }
  if (signal?.aborted) {
    return Promise.resolve(createCommandResult({ ...base, cancelled: true, durationMs: 0 }))
  }
  return new Promise((resolve, reject) => {
    const child = IS_WINDOWS
      ? spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      : spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = createCollector(maxOutputBytes)
    const err = createCollector(maxOutputBytes)
    let timedOut = false
    let cancelled = false
    let killTimer = null

    const terminate = () => {
      killTree(child, 'SIGTERM')
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS)
    }
    const timer = setTimeout(() => { timedOut = true; terminate() }, timeoutMs)
    const onAbort = () => { cancelled = true; terminate() }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', d => out.push(d))
    child.stderr.on('data', d => err.push(d))
    child.on('error', e => {
      clearTimeout(timer); clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      reject(new WorkspaceError('internal_error', `Failed to start command: ${e.message}`))
    })
    child.on('close', (exitCode, sig) => {
      clearTimeout(timer); clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      killTree(child, 'SIGKILL') // reap anything the command left behind in its process group
      const o = out.finish()
      const e = err.finish()
      resolve(createCommandResult({
        ...base, exitCode, signal: sig, stdout: o.text, stderr: e.text, timedOut, cancelled,
        truncated: o.truncated || e.truncated, durationMs: Date.now() - started,
      }))
    })
  })
}
