// Compact, stable workspace facts: repository, branch, HEAD, dirty/clean, manifests, top-level
// structure, package manager and light conventions. Does not grow with conversation length.
import { getRepositoryCache } from './repositoryContext.js'

const MAX_ENTRIES = 40
const SOURCE_DIRS = ['src', 'lib', 'app', 'packages', 'server', 'client']
const TEST_DIRS = ['test', 'tests', '__tests__', 'spec', 'e2e']
const FRAMEWORKS = ['react', 'next', 'vue', 'nuxt', 'svelte', '@angular/core', 'express', 'fastify', 'koa', 'vite', 'electron']
const TEST_TOOLS = [['vitest', 'vitest'], ['jest', 'jest'], ['mocha', 'mocha'], ['node --test', 'node:test'], ['playwright', 'playwright'], ['pytest', 'pytest']]
const MANIFEST_LANGUAGE = { 'Cargo.toml': 'Rust', 'go.mod': 'Go', 'pom.xml': 'Java', 'build.gradle': 'Java/Kotlin', 'pyproject.toml': 'Python', 'requirements.txt': 'Python' }

function statusSummary(status) {
  if (!status) return 'unavailable (not a git repository)'
  if (status.clean) return 'clean'
  return [['modified', status.modified], ['staged', status.staged], ['deleted', status.deleted], ['untracked', status.untracked], ['conflicted', status.conflicted]]
    .filter(([, list]) => list?.length).map(([label, list]) => `${list.length} ${label}`).join(', ')
}

async function readPackageJson(workspace) {
  const cache = getRepositoryCache(workspace)
  let st
  try { st = await workspace.stat('package.json') } catch { return null }
  const sig = `${st.size}:${st.mtimeMs}`
  if (cache.manifest?.sig === sig) return cache.manifest.json
  try {
    const { content } = await workspace.readFile('package.json')
    const json = JSON.parse(content)
    cache.manifest = { sig, json }
    return json
  } catch { return null }
}

async function conventions(workspace, entryNames) {
  const repo = workspace.metadata?.repository ?? {}
  const manifests = repo.manifests ?? []
  const pkg = manifests.includes('package.json') ? await readPackageJson(workspace) : null
  const parts = []
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }
  if (pkg) parts.push(`language ${deps.typescript || entryNames.includes('tsconfig.json') ? 'TypeScript/JavaScript' : 'JavaScript'}`)
  else if (manifests.length) parts.push(`language ${MANIFEST_LANGUAGE[manifests.find(m => MANIFEST_LANGUAGE[m])] ?? 'unknown'}`)
  const fw = FRAMEWORKS.filter(f => deps[f])
  if (fw.length) parts.push(`frameworks ${fw.join(', ')}`)
  const testScript = pkg?.scripts?.test ?? ''
  const tool = TEST_TOOLS.find(([needle]) => testScript.includes(needle) || deps[needle])
  if (tool) parts.push(`tests ${tool[1]}${pkg?.scripts?.test ? ` (npm test → ${testScript.slice(0, 60)})` : ''}`)
  else if (entryNames.includes('pytest.ini') || entryNames.includes('conftest.py')) parts.push('tests pytest')
  const src = SOURCE_DIRS.filter(d => entryNames.includes(d))
  const tst = TEST_DIRS.filter(d => entryNames.includes(d))
  if (src.length) parts.push(`source ${src.map(d => `${d}/`).join(' ')}`)
  if (tst.length) parts.push(`tests dir ${tst.map(d => `${d}/`).join(' ')}`)
  return parts.length ? parts.join('; ') : null
}

/**
 * @param {object} workspace a Workspace (see workspace/workspace.js)
 * @param {{level?:'full'|'minimal'}} [options]
 * @returns {Promise<string>}
 */
export async function buildWorkspaceContext(workspace, { level = 'full' } = {}) {
  const repo = workspace.metadata?.repository ?? {}
  const [status, listing] = await Promise.all([
    repo.isGitRepository ? workspace.gitStatus().catch(() => null) : null,
    level === 'minimal' ? { entries: [] } : workspace.listDirectory('').catch(() => ({ entries: [] })),
  ])
  const entries = listing.entries.filter(e => !(e.ignored && e.name === '.git'))
  const names = entries.slice(0, MAX_ENTRIES).map(e => (e.type === 'directory' ? `${e.name}/` : e.name))
  const more = entries.length > MAX_ENTRIES ? ` … (+${entries.length - MAX_ENTRIES} more)` : ''
  const lines = [
    'WORKSPACE',
    `Repository: ${repo.name ?? workspace.metadata?.name ?? workspace.id}`,
    `Workspace: ${workspace.id} (commands run from the repository root; use workspace-relative paths)`,
    `Branch: ${status?.branch ?? repo.branch ?? 'n/a'}`,
    `HEAD: ${status?.headSha ?? repo.headSha ?? 'n/a'}`,
    `Git status: ${statusSummary(status)}`,
  ]
  if (level === 'full') {
    lines.push(`Top-level: ${names.join('  ') || '(empty)'}${more}`)
    lines.push(`Detected project: ${repo.manifests?.length ? `${repo.manifests.join(', ')}${repo.packageManager ? ` (package manager: ${repo.packageManager})` : ''}` : 'no known manifest'}`)
    const conv = await conventions(workspace, entries.map(e => e.name))
    if (conv) lines.push(`Conventions: ${conv}`)
  }
  return lines.join('\n')
}
