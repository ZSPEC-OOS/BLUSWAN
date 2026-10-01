export const readFile = {
  name: 'read_file',
  description: 'Read a file in the active workspace, optionally limited to a 1-based line range.',
  permission: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, description: 'Workspace-relative file path.' },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  execute: ({ workspace }, { path, startLine, endLine }) => workspace.readFile(path, { startLine, endLine }),
}
