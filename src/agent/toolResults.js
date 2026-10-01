// Serialization of tool results for the model. One deterministic plain-text
// representation; bodies are already bounded by the workspace limits, and a
// final character cap is applied here as a safety net.

const clip = (text, max) => {
  if (text.length <= max) return text
  const head = Math.ceil(max * 0.6)
  const tail = max - head
  return `${text.slice(0, head)}\n…[${text.length - max} characters omitted]…\n${text.slice(text.length - tail)}`
}

function section(label, text) {
  return text === '' ? `${label}: (empty)` : `${label}:\n${text}`
}

function formatOutput(tool, o) {
  switch (tool) {
    case 'read_file':
      return [`File: ${o.path} (lines ${o.startLine}-${o.endLine} of ${o.totalLines})`,
        `Truncated: ${o.truncated}${o.nextStartLine ? ` (continue at line ${o.nextStartLine})` : ''}`, o.content].join('\n')
    case 'read_many_files':
      return o.files.map(f => (f.ok
        ? `=== ${f.path} (lines ${f.startLine}-${f.endLine} of ${f.totalLines}, truncated: ${f.truncated}) ===\n${f.content}`
        : `=== ${f.path} ===\nError [${f.error.code}]: ${f.error.message}`)).join('\n')
    case 'shell':
      return [`Command: ${o.command}`, `Exit code: ${o.exitCode ?? 'none'}${o.signal ? ` (signal ${o.signal})` : ''}`,
        `Timed out: ${o.timedOut}`, `Output truncated: ${o.truncated}`,
        section('STDOUT', o.stdout), section('STDERR', o.stderr)].join('\n')
    case 'git_diff':
      return [`Files changed: ${o.files.length} (+${o.additions} -${o.deletions}), truncated: ${o.truncated}`, o.diff === '' ? '(no changes)' : o.diff].join('\n')
    default:
      return JSON.stringify(o)
  }
}

/** @param {{ok:boolean,tool:string,output:*,error:*}} result @returns {string} */
export function serializeToolResult(result, { maxChars = 60_000 } = {}) {
  let text
  if (result.ok) {
    text = formatOutput(result.tool, result.output)
  } else {
    const lines = [`Error [${result.error.code}]: ${result.error.message}`]
    if (result.error.details) lines.push(`Details: ${JSON.stringify(result.error.details)}`)
    if (result.output && result.tool === 'shell') lines.push(formatOutput('shell', result.output))
    else if (result.output && result.tool === 'read_many_files') lines.push(formatOutput('read_many_files', result.output))
    text = lines.join('\n')
  }
  return clip(`Tool: ${result.tool}\nStatus: ${result.ok ? 'ok' : 'error'}\n${text}`, maxChars)
}

/** Short, bounded description stored in session tool history (the full text lives in the tool message). */
export function summarizeToolResult(result) {
  if (!result.ok) return { ok: false, errorCode: result.error.code, message: result.error.message.slice(0, 200) }
  const o = result.output ?? {}
  const summary = { ok: true }
  if (result.tool === 'shell') Object.assign(summary, { exitCode: o.exitCode })
  if (o.changedFiles) summary.changedFiles = o.changedFiles
  if (result.tool === 'write_file' || result.tool === 'delete_file') summary.path = o.path
  return summary
}
