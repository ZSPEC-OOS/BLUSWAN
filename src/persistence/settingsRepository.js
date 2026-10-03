// User preferences that are safe to store: permission mode, model name, UI choices. Provider credentials are
// never settings — they come from the server's credential store.
import { assertAdapter } from './persistence.js'
import { isModelMode } from '../protocol/schemas.js'
import { isPermissionMode, DEFAULT_PERMISSION_MODE } from '../tools/permissionModes.js'

export const sanitizeSettings = (s = {}) => ({
  permissionMode: isPermissionMode(s.permissionMode) ? s.permissionMode : DEFAULT_PERMISSION_MODE,
  provider: typeof s.provider === 'string' ? s.provider.slice(0, 40) : '', // '' = no explicit choice; the server picks a configured provider
  modelMode: isModelMode(s.modelMode) || s.modelMode === 'manual' ? s.modelMode : '', // '' = no explicit choice (server default); 'manual' = a specific provider/model was chosen
  model: typeof s.model === 'string' ? s.model.trim().slice(0, 100) : '',
})

export function createSettingsRepository(adapter, { userId }) {
  assertAdapter(adapter)
  return {
    async load() { return sanitizeSettings(await adapter.loadSettings(userId) ?? {}) },
    async save(settings) { return adapter.saveSettings(userId, sanitizeSettings(settings)) },
  }
}
