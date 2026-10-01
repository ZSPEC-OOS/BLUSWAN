import { ToolError } from '../result.js'
import { classifyCommand } from '../permissions.js'

export const shell = {
  name: 'shell',
  description: 'Run a shell command from the workspace root. Returns exit code, stdout and stderr (a non-zero exit is reported, not an error). Subject to a timeout and output limits.',
  permission: 'workspace_write',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1 },
      timeoutMs: { type: 'integer', minimum: 1, description: 'Capped at the configured maximum.' },
      env: { type: 'object', description: 'Extra environment variables (string values).' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  classify: ({ command }) => classifyCommand(command),
  async execute({ workspace, signal }, { command, timeoutMs, env }) {
    for (const [k, v] of Object.entries(env ?? {})) {
      if (typeof v !== 'string') throw new ToolError('invalid_input', `env.${k} must be a string`)
    }
    const result = await workspace.runCommand(command, { timeoutMs, env, signal })
    if (result.cancelled) throw new ToolError('command_cancelled', 'Command was cancelled', { output: result })
    if (result.timedOut) throw new ToolError('command_timeout', `Command timed out after ${result.durationMs}ms`, { output: result })
    // A non-zero exit is an observation (e.g. failing tests), not a tool failure: the command ran.
    return result
  },
}
