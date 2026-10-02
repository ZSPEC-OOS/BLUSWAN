// Phase 12 — Mobile workspace UX: header, Workspace drawer, Settings, stability, overflow, keyboard, orientation.
import { test, expect } from '@playwright/test'
import { ctl, send, openRepo, composer, conversationLog, closeSidebar } from './helpers.mjs'

let repo
test.beforeEach(async ({ request }) => { ({ repo } = await ctl.reset(request)) })

const PHONE = { width: 390, height: 844 }
const header = (page) => page.locator('.mhead')
const menu = (page) => page.getByRole('button', { name: /^Open workspace menu/ }).first()
const workspace = (page) => page.getByRole('dialog', { name: 'Workspace' })
const settings = (page) => page.getByRole('dialog', { name: 'Settings' })
const noOverflow = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal overflow').toBe(true)
const streams = async (request) => (await ctl.get(request, 'stats')).proxiedStreams

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

test.describe('phone composition', () => {
  test('the default screen is header, conversation and composer — without the desktop toolbar', async ({ page }) => {
    await page.goto('/')
    await expect(composer(page)).toBeVisible()
    await expect(header(page)).toBeVisible()
    await expect(menu(page)).toBeVisible(); await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible()
    await expect(header(page)).toContainText('BLUSWAN'); await expect(page.getByTestId('mobile-context')).toHaveText('No repository')
    for (const gone of [page.getByRole('combobox', { name: 'Model' }), page.getByRole('combobox', { name: 'Permission mode' }), page.getByRole('button', { name: 'Toggle workspace panel' }), page.locator('.topbar')]) await expect(gone).toHaveCount(0)
    await expect(page.getByText('Choose a repository to start coding.')).toBeVisible()
    await noOverflow(page)
    for (const b of [menu(page), page.getByRole('button', { name: 'Open settings' })]) { const box = await b.boundingBox(); expect(box.width).toBeGreaterThanOrEqual(43); expect(box.height).toBeGreaterThanOrEqual(43) }
  })

  test('repository and branch context stay in view; long names truncate instead of pushing the buttons away', async ({ page, request }) => {
    await page.goto('/'); await openRepo(page, repo)
    await expect(page.getByTestId('mobile-context')).toContainText('repo')
    await ctl.post(request, 'git/branch', `?name=${encodeURIComponent(`feature/${'a-very-long-branch-segment-'.repeat(6)}end`)}`)
    await page.getByRole('button', { name: 'Open settings' }).click(); await settings(page).getByRole('button', { name: 'Close settings' }).click()
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))) // the shell re-reads git when the tab regains focus
    await expect(page.getByTestId('mobile-context')).toContainText('feature/', { timeout: 15_000 })
    for (const b of [menu(page), page.getByRole('button', { name: 'Open settings' })]) { const box = await b.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width) }
    await noOverflow(page)
    const ctx = await page.getByTestId('mobile-context').boundingBox(); expect(ctx.x + ctx.width).toBeLessThanOrEqual(PHONE.width)
  })

  test('Workspace: sections, existing repository actions, Git rows only with a repository, and a clean close', async ({ page }) => {
    await page.goto('/')
    await menu(page).click()
    const w = workspace(page); await expect(w).toBeVisible(); await expect(menu(page)).toHaveAttribute('aria-expanded', 'true')
    for (const h of ['Current', 'Repositories', 'Conversations']) await expect(w.getByRole('heading', { name: h })).toBeVisible()
    await expect(w.getByRole('heading', { name: 'Git' })).toHaveCount(0) // no repository yet
    await expect(w.getByRole('button', { name: 'Browse GitHub' })).toBeVisible(); await expect(w.getByRole('button', { name: 'Open Local Repository' })).toBeVisible()
    await noOverflow(page)
    await page.keyboard.press('Escape'); await expect(w).toHaveCount(0)
    await expect(menu(page)).toBeFocused() // focus returns to the opener
    await menu(page).click(); await page.mouse.click(PHONE.width - 4, 400); await expect(workspace(page)).toHaveCount(0) // tap outside
    await menu(page).click(); await workspace(page).getByRole('button', { name: 'Close workspace' }).click(); await expect(workspace(page)).toHaveCount(0)
  })

  test('Browse GitHub and Open Local Repository reach the existing flows; Git appears once a repository is open', async ({ page }) => {
    await page.goto('/'); await menu(page).click()
    await workspace(page).getByRole('button', { name: 'Browse GitHub' }).click()
    await expect(page.getByRole('dialog', { name: 'Repositories' })).toContainText(/Connect GitHub|GitHub connected/)
    await page.getByRole('button', { name: 'Close Repositories' }).click()
    await menu(page).click(); await workspace(page).getByRole('button', { name: 'Open Local Repository' }).click()
    await expect(page.getByRole('dialog', { name: 'Open Local Repository' }).getByRole('textbox', { name: 'Repository path' })).toBeVisible()
    await page.getByRole('button', { name: 'Close Open Local Repository' }).click()
  })

  test('opening a repository, then Workspace shows Git (Changes) and the conversation history', async ({ page }) => {
    await page.goto('/'); await openRepo(page, repo)
    await send(page, 'fix add please'); await expect(conversationLog(page)).toContainText('Verified')
    await menu(page).click(); const w = workspace(page)
    await expect(w.getByRole('heading', { name: 'Git' })).toBeVisible()
    await expect(w.getByRole('region', { name: 'Repository workflow' })).toBeVisible()
    await expect(w.getByRole('navigation', { name: 'Conversation list' })).toContainText('Fix add please')
    await w.getByRole('button', { name: /^Changes/ }).click()
    await expect(page.getByRole('dialog', { name: 'Workspace' }).first()).toBeVisible() // the existing changes sheet
    await expect(page.getByRole('list', { name: 'Changed files' })).toContainText('math.js')
  })

  test('Settings: model, edit mode, GitHub and runtime — the existing controls', async ({ page }) => {
    await page.goto('/'); await page.getByRole('button', { name: 'Open settings' }).click()
    const s = settings(page); await expect(s).toBeVisible()
    for (const h of ['AI', 'Editing', 'Connections', 'Runtime']) await expect(s.getByRole('heading', { name: h })).toBeVisible()
    await expect(s.getByRole('combobox', { name: 'Model' })).toHaveValue(/scripted-model/)
    const mode = s.getByLabel('Edit mode'); await expect(mode).toHaveValue('auto_edit')
    await mode.selectOption('ask'); await expect(mode).toHaveValue('ask')
    await expect(s.getByTestId('github-status')).toContainText(/Not connected|Connected|Unavailable/)
    await expect(s.getByTestId('runtime-status')).toContainText('Connected')
    await s.getByRole('button', { name: 'Diagnostics' }).click()
    await s.getByRole('button', { name: 'Run checks' }).click()
    await expect(s.getByRole('region', { name: 'Connection details' })).toContainText('Runtime reachable')
    await noOverflow(page)
    await s.getByRole('button', { name: 'Close settings' }).click(); await expect(settings(page)).toHaveCount(0)
    await page.getByRole('button', { name: 'Open settings' }).click() // the mode change persisted in the shared state
    await expect(settings(page).getByLabel('Edit mode')).toHaveValue('ask')
  })

  test('the GitHub row shows the live connection and opens the existing GitHub panel', async ({ page }) => {
    await page.goto('/'); await page.getByRole('button', { name: 'Open settings' }).click()
    await settings(page).getByRole('button', { name: /^GitHub/ }).click()
    await expect(page.getByRole('dialog', { name: 'Repositories' })).toBeVisible()
  })
})

test.describe('stability', () => {
  test('opening and closing Workspace and Settings during a streaming run changes nothing about the run, session or stream', async ({ page, request }) => {
    await page.goto('/'); await openRepo(page, repo)
    await send(page, 'slow work')
    await expect(conversationLog(page)).toContainText('tick 2')
    const before = { streams: await streams(request), requests: (await ctl.get(request, 'stats')).requests }
    for (let i = 0; i < 3; i++) {
      await menu(page).click(); await expect(workspace(page)).toBeVisible(); await closeSidebar(page)
      await page.getByRole('button', { name: 'Open settings' }).click(); await expect(settings(page)).toBeVisible(); await settings(page).getByRole('button', { name: 'Close settings' }).click()
    }
    await expect(conversationLog(page)).toContainText('tick 12', { timeout: 20_000 }) // still streaming, uninterrupted
    expect(await streams(request)).toBe(before.streams) // no stream was dropped or re-opened
    await expect(page.getByTestId('mobile-context')).toContainText('repo')
    await page.getByRole('button', { name: 'Stop BLUSWAN' }).click()
    await expect(page.getByRole('button', { name: 'Stop BLUSWAN' })).toHaveCount(0)
    await expect(conversationLog(page).getByRole('article', { name: 'Your message' })).toHaveCount(1)
  })

  test('reconnecting stays visible on the main screen, not only inside Settings', async ({ page, request }) => {
    await page.goto('/'); await expect(composer(page)).toBeVisible()
    await ctl.post(request, 'stream/block', '?on=1')
    await expect(page.getByTestId('connection-banner')).toContainText('Connection lost — reconnecting', { timeout: 10_000 })
    await page.getByRole('button', { name: 'Open settings' }).click()
    await expect(settings(page).getByTestId('runtime-status')).toContainText('Reconnecting')
    await settings(page).getByRole('button', { name: 'Close settings' }).click()
    await ctl.post(request, 'stream/block', '?on=0')
    await expect(page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 20_000 })
  })
})

test.describe('layout', () => {
  test('keyboard: when the visual viewport shrinks (iOS keyboard) the shell shrinks with it and the composer stays visible', async ({ page }) => {
    await page.addInitScript(() => { // a controllable visualViewport: the keyboard overlays the page without resizing the layout viewport
      const l = {}; const vv = { height: window.innerHeight, offsetTop: 0, addEventListener: (t, f) => { (l[t] ||= []).push(f) }, removeEventListener: () => {} }
      Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true })
      window.__keyboard = (px) => { vv.height = window.innerHeight - px; for (const f of l.resize ?? []) f() }
    })
    await page.goto('/'); await expect(composer(page)).toBeVisible()
    const closed = await composer(page).boundingBox()
    await page.evaluate(() => window.__keyboard(320))
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--kb-inset'))).toBe('320px')
    const open = await composer(page).boundingBox()
    expect(open.y + open.height).toBeLessThanOrEqual(844 - 320 + 2) // above the keyboard
    expect(open.y).toBeGreaterThanOrEqual(0)
    await page.evaluate(() => window.__keyboard(0))
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--kb-inset'))).toBe('0px')
    expect((await composer(page).boundingBox()).y).toBeCloseTo(closed.y, 0)
  })

  test('landscape phone and a narrow-tablet width keep the phone layout without overflow', async ({ page }) => {
    for (const vp of [{ width: 844, height: 390 }, { width: 700, height: 900 }]) {
      await page.setViewportSize(vp); await page.goto('/'); await expect(header(page)).toBeVisible(); await expect(composer(page)).toBeVisible(); await noOverflow(page)
      await menu(page).click(); await expect(workspace(page)).toBeVisible(); await noOverflow(page)
      const sent = await workspace(page).getByRole('button', { name: '＋ New chat' }).boundingBox(); expect(sent.height).toBeGreaterThanOrEqual(43)
      await closeSidebar(page)
    }
  })
})

test.describe('desktop is unchanged', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false })
  test('the toolbar, model and permission controls, sidebar and settings dialog are all still there', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.topbar')).toBeVisible(); await expect(page.locator('.mhead')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible(); await expect(page.getByRole('combobox', { name: 'Permission mode' })).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Conversations sidebar' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Repositories' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Local Repository' })).toBeVisible() // empty-state call to action
    await page.getByRole('button', { name: 'Open settings' }).click(); await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('Permissions')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  })
})
