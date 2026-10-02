// typecheck validation runner: bounded execution of a discovered typecheck command (observational only —
// never runs fixers or installs).
import { runValidationStep } from './runner.js'

export const runTypecheckStep = ({ step, config, ...rest }) =>
  runValidationStep({ ...rest, step: { ...step, kind: 'typecheck' }, timeoutMs: config.defaultTypecheckTimeoutMs })
