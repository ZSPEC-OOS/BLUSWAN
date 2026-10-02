// Display names for providers. Display data only — no protocol behaviour depends on it.
export const PROVIDER_LABEL = Object.freeze({ deepseek: 'DeepSeek', kimi: 'Kimi', openai: 'OpenAI', anthropic: 'Anthropic' })
export const providerLabel = (id) => PROVIDER_LABEL[id] ?? String(id ?? '')
