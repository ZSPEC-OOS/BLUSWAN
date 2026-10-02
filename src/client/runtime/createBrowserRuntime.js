// Composes the runtime for the web client: interactive approvals, user settings applied to the provider.
// The browser has no filesystem or shell, so repository tools need a host that supplies a workspace
// manager (see scripts/host.mjs); without one the runtime still chats but offers no repository tools.
import { createAgentRuntime } from '../../agent/runtime.js'
import { createProviderRegistry } from '../../providers/registry.js'
import { createDeepSeekProvider, DEEPSEEK_ID } from '../../providers/deepseek.js'
import { getProviderConfig, getRuntimeConfig } from '../../config/runtimeConfig.js'

/** @param {{settings:object, workspaces?:object|null, config?:object}} options */
export function createBrowserRuntime({ settings, workspaces = null, config = getRuntimeConfig() }) {
  const provider = createDeepSeekProvider({ getConfig: () => settings.resolveProviderConfig(getProviderConfig(DEEPSEEK_ID, config)) })
  const runtime = createAgentRuntime({
    providers: createProviderRegistry([provider]), workspaces, approvals: 'interactive',
    config: { ...config, permissionMode: settings.get().permissionMode },
  })
  return runtime
}

/** The model the next new session should use. */
export const selectedModel = (settings, config = getRuntimeConfig()) => ({
  provider: settings.get().provider || DEEPSEEK_ID,
  model: settings.get().model || getProviderConfig(DEEPSEEK_ID, config).model || '',
})
