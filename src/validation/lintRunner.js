// lint validation runner: bounded execution of a discovered lint command (observational only —
// never runs fixers or installs).
import { runValidationStep } from './runner.js'

export const runLintStep = ({ step, config, ...rest }) =>
  runValidationStep({ ...rest, step: { ...step, kind: 'lint' }, timeoutMs: config.defaultLintTimeoutMs })
