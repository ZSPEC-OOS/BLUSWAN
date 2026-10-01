// Runtime condition of one session's agent. Describes state; does not enforce a workflow.

export function createAgentState(sessionId, now = Date.now()) {
  return {
    sessionId,
    status: 'idle',
    turnCount: 0,
    startedAt: now,
    lastActivityAt: now,
    abortController: null,
    error: null,
  }
}

export function updateAgentState(state, patch, now = Date.now()) {
  return { ...state, ...patch, lastActivityAt: now }
}
