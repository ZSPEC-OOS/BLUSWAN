// Normalized result of a command execution (shell tool, future validation runs).

export function createCommandResult({
  command, exitCode = null, signal = null, stdout = '', stderr = '',
  timedOut = false, cancelled = false, truncated = false, durationMs = 0, cwd = '',
} = {}) {
  return { command, cwd, exitCode, signal, stdout, stderr, timedOut, cancelled, truncated, durationMs }
}

export function commandSucceeded(result) {
  return !!result && result.exitCode === 0 && !result.timedOut && !result.cancelled
}
