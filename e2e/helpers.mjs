// Shared helpers for the end-to-end specs.
import { expect } from '@playwright/test'

export const ctl = {
  reset: async (request) => (await (await request.post('/__e2e/reset')).json()),
  post: (request, op, query = '') => request.post(`/__e2e/${op}${query}`),
  get: async (request, op, query = '') => (await request.get(`/__e2e/${op}${query}`)).json(),
}

export const composer = (page) => page.getByRole('textbox', { name: 'Message BLUSWAN' })
export async function send(page, text) {
  await closeSidebar(page) // the phone drawer covers the composer
  const sendButton = page.getByRole('button', { name: 'Send' })
  // the composer remounts when the active conversation changes; retry the fill until the text sticks
  await expect(async () => { await composer(page).fill(text); await expect(sendButton).toBeEnabled({ timeout: 700 }) }).toPass({ timeout: 8000 })
  await sendButton.click()
}
export async function openRepo(page, repo) {
  if (await onPhone(page)) {
    await openSidebar(page)
    await page.getByRole('button', { name: 'Open Local Repository' }).click()
  } else await page.getByRole('button', { name: 'Open settings' }).click()
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

/** Phone layout: the header's ☰ opens the Workspace drawer (conversations, repositories, Git). */
export const onPhone = async (page) => (page.viewportSize()?.width ?? 1280) <= 900 // the shell's phone breakpoint
export async function openSidebar(page) {
  if (!(await onPhone(page))) return
  if (!(await page.getByRole('dialog', { name: 'Workspace' }).isVisible().catch(() => false))) await page.getByRole('button', { name: /^Open workspace menu/ }).first().click()
  await expect(page.getByRole('dialog', { name: 'Workspace' })).toBeVisible()
}
export async function closeSidebar(page) {
  const close = page.getByRole('button', { name: 'Close workspace' })
  if (await close.isVisible().catch(() => false)) await close.click()
}
/** The repository workflow region: always on the page on desktop, inside the Workspace drawer on phones. */
export async function gitbar(page) {
  if (await onPhone(page)) await openSidebar(page)
  return page.getByRole('region', { name: 'Repository workflow' })
}
