// Basic repository awareness: identity, git state, and project manifests.
import fs from 'node:fs/promises'
import path from 'node:path'

export const MANIFESTS = Object.freeze([
  'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
])

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'], ['uv.lock', 'uv'], ['poetry.lock', 'poetry'],
]
const MANIFEST_MANAGER = {
  'package.json': 'npm', 'pyproject.toml': 'pip', 'requirements.txt': 'pip',
  'Cargo.toml': 'cargo', 'go.mod': 'go', 'pom.xml': 'maven', 'build.gradle': 'gradle',
}

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

async function declaredManager(root) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    if (typeof pkg.packageManager === 'string') return pkg.packageManager.split('@')[0] || null
  } catch { /* no or invalid package.json */ }
  return null
}

/** @param {{root:string, git:object, name?:string}} args */
export async function detectRepository({ root, git, name }) {
  const manifests = []
  for (const m of MANIFESTS) if (await exists(path.join(root, m))) manifests.push(m)

  let packageManager = await declaredManager(root)
  if (!packageManager) {
    for (const [file, manager] of LOCKFILES) {
      if (await exists(path.join(root, file))) { packageManager = manager; break }
    }
  }
  if (!packageManager && manifests.length) packageManager = MANIFEST_MANAGER[manifests[0]] ?? null

  const gitInfo = await git.info().catch(() => ({ isGitRepository: false, branch: null, headSha: null }))
  return {
    root,
    name: name ?? path.basename(root),
    isGitRepository: gitInfo.isGitRepository,
    branch: gitInfo.branch,
    headSha: gitInfo.headSha,
    packageManager,
    manifests,
  }
}
