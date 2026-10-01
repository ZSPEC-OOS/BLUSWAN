export const applyPatch = {
  name: 'apply_patch',
  description: 'Apply a unified diff to one or more files in the active workspace. All-or-nothing: on any failure no file is changed. Use "--- /dev/null" to create and "+++ /dev/null" to delete.',
  permission: 'workspace_write',
  inputSchema: {
    type: 'object',
    properties: {
      patch: { type: 'string', minLength: 1, description: 'Unified diff text with ---/+++ headers and @@ hunks.' },
    },
    required: ['patch'],
    additionalProperties: false,
  },
  execute: ({ workspace }, { patch }) => workspace.applyPatch(patch),
  changes: output => output.files,
}
