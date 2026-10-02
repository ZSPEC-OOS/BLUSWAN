// test validation runner: bounded execution of a discovered test command (observational only —
// never runs fixers or installs).
import { runValidationStep } from './runner.js'

export const runTestStep = ({ step, config, ...rest }) =>
  runValidationStep({ ...rest, step: { ...step, kind: 'test' }, timeoutMs: step.scope === 'focused' ? config.defaultTestTimeoutMs : config.broadTestTimeoutMs })
