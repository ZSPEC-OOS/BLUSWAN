// Project detection: normalizes what a repository is (ecosystem, package manager, languages,
// frameworks, test tools) from files at its root. Pure description + a thin workspace reader.
// The descriptor is provider-neutral and serializable.

const NODE_LOCKS = [ // precedence when several lockfiles exist
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'],
]
const FRAMEWORKS = ['next', 'nuxt', 'react', 'vue', 'svelte', '@angular/core', 'express', 'fastify', 'koa', 'electron', 'vite']
const NODE_TEST_TOOLS = [['vitest', 'vitest'], ['jest', 'jest'], ['mocha', 'mocha'], ['node --test', 'node:test'], ['playwright', 'playwright'], ['ava', 'ava']]

export const MANIFEST_FILES = Object.freeze([
  'package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile', 'pytest.ini',
  'Cargo.toml', 'go.mod',
])
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum']

/**
 * @param {{rootFiles:Iterable<string>, packageJson?:object|null, pyproject?:string, requirements?:string}} input
 * @returns {object} project descriptor (see detectProject)
 */
export function describeProject({ rootFiles, packageJson = null, pyproject = '', requirements = '' }) {
  const files = new Set(rootFiles)
  const has = (f) => files.has(f)
  const manifests = MANIFEST_FILES.filter(has)
  const lockfiles = LOCKFILES.filter(has)
  const ecosystems = []
  const languages = []
  let packageManager = null
  let framework = null
  const testFrameworks = []
  let hasTypeScript = false
  let conflictingLockfiles = []
  const scripts = packageJson?.scripts && typeof packageJson.scripts === 'object' ? { ...packageJson.scripts } : {}

  if (has('package.json')) {
    ecosystems.push('node')
    languages.push('javascript')
    const deps = { ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) }
    hasTypeScript = has('tsconfig.json') || !!deps.typescript
    if (hasTypeScript) languages.push('typescript')
    const present = NODE_LOCKS.filter(([f]) => has(f))
    const declared = typeof packageJson?.packageManager === 'string' ? packageJson.packageManager.split('@')[0] : null
    packageManager = declared || present[0]?.[1] || 'npm' // documented fallback: npm
    const managers = [...new Set(present.map(([, m]) => m))]
    if (managers.length > 1) conflictingLockfiles = present.map(([f]) => f)
    framework = FRAMEWORKS.find(f => deps[f]) ?? null
    const testScript = scripts.test ?? ''
    for (const [needle, name] of NODE_TEST_TOOLS) if (testScript.includes(needle) || deps[needle]) testFrameworks.push(name)
  }

  const pythonManifest = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'].some(has)
  if (pythonManifest) {
    ecosystems.push('python')
    languages.push('python')
    if (!packageManager) {
      packageManager = has('uv.lock') ? 'uv' : (has('poetry.lock') || /\[tool\.poetry\]/.test(pyproject)) ? 'poetry' : has('Pipfile') ? 'pipenv' : 'pip'
    }
    if (has('pytest.ini') || /\[tool\.pytest|\[pytest\]/.test(pyproject) || /\bpytest\b/.test(requirements) || has('conftest.py')) testFrameworks.push('pytest')
  }
  if (has('Cargo.toml')) { ecosystems.push('rust'); languages.push('rust'); packageManager ??= 'cargo'; testFrameworks.push('cargo test') }
  if (has('go.mod')) { ecosystems.push('go'); languages.push('go'); packageManager ??= 'go'; testFrameworks.push('go test') }

  return {
    ecosystem: ecosystems[0] ?? 'unknown',
    ecosystems,
    packageManager,
    conflictingLockfiles,
    language: languages,
    framework,
    testFrameworks: [...new Set(testFrameworks)],
    hasTypeScript,
    manifests,
    lockfiles,
    scripts,
    tools: {
      ruff: /\[tool\.ruff\]/.test(pyproject) || has('ruff.toml'),
      mypy: /\[tool\.mypy\]/.test(pyproject) || has('mypy.ini'),
    },
    validationCommands: {},
  }
}

async function readIfPresent(workspace, name, rootFiles) {
  if (!rootFiles.has(name)) return null
  try { return (await workspace.readFile(name)).content } catch { return null }
}

/** Reads root files through the Workspace contract and describes the project. */
export async function detectProject(workspace) {
  const { entries } = await workspace.listDirectory('')
  const rootFiles = new Set(entries.filter(e => e.type === 'file').map(e => e.name))
  let packageJson = null
  const pkgText = await readIfPresent(workspace, 'package.json', rootFiles)
  if (pkgText) { try { packageJson = JSON.parse(pkgText) } catch { /* invalid manifest: treated as no scripts */ } }
  return describeProject({
    rootFiles, packageJson,
    pyproject: (await readIfPresent(workspace, 'pyproject.toml', rootFiles)) ?? '',
    requirements: (await readIfPresent(workspace, 'requirements.txt', rootFiles)) ?? '',
  })
}
