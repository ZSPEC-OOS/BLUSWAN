import ActivityRow from './ActivityRow.jsx'

/** A project check (tests, lint, build…): compact result, diagnostics on demand. */
export default function ValidationActivity({ item, defaultOpen = false }) {
  return <ActivityRow status={item.status} label={item.label} details={item.details} defaultOpen={defaultOpen} kind="validation" />
}
