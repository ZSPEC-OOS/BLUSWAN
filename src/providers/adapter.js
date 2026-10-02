// Builds a ProviderAdapter from a protocol description. All four adapters are produced here, so streaming,
// timeouts, cancellation and error mapping behave identically; each provider file only describes its wire format.
import { getRuntimeConfig, getProviderConfig } from '../config/runtimeConfig.js'
import { streamResponse } from './transport.js'

/** Throws configuration_error when credentials, base URL or model are missing. Messages name server variables only. */
export function validateProviderConfig({ errors, label, envPrefix }, config, model) {
  if (!config?.apiKey) throw errors.configuration(`${label} API key is not configured on the server (set ${envPrefix}_API_KEY).`)
  if (!config.baseUrl) throw errors.configuration(`${label} base URL is not configured.`)
  if (!model) throw errors.configuration(`No ${label} model selected (set ${envPrefix}_MODEL).`)
}

/**
 * @param {{ id:string, label:string, envPrefix:string, errors:object, protocol:object, capabilitiesFor:(model:string)=>object,
 *           models:object[], getConfig?:()=>object, fetchImpl?:typeof fetch, requestTimeoutMs?:number, streamTimeoutMs?:number }} d
 */
export function createAdapter({ id, label, envPrefix, errors, protocol, capabilitiesFor, models, getConfig = () => getProviderConfig(id), fetchImpl, requestTimeoutMs, streamTimeoutMs }) {
  const ctx = { errors, label, envPrefix }
  return {
    id,
    label,
    capabilities: capabilitiesFor,
    normalizeMessages: protocol.normalizeMessages,
    normalizeTools: protocol.normalizeTools,
    /** Known models plus whatever the server is configured to use. */
    listModels() {
      const configured = getConfig()?.model
      const out = models.map(m => ({ provider: id, id: m.id, displayName: m.displayName ?? m.id, capabilities: capabilitiesFor(m.id), known: true }))
      if (configured && !out.some(m => m.id === configured)) out.unshift({ provider: id, id: configured, displayName: configured, capabilities: capabilitiesFor(configured), known: false })
      return out
    },
    validate: (model) => { const c = getConfig(); validateProviderConfig(ctx, c, model || c?.model) },

    async stream(request, { onEvent }) {
      const config = getConfig()
      const model = request.model || config.model
      validateProviderConfig(ctx, config, model)
      const caps = capabilitiesFor(model)
      const rt = getRuntimeConfig()
      return streamResponse({
        id, label, errors, request: { ...request, model }, config, caps, onEvent, fetchImpl,
        build: protocol.build, createParser: protocol.createParser,
        requestTimeoutMs: requestTimeoutMs ?? rt.requestTimeoutMs, streamTimeoutMs: streamTimeoutMs ?? rt.streamTimeoutMs,
      })
    },
  }
}
