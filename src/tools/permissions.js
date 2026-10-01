// Effect classification and the permission gate. Safety does not rely on the
// system prompt: every tool call is classified and checked before execution.

/** Ordered from least to most severe. */
export const EFFECTS = Object.freeze([
  'read', 'workspace_write', 'dependency_change', 'external_effect', 'destructive', 'prohibited',
])
const RANK = Object.fromEntries(EFFECTS.map((e, i) => [e, i]))

export const maxEffect = (a, b) => (RANK[a] >= RANK[b] ? a : b)

/**
 * Effects allowed without human approval. Phase 2 has no approval UI, so
 * dependency changes and external effects are denied by default; `prohibited`
 * can never be allowed.
 */
export const DEFAULT_POLICY = Object.freeze({
  allowedEffects: Object.freeze(['read', 'workspace_write', 'destructive']),
})

// ─── Shell command classification ────────────────────────────────────────────

const WRAPPERS = new Set(['env', 'time', 'nohup', 'command', 'nice', 'timeout', 'exec'])
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'echo', 'printf', 'pwd', 'which', 'whoami', 'date',
  'true', 'false', 'test', '[', 'diff', 'sort', 'uniq', 'cut', 'tr', 'stat', 'file', 'tree', 'basename', 'dirname',
  'realpath', 'sleep', 'uname', 'hostname', 'id',
])
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'ls-tree', 'cat-file', 'grep', 'rev-list', 'diff-tree', 'show-ref', 'name-rev'])
const GIT_WRITE = new Set(['add', 'commit', 'checkout', 'switch', 'merge', 'rebase', 'stash', 'apply', 'restore', 'branch', 'tag', 'cherry-pick', 'revert', 'mv', 'rm', 'init', 'config', 'am'])
const GIT_EXTERNAL = new Set(['push', 'pull', 'fetch', 'clone', 'remote', 'submodule', 'ls-remote'])
const PM = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PM_DEPS = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'up', 'link', 'unlink', 'dedupe', 'prune', 'rebuild'])
const PM_EXTERNAL = new Set(['publish', 'login', 'logout', 'adduser', 'deprecate', 'unpublish', 'access', 'owner', 'dist-tag', 'token'])
const SCRIPT_READ = /^(test|tests|t|lint|build|typecheck|type-check|check|format:check|test:[\w:.-]+|lint:[\w:.-]+|build:[\w:.-]+|check:[\w:.-]+)$/
const NETWORK = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet', 'gh', 'docker', 'kubectl', 'terraform', 'aws', 'gcloud', 'az', 'heroku', 'vercel', 'netlify', 'firebase'])
const PROHIBITED_BIN = new Set(['sudo', 'su', 'doas', 'mkfs', 'fdisk', 'parted', 'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'systemctl', 'mount', 'umount', 'chown', 'kill', 'killall', 'pkill', 'crontab', 'passwd', 'useradd', 'userdel', 'iptables'])
const DESTRUCTIVE_BIN = new Set(['rm', 'rmdir', 'shred', 'truncate', 'unlink'])
const DANGEROUS_RM_TARGET = /^(\/|\/\*|~|~\/.*|\$HOME.*|\.|\.\.|\.\/|\.\.\/.*|\*|\.\/\*|\.git|\.git\/.*|\/[^ ]*)$/

function splitTopLevel(command) {
  const segments = []
  let cur = ''
  let quote = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"') cur += command[++i] ?? ''
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") { quote = c; cur += c }
    else if (c === '\\') { cur += c + (command[++i] ?? '') }
    else if (c === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) cur += c // 2>&1, &>
    else if (c === ';' || c === '\n' || c === '&' || c === '|') {
      segments.push({ text: cur, op: c === '|' && command[i + 1] !== '|' ? 'pipe' : 'seq' })
      cur = ''
      if ((c === '&' || c === '|') && command[i + 1] === c) i++
    } else cur += c
  }
  if (cur.trim()) segments.push({ text: cur, op: 'seq' })
  return segments
}

function tokenize(text) {
  const tokens = []
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(text))) tokens.push(m[1] ?? m[2] ?? m[3])
  return tokens
}

function substitutions(command) {
  const out = []
  for (let i = 0; i < command.length; i++) {
    if (command[i] === '$' && command[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      for (; j < command.length && depth; j++) depth += command[j] === '(' ? 1 : command[j] === ')' ? -1 : 0
      out.push(command.slice(i + 2, j - 1)); i = j - 1
    } else if (command[i] === '`') {
      const j = command.indexOf('`', i + 1)
      if (j > i) { out.push(command.slice(i + 1, j)); i = j }
    }
  }
  return out
}

function classifySimple(tokens, depth) {
  let t = [...tokens]
  while (t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || WRAPPERS.has(t[0]))) {
    if (t[0] === 'timeout') t.splice(0, 2); else t.shift()
  }
  if (!t.length) return { effect: 'read', reason: 'no command' }
  const bin = t[0].split('/').pop()
  const args = t.slice(1)
  const flags = args.filter(a => a.startsWith('-'))
  const operands = args.filter(a => !a.startsWith('-'))
  const sub = operands[0]

  if (PROHIBITED_BIN.has(bin) || bin.startsWith('mkfs')) return { effect: 'prohibited', reason: `${bin} is not permitted` }
  if (bin === 'dd' && args.some(a => /^of=\/dev\//.test(a))) return { effect: 'prohibited', reason: 'raw device write' }
  if (bin === 'chmod' && flags.some(f => /R/.test(f)) && operands.some(o => o.startsWith('/'))) return { effect: 'prohibited', reason: 'recursive chmod outside workspace' }
  if (DESTRUCTIVE_BIN.has(bin)) {
    const target = operands.find(o => DANGEROUS_RM_TARGET.test(o))
    if (target) return { effect: 'prohibited', reason: `${bin} on protected or out-of-workspace target: ${target}` }
    return { effect: 'destructive', reason: `${bin} deletes files` }
  }
  if (['sh', 'bash', 'zsh', 'dash'].includes(bin)) {
    const ci = args.indexOf('-c')
    if (ci >= 0 && args[ci + 1] !== undefined && depth < 3) return classifyCommand(args[ci + 1], depth + 1)
    return { effect: 'workspace_write', reason: `${bin} runs arbitrary scripts` }
  }
  if (bin === 'eval' && depth < 3) return classifyCommand(args.join(' '), depth + 1)
  if (NETWORK.has(bin)) return { effect: 'external_effect', reason: `${bin} may perform network or remote operations` }

  if (bin === 'git') {
    const gsub = operands[0]
    if (GIT_EXTERNAL.has(gsub)) return { effect: 'external_effect', reason: `git ${gsub} contacts a remote` }
    if (gsub === 'reset' || gsub === 'clean') return { effect: 'destructive', reason: `git ${gsub} discards work` }
    if (gsub === 'checkout' && (args.includes('--') || args.includes('.'))) return { effect: 'destructive', reason: 'git checkout discards changes' }
    if (gsub === 'branch' && flags.some(f => /^-[dD]$/.test(f) || f === '--delete')) return { effect: 'destructive', reason: 'git branch deletion' }
    if (gsub === 'restore' && !flags.includes('--staged')) return { effect: 'destructive', reason: 'git restore discards changes' }
    if (gsub === 'branch' && operands.length === 1 && flags.length === 0) return { effect: 'read', reason: 'git branch (list)' }
    if (gsub === 'config' && flags.includes('--get')) return { effect: 'read', reason: 'git config --get' }
    if (GIT_READ.has(gsub)) return { effect: 'read', reason: `git ${gsub}` }
    if (GIT_WRITE.has(gsub)) return { effect: 'workspace_write', reason: `git ${gsub} modifies the repository` }
    return { effect: 'workspace_write', reason: `unrecognized git subcommand: ${gsub}` }
  }

  if (PM.has(bin)) {
    if (PM_EXTERNAL.has(sub)) return { effect: 'external_effect', reason: `${bin} ${sub} publishes or alters remote state` }
    if (PM_DEPS.has(sub)) return { effect: 'dependency_change', reason: `${bin} ${sub} changes dependencies` }
    if (sub === 'run' || sub === 'run-script') {
      return SCRIPT_READ.test(operands[1] ?? '')
        ? { effect: 'read', reason: `${bin} run ${operands[1]}` }
        : { effect: 'workspace_write', reason: `${bin} run ${operands[1] ?? ''} runs an arbitrary script` }
    }
    if (SCRIPT_READ.test(sub ?? '')) return { effect: 'read', reason: `${bin} ${sub}` }
    if (['ls', 'list', 'outdated', 'audit', 'view', 'why', 'info', 'config', 'root', 'bin', 'help', 'version'].includes(sub) || flags.includes('--version')) return { effect: 'read', reason: `${bin} ${sub ?? ''}`.trim() }
    return { effect: 'workspace_write', reason: `${bin} ${sub ?? ''} may modify the workspace` }
  }
  if (['npx', 'pnpx', 'bunx'].includes(bin) || (bin === 'yarn' && sub === 'dlx')) {
    return flags.some(f => f === '--no-install' || f === '--no') ? { effect: 'workspace_write', reason: `${bin} (local only)` } : { effect: 'dependency_change', reason: `${bin} may download and run packages` }
  }
  if (bin === 'pip' || bin === 'pip3' || (/^python3?(\.\d+)?$/.test(bin) && args[0] === '-m' && args[1] === 'pip')) {
    const p = bin.startsWith('pip') ? sub : operands[1]
    return ['list', 'show', 'freeze', 'check'].includes(p) ? { effect: 'read', reason: 'pip query' } : { effect: 'dependency_change', reason: 'pip changes packages' }
  }
  if (['poetry', 'uv', 'pipenv', 'conda'].includes(bin)) return ['run', 'show', 'check', 'lock'].includes(sub) ? { effect: 'workspace_write', reason: `${bin} ${sub}` } : { effect: 'dependency_change', reason: `${bin} ${sub ?? ''} changes packages` }
  if (bin === 'cargo') {
    if (['publish', 'login', 'owner', 'yank'].includes(sub)) return { effect: 'external_effect', reason: `cargo ${sub}` }
    if (['add', 'install', 'update', 'remove', 'fetch'].includes(sub)) return { effect: 'dependency_change', reason: `cargo ${sub}` }
    if (['test', 'check', 'clippy', 'build', 'fmt', 'doc', 'tree', 'metadata'].includes(sub)) return { effect: 'read', reason: `cargo ${sub}` }
    return { effect: 'workspace_write', reason: `cargo ${sub ?? ''}` }
  }
  if (bin === 'go') {
    if (['get', 'install'].includes(sub) || (sub === 'mod' && operands[1] !== 'verify')) return { effect: 'dependency_change', reason: `go ${sub}` }
    if (['test', 'build', 'vet', 'fmt', 'list', 'version', 'env'].includes(sub)) return { effect: 'read', reason: `go ${sub}` }
    return { effect: 'workspace_write', reason: `go ${sub ?? ''}` }
  }
  if (['apt', 'apt-get', 'brew', 'gem', 'bundle', 'composer', 'dnf', 'yum', 'apk', 'pacman', 'snap'].includes(bin)) {
    return { effect: 'dependency_change', reason: `${bin} manages system or project packages` }
  }
  if (bin === 'node' && (flags.includes('--test') || flags.includes('--version') || flags.includes('-v') || flags.includes('--check'))) return { effect: 'read', reason: `node ${flags[0]}` }
  if (['pytest', 'jest', 'vitest', 'mocha', 'eslint', 'tsc', 'ruff', 'mypy', 'flake8', 'pylint', 'rubocop', 'phpunit'].includes(bin)) return { effect: 'read', reason: `${bin} (test/lint tool)` }
  if (bin === 'prettier') return flags.includes('--write') ? { effect: 'workspace_write', reason: 'prettier --write' } : { effect: 'read', reason: 'prettier check' }
  if (/^python3?(\.\d+)?$/.test(bin) && args[0] === '-m' && ['pytest', 'unittest', 'mypy', 'ruff', 'flake8'].includes(args[1])) return { effect: 'read', reason: `python -m ${args[1]}` }
  if (bin === 'make') return SCRIPT_READ.test(sub ?? '') ? { effect: 'read', reason: `make ${sub}` } : { effect: 'workspace_write', reason: 'make target may write files' }
  if (bin === 'find') {
    if (args.includes('-delete')) return { effect: 'destructive', reason: 'find -delete' }
    if (args.some(a => ['-exec', '-execdir', '-ok'].includes(a))) return { effect: 'workspace_write', reason: 'find -exec runs commands' }
    return { effect: 'read', reason: 'find' }
  }
  if (bin === 'sed') return flags.some(f => /^-[a-zA-Z]*i/.test(f) || f.startsWith('--in-place')) ? { effect: 'workspace_write', reason: 'sed -i' } : { effect: 'read', reason: 'sed' }
  if (bin === 'awk') return { effect: 'read', reason: 'awk' }
  if (READ_ONLY.has(bin)) return { effect: 'read', reason: bin }
  if (['mkdir', 'touch', 'cp', 'mv', 'tee', 'ln', 'chmod', 'patch', 'install'].includes(bin)) return { effect: 'workspace_write', reason: `${bin} modifies files` }
  return { effect: 'workspace_write', reason: `unrecognized command "${bin}" assumed to modify the workspace` }
}

/**
 * Conservative, deterministic classification of a shell command line. Unknown
 * programs are assumed to write to the workspace; the most severe segment wins.
 * @returns {{effect:string, reason:string}}
 */
export function classifyCommand(command, depth = 0) {
  if (typeof command !== 'string' || command.trim() === '') return { effect: 'read', reason: 'empty command' }
  if (/:\s*\(\s*\)\s*\{.*:\s*\|\s*:/.test(command)) return { effect: 'prohibited', reason: 'fork bomb' }
  let worst = { effect: 'read', reason: 'read-only command' }
  const consider = c => { if (RANK[c.effect] > RANK[worst.effect]) worst = c }

  for (const inner of substitutions(command)) if (depth < 3) consider(classifyCommand(inner, depth + 1))

  const segments = splitTopLevel(command)
  segments.forEach((seg, i) => {
    const tokens = tokenize(seg.text)
    if (!tokens.length) return
    const next = segments[i + 1] ? tokenize(segments[i + 1].text)[0] : null
    if (seg.op === 'pipe' && ['sh', 'bash', 'zsh', 'dash', 'python', 'python3', 'node', 'perl', 'ruby'].includes((next ?? '').split('/').pop())) {
      consider({ effect: 'prohibited', reason: 'piping data into an interpreter' })
    }
    consider(classifySimple(tokens.filter(t => !/^\d*>>?(&\d+)?$/.test(t) && !/^\d*>>?\S/.test(t)), depth))
    // Output redirection writes files; targets outside the workspace are prohibited.
    for (let k = 0; k < tokens.length; k++) {
      const m = /^(\d*)>>?(&\d+)?(.*)$/.exec(tokens[k])
      if (!m || m[2]) continue
      const target = m[3] || tokens[k + 1] || ''
      if (['/dev/null', '/dev/stdout', '/dev/stderr'].includes(target)) continue
      if (target.startsWith('/') || target.startsWith('~') || target.split('/').includes('..')) {
        consider({ effect: 'prohibited', reason: `redirect to path outside workspace: ${target}` })
      } else consider({ effect: 'workspace_write', reason: 'output redirection writes a file' })
    }
  })
  return worst
}

/**
 * Decides whether a classified effect may run under `policy`.
 * @returns {{allowed:boolean, effect:string, reason:string|null}}
 */
export function checkPermission(effect, reason, policy = DEFAULT_POLICY) {
  if (effect === 'prohibited') return { allowed: false, effect, reason: reason ?? 'prohibited operation' }
  if (policy.allowedEffects.includes(effect)) return { allowed: true, effect, reason: null }
  return { allowed: false, effect, reason: `${effect} operations require approval, which is not available: ${reason ?? ''}`.trim() }
}
