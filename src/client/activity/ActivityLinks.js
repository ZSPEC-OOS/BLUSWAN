// Lets activity rows open workspace views (a file's diff, command output, validation details) without
// threading callbacks through every component. Links are driven by structured event metadata
// (file.changed paths, tool-call ids), never by parsing message text.
import { createContext, useContext } from 'react'

export const ActivityLinksContext = createContext(null)
export const useActivityLinks = () => useContext(ActivityLinksContext)

/**
 * Review links for one activity item, derived from structured metadata only: the paths of its `file.changed`
 * events, its tool-call id (shell output) or validation id.
 * @returns {{key:string,text:string,aria:string,onClick:()=>void}[]}
 */
export function buildActivityLinks(item, links) {
  if (!links || item.status === 'running') return []
  const out = []
  if (item.tool === 'validation') {
    out.push({ key: 'v', text: 'Details', aria: `View details of ${item.label}`, onClick: () => links.openValidation(item.id) })
    return out
  }
  for (const f of (item.files ?? []).slice(0, 3)) {
    if (f.action === 'deleted' && !links.canOpenDeleted) continue
    out.push({ key: `f:${f.path}`, text: 'View diff', aria: `View diff of ${f.path}`, onClick: () => links.openFile(f.path) })
  }
  if (item.tool === 'shell') out.push({ key: 'out', text: 'Output', aria: `View output of ${item.command ?? 'command'}`, onClick: () => links.openCommand(item.id) })
  return out
}
