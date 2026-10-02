// User-facing permission modes mapped onto the tool-effect classes (see permissions.js).
// Deterministic: (mode, effect) → allow | ask | block. `prohibited` is blocked in every mode.
//
//   effect             Ask    Auto Edit   Full Auto
//   read               allow  allow       allow
//   workspace_write    ask    allow       allow
//   destructive        ask    ask         allow
//   dependency_change  ask    ask         allow
//   external_effect    ask    ask         ask      (publishing, pushing, network — never silent)
//   prohibited         block  block       block
//
// "Safe validation" (project test/lint/build commands run by the validation engine) is pre-screened
// by the command classifier and is automatic in every mode.
import { redactSecrets } from '../utils/redact.js'

export const PERMISSION_MODES = Object.freeze(['ask', 'auto_edit', 'full_auto'])
export const DEFAULT_PERMISSION_MODE = 'auto_edit'

export const MODE_INFO = Object.freeze({
  ask: { label: 'Ask', description: 'Reads and safe checks run automatically; edits, deletions, installs and anything external need your approval.' },
  auto_edit: { label: 'Auto Edit', description: 'Edits and safe commands run automatically; deletions, installs and anything external need your approval.' },
  full_auto: { label: 'Full Auto', description: 'Workspace operations run automatically, including deletions and installs; external effects still ask and unsafe commands stay blocked.' },
})

const TABLE = Object.freeze({
  ask: { read: 'allow', workspace_write: 'ask', destructive: 'ask', dependency_change: 'ask', external_effect: 'ask', prohibited: 'block' },
  auto_edit: { read: 'allow', workspace_write: 'allow', destructive: 'ask', dependency_change: 'ask', external_effect: 'ask', prohibited: 'block' },
  full_auto: { read: 'allow', workspace_write: 'allow', destructive: 'allow', dependency_change: 'allow', external_effect: 'ask', prohibited: 'block' },
})

export const isPermissionMode = (m) => PERMISSION_MODES.includes(m)

/** @returns {'allow'|'ask'|'block'} unknown modes/effects fail closed to "ask"/"block". */
export function decidePermission(mode, effect) {
  if (effect === 'prohibited') return 'block'
  return TABLE[mode]?.[effect] ?? 'ask'
}

export const BLOCKED_MESSAGE = 'This command is blocked by workspace safety policy.'

const EFFECT_NOTE = {
  workspace_write: 'This may modify files in the workspace.',
  destructive: 'This can delete files.',
  dependency_change: 'This changes project dependencies.',
  external_effect: 'This may have effects outside the workspace (network or remote services).',
}

function patchPaths(patch) {
  return [...new Set([...String(patch ?? '').matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)].map(m => m[1]).filter(p => p !== '/dev/null'))]
}

/**
 * Plain-language, secret-free description of what is being asked, for the approval prompt.
 * @returns {{action:string, description:string, command?:string, paths?:string[]}}
 */
export function describePermission({ tool, input = {}, effect }) {
  const note = EFFECT_NOTE[effect] ?? ''
  switch (tool) {
    case 'shell': return { action: 'run', command: redactSecrets(String(input.command ?? '')).slice(0, 400), description: note }
    case 'delete_file': return { action: 'delete', paths: [input.path], description: 'This permanently deletes the file.' }
    case 'write_file': return { action: 'write', paths: [input.path], description: 'This creates the file or replaces its content.' }
    case 'apply_patch': return { action: 'modify', paths: patchPaths(input.patch), description: 'This modifies the listed files.' }
    default: return { action: tool, description: note }
  }
}
