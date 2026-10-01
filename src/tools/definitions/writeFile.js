export const writeFile = {
  name: 'write_file',
  description: 'Create a file or fully replace its content. Prefer apply_patch for edits to existing files. Reports whether an existing file was overwritten.',
  permission: 'workspace_write',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  execute: ({ workspace }, { path, content }) => workspace.writeFile(path, content),
  changes: output => [{ path: output.path, change: output.created ? 'created' : 'modified' }],
}
