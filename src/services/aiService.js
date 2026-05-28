import { KEYS as STORAGE_KEYS } from '../shared/storageKeys.js'
import { detectProvider, toProviderTools, getDevProxyUrl, normalizeBaseUrl } from './providerRegistry.js'
import { STREAM_CHUNK_TIMEOUT_MS, THINKING_BUDGET_TOKENS } from '../config/constants.js'

const MODELS_KEY    = STORAGE_KEYS.LS.AI_MODELS      // localStorage  — config only, NO api keys
const KEYS_SS_KEY   = STORAGE_KEYS.SS.AI_KEYS         // sessionStorage — api keys (primary, clears on tab close)
const KEYS_LS_KEY   = STORAGE_KEYS.LS.AI_KEYS_BACKUP  // localStorage  — api keys encrypted backup (iOS resilience)
const SESSION_KEY_K = STORAGE_KEYS.SS.AI_SESSION_KEY  // sessionStorage — 32 random bytes, base64-encoded

// ── AES-GCM encryption (SubtleCrypto) ────────────────────────────────────────
// Ciphertext format: 'v2:' + base64(12-byte IV || AES-GCM ciphertext)
// The raw key bytes are stored in sessionStorage (cleared on tab close) so an
// offline attacker who reads only localStorage cannot decrypt the backup.
// Legacy XOR-encrypted data (no 'v2:' prefix) is transparently migrated on the
// next save.

const AES_ALGO  = { name: 'AES-GCM', length: 256 }
const IV_BYTES  = 12
const V2_PREFIX = 'v2:'

// Import the session key once and cache the CryptoKey for all subsequent calls.
let _cryptoKeyPromise = null

const SESSION_KEY_PERSIST = SESSION_KEY_K + '-persist' // localStorage fallback for cross-session recovery

async function _getOrCreateCryptoKey() {
  if (_cryptoKeyPromise) return _cryptoKeyPromise
  _cryptoKeyPromise = (async () => {
    try {
      // Primary: sessionStorage. Fallback: localStorage persist key (survives browser restart).
      let rawB64 = sessionStorage.getItem(SESSION_KEY_K)
      if (!rawB64) {
        try { rawB64 = localStorage.getItem(SESSION_KEY_PERSIST) } catch {}
      }
      let rawBytes
      if (rawB64) {
        rawBytes = Uint8Array.from(atob(rawB64), c => c.charCodeAt(0))
      } else {
        rawBytes = crypto.getRandomValues(new Uint8Array(32))
      }
      const b64 = btoa(String.fromCharCode(...rawBytes))
      sessionStorage.setItem(SESSION_KEY_K, b64)
      try { localStorage.setItem(SESSION_KEY_PERSIST, b64) } catch {}
      return await crypto.subtle.importKey('raw', rawBytes, AES_ALGO, false, ['encrypt', 'decrypt'])
    } catch {
      return null   // restricted environment — _xorEncrypt/_xorDecrypt fallbacks used below
    }
  })()
  return _cryptoKeyPromise
}

async function encrypt(text) {
  if (!text) return ''
  try {
    const key = await _getOrCreateCryptoKey()
    if (!key) throw new Error('no key')
    const iv      = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const encoded = new TextEncoder().encode(text)
    const buf     = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
    const combined = new Uint8Array(IV_BYTES + buf.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(buf), IV_BYTES)
    return V2_PREFIX + btoa(String.fromCharCode(...combined))
  } catch {
    return _xorEncrypt(text)   // fallback: restricted browsers / test environments
  }
}

// Auto-detects v2 (AES-GCM) vs legacy XOR format so existing stored keys keep
// working transparently — they will be re-encrypted with AES-GCM on next save.
async function decrypt(text) {
  if (!text) return ''
  try {
    if (text.startsWith(V2_PREFIX)) {
      const key    = await _getOrCreateCryptoKey()
      if (!key) return ''
      const bytes  = Uint8Array.from(atob(text.slice(V2_PREFIX.length)), c => c.charCodeAt(0))
      const iv     = bytes.slice(0, IV_BYTES)
      const cipher = bytes.slice(IV_BYTES)
      const plain  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)
      return new TextDecoder().decode(plain)
    }
    // Legacy XOR path — backward-compatible with data encrypted before this upgrade
    return _xorDecrypt(text)
  } catch {
    return ''
  }
}

// ── Legacy XOR (read-only — migration path only, not used for new writes) ─────
function _xorDecrypt(text) {
  if (!text) return ''
  try {
    const rawB64 = sessionStorage.getItem(SESSION_KEY_K)
    const key = rawB64 ? atob(rawB64) : 'bluswan-fallback-key-xor'
    return atob(text).split('').map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))
    ).join('')
  } catch { return '' }
}

function _xorEncrypt(text) {
  if (!text) return ''
  const rawB64 = sessionStorage.getItem(SESSION_KEY_K) || btoa('bluswan-fallback-key-xor')
  const key = atob(rawB64)
  return btoa(text.split('').map((c, i) =>
    String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))
  ).join(''))
}

const DEFAULT_MODELS = [
  {
    id:      'default-deepseek-chat',
    name:    'DeepSeek Chat',
    baseUrl: 'https://api.deepseek.com/v1',
    modelId: 'deepseek-chat',
    apiKey:  '',
  },
  {
    id:      'default-deepseek-reasoner',
    name:    'DeepSeek Reasoner (R1)',
    baseUrl: 'https://api.deepseek.com/v1',
    modelId: 'deepseek-reasoner',
    apiKey:  '',
  },
]

// Presets removed — users add models manually via the custom model form.

// IDs that were once automatically included but have since been removed from
// DEFAULT_MODELS.  They are silently stripped from saved localStorage configs
// on next load so users don't see orphaned entries they never manually added.
const LEGACY_PRESET_IDS = new Set([
  'preset-kimi-k2-5',
])

export async function loadModels() {
  try {
    // Load model configs (without API keys) from localStorage
    const raw    = localStorage.getItem(MODELS_KEY)
    const parsed = raw !== null ? JSON.parse(raw) : null

    // Migration: strip legacy presets that were removed from DEFAULT_MODELS
    const migrated = parsed
      ? parsed.filter(m => !LEGACY_PRESET_IDS.has(m.id))
      : null

    const configs = migrated || DEFAULT_MODELS

    // Load API keys — sessionStorage (primary) with localStorage backup fallback for iOS
    let keys = {}
    try {
      const keysRaw = sessionStorage.getItem(KEYS_SS_KEY)
      if (keysRaw) {
        const decrypted = JSON.parse(await decrypt(keysRaw))
        keys = decrypted || {}
      } else {
        // sessionStorage was cleared (iOS tab kill) — recover from localStorage backup
        const bakRaw = localStorage.getItem(KEYS_LS_KEY)
        if (bakRaw) {
          const bakDecrypted = JSON.parse(await decrypt(bakRaw))
          keys = bakDecrypted || {}
          // Re-seed sessionStorage from backup so future reads are fast
          sessionStorage.setItem(KEYS_SS_KEY, await encrypt(JSON.stringify(keys)))
        }
      }
    } catch {}

    // Merge: sessionStorage key wins; fall back to any key still in localStorage config (migration)
    return configs.map(m => ({ ...m, apiKey: keys[m.id] ?? m.apiKey ?? '' }))
  } catch {
    return DEFAULT_MODELS
  }
}

export async function saveModels(models) {
  // Persist config (no API keys) to localStorage
  const configs = models.map(({ apiKey, ...rest }) => rest)
  localStorage.setItem(MODELS_KEY, JSON.stringify(configs))

  // Persist API keys — sessionStorage (primary) + localStorage backup (iOS resilience)
  const keys = {}
  models.forEach(m => { if (m.apiKey) keys[m.id] = m.apiKey })
  const encrypted = await encrypt(JSON.stringify(keys))
  sessionStorage.setItem(KEYS_SS_KEY, encrypted)
  try { localStorage.setItem(KEYS_LS_KEY, encrypted) } catch {}
}

// ── Web-search API key (Tavily) ───────────────────────────────────────────────
const SEARCH_KEY_SS = STORAGE_KEYS.SS.SEARCH_KEY

export async function loadSearchKey() {
  try {
    const raw = sessionStorage.getItem(SEARCH_KEY_SS)
    return raw ? await decrypt(raw) : ''
  } catch { return '' }
}

export async function saveSearchKey(key) {
  try {
    if (key) sessionStorage.setItem(SEARCH_KEY_SS, await encrypt(key))
    else      sessionStorage.removeItem(SEARCH_KEY_SS)
  } catch {}
}

// Wipe all stored API keys from both storages
export function clearApiKeys() {
  sessionStorage.removeItem(KEYS_SS_KEY)
  try {
    const raw = localStorage.getItem(MODELS_KEY)
    if (raw) {
      const models = JSON.parse(raw)
      localStorage.setItem(MODELS_KEY, JSON.stringify(
        models.map(({ apiKey, ...rest }) => rest)
      ))
    }
  } catch {}
}

// ── Test connection ───────────────────────────────────────────────────────────
// Sends a minimal non-streaming request to verify the API key and endpoint work.
// Returns { ok: true, model, ms, warning? } or { ok: false, error }
export async function testModelConnection(modelConfig) {
  const { apiKey, baseUrl, modelId } = modelConfig || {}
  if (!apiKey)   return { ok: false, error: 'No API key entered' }
  if (!baseUrl)  return { ok: false, error: 'No base URL configured' }
  if (!modelId)  return { ok: false, error: 'No model ID configured' }

  // Validate that baseUrl is a well-formed absolute URL
  let parsedUrl
  try {
    parsedUrl = new URL(baseUrl)
    if (!parsedUrl.protocol.startsWith('http')) throw new Error('not http')
  } catch {
    return { ok: false, error: `Invalid base URL — must be a full URL (e.g. https://api.openai.com/v1)` }
  }

  // In dev mode, the Vite proxy strips the URL path and replaces it with the
  // correct /v1 prefix automatically.  This means a test against a broken path
  // like https://api.anthropic.com/v99-BROKEN will PASS even though the real
  // URL is wrong — the proxy silently fixes it.  Detect this and warn the user
  // so they aren't misled into thinking a broken URL is working.
  let warning = null
  if (IS_DEV) {
    const proxied = devProxyUrl(baseUrl)
    if (proxied !== baseUrl) {
      // The proxy will override the URL path — check if the configured path looks right.
      // Most providers use /v1 (or a subpath of it) as the base.
      const path = parsedUrl.pathname.replace(/\/$/, '')
      const looksValid =
        path === '/v1' ||
        path.startsWith('/v1/') ||
        path.endsWith('/v1') ||
        path.includes('/v1beta') ||
        path.includes('/openai/v1')
      if (!looksValid) {
        warning =
          `Dev proxy overrode the URL path — test passed but the configured path "${parsedUrl.pathname}" looks wrong. ` +
          `It would fail in production. Expected something like /v1.`
      }
    }
  }

  const t0 = Date.now()
  try {
    const isAnthropic = isAnthropicUrl(baseUrl)
    let url, options

    if (isAnthropic) {
      ;({ url, options } = buildAnthropicRequest(baseUrl, apiKey, modelId, {
        max_tokens: 16,
        stream: false,
        messages: [{ role: 'user', content: 'Hi' }],
      }, modelConfig))
    } else {
      const tokenParam = modelConfig.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'
      ;({ url, options } = buildOpenAIRequest(baseUrl, apiKey, modelId, {
        [tokenParam]: 16,
        stream: false,
        messages: [{ role: 'user', content: 'Hi' }],
      }, modelConfig))
    }

    const res = await fetch(url, options)
    const ms  = Date.now() - t0
    if (!res.ok) {
      const text = await res.text()
      let msg = `HTTP ${res.status}`
      try {
        const parsed = JSON.parse(text)
        msg = parsed?.error?.message || parsed?.message || msg
      } catch {}
      return { ok: false, error: msg }
    }
    return { ok: true, model: modelId, ms, warning }
  } catch (e) {
    const isCors = e.message === 'Failed to fetch' || e.name === 'TypeError'
    return {
      ok: false,
      error: isCors
        ? 'Network error — likely a CORS block. Restart the dev server so the new proxy takes effect.'
        : e.message,
    }
  }
}

// Test Tavily web-search API key with a minimal search request
export async function testSearchConnection(apiKey) {
  if (!apiKey) return { ok: false, error: 'No API key entered' }
  const t0 = Date.now()
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query: 'test', max_results: 1 }),
    })
    const ms = Date.now() - t0
    if (!res.ok) {
      const text = await res.text()
      let msg = `HTTP ${res.status}`
      try { msg = JSON.parse(text)?.detail || msg } catch {}
      return { ok: false, error: msg }
    }
    return { ok: true, ms }
  } catch (e) {
    return { ok: false, error: e.message || 'Network error' }
  }
}

function isAnthropicUrl(baseUrl) {
  return detectProvider(baseUrl).id === 'anthropic'
}

// ── Proxy detection ───────────────────────────────────────────────────────────
// When the Firebase Cloud Function is deployed, VITE_AI_PROXY_URL is set to
// https://us-central1-wolfkrow-ea567.cloudfunctions.net/api
// The proxy holds all API keys as Firebase Secrets — the browser key field
// can be left blank and the model will still work.
const PROXY_URL = import.meta.env?.VITE_AI_PROXY_URL || null

// In dev mode Vite proxies these paths through Node to avoid browser CORS blocks.
// In production the app must be served with a reverse proxy or use PROXY_URL.
const IS_DEV = import.meta.env?.DEV ?? false
function devProxyUrl(baseUrl) {
  return getDevProxyUrl(baseUrl, IS_DEV)
}

// detectProviderName: legacy name needed by buildOpenAIRequest proxy body
function detectProviderName(baseUrl) {
  return detectProvider(baseUrl).id
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const DEFAULT_MAX_TOKENS = 8192

// ── No-tool fallback cache ────────────────────────────────────────────────────
// Models that returned a "tools not supported" error this session are cached here.
// Subsequent calls skip tools entirely so we don't keep erroring.
const NO_TOOL_MODELS = new Set()

function isToolSupportError(errText = '') {
  const t = errText.toLowerCase()
  return (
    t.includes('tool') ||
    t.includes('function call') ||
    t.includes('does not support') ||
    t.includes('not support') ||
    t.includes('unsupported')
  )
}

async function fetchWithRetry(url, options, maxRetries = 4) {
  let delay = 2000
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options)
      if (res.status === 429 && attempt < maxRetries) {
        const retryAfter = res.headers.get('retry-after')
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay
        await sleep(waitMs)
        delay = Math.min(delay * 2, 30000)
        continue
      }
      return res
    } catch (err) {
      // AbortError must propagate immediately — never retry a user-initiated abort
      if (err.name === 'AbortError') throw err
      // Network error / DNS failure etc.
      if (attempt < maxRetries) {
        await sleep(delay)
        delay = Math.min(delay * 2, 30000)
        continue
      }
      throw err
    }
  }
}

async function readChunkWithTimeout(reader, timeoutMs = STREAM_CHUNK_TIMEOUT_MS) {
  let timeoutId
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Stream read timeout')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeoutId)
  }
}

const MAX_STREAM_CHARS = 524288  // 512 KB hard cap — prevents OOM on very long responses

async function readSSEStream(res, onChunk, extractDelta, signal) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let textCapped = false

  while (true) {
    if (signal?.aborted) {
      reader.cancel()
      break
    }
    let done, value
    try {
      ;({ done, value } = await readChunkWithTimeout(reader))
    } catch (err) {
      reader.cancel()
      throw err
    }
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') continue
      try {
        const delta = extractDelta(JSON.parse(data))
        if (delta && !textCapped) {
          fullText += delta
          if (fullText.length > MAX_STREAM_CHARS) {
            fullText = fullText.slice(0, MAX_STREAM_CHARS) + '\n[Response truncated at 512 KB]'
            textCapped = true
          }
          onChunk?.(fullText)
        }
      } catch (e) {
        console.warn('readSSEStream: skipped malformed event', { error: e.message, data: data?.slice(0, 80) })
      }
    }
  }

  return fullText
}

// Build request options — routes through Firebase proxy when VITE_AI_PROXY_URL is set.
// modelConfig is passed through to apply temperature and extended-thinking settings.
function buildAnthropicRequest(baseUrl, apiKey, modelId, body, modelConfig = {}) {
  // Apply temperature — extended thinking requires temperature = 1
  if (modelConfig.enableThinking) {
    body.thinking  = { type: 'enabled', budget_tokens: modelConfig.thinkingBudget || THINKING_BUDGET_TOKENS }
    body.temperature = 1   // required by Anthropic when thinking is enabled
  } else if (modelConfig.temperature !== undefined) {
    body.temperature = modelConfig.temperature
  }

  if (PROXY_URL) {
    return {
      url: `${PROXY_URL}/proxy`,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', body: { model: modelId, ...body } }),
      },
    }
  }
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-allow-browser': 'true',
  }
  if (modelConfig.enableThinking) {
    headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14'
  }
  return {
    url: `${devProxyUrl(baseUrl)}/messages`,
    options: {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelId, ...body }),
    },
  }
}

function buildOpenAIRequest(baseUrl, apiKey, modelId, body, modelConfig = {}) {
  // Some models (e.g. OpenAI o-series) reject max_tokens; use max_completion_tokens instead.
  if (modelConfig.useMaxCompletionTokens && 'max_tokens' in body) {
    body = { ...body, max_completion_tokens: body.max_tokens }
    const { max_tokens: _dropped, ...rest } = body
    body = rest
  }
  if (modelConfig.temperature !== undefined) {
    body.temperature = modelConfig.temperature
  }
  // Kimi K2.5 extended thinking — Moonshot API flag
  if (modelConfig.enableThinking && baseUrl.includes('moonshot.cn')) {
    body.enable_thinking = true
    body.temperature = 1  // Kimi K2.5 requires temperature=1 when thinking is enabled
  }
  if (PROXY_URL) {
    return {
      url: `${PROXY_URL}/proxy`,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: detectProviderName(baseUrl), body: { model: modelId, ...body } }),
      },
    }
  }
  return {
    url: `${devProxyUrl(normalizeBaseUrl(baseUrl))}/chat/completions`,
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelId, ...body }),
    },
  }
}

async function runAnthropicPrompt(modelConfig, messages, onChunk, signal) {
  const { apiKey, baseUrl, modelId } = modelConfig
  const { url, options } = buildAnthropicRequest(baseUrl, apiKey, modelId, {
    max_tokens: modelConfig.maxTokens || DEFAULT_MAX_TOKENS, stream: true, messages,
  }, modelConfig)

  const res = await fetchWithRetry(url, { ...options, signal })
  if (!res.ok) { const err = await res.text(); throw new Error(`AI API error ${res.status}: ${err}`) }

  return readSSEStream(
    res, onChunk,
    (parsed) => parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta'
      ? parsed.delta.text : null,
    signal,
  )
}

async function runOpenAIPrompt(modelConfig, messages, onChunk, signal) {
  const { apiKey, baseUrl, modelId } = modelConfig
  const { url, options } = buildOpenAIRequest(baseUrl, apiKey, modelId, { stream: true, messages }, modelConfig)

  const res = await fetchWithRetry(url, { ...options, signal })
  if (!res.ok) { const err = await res.text(); throw new Error(`AI API error ${res.status}: ${err}`) }

  return readSSEStream(res, onChunk, (parsed) => parsed.choices?.[0]?.delta?.content ?? null, signal)
}

// ── Streaming SSE readers for tool-use responses ─────────────────────────────

const MAX_THINKING_CHARS = 262144  // 256 KB cap for extended-thinking blocks

async function readAnthropicToolStream(res, signal, onTextDelta) {
  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer    = ''
  let fullText  = ''
  let fullTextCapped = false
  // Track all content blocks by index so we can reconstruct _raw in the correct
  // order.  Anthropic requires thinking blocks to be present in subsequent turns
  // when extended thinking is active — stripping them causes a 400 on turn 2+.
  const blocks     = {}   // index → block object (any type)
  const toolBlocks = {}   // index → { id, name, jsonParts[] }  (subset of blocks)
  let stopReason   = null
  // Claude Code-style token usage tracking — captured from message_start / message_delta
  const usage      = { input: 0, output: 0 }

  while (true) {
    if (signal?.aborted) { reader.cancel(); break }
    let done, value
    try {
      ;({ done, value } = await readChunkWithTimeout(reader))
    } catch (err) {
      reader.cancel()
      throw err
    }
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') continue
      try {
        const ev = JSON.parse(data)
        if (ev.type === 'message_start') {
          // Capture input token count from the opening message envelope
          if (ev.message?.usage?.input_tokens) usage.input = ev.message.usage.input_tokens
        } else if (ev.type === 'content_block_start') {
          const cb = ev.content_block
          if (cb?.type === 'tool_use') {
            toolBlocks[ev.index] = { id: cb.id, name: cb.name, jsonParts: [] }
            blocks[ev.index] = { _toolIndex: ev.index }  // placeholder; filled after parse
          } else if (cb?.type === 'thinking') {
            blocks[ev.index] = { type: 'thinking', thinking: '' }
          } else if (cb?.type === 'text') {
            blocks[ev.index] = { type: 'text', text: '' }
          }
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta') {
            if (!fullTextCapped) {
              fullText += ev.delta.text
              if (fullText.length > MAX_STREAM_CHARS) {
                fullText = fullText.slice(0, MAX_STREAM_CHARS)
                fullTextCapped = true
              }
            }
            onTextDelta?.(ev.delta.text)
            if (blocks[ev.index]) blocks[ev.index].text = (blocks[ev.index].text || '') + ev.delta.text
          } else if (ev.delta?.type === 'thinking_delta' && blocks[ev.index]) {
            const cur = blocks[ev.index].thinking || ''
            if (cur.length < MAX_THINKING_CHARS) {
              blocks[ev.index].thinking = cur + ev.delta.thinking
            }
          } else if (ev.delta?.type === 'input_json_delta' && toolBlocks[ev.index]) {
            toolBlocks[ev.index].jsonParts.push(ev.delta.partial_json)
          }
        } else if (ev.type === 'message_delta') {
          stopReason = ev.delta?.stop_reason
          // Capture output token count from the closing delta
          if (ev.usage?.output_tokens) usage.output = ev.usage.output_tokens
        }
      } catch {}
    }
  }

  const toolCalls = Object.values(toolBlocks).map(b => {
    let input = {}
    try { input = JSON.parse(b.jsonParts.join('')) } catch {}
    return { id: b.id, name: b.name, input }
  })

  // _raw: content block array Anthropic needs back in the next assistant message.
  // Must include thinking blocks (if any) in their original index order.
  const _raw = Object.entries(blocks)
    .sort(([a], [b]) => Number(a) - Number(b))
    .flatMap(([, block]) => {
      if (block._toolIndex !== undefined) {
        const tc = toolCalls.find(t => toolBlocks[block._toolIndex]?.id === t.id)
        if (!tc) return []
        return [{ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input }]
      }
      if (block.type === 'thinking' && block.thinking) return [block]
      if (block.type === 'text' && block.text) return [{ type: 'text', text: block.text }]
      return []
    })

  return { text: fullText, toolCalls, isDone: stopReason === 'end_turn' || toolCalls.length === 0, _raw, usage }
}

const MAX_REASONING_CHARS = 262144  // 256 KB cap for reasoning/thinking content

async function readOpenAIToolStream(res, signal, onTextDelta) {
  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer    = ''
  let fullText  = ''
  let fullTextCapped = false
  let reasoningContent = ''
  let reasoningCapped  = false
  const tcMap   = {}   // index → { id, name, argParts[] }
  let finishReason = null
  // Claude Code-style token usage (sent in the final chunk when stream_options.include_usage=true)
  const usage   = { input: 0, output: 0 }

  while (true) {
    if (signal?.aborted) { reader.cancel(); break }
    let done, value
    try {
      ;({ done, value } = await readChunkWithTimeout(reader))
    } catch (err) {
      reader.cancel()
      throw err
    }
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') continue
      try {
        const ev     = JSON.parse(data)
        // Capture usage from the final summary chunk (stream_options.include_usage=true)
        if (ev.usage) {
          if (ev.usage.prompt_tokens)     usage.input  = ev.usage.prompt_tokens
          if (ev.usage.completion_tokens) usage.output = ev.usage.completion_tokens
        }
        const choice = ev.choices?.[0]
        if (!choice) continue
        const delta  = choice.delta
        if (delta?.content) {
          if (!fullTextCapped) {
            fullText += delta.content
            if (fullText.length > MAX_STREAM_CHARS) {
              fullText = fullText.slice(0, MAX_STREAM_CHARS)
              fullTextCapped = true
            }
          }
          onTextDelta?.(delta.content)
        }
        // Kimi K2.5 thinking mode — accumulate reasoning_content (capped to prevent OOM)
        if (delta?.reasoning_content && !reasoningCapped) {
          reasoningContent += delta.reasoning_content
          if (reasoningContent.length > MAX_REASONING_CHARS) {
            reasoningContent = reasoningContent.slice(0, MAX_REASONING_CHARS)
            reasoningCapped = true
          }
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!tcMap[tc.index]) tcMap[tc.index] = { id: '', name: '', argParts: [] }
            if (tc.id)                   tcMap[tc.index].id = tc.id
            if (tc.function?.name)       tcMap[tc.index].name = tc.function.name
            if (tc.function?.arguments)  tcMap[tc.index].argParts.push(tc.function.arguments)
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      } catch {}
    }
  }

  const toolCalls = Object.values(tcMap).map((tc, i) => {
    let input = {}
    try { input = JSON.parse(tc.argParts.join('')) } catch {}
    // Guarantee a non-empty ID — Kimi sometimes omits it after the first delta chunk.
    // The ID in _raw.tool_calls MUST match tool_call_id in tool results, so we
    // derive a stable fallback and apply it to both sides.
    const id = tc.id || `call_${i}_${tc.name || 'tool'}`
    return { id, name: tc.name, input }
  })

  const _raw = {
    role: 'assistant',
    content: fullText || null,
    tool_calls: toolCalls.length > 0
      ? toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } }))
      : undefined,
  }
  // Preserve reasoning_content for providers that require it in multi-turn history (e.g. Kimi K2.5 thinking mode)
  if (reasoningContent) _raw.reasoning_content = reasoningContent

  // isDone when no tool calls to execute — finish_reason can be 'stop', 'tool_calls',
  // or null (stream cut off). We drive the loop by tool call presence, not reason string.
  return { text: fullText, toolCalls, isDone: toolCalls.length === 0, _raw, usage }
}

// ── callWithToolsStreaming — streaming tool-use call ──────────────────────────
// Same interface as callWithTools but streams text tokens via onTextDelta(delta).
export async function callWithToolsStreaming(modelConfig, messages, tools, signal, systemPrompt, onTextDelta) {
  const { apiKey, baseUrl, modelId } = modelConfig
  const isAnthropic = isAnthropicUrl(baseUrl)

  if (isAnthropic) {
    const body = { max_tokens: modelConfig.maxTokens || DEFAULT_MAX_TOKENS, stream: true, tools, messages }
    if (systemPrompt) body.system = systemPrompt
    const { url, options } = buildAnthropicRequest(baseUrl, apiKey, modelId, body, modelConfig)
    const res = await fetchWithRetry(url, { ...options, signal })
    if (!res.ok) { const err = await res.text(); throw new Error(`AI API error ${res.status}: ${err}`) }
    return readAnthropicToolStream(res, signal, onTextDelta)
  }

  const noToolMode = NO_TOOL_MODELS.has(modelId) || !tools?.length
  const providerTools = noToolMode ? [] : toProviderTools(tools, baseUrl)
  const body = noToolMode
    ? { stream: true, messages, stream_options: { include_usage: true } }
    : { stream: true, tools: providerTools, tool_choice: 'auto', messages, stream_options: { include_usage: true } }

  try {
    const { url, options } = buildOpenAIRequest(baseUrl, apiKey, modelId, body, modelConfig)
    const res = await fetchWithRetry(url, { ...options, signal })
    if (!res.ok) {
      const errText = await res.text()
      if (!noToolMode && (res.status === 400 || res.status === 422) && isToolSupportError(errText)) {
        NO_TOOL_MODELS.add(modelId)
        const fallbackBody = { stream: true, messages, stream_options: { include_usage: true } }
        const { url: u2, options: o2 } = buildOpenAIRequest(baseUrl, apiKey, modelId, fallbackBody, modelConfig)
        const res2 = await fetchWithRetry(u2, { ...o2, signal })
        if (!res2.ok) { const e2 = await res2.text(); throw new Error(`AI API error ${res2.status}: ${e2}`) }
        return readOpenAIToolStream(res2, signal, onTextDelta)
      }
      throw new Error(`AI API error ${res.status}: ${errText}`)
    }
    return readOpenAIToolStream(res, signal, onTextDelta)
  } catch (err) {
    if (err.name === 'AbortError') throw err
    if (!noToolMode && isToolSupportError(err.message)) {
      NO_TOOL_MODELS.add(modelId)
      const fallbackBody = { stream: true, messages, stream_options: { include_usage: true } }
      const { url, options } = buildOpenAIRequest(baseUrl, apiKey, modelId, fallbackBody, modelConfig)
      const res = await fetchWithRetry(url, { ...options, signal })
      if (!res.ok) { const e = await res.text(); throw new Error(`AI API error ${res.status}: ${e}`) }
      return readOpenAIToolStream(res, signal, onTextDelta)
    }
    throw err
  }
}

// ── callWithTools — non-streaming call with function/tool schemas ─────────────
// Used by the agentic loop.  Returns a normalised response:
//   { text, toolCalls: [{id, name, input}], isDone, _raw }
// Works with both Anthropic (tool_use blocks) and OpenAI (tool_calls array).
export async function callWithTools(modelConfig, messages, tools, signal, systemPrompt) {
  const { apiKey, baseUrl, modelId } = modelConfig
  const isAnthropic = isAnthropicUrl(baseUrl)

  if (isAnthropic) {
    const body = { max_tokens: modelConfig.maxTokens || DEFAULT_MAX_TOKENS, tools, messages }
    if (systemPrompt) body.system = systemPrompt
    const { url, options } = buildAnthropicRequest(baseUrl, apiKey, modelId, body, modelConfig)
    const res = await fetchWithRetry(url, { ...options, signal })
    if (!res.ok) { const err = await res.text(); throw new Error(`AI API error ${res.status}: ${err}`) }
    const data = await res.json()
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
    const toolCalls = (data.content || [])
      .filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input }))
    return { text, toolCalls, isDone: data.stop_reason === 'end_turn', _raw: data.content }
  }

  // OpenAI / Kimi / any compatible
  const noToolMode = NO_TOOL_MODELS.has(modelId) || !tools?.length
  const providerTools = noToolMode ? [] : toProviderTools(tools, baseUrl)
  const reqBody = noToolMode
    ? { messages }
    : { tools: providerTools, tool_choice: 'auto', messages }

  async function parseOpenAIResponse(res) {
    const data = await res.json()
    const choice = data.choices?.[0]
    const text = choice?.message?.content || ''
    const toolCalls = (choice?.message?.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      input: (() => { try { return JSON.parse(tc.function.arguments || '{}') } catch { return {} } })(),
    }))
    return { text, toolCalls, isDone: choice?.finish_reason === 'stop', _raw: choice?.message }
  }

  try {
    const { url, options } = buildOpenAIRequest(baseUrl, apiKey, modelId, reqBody, modelConfig)
    const res = await fetchWithRetry(url, { ...options, signal })
    if (!res.ok) {
      const errText = await res.text()
      if (!noToolMode && (res.status === 400 || res.status === 422) && isToolSupportError(errText)) {
        NO_TOOL_MODELS.add(modelId)
        const { url: u2, options: o2 } = buildOpenAIRequest(baseUrl, apiKey, modelId, { messages }, modelConfig)
        const res2 = await fetchWithRetry(u2, { ...o2, signal })
        if (!res2.ok) { const e2 = await res2.text(); throw new Error(`AI API error ${res2.status}: ${e2}`) }
        return parseOpenAIResponse(res2)
      }
      throw new Error(`AI API error ${res.status}: ${errText}`)
    }
    return parseOpenAIResponse(res)
  } catch (err) {
    if (err.name === 'AbortError') throw err
    if (!noToolMode && isToolSupportError(err.message)) {
      NO_TOOL_MODELS.add(modelId)
      const { url, options } = buildOpenAIRequest(baseUrl, apiKey, modelId, { messages }, modelConfig)
      const res = await fetchWithRetry(url, { ...options, signal })
      if (!res.ok) { const e = await res.text(); throw new Error(`AI API error ${res.status}: ${e}`) }
      return parseOpenAIResponse(res)
    }
    throw err
  }
}

// Convert Anthropic-style content blocks to OpenAI-compatible format
function toOpenAIContent(content) {
  if (typeof content === 'string') return content
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'image') {
      return {
        type: 'image_url',
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      }
    }
    if (block.type === 'document') {
      try {
        const text = atob(block.source.data)
        return { type: 'text', text }
      } catch {
        return { type: 'text', text: '' }
      }
    }
    return { type: 'text', text: '' }
  })
}

export async function runPrompt(modelConfig, content, context = [], onChunk, signal) {
  const { baseUrl } = modelConfig

  if (isAnthropicUrl(baseUrl)) {
    const messages = [...context, { role: 'user', content }]
    return runAnthropicPrompt(modelConfig, messages, onChunk, signal)
  }

  // OpenAI path: convert content blocks
  const openAIContext = context.map((msg) => ({
    ...msg,
    content: toOpenAIContent(msg.content),
  }))
  const messages = [...openAIContext, { role: 'user', content: toOpenAIContent(content) }]
  return runOpenAIPrompt(modelConfig, messages, onChunk, signal)
}

// A wrapper that retries failed prompt calls (network errors, rate limits) up to maxRetries.
export async function runPromptWithRetry(modelConfig, content, context = [], onChunk, signal, maxRetries = 2) {
  let lastErr = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await runPrompt(modelConfig, content, context, onChunk, signal)
    } catch (err) {
      lastErr = err
      // If aborted, propagate immediately
      if (err.name === 'AbortError') throw err
      // If this was last attempt, throw
      if (attempt === maxRetries) throw err
      // Otherwise wait and retry
      await sleep(1000 * Math.pow(2, attempt))
    }
  }
  throw lastErr
}

// ── countTokensAnthropic — estimate token count before sending ────────────────
// Returns { inputTokens } or throws on error.  Only works for Anthropic models.
// Safe to call at any time — does NOT consume output tokens.
export async function countTokensAnthropic(modelConfig, messages, systemPrompt) {
  const { apiKey, baseUrl, modelId } = modelConfig
  if (!isAnthropicUrl(baseUrl)) throw new Error('countTokensAnthropic: only supported for Anthropic models')

  const body = { model: modelId, messages }
  if (systemPrompt) body.system = systemPrompt

  if (PROXY_URL) {
    const res = await fetchWithRetry(`${PROXY_URL}/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', endpoint: '/v1/messages/count_tokens', body }),
    })
    if (!res.ok) { const err = await res.text(); throw new Error(`Token count error ${res.status}: ${err}`) }
    const data = await res.json()
    return { inputTokens: data.input_tokens }
  }

  const res = await fetchWithRetry(`${baseUrl}/messages/count_tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-allow-browser': 'true',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) { const err = await res.text(); throw new Error(`Token count error ${res.status}: ${err}`) }
  const data = await res.json()
  return { inputTokens: data.input_tokens }
}

// ── callForStructuredOutput — JSON extraction via tool_use / JSON mode ────────
// Asks the model to fill a named tool schema and returns the parsed input object.
// Works with both Anthropic (tool_use blocks) and OpenAI-compat providers
// (tool_calls with JSON mode fallback for models that reject tools).
// toolName:   string  — name of the tool (e.g. 'extract_plan')
// toolSchema: object  — JSON Schema for the tool's input_schema
// prompt:     string  — user instruction
// systemPrompt: string | undefined
// Returns the parsed object on success, throws on error.
export async function callForStructuredOutput(modelConfig, toolName, toolSchema, prompt, systemPrompt) {
  const { apiKey, baseUrl, modelId } = modelConfig

  if (isAnthropicUrl(baseUrl)) {
    const tools = [{ name: toolName, description: toolSchema.description || toolName, input_schema: toolSchema }]
    const messages = [{ role: 'user', content: prompt }]
    const body = {
      max_tokens: modelConfig.maxTokens || DEFAULT_MAX_TOKENS,
      tools,
      tool_choice: { type: 'tool', name: toolName },
      messages,
    }
    if (systemPrompt) body.system = systemPrompt
    const { url, options } = buildAnthropicRequest(baseUrl, apiKey, modelId, body)
    const res = await fetchWithRetry(url, options)
    if (!res.ok) { const err = await res.text(); throw new Error(`AI API error ${res.status}: ${err}`) }
    const data = await res.json()
    const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === toolName)
    if (!toolUse) throw new Error(`callForStructuredOutput: model did not call tool '${toolName}'`)
    return toolUse.input
  }

  // OpenAI-compat path (DeepSeek, Groq, OpenAI, etc.) — try tool_calls first,
  // then fall back to JSON mode if the model rejects function calling.
  const openAITools = [{
    type: 'function',
    function: { name: toolName, description: toolSchema.description || toolName, parameters: toolSchema },
  }]
  const messages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }]

  async function tryToolCall() {
    const body = {
      tools: openAITools,
      tool_choice: { type: 'function', function: { name: toolName } },
      messages,
    }
    const { url, options } = buildOpenAIRequest(baseUrl, apiKey, modelId, body, modelConfig)
    const res = await fetchWithRetry(url, options)
    if (!res.ok) {
      const errText = await res.text()
      if ((res.status === 400 || res.status === 422) && isToolSupportError(errText)) return null
      throw new Error(`AI API error ${res.status}: ${errText}`)
    }
    const data = await res.json()
    const tc = data.choices?.[0]?.message?.tool_calls?.[0]
    if (!tc) return null
    try { return JSON.parse(tc.function.arguments || '{}') } catch { return null }
  }

  // Models known to reject response_format (e.g. deepseek-reasoner / R1 variants).
  // These use plain-text JSON extraction instead.
  function supportsJsonMode(id) {
    return !id.includes('reasoner') && !id.includes('-r1')
  }

  async function tryJsonMode() {
    const jsonPrompt = `${prompt}\n\nRespond ONLY with a valid JSON object matching this schema:\n${JSON.stringify(toolSchema, null, 2)}`
    const baseMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: jsonPrompt }]
      : [{ role: 'user', content: jsonPrompt }]
    const body = supportsJsonMode(modelId)
      ? { response_format: { type: 'json_object' }, messages: baseMessages }
      : { messages: baseMessages }
    const { url, options } = buildOpenAIRequest(baseUrl, apiKey, modelId, body, modelConfig)
    const res = await fetchWithRetry(url, options)
    if (!res.ok) { const err = await res.text(); throw new Error(`AI API error ${res.status}: ${err}`) }
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content || ''
    // Extract JSON from response — models without json_mode may wrap it in prose or markdown
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('callForStructuredOutput: model returned no JSON object')
    try { return JSON.parse(jsonMatch[0]) } catch { throw new Error('callForStructuredOutput: model returned invalid JSON') }
  }

  const result = await tryToolCall()
  if (result !== null) return result
  NO_TOOL_MODELS.add(modelId)
  return tryJsonMode()
}
