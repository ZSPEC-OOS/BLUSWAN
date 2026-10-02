// Node module-customization hooks so `node:test` can import .jsx components and .css side-effect
// imports (compiled with Vite's own esbuild). Test tooling only — never part of the app bundle.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { transformWithEsbuild } from 'vite'

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }
  if (url.endsWith('.jsx')) {
    const file = fileURLToPath(url)
    const { code } = await transformWithEsbuild(await readFile(file, 'utf8'), file, { loader: 'jsx', jsx: 'automatic', format: 'esm', target: 'es2022' })
    return { format: 'module', source: code, shortCircuit: true }
  }
  return nextLoad(url, context)
}
