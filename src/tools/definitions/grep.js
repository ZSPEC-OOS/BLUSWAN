export const grep = {
  name: 'grep',
  description: 'Search file contents line by line. Literal match by default; set regex for a regular expression.',
  permission: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', minLength: 1 },
      path: { type: 'string', description: 'Restrict to this workspace-relative file or directory.' },
      caseSensitive: { type: 'boolean' },
      regex: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1 },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  execute: ({ workspace }, { pattern, path, caseSensitive, regex, limit }) =>
    workspace.grep(pattern, { path, caseSensitive, regex, limit }),
}
