// build validation runner: bounded execution of a discovered build command (observational only —
// never runs fixers or installs).
import { runValidationStep } from './runner.js'

export const runBuildStep = ({ step, config, ...rest }) =>
  runValidationStep({ ...rest, step: { ...step, kind: 'build' }, timeoutMs: config.defaultBuildTimeoutMs })
