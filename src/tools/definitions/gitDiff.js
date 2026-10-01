export const gitDiff = {
  name: 'git_diff',
  description: 'Unified diff of working-tree changes (including untracked files), or of staged changes with staged=true.',
  permission: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Restrict to this workspace-relative path.' },
      staged: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  execute: ({ workspace }, { path, staged = false }) => workspace.gitDiff({ path, staged }),
}
