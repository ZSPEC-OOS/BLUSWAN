// Core product flows against the real server and web client (scripted model, temporary repository and storage).
import { test, expect } from '@playwright/test'
import { ctl, send, openRepo, composer, conversationLog, openSidebar } from './helpers.mjs'

let repo
test.beforeEach(async ({ request }) => { ({ repo } = await ctl.reset(request)) })

test('boots to a usable app with no blank screen @mobile', async ({ page }) => {
  await page.goto('/')
  await expect(composer(page)).toBeVisible()
  await expect(page.getByTestId('connection-banner')).toHaveCount(0)
  await expect(page.getByText('Hello from')).toHaveCount(0)
})

test('send, stream and finish a conversation; it is saved @mobile', async ({ page }) => {
  await page.goto('/')
  await send(page, 'hello there')
  await expect(conversationLog(page)).toContainText('Hello from the scripted model.')
  await expect(page.getByText('Completed').first()).toBeVisible()
  await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible()
})

test('open a repository, edit files, view changes, diff and validation', async ({ page, request }) => {
  await page.goto('/')
  await openRepo(page, repo)
  await send(page, 'fix add please')
  await expect(conversationLog(page)).toContainText('Verified: the tests pass.')
  await expect(conversationLog(page).getByRole('button', { name: /Done: Modified src\/math\.js/ })).toBeVisible()
  expect(await ctl.get(request, 'file', '?path=src/math.js')).toMatchObject({ content: expect.stringContaining('a + b') })
  await page.getByRole('button', { name: /file changed — toggle workspace panel/ }).click()
  const panel = page.getByRole('tabpanel')
  await expect(panel.getByRole('list', { name: 'Changed files' })).toContainText('math.js')
  await panel.getByRole('button', { name: /math\.js/ }).click()
  await expect(page.getByRole('region', { name: 'Diff of src/math.js' })).toContainText('a + b')
  await conversationLog(page).getByRole('button', { name: /View details of Tests passed/ }).click()
  await expect(page.getByRole('list', { name: 'Validation checks' })).toBeVisible()
})

test('Stop cancels a running turn and the session stays usable', async ({ page }) => {
  await page.goto('/')
  await send(page, 'slow please')
  await expect(conversationLog(page)).toContainText('tick 2')
  await page.getByRole('button', { name: 'Stop BLUSWAN' }).click()
  await expect(page.getByRole('button', { name: 'Stop BLUSWAN' })).toHaveCount(0)
  const before = await conversationLog(page).innerText()
  await page.waitForTimeout(500)
  expect(await conversationLog(page).innerText()).toBe(before) // nothing keeps streaming after Stop
  await send(page, 'hello again')
  await expect(conversationLog(page)).toContainText('Hello from the scripted model.')
})

test('permission prompt: approve runs the command, deny does not', async ({ page, request }) => {
  await page.goto('/')
  await openRepo(page, repo)
  await page.getByRole('combobox', { name: 'Permission mode' }).selectOption({ label: 'Ask' })
  await send(page, 'create approval')
  const group = page.getByRole('group').filter({ hasText: 'touch approved.txt' })
  await expect(group).toBeVisible()
  expect(await ctl.get(request, 'file', '?path=approved.txt')).toEqual({ content: null }) // nothing ran yet
  await group.getByRole('button', { name: 'Deny' }).click()
  await expect(page.getByText('Completed').first()).toBeVisible()
  expect(await ctl.get(request, 'file', '?path=approved.txt')).toEqual({ content: null })
  await send(page, 'create approval')
  await page.getByRole('group').filter({ hasText: 'touch approved.txt' }).last().getByRole('button', { name: 'Allow once' }).click()
  await expect.poll(async () => (await ctl.get(request, 'file', '?path=approved.txt')).content).toBe('')
})

test('a prohibited command never runs in any mode, even Full Auto', async ({ page, request }) => {
  await page.goto('/')
  await openRepo(page, repo)
  await page.getByRole('combobox', { name: 'Permission mode' }).selectOption({ label: 'Full Auto' })
  await send(page, 'dangerous please')
  await expect(conversationLog(page)).toContainText(/not allowed|blocked|Blocked/i)
  expect(await ctl.get(request, 'file', '?path=package.json')).toMatchObject({ content: expect.stringContaining('fixture') }) // the repository is intact
})

test('switching conversations keeps each transcript; reload restores them @mobile', async ({ page }) => {
  await page.goto('/')
  await send(page, 'hello first')
  await expect(page.getByText('Completed').first()).toBeVisible()
  await openSidebar(page)
  await page.getByRole('button', { name: '＋ New chat' }).click()
  await send(page, 'hello second')
  await expect(conversationLog(page)).toContainText('Hello from the scripted model.')
  await page.reload()
  await expect(composer(page)).toBeVisible()
  await openSidebar(page)
  await expect(page.getByRole('navigation', { name: 'Conversation list' })).toContainText('Hello first')
  await expect(page.getByRole('navigation', { name: 'Conversation list' })).toContainText('Hello second')
  await page.getByRole('button', { name: /^Hello first/ }).click()
  await expect(conversationLog(page)).toContainText('hello first')
  await expect(conversationLog(page)).not.toContainText('hello second')
})

test('revert a file after a change; validation becomes stale', async ({ page, request }) => {
  await page.goto('/')
  await openRepo(page, repo)
  await send(page, 'fix add please')
  await expect(conversationLog(page)).toContainText('Verified')
  await page.getByRole('button', { name: /file changed — toggle workspace panel/ }).click()
  await page.getByRole('tabpanel').getByRole('button', { name: /math\.js/ }).click()
  await page.getByRole('button', { name: /^Revert/ }).first().click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revert file' }).click()
  await expect.poll(async () => (await ctl.get(request, 'file', '?path=src/math.js')).content).toContain('a - b')
  await conversationLog(page).getByRole('button', { name: /View details of Tests passed/ }).click()
  await expect(page.getByText(/Revalidation needed|revalidation needed/).first()).toBeVisible()
})
