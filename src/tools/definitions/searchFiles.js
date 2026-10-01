export const searchFiles = {
  name: 'search_files',
  description: 'Find files by name or path substring, or by glob (e.g. "*.test.mjs"). Does not search file contents; use grep for that.',
  permission: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      path: { type: 'string', description: 'Restrict to this workspace-relative directory.' },
      limit: { type: 'integer', minimum: 1 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  execute: ({ workspace }, { query, path, limit }) => workspace.searchFiles(query, { path, limit }),
}
