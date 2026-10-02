// Model-aware token budget: how much input a request may use.
//
//   availableInputTokens = contextWindow − reservedOutputTokens − reservedSafetyTokens − toolTokens
//
// The window and output limit come from provider/model capability metadata; nothing is hard-coded
// to one model. Compaction starts at `compactionThreshold` and aims for `compactionTarget`.
import { resolveContextConfig } from '../config/runtimeConfig.js'

/**
 * @param {{capabilities:{contextWindow:number,maxOutputTokens?:number}, config?:object, toolTokens?:number,
 *          requestedOutputTokens?:number}} args
 */
export function createTokenBudget({ capabilities, config = {}, toolTokens = 0, requestedOutputTokens }) {
  const cfg = resolveContextConfig(config)
  const contextWindow = capabilities.contextWindow
  const wanted = requestedOutputTokens ?? (cfg.reservedOutputTokens || cfg.maxOutputTokens)
  const reservedOutputTokens = Math.min(wanted, capabilities.maxOutputTokens ?? wanted)
  const reservedSafetyTokens = cfg.contextSafetyMarginTokens
  const availableInputTokens = contextWindow - reservedOutputTokens - reservedSafetyTokens - toolTokens
  return {
    contextWindow,
    reservedOutputTokens,
    reservedSafetyTokens,
    toolTokens,
    availableInputTokens,
    compactionThreshold: Math.floor(Math.max(availableInputTokens, 0) * cfg.compactionThresholdRatio),
    compactionTarget: Math.floor(Math.max(availableInputTokens, 0) * cfg.compactionTargetRatio),
  }
}
