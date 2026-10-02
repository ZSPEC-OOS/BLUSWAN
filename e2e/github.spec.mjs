// The GitHub task lifecycle in the browser, against the real runtime and a fake GitHub backed by real local git remotes.
import { test, expect } from '@playwright/test'
import { ctl, send, composer, conversationLog, openSidebar, gitbar, closeSidebar } from './helpers.mjs'

test.beforeEach(async ({ request }) => { await ctl.reset(request) })

const dialog = (page, name) => page.getByRole('dialog', { name })

async function openRepositories(page) {
  await openSidebar(page)
  const browse = page.getByRole('button', { name: 'Browse GitHub' }).first()
  if (await browse.isVisible().catch(() => false)) await browse.click(); else await page.getByRole('button', { name: 'Repositories' }).click()
}
async function connectAndClone(page) {
  await page.goto('/')
  await expect(composer(page)).toBeVisible()
  await openRepositories(page)
  await dialog(page, 'Repositories').getByRole('button', { name: 'Connect GitHub', exact: true }).click()
  // GitHub (fake) approves the installation and redirects back; the app finishes the connection
  const panel = dialog(page, 'Repositories')
  await expect(panel).toContainText('GitHub connected')
  expect(new URL(page.url()).search).toBe('') // callback parameters are removed from the address bar
  await panel.getByRole('button', { name: /acme \/ widgets/ }).click()
  await expect(panel).toContainText('Default branch: main')
  await panel.getByRole('button', { name: 'Clone & Open', exact: true }).click()
  await expect(dialog(page, 'Repositories')).toHaveCount(0, { timeout: 30_000 })
  await expect((await gitbar(page))).toContainText('acme/widgets')
  await expect((await gitbar(page))).toContainText('main')
}
async function createTaskBranch(page, task) {
  await (await gitbar(page)).getByRole('button', { name: 'Create Task Branch' }).click()
  const d = dialog(page, 'Branches')
  await d.getByLabel('What is the task?').fill(task)
  await d.getByRole('button', { name: 'Create Branch', exact: true }).click()
  await expect(d).toHaveCount(0)
}

test('connect → browse → clone → task branch → code → commit → push → PR → merge → clean up → next task @mobile', async ({ page, request }) => {
  await connectAndClone(page)
  expect((await ctl.get(request, 'gh/local')).branch).toBe('main')
  await expect((await gitbar(page))).toContainText('Ready to start a new task')

  await createTaskBranch(page, 'Fix add function')
  await expect((await gitbar(page))).toContainText('bluswan/fix-add-function')
  expect((await ctl.get(request, 'gh/local')).branch).toBe('bluswan/fix-add-function')

  await send(page, 'fix add please')
  await expect(conversationLog(page)).toContainText('Verified: the tests pass.')
  await expect((await gitbar(page))).toContainText('uncommitted changes')
  await expect((await gitbar(page))).toContainText('DIRTY')

  await (await gitbar(page)).getByRole('button', { name: 'Commit Changes' }).click()
  const commit = dialog(page, 'Commit changes')
  await expect(commit.getByLabel('Commit message')).not.toHaveValue('')
  await expect(commit).toContainText('not on GitHub')
  await commit.getByRole('button', { name: 'Commit Changes', exact: true }).click()
  await expect((await gitbar(page))).toContainText('Committed locally')
  await expect((await gitbar(page))).toContainText('LOCAL')
  expect((await ctl.get(request, 'gh/remote', '?branch=bluswan/fix-add-function')).branches).not.toContain('bluswan/fix-add-function')

  await (await gitbar(page)).getByRole('button', { name: 'Push Branch' }).click()
  await dialog(page, 'Push branch').getByRole('button', { name: 'Push Branch', exact: true }).click()
  await expect((await gitbar(page))).toContainText('Ready for review')
  await expect((await gitbar(page))).toContainText('PUSHED')
  expect((await ctl.get(request, 'gh/remote', '?branch=bluswan/fix-add-function')).branches).toContain('bluswan/fix-add-function')

  await (await gitbar(page)).getByRole('button', { name: 'Create Pull Request' }).click()
  const pr = dialog(page, 'Create pull request')
  await expect(pr.getByLabel('Description')).toHaveValue(/## Validation/)
  await expect(pr.getByRole('region', { name: 'Validation' })).toContainText(/npm test|Validation/)
  await pr.getByRole('button', { name: 'Create Pull Request', exact: true }).click()
  await expect((await gitbar(page))).toContainText('Pull Request #1 is open')
  await expect((await gitbar(page)).getByLabel('Pull request open')).toBeVisible()
  const link = (await gitbar(page)).getByRole('link', { name: 'Open Pull Request' })
  expect(await link.getAttribute('href')).toBe('https://github.com/acme/widgets/pull/1')
  expect(await link.getAttribute('rel')).toContain('noopener')

  await ctl.post(request, 'gh/merge', '?n=1')
  await (await gitbar(page)).getByRole('button', { name: 'Refresh Status' }).click({ timeout: 4000 }).catch(() => {}) // the bar may already have refreshed itself
  await expect((await gitbar(page))).toContainText('Merged. Your changes are now on main.')

  await (await gitbar(page)).getByRole('button', { name: 'Sync Main & Clean Up' }).click()
  const clean = dialog(page, 'Sync main & clean up')
  await expect(clean).toContainText('delete local branch')
  await clean.getByRole('button', { name: 'Sync & Clean Up', exact: true }).click()
  await expect(clean).toContainText('Repository synced')
  const local = await ctl.get(request, 'gh/local')
  expect(local.branch).toBe('main'); expect(local.status).toBe(''); expect(local.branches).toEqual(['main']); expect(local.math).toContain('a + b')
  expect((await ctl.get(request, 'gh/remote', '?branch=bluswan/fix-add-function')).branches).toEqual(['main'])

  await clean.getByRole('button', { name: 'Start New Task', exact: true }).click()
  const next = dialog(page, 'Branches'); await next.getByLabel('What is the task?').fill('Add subtract'); await next.getByRole('button', { name: 'Create Branch', exact: true }).click()
  await expect((await gitbar(page))).toContainText('bluswan/add-subtract')
  // the finished conversation is still in history
  await openSidebar(page)
  await expect(page.getByRole('navigation', { name: 'Conversation list' })).toContainText('Fix add please')
  await expect(page.getByRole('navigation', { name: 'Conversation list' })).toContainText('PR #1 — merged') // the PR stays attached to the finished conversation
})

test('GitHub failures are shown and recoverable: clone failure, push rejection', async ({ page, request }) => {
  await page.goto('/'); await openRepositories(page)
  await dialog(page, 'Repositories').getByRole('button', { name: 'Connect GitHub', exact: true }).click()
  const panel = dialog(page, 'Repositories'); await expect(panel).toContainText('GitHub connected')
  await ctl.post(request, 'gh/break-remote', '?on=1')
  await panel.getByRole('button', { name: /acme \/ widgets/ }).click()
  await panel.getByRole('button', { name: 'Clone & Open', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText(/Git failed|clone/i)
  expect((await ctl.get(request, 'gh/local')).exists).toBe(false)
  await ctl.post(request, 'gh/break-remote', '?on=0')
  await panel.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect((await gitbar(page))).toContainText('acme/widgets', { timeout: 30_000 })

  await createTaskBranch(page, 'Fix add function')
  await send(page, 'fix add please'); await expect(conversationLog(page)).toContainText('Verified')
  await (await gitbar(page)).getByRole('button', { name: 'Commit Changes' }).click(); await dialog(page, 'Commit changes').getByRole('button', { name: 'Commit Changes', exact: true }).click()
  await ctl.post(request, 'gh/reject-pushes')
  await (await gitbar(page)).getByRole('button', { name: 'Push Branch' }).click()
  const push = dialog(page, 'Push branch'); await push.getByRole('button', { name: 'Push Branch', exact: true }).click()
  await expect(push.getByRole('alert')).toContainText(/rejected/i)
  await push.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect((await gitbar(page))).toContainText('Committed locally') // nothing was claimed to be on GitHub
})

test('the workflow survives a runtime restart and works offline-aware', async ({ page, request }) => {
  await connectAndClone(page); await createTaskBranch(page, 'Fix add function')
  await send(page, 'fix add please'); await expect(conversationLog(page)).toContainText('Verified')
  await (await gitbar(page)).getByRole('button', { name: 'Commit Changes' }).click(); await dialog(page, 'Commit changes').getByRole('button', { name: 'Commit Changes', exact: true }).click()
  await (await gitbar(page)).getByRole('button', { name: 'Push Branch' }).click(); await dialog(page, 'Push branch').getByRole('button', { name: 'Push Branch', exact: true }).click()
  await (await gitbar(page)).getByRole('button', { name: 'Create Pull Request' }).click(); await dialog(page, 'Create pull request').getByRole('button', { name: 'Create Pull Request', exact: true }).click()
  await expect((await gitbar(page))).toContainText('Pull Request #1 is open')
  await ctl.post(request, 'backend/restart')
  await ctl.post(request, 'gh/merge', '?n=1')
  await page.reload()
  await expect(composer(page)).toBeVisible()
  // the repository, branch and PR come back from the server; the merge happened while we were away
  await expect((await gitbar(page))).toContainText('bluswan/fix-add-function', { timeout: 20_000 })
  await (await gitbar(page)).getByRole('button', { name: 'Refresh Status' }).click({ timeout: 2000 }).catch(() => {}) // may already have refreshed itself
  await expect((await gitbar(page))).toContainText('Merged', { timeout: 20_000 })
  await ctl.post(request, 'backend/stop')
  await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 20_000 })
  await expect((await gitbar(page)).getByRole('button', { name: 'Sync Main & Clean Up' })).toBeDisabled()
})
