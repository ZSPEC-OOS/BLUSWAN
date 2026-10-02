import ActivityRow from './ActivityRow.jsx'
import { buildActivityLinks, useActivityLinks } from './ActivityLinks.js'

/** A project check (tests, lint, build…): compact result, diagnostics on demand. */
export default function ValidationActivity({ item, defaultOpen = false }) {
  const links = useActivityLinks()
  return <ActivityRow status={item.status} label={item.label} details={item.details} defaultOpen={defaultOpen} kind="validation" links={buildActivityLinks(item, links)} />
}
