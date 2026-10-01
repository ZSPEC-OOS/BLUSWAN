export const deleteFile = {
  name: 'delete_file',
  description: 'Delete a single file. Directories cannot be deleted.',
  permission: 'destructive',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', minLength: 1 } },
    required: ['path'],
    additionalProperties: false,
  },
  execute: ({ workspace }, { path }) => workspace.deleteFile(path),
  changes: output => [{ path: output.path, change: 'deleted' }],
}
