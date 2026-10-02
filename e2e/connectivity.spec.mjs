// Connectivity, recovery and multi-user behaviour with the real server behind a controllable front server.
import { test, expect } from '@playwright/test'
import { ctl, send, openRepo, composer, conversationLog, openSidebar, banner } from './helpers.mjs'

let repo
test.beforeEach(async ({ request }) => { ({ repo } = await ctl.reset(request)) })

const screen = (page) => page.locator('.conn-screen')

test.describe('boot failures', () => {
  test('runtime not running: explains, retries by itself, and continues without a reload @mobile', async ({ page, request }) => {
    await ctl.post(request, 'backend/stop')
    await page.goto('/')
    await expect(screen(page)).toContainText('could not reach its runtime')
    await expect(screen(page).getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(screen(page)).not.toContainText('stored on the server')
    await ctl.post(request, 'backend/start')
    await expect(composer(page)).toBeVisible({ timeout: 20_000 }) // automatic bounded retry; no reload
    await expect(screen(page)).toHaveCount(0)
  })

  test('"Try again" reruns the sequence immediately; connection details pinpoint the failing stage', async ({ page, request }) => {
    await ctl.post(request, 'backend/stop')
    await page.goto('/')
    await expect(screen(page)).toContainText('could not reach its runtime')
    await screen(page).getByRole('button', { name: 'Connection details' }).click()
    await expect(page.getByRole('region', { name: 'Connection details' })).toContainText('Runtime address')
    await ctl.post(request, 'backend/start')
    await screen(page).getByRole('button', { name: 'Try again' }).click()
    await expect(composer(page)).toBeVisible({ timeout: 10_000 })
  })

  test('runtime up but not ready (storage): says so, pauses, and recovers when storage returns', async ({ page, request }) => {
    await ctl.post(request, 'ready-fail', '?on=1')
    await page.goto('/')
    await expect(screen(page)).toContainText('Storage is unavailable')
    await expect(screen(page)).toContainText('coding is paused')
    await ctl.post(request, 'ready-fail', '?on=0')
    await expect(composer(page)).toBeVisible({ timeout: 20_000 })
  })

  test('a runtime from a different release asks for a reload and does not load data', async ({ page, request }) => {
    await ctl.post(request, 'health-protocol', '?v=2')
    await page.goto('/')
    await expect(screen(page)).toContainText('do not match')
    await expect(screen(page).getByRole('button', { name: 'Reload' })).toBeVisible()
    await ctl.post(request, 'health-protocol', '')
    await screen(page).getByRole('button', { name: 'Reload' }).click()
    await expect(composer(page)).toBeVisible()
  })

  test('expired credentials at load: sign-in prompt, no retry storm, recovers after refresh', async ({ page, request }) => {
    await ctl.post(request, 'token/expire', '?user=alice')
    await page.goto('/')
    await expect(screen(page)).toContainText('session has expired')
    await ctl.post(request, 'token/refresh', '?user=alice')
    await screen(page).getByRole('button', { name: 'Try again' }).click()
    await expect(composer(page)).toBeVisible()
  })
})

test.describe('offline and reconnect', () => {
  test('cached conversations stay readable offline, actions are disabled, and the app recovers without a reload @mobile', async ({ page, request }) => {
    await page.goto('/')
    await send(page, 'hello cached')
    await expect(page.getByText('Completed').first()).toBeVisible()
    await page.reload() // bootstrap now lists the conversation and the index cache is written
    await expect(composer(page)).toBeVisible()
    await ctl.post(request, 'backend/stop')
    await page.reload()
    await expect(banner(page)).toContainText('Offline — showing your saved conversations')
    await openSidebar(page)
    await expect(page.getByRole('navigation', { name: 'Conversation list' })).toContainText('Hello cached')
    const close = page.getByRole('button', { name: 'Close sidebar' })
    if (await close.isVisible().catch(() => false)) await close.click() // phone drawer
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled()
    await expect(composer(page)).toBeVisible()
    await ctl.post(request, 'backend/start')
    await banner(page).getByRole('button', { name: 'Try now' }).click()
    await expect(banner(page)).toHaveCount(0, { timeout: 15_000 })
    await send(page, 'hello again')
    await expect(conversationLog(page)).toContainText('Hello from the scripted model.')
  })

  test('runtime restart while open: reconnects, keeps the conversation, no duplicate messages', async ({ page, request }) => {
    await page.goto('/')
    await send(page, 'hello before restart')
    await expect(page.getByText('Completed').first()).toBeVisible()
    await ctl.post(request, 'backend/restart')
    await expect(banner(page)).toHaveCount(0, { timeout: 20_000 }) // reconnecting banner disappears once online
    await send(page, 'hello after restart')
    await expect(conversationLog(page).getByRole('article', { name: 'Your message' })).toHaveCount(2)
    await expect(conversationLog(page).getByRole('article', { name: 'BLUSWAN' })).toHaveCount(2)
    await page.reload()
    await expect(conversationLog(page).getByRole('article', { name: 'Your message' })).toHaveCount(2)
  })

  test('the event stream drops mid-run: the turn finishes, nothing is duplicated or lost', async ({ page, request }) => {
    await page.goto('/')
    await send(page, 'slow stream')
    await expect(conversationLog(page)).toContainText('tick 3')
    await ctl.post(request, 'stream/drop')
    await expect(conversationLog(page)).toContainText('tick 12', { timeout: 20_000 }) // the run kept going; the client resynced
    const text = await conversationLog(page).innerText()
    for (const n of [3, 5, 8, 10]) expect(text.match(new RegExp(`tick ${n} `, 'g'))?.length ?? 0, `tick ${n}`).toBe(1)
    await page.getByRole('button', { name: 'Stop BLUSWAN' }).click()
    await expect(page.getByRole('button', { name: 'Stop BLUSWAN' })).toHaveCount(0)
  })

  test('stream blocked (network loss): banner shows, then clears when it returns', async ({ page, request }) => {
    await page.goto('/')
    await expect(composer(page)).toBeVisible()
    await ctl.post(request, 'stream/block', '?on=1')
    await expect(banner(page)).toContainText('Connection lost — reconnecting', { timeout: 10_000 })
    await ctl.post(request, 'stream/block', '?on=0')
    await expect(banner(page)).toHaveCount(0, { timeout: 20_000 })
  })

  test('credentials expire while open: asks to sign in again instead of retrying forever; recovers after refresh', async ({ page, request }) => {
    await page.goto('/')
    await expect(composer(page)).toBeVisible()
    await ctl.post(request, 'token/expire', '?user=alice')
    await ctl.post(request, 'stream/drop')
    await expect(banner(page)).toContainText('session has expired', { timeout: 15_000 })
    const before = (await ctl.get(request, 'stats')).requests
    await page.waitForTimeout(2500)
    expect((await ctl.get(request, 'stats')).requests - before).toBeLessThan(4) // no reconnect storm
    await ctl.post(request, 'token/refresh', '?user=alice')
    await banner(page).getByRole('button', { name: 'Try again' }).click()
    await expect(banner(page)).toHaveCount(0, { timeout: 15_000 })
  })

  test('runtime restarts during a run: the run is stopped cleanly, work is kept, and the conversation continues', async ({ page, request }) => {
    await page.goto('/')
    await send(page, 'slow work')
    await expect(conversationLog(page)).toContainText('tick 2')
    await ctl.post(request, 'backend/restart')
    await expect(banner(page)).toHaveCount(0, { timeout: 20_000 })
    await page.reload()
    await expect(conversationLog(page)).toContainText(/Stopped|interrupted/i) // a graceful shutdown cancels the run; a crash would restore it as interrupted
    await send(page, 'hello after interruption')
    await expect(conversationLog(page)).toContainText('Hello from the scripted model.')
  })
})

test.describe('isolation, outages and workspace loss', () => {
  test('two users never see each other\'s conversations', async ({ browser, request }) => {
    const a = await browser.newContext(); const b = await browser.newContext()
    await a.addCookies([{ name: 'e2e_user', value: 'alice', url: 'http://127.0.0.1:4173' }])
    await b.addCookies([{ name: 'e2e_user', value: 'bob', url: 'http://127.0.0.1:4173' }])
    const pa = await a.newPage(); const pb = await b.newPage()
    await pa.goto('http://127.0.0.1:4173/'); await pb.goto('http://127.0.0.1:4173/')
    await send(pa, 'alice secret plan')
    await expect(pa.getByText('Completed').first()).toBeVisible()
    await pb.reload()
    await expect(composer(pb)).toBeVisible()
    await expect(pb.locator('body')).not.toContainText('alice secret plan')
    await pa.reload()
    await expect(pa.getByRole('navigation', { name: 'Conversation list' })).toContainText('Alice secret plan')
    const id = (await (await a.request.get('http://127.0.0.1:4173/api/sessions')).json()).items[0].id
    expect((await b.request.get(`http://127.0.0.1:4173/api/sessions/${id}`)).status()).toBe(404)
    await a.close(); await b.close(); void request
  })

  test('a provider outage fails the turn clearly while the rest of the app stays usable', async ({ page, request }) => {
    await page.goto('/')
    await ctl.post(request, 'provider', '?mode=outage')
    await send(page, 'hello during outage')
    await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 15_000 })
    await expect(banner(page)).toHaveCount(0) // the runtime itself is fine
    await page.getByRole('button', { name: 'Open settings' }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    await page.getByRole('button', { name: 'Close settings' }).click()
    await ctl.post(request, 'provider', '?mode=ok')
    await send(page, 'hello after outage')
    await expect(conversationLog(page)).toContainText('Hello from the scripted model.')
  })

  test('the repository disappears: the conversation survives and the app does not collapse', async ({ page, request }) => {
    await page.goto('/')
    await openRepo(page, repo)
    await send(page, 'hello repo')
    await expect(page.getByText('Completed').first()).toBeVisible()
    await ctl.post(request, 'backend/stop')
    await ctl.post(request, 'repo/move', '?on=1')
    await ctl.post(request, 'backend/start')
    await page.reload()
    await expect(conversationLog(page)).toContainText('hello repo')
    await expect(page.getByText(/Workspace unavailable/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible()
    await ctl.post(request, 'repo/move', '?on=0')
  })
})

test.describe('phone layout', () => {
  test('connection screen and offline banner fit a phone, with usable touch targets @mobile', async ({ page, request }) => {
    await ctl.post(request, 'backend/stop')
    await page.goto('/')
    await expect(screen(page)).toContainText('could not reach its runtime')
    const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    expect(noScroll, 'no horizontal scrolling').toBe(true)
    for (const name of ['Try again', 'Connection details']) {
      const box = await screen(page).getByRole('button', { name }).boundingBox()
      expect(box.height, `${name} is at least 44px tall`).toBeGreaterThanOrEqual(43)
    }
    await ctl.post(request, 'backend/start')
    await expect(composer(page)).toBeVisible({ timeout: 20_000 })
    const input = await composer(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    expect(input, 'composer text is at least 16px so iOS does not zoom').toBeGreaterThanOrEqual(16)
  })
})
