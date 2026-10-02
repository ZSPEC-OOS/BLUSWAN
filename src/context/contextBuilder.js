// Assembles the provider request from logical sections and measures each one.
// Sections (in order): system instructions · workspace · session summary · repository · conversation.
// The first four are rendered into one system message; the conversation follows as normal messages.
// Tool schemas are budgeted separately (see tokenBudget.js).

export const PRIORITY = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 })

/**
 * @param {{estimator:object, systemText:string, workspaceText:string|null, summary:{text:string}|null,
 *          repository:{text:string,type:string,source:string,priority:string}[],
 *          conversation:{messages:object[], sources:string[]}, priorityOf:(sourceId:string)=>string}} input
 */
export function assembleContext({ estimator, systemText, workspaceText, summary, repository, conversation, priorityOf }) {
  const repoText = repository.length ? `REPOSITORY CONTEXT\n${repository.map(i => i.text).join('\n\n')}` : null
  const content = [systemText, workspaceText, summary?.text, repoText].filter(Boolean).join('\n\n')
  const systemMessage = { role: 'system', content }
  const messages = [systemMessage, ...conversation.messages]

  const tokens = {
    workspace: workspaceText ? estimator.estimateTokens(workspaceText) : 0,
    summary: summary ? estimator.estimateTokens(summary.text) : 0,
    repository: repoText ? estimator.estimateTokens(repoText) : 0,
    conversation: 0,
    tools: 0,
  }
  tokens.system = estimator.estimateMessageTokens(systemMessage) - tokens.workspace - tokens.summary - tokens.repository
  const items = [
    { section: 'system', type: 'system_instructions', source: 'system', priority: 'critical', estimatedTokens: Math.max(tokens.system, 0) },
  ]
  if (workspaceText) items.push({ section: 'workspace', type: 'workspace_metadata', source: 'workspace', priority: 'medium', estimatedTokens: tokens.workspace })
  if (summary) items.push({ section: 'summary', type: 'session_summary', source: 'session.contextSummary', priority: 'high', estimatedTokens: tokens.summary })
  for (const r of repository) items.push({ section: 'repository', type: r.type, source: r.source, priority: r.priority, estimatedTokens: r.tokens })
  conversation.messages.forEach((m, i) => {
    const estimatedTokens = estimator.estimateMessageTokens(m)
    const section = m.role === 'tool' ? 'tools' : 'conversation'
    tokens[section] += estimatedTokens
    const type = m.role === 'tool' ? `tool_result:${m.name}` : m.toolCalls?.length ? 'assistant_tool_call' : `${m.role}_message`
    items.push({ section, type, source: conversation.sources[i], priority: priorityOf(conversation.sources[i], m), estimatedTokens })
  })
  const total = estimator.estimateContextTokens(messages)
  return { messages, sections: tokens, items, totalTokens: total }
}
