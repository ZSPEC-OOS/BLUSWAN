// Temporary repository fixture for tests. Lives under the OS temp directory;
// never touches the BLUSWAN working tree.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { sanitizedEnv } from '../git.js'

export const FIXTURE_FILES = Object.freeze({
  'package.json': `${JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test tests/math.test.js' } }, null, 2)}\n`,
  'src/math.js': 'export function add(a, b) {\n  return a - b\n}\n\nexport function multiply(a, b) {\n  return a * b\n}\n',
  'src/index.js': "import { add } from './math.js'\n\nconsole.log(add(1, 2))\n",
  'tests/math.test.js': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add, multiply } from '../src/math.js'\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5)\n})\n\ntest('multiply', () => {\n  assert.equal(multiply(2, 3), 6)\n})\n",
})

/** Patch that fixes the intentional bug in fixture src/math.js. */
export const FIX_ADD_PATCH = `--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a - b
+  return a + b
 }
`

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: sanitizedEnv(), stdio: 'pipe' }).toString()
}

/**
 * @param {{git?:boolean, files?:Record<string,string>}} [options]
 * @returns {Promise<{root:string, cleanup:()=>Promise<void>, git:(...args:string[])=>string}>}
 */
export async function createFixtureRepo({ git: useGit = true, files = FIXTURE_FILES } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluswan-fixture-')))
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fs.writeFile(path.join(root, rel), content)
  }
  if (useGit) {
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.email', 'test@example.com')
    git(root, 'config', 'user.name', 'Fixture')
    git(root, 'config', 'commit.gpgsign', 'false')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'initial')
  }
  return {
    root,
    git: (...args) => git(root, ...args),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}
