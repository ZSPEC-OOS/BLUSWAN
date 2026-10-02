// Shared helpers for the end-to-end specs.
import { expect } from '@playwright/test'

export const ctl = {
  reset: async (request) => (await (await request.post('/__e2e/reset')).json()),
  post: (request, op, query = '') => request.post(`/__e2e/${op}${query}`),
  get: async (request, op, query = '') => (await request.get(`/__e2e/${op}${query}`)).json(),
}

export const composer = (page) => page.getByRole('textbox', { name: 'Message BLUSWAN' })
export async function send(page, text) {
  const sendButton = page.getByRole('button', { name: 'Send' })
  // the composer remounts when the active conversation changes; retry the fill until the text sticks
  await expect(async () => { await composer(page).fill(text); await expect(sendButton).toBeEnabled({ timeout: 700 }) }).toPass({ timeout: 8000 })
  await sendButton.click()
}
export async function openRepo(page, repo) {
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('textbox', { name: 'Repository path' }).fill(repo)
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  const close = page.getByRole('button', { name: 'Close settings' })
  if (await close.isVisible().catch(() => false)) await close.click()
  await expect(page.getByRole('banner')).toContainText('repo')
}
export async function user(context, name) {
  await context.addCookies([{ name: 'e2e_user', value: name, url: 'http://127.0.0.1:4173' }])
}
export const conversationLog = (page) => page.getByRole('log', { name: 'Conversation' })
export const banner = (page) => page.getByTestId('connection-banner')

/** On phones the conversation list is a drawer (translated off-screen when closed); open it if it is not on screen. */
export async function openSidebar(page) {
  const toggle = page.getByRole('button', { name: 'Toggle conversations sidebar' })
  if (!(await toggle.isVisible().catch(() => false))) return
  const onScreen = await page.getByRole('button', { name: '＋ New chat' }).evaluate((el) => { const r = el.getBoundingClientRect(); return r.right > 4 && r.left < innerWidth - 4 }).catch(() => false)
  if (!onScreen) await toggle.click()
}
