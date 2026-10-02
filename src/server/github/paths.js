// Where GitHub repositories are cloned: <root>/users/<opaque-user-key>/github/<owner>/<repo>, always below an allowed root.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createError } from '../../protocol/schemas.js'

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/

export function validateOwnerRepo(owner, repo) {
  if (typeof owner !== 'string' || !OWNER.test(owner) || typeof repo !== 'string' || !REPO.test(repo) || repo === '.' || repo === '..' || repo.startsWith('.git') && repo.length <= 4) {
    throw createError({ code: 'invalid_request', message: 'That is not a valid GitHub repository name.' })
  }
  return { owner, repo }
}

/** Stable, opaque, filesystem-safe identifier for a user (never an email or raw uid). */
export const userKey = (userId) => crypto.createHash('sha256').update(`bluswan-user:${userId}`).digest('hex').slice(0, 24)

/** Lower-cased: GitHub names are case-insensitive, so one repository can never occupy two directories. */
export const repoKey = (owner, repo) => `${owner}__${repo}`.toLowerCase()

export function clonePath({ root, userId, owner, repo }) {
  validateOwnerRepo(owner, repo)
  return path.join(path.resolve(root), 'users', userKey(userId), 'github', owner.toLowerCase(), repo.toLowerCase())
}

/** Creates the parent directories and proves, via realpath, that the destination is inside `root`. */
export async function prepareCloneDir({ root, dest }) {
  const rootReal = await fs.realpath(root)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const parentReal = await fs.realpath(path.dirname(dest))
  const target = path.join(parentReal, path.basename(dest))
  if (target !== rootReal && !target.startsWith(rootReal + path.sep)) throw createError({ code: 'forbidden', message: 'The clone location is outside the allowed workspace roots.' })
  return target
}

/** Ownership check for deletion: only directories BLUSWAN itself created for this user may be removed. */
export function isOwnedClone({ root, userId, target }) {
  const base = path.join(path.resolve(root), 'users', userKey(userId), 'github') + path.sep
  return path.resolve(target).startsWith(base)
}

export function normalizeRemote(url) {
  return String(url ?? '').trim().replace(/^(https?:\/\/)[^@/]+@/i, '$1').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase()
}
