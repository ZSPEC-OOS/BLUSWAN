import ActivityRow from './ActivityRow.jsx'
import { buildActivityLinks, useActivityLinks } from './ActivityLinks.js'

/** A single tool action. The raw tool name appears only inside the expanded details. */
export default function ToolActivity({ item, defaultOpen = false }) {
  const links = useActivityLinks()
  const details = [...item.details]
  if (item.tool && defaultOpen) details.push(`tool: ${item.tool}`)
  return <ActivityRow status={item.status} label={item.label} details={details} subdued={item.subdued && item.status !== 'running'} defaultOpen={defaultOpen} links={buildActivityLinks(item, links)} kind={item.error?.code === 'permission_denied' ? 'blocked' : undefined} />
}
