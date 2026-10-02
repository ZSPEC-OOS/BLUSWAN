// Connection screen, banner and diagnostics rendering (server-side, no DOM).
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { importComponent, render, h } from '../testing/renderJsx.mjs'

let Screen, Banner, Diag
before(async () => {
  Screen = (await importComponent('status/ConnectionScreen.jsx')).default
  Banner = (await importComponent('status/ConnectionBanner.jsx')).default
  Diag = (await importComponent('status/DiagnosticsPanel.jsx')).default
})
const noop = () => {}
const fail = (kind, extra = {}) => ({ state: 'server_unreachable', usable: false, failure: { kind, retryable: true, status: null, requestId: null, ...extra } })

describe('ConnectionScreen', () => {
  it('shows progress (never a blank page) while connecting', async () => {
    for (const state of ['starting', 'checking_server', 'authenticating', 'loading_bootstrap', 'connecting_stream']) {
      const html = await render(await h(Screen, { connection: { state } }))
      assert.match(html, /role="status"/); assert.match(html, /conn-card__spinner/); assert.match(html, /BLUSWAN/)
    }
    assert.match(await render(await h(Screen, { connection: { state: 'checking_server' } })), /Checking BLUSWAN/)
  })
  it('each failure kind gets its own explanation and actions', async () => {
    const cases = {
      server_unreachable: [/could not reach its runtime/, /Try again/, /Connection details/],
      server_not_ready: [/runtime is starting/, /Try again/],
      authentication_failed: [/session has expired/, /Sign in again/],
      persistence_unavailable: [/Storage is unavailable[\s\S]*coding is paused/, /Try again/],
      workspace_host_unavailable: [/workspace location is unavailable[\s\S]*keep working/, /Try again/],
      configuration_error: [/misconfigured/, /Connection details/],
      client_server_version_mismatch: [/do not match/, /Reload/],
    }
    for (const [kind, res] of Object.entries(cases)) {
      const html = await render(await h(Screen, { connection: fail(kind), onRetry: noop, onSignIn: noop, onReload: noop }))
      assert.match(html, /role="alert"/, kind)
      for (const re of res) assert.match(html, re, `${kind}: ${re}`)
    }
  })
  it('does not offer actions that cannot work and never claims conversations are stored on the server', async () => {
    const html = await render(await h(Screen, { connection: fail('server_unreachable') }))
    assert.doesNotMatch(html, /<button[^>]*>Try again/); assert.doesNotMatch(html, /stored on the server/i)
    assert.doesNotMatch(await render(await h(Screen, { connection: fail('authentication_failed') })), /<button[^>]*>Sign in again/)
  })
  it('shows the status code, request id, retry countdown, URL warnings and mobile guidance', async () => {
    const html = await render(await h(Screen, {
      connection: fail('server_unreachable', { status: 502, requestId: 'req-abc12345' }), onRetry: noop, mobile: true,
      warnings: [{ code: 'localhost_api_from_remote_page', message: 'This device is trying to reach a runtime at "localhost"' }],
    }))
    assert.match(html, /HTTP 502/); assert.match(html, /req-abc12345/); assert.match(html, /trying to reach a runtime at &quot;localhost&quot;|trying to reach a runtime at "localhost"/); assert.match(html, /not “localhost”/)
  })
  it('a configuration message overrides the default detail', async () => {
    assert.match(await render(await h(Screen, { kind: 'configuration_error', message: 'VITE_BLUSWAN_API_URL must be absolute.' })), /VITE_BLUSWAN_API_URL must be absolute/)
  })
})

describe('ConnectionBanner', () => {
  it('renders nothing while online', async () => {
    assert.equal(await render(await h(Banner, { connection: { state: 'online' } })), '')
    assert.equal(await render(await h(Banner, { connection: null })), '')
  })
  it('reflects reconnecting, offline cache, auth and version problems', async () => {
    assert.match(await render(await h(Banner, { connection: { state: 'reconnecting' } })), /Connection lost — reconnecting/)
    const off = await render(await h(Banner, { connection: { state: 'offline_cached', offlineIndex: true }, onRetry: noop, onDetails: noop }))
    assert.match(off, /Offline — showing your saved conversations/); assert.match(off, /Try now/); assert.match(off, /Details/)
    assert.match(await render(await h(Banner, { connection: { state: 'auth_error', failure: { kind: 'authentication_failed' } }, onSignIn: noop })), /Sign in again/)
    assert.match(await render(await h(Banner, { connection: { state: 'server_error', failure: { kind: 'client_server_version_mismatch' } } })), /Reload/)
  })
})

describe('DiagnosticsPanel', () => {
  it('lists versions, address and state, and no credentials', async () => {
    const html = await render(await h(Diag, { connection: { state: 'server_unreachable', failure: { kind: 'server_unreachable', stage: 'checking_server', requestId: 'req-1234abcd' } }, apiUrl: 'https://rt.example.com', diagnose: async () => ({}) }))
    assert.match(html, /https:\/\/rt\.example\.com/); assert.match(html, /server_unreachable while checking server/); assert.match(html, /req-1234abcd/); assert.match(html, /Run checks/)
    assert.doesNotMatch(html, /token|authorization/i)
  })
})
