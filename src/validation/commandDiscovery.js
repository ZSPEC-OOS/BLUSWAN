// Finds validation commands from repository evidence only. Priority: explicit project script/config
// > well-known ecosystem default > nothing. Script names are never trusted on their own: the script
// body (and the scripts it references, including npm pre/post hooks) is run through the shell
// command classifier, and anything that is not read/workspace-only is marked unsafe and never auto-run.
import { classifyCommand } from '../tools/permissions.js'

export const KINDS = Object.freeze(['test', 'lint', 'typecheck', 'build', 'format_check', 'custom'])
const AUTO_ALLOWED = new Set(['read', 'workspace_write'])
const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 }

// package.json script names → kind, in priority order within a kind
const SCRIPT_KINDS = [
  ['test', 'test'], ['test:unit', 'test'], ['test:integration', 'custom'], ['lint', 'lint'], ['typecheck', 'typecheck'],
  ['type-check', 'typecheck'], ['check', 'custom'], ['build', 'build'], ['format:check', 'format_check'], ['prettier:check', 'format_check'],
]

/** How the project's package manager runs a script. */
export function scriptCommand(packageManager, name) {
  switch (packageManager) {
    case 'pnpm': return name === 'test' ? 'pnpm test' : `pnpm run ${name}`
    case 'yarn': return name === 'test' ? 'yarn test' : `yarn run ${name}`
    case 'bun': return `bun run ${name}` // `bun test` would invoke bun's own runner
    default: return name === 'test' ? 'npm test' : `npm run ${name}`
  }
}

/** Classifies a script together with the scripts it references and its pre/post hooks. */
export function scriptSafety(scripts, name, seen = new Set()) {
  if (seen.has(name) || typeof scripts[name] !== 'string') return { safe: true, reason: null }
  seen.add(name)
  const bodies = [scripts[name], scripts[`pre${name}`], scripts[`post${name}`]].filter(b => typeof b === 'string')
  for (const body of bodies) {
    const c = classifyCommand(body)
    if (!AUTO_ALLOWED.has(c.effect)) return { safe: false, reason: `script "${name}" is ${c.effect}: ${c.reason}` }
    for (const m of body.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/g)) {
      if (m[1] !== name && typeof scripts[m[1]] === 'string') {
        const inner = scriptSafety(scripts, m[1], seen)
        if (!inner.safe) return inner
      }
    }
  }
  return { safe: true, reason: null }
}

function entry(kind, command, source, confidence, extra = {}) {
  const c = classifyCommand(command)
  const safe = AUTO_ALLOWED.has(c.effect) && (extra.safe ?? true)
  return { kind, command, source, confidence, safe, ...(safe ? {} : { unsafeReason: extra.unsafeReason ?? `${c.effect}: ${c.reason}` }) }
}

/**
 * @param {object} project descriptor from projectDetector
 * @returns {{commands:object[], byKind:Record<string,object|null>}} `byKind` holds the best SAFE command per kind
 */
export function discoverValidationCommands(project) {
  const out = []
  const pm = project.packageManager
  if (project.ecosystems.includes('node')) {
    const used = new Set()
    for (const [name, kind] of SCRIPT_KINDS) {
      if (typeof project.scripts[name] !== 'string' || used.has(`${kind}:${name}`)) continue
      const safety = scriptSafety(project.scripts, name)
      out.push(entry(kind, scriptCommand(pm, name), `package.json#scripts.${name}`, 'high', { safe: safety.safe, unsafeReason: safety.reason }))
    }
    if (project.hasTypeScript && !out.some(c => c.kind === 'typecheck') && project.scripts.build === undefined) {
      // no explicit script: only a local, installed compiler is a reasonable guess
      out.push(entry('typecheck', 'node_modules/.bin/tsc --noEmit', 'tsconfig.json (default)', 'low'))
    }
  }
  if (project.ecosystems.includes('python')) {
    if (project.testFrameworks.includes('pytest')) out.push(entry('test', 'python -m pytest', 'pytest configuration', 'high'))
    if (project.tools.ruff) out.push(entry('lint', 'ruff check .', 'ruff configuration', 'high'))
    if (project.tools.mypy) out.push(entry('typecheck', 'mypy .', 'mypy configuration', 'high'))
  }
  if (project.ecosystems.includes('rust')) {
    out.push(entry('test', 'cargo test', 'Cargo.toml (default)', 'medium'))
    out.push(entry('typecheck', 'cargo check', 'Cargo.toml (default)', 'medium'))
    out.push(entry('build', 'cargo build', 'Cargo.toml (default)', 'medium'))
    out.push(entry('lint', 'cargo clippy', 'Cargo.toml (default)', 'low'))
  }
  if (project.ecosystems.includes('go')) {
    out.push(entry('test', 'go test ./...', 'go.mod (default)', 'medium'))
    out.push(entry('lint', 'go vet ./...', 'go.mod (default)', 'medium'))
    out.push(entry('build', 'go build ./...', 'go.mod (default)', 'medium'))
  }
  out.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence])
  const byKind = Object.fromEntries(KINDS.map(k => [k, out.find(c => c.kind === k && c.safe && c.confidence !== 'low') ?? null]))
  return { commands: out, byKind }
}

/** A focused test command for specific test files, where the toolchain supports it. */
export function focusedTestCommand(project, testFiles, byKind) {
  if (!testFiles.length || !byKind.test) return null
  const quoted = testFiles.map(f => (/^[\w./@-]+$/.test(f) ? f : JSON.stringify(f))).join(' ')
  if (project.ecosystems.includes('python') && byKind.test.command.includes('pytest')) return `python -m pytest ${quoted}`
  if (project.ecosystems.includes('node')) {
    const fw = project.testFrameworks
    if (fw.includes('node:test')) return `node --test ${quoted}`
    if (fw.includes('vitest') || fw.includes('jest') || fw.includes('mocha')) return `${byKind.test.command}${byKind.test.command.startsWith('npm') ? ' --' : ''} ${quoted}`
  }
  return null
}
