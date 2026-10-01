export const listDirectory = {
  name: 'list_directory',
  description: 'List entries of a workspace directory (default: root). Generated directories are flagged and not expanded.',
  permission: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative directory; empty for the root.' },
      depth: { type: 'integer', minimum: 1, description: 'Levels to descend (default 1).' },
    },
    additionalProperties: false,
  },
  execute: ({ workspace }, { path = '', depth = 1 }) => workspace.listDirectory(path, { depth }),
}
