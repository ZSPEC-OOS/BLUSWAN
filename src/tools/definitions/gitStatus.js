export const gitStatus = {
  name: 'git_status',
  description: 'Structured git status of the workspace: branch, HEAD, staged, modified, deleted and untracked files.',
  permission: 'read',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute: ({ workspace }) => workspace.gitStatus(),
}
