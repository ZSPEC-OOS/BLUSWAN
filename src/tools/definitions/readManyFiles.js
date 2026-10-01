import { ToolError } from '../result.js'

export const readManyFiles = {
  name: 'read_many_files',
  description: 'Read several files in one call. Per-file failures are reported without failing the call.',
  permission: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
    },
    required: ['paths'],
    additionalProperties: false,
  },
  async execute({ workspace, limits }, { paths }) {
    if (paths.length > limits.maxReadManyFiles) {
      throw new ToolError('output_limit_exceeded', `Too many files: ${paths.length} (maximum ${limits.maxReadManyFiles} per call)`)
    }
    let remaining = limits.maxReadManyBytes
    const files = []
    for (const path of paths) {
      if (remaining <= 0) {
        files.push({ path, ok: false, content: null, error: { code: 'output_limit_exceeded', message: 'Total output budget for this call exhausted; read this file separately.' } })
        continue
      }
      try {
        const r = await workspace.readFile(path, { maxBytes: remaining })
        remaining -= new TextEncoder().encode(r.content).length
        files.push({ path: r.path, ok: true, content: r.content, startLine: r.startLine, endLine: r.endLine, totalLines: r.totalLines, truncated: r.truncated, error: null })
      } catch (e) {
        if (!e?.code) throw e
        files.push({ path, ok: false, content: null, error: { code: e.code, message: e.message } })
      }
    }
    const failed = files.filter(f => !f.ok)
    if (failed.length === files.length) {
      throw new ToolError(failed[0].error.code, `All ${files.length} files failed: ${failed[0].error.message}`, { output: { files } })
    }
    return { files }
  },
}
