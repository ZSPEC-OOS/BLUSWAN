// Compact repository snapshot given to the model at the start of each run.
// Deliberately small: the model retrieves details with tools.

const MAX_ENTRIES = 40

function statusSummary(status) {
  if (!status) return 'unavailable (not a git repository)'
  if (status.clean) return 'clean'
  const parts = [['modified', status.modified], ['staged', status.staged], ['deleted', status.deleted], ['untracked', status.untracked], ['conflicted', status.conflicted]]
    .filter(([, list]) => list?.length).map(([label, list]) => `${list.length} ${label}`)
  return parts.join(', ')
}

/** @param {object} workspace a Workspace (see workspace/workspace.js) @returns {Promise<string>} */
export async function buildWorkspaceContext(workspace) {
  const repo = workspace.metadata?.repository ?? {}
  const [status, listing] = await Promise.all([
    repo.isGitRepository ? workspace.gitStatus().catch(() => null) : null,
    workspace.listDirectory('').catch(() => ({ entries: [] })),
  ])
  const entries = listing.entries.filter(e => !e.ignored || e.name !== '.git')
  const names = entries.slice(0, MAX_ENTRIES).map(e => (e.type === 'directory' ? `${e.name}/` : e.name))
  const more = entries.length > MAX_ENTRIES ? ` … (+${entries.length - MAX_ENTRIES} more)` : ''
  const lines = [
    'WORKSPACE',
    `Repository: ${repo.name ?? workspace.metadata?.name ?? workspace.id}`,
    `Workspace: ${workspace.id} (commands run from the repository root; use workspace-relative paths)`,
    `Branch: ${status?.branch ?? repo.branch ?? 'n/a'}`,
    `HEAD: ${status?.headSha ?? repo.headSha ?? 'n/a'}`,
    `Git status: ${statusSummary(status)}`,
    `Top-level: ${names.join('  ') || '(empty)'}${more}`,
    `Detected project: ${repo.manifests?.length ? `${repo.manifests.join(', ')}${repo.packageManager ? ` (package manager: ${repo.packageManager})` : ''}` : 'no known manifest'}`,
  ]
  return lines.join('\n')
}
