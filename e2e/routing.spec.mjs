// Phase 13 — Adaptive intelligence routing, end to end through the real server with two scripted models
// (`fake-fast` = Flash profile, `fake-pro` = Pro profile). Replies start with the model that produced them.
import { test, expect } from '@playwright/test'
import { ctl, send, openRepo, conversationLog, onPhone } from './helpers.mjs'

let repo
test.beforeEach(async ({ request }) => { ({ repo } = await ctl.reset(request)); await ctl.post(request, 'routing', '?on=1') })

const SIMPLE = 'Fix the typo in README.md.'
const HARD = 'Refactor the entire codebase across all modules to use the new data model.'
const indicator = (page) => page.getByTestId('route-indicator')
const log = (page) => conversationLog(page)

async function openModelControls(page) {
  if (await onPhone(page)) {
    await page.getByRole('button', { name: 'Open settings' }).click()
    return page.getByRole('dialog', { name: 'Settings' })
  }
  return page
}
async function chooseMode(page, label) {
  if (await onPhone(page)) {
    const dlg = await openModelControls(page)
    const radio = dlg.getByRole('radio', { name: new RegExp(`^${label}`) })
    await radio.click()
    await expect(radio).toBeChecked() // the choice round-trips through the server before the radio reflects it
    await dlg.getByRole('button', { name: 'Close settings' }).click()
  } else await page.getByRole('combobox', { name: 'Model' }).selectOption({ label: label === 'Auto' ? 'Auto (recommended)' : label })
}

test.describe('Auto routing', () => {
  test('simple work runs on Flash, hard work on Pro, each request routed independently @mobile', async ({ page }) => {
    await page.goto('/'); await openRepo(page, repo)
    await send(page, SIMPLE)
    await expect(log(page)).toContainText('[fake-fast] done.')
    await expect(indicator(page).last()).toHaveText('Auto · Flash')
    await send(page, HARD)
    await expect(log(page)).toContainText('[fake-pro] done.')
    await expect(indicator(page).last()).toHaveText('Auto · Pro')
    await send(page, SIMPLE)
    await expect(log(page).getByText('[fake-fast] done.')).toHaveCount(2)
    await expect(indicator(page)).toHaveText(['Auto · Flash', 'Auto · Pro', 'Auto · Flash'])
  })

  test('a Flash run that cannot make progress escalates to Pro once, and says so @mobile', async ({ page }) => {
    await page.goto('/'); await openRepo(page, repo)
    await send(page, 'stubborn: fix the typo in README.md')
    await expect(log(page)).toContainText('[fake-pro] resolved after escalation.', { timeout: 30_000 })
    await expect(indicator(page)).toHaveCount(1)
    await expect(indicator(page)).toHaveText(/Auto · Pro.*Escalated for deeper reasoning/)
    await expect(log(page).getByText('[fake-fast]')).toHaveCount(0)
    // the next request starts fresh on the cheap tier
    await send(page, SIMPLE)
    await expect(indicator(page).last()).toHaveText('Auto · Flash')
  })

  test('an ambiguous request is settled by the bounded classifier, never silently left to Flash @mobile', async ({ page }) => {
    await page.goto('/'); await openRepo(page, repo)
    await send(page, 'Improve the error handling in the sync module and clean up anything weird.')
    await expect(log(page)).toContainText('[fake-pro] done.')
    await expect(indicator(page)).toHaveText('Auto · Pro')
  })

  test('the indicator never shows reasoning, scores or reason prose @mobile', async ({ page }) => {
    await page.goto('/'); await openRepo(page, repo)
    await send(page, HARD)
    await expect(indicator(page)).toHaveText('Auto · Pro')
    const text = await page.locator('body').innerText()
    for (const leak of [/score/i, /threshold/i, /reasonCodes?/i, /classifier/i]) expect(text).not.toMatch(leak)
  })
})

test.describe('manual modes', () => {
  test('Flash and Pro are absolute @mobile', async ({ page }) => {
    await page.goto('/'); await openRepo(page, repo)
    await chooseMode(page, 'Pro')
    await send(page, SIMPLE)
    await expect(log(page)).toContainText('[fake-pro] done.')
    await expect(indicator(page).last()).toHaveText('Pro')
    await chooseMode(page, 'Flash')
    await send(page, HARD)
    await expect(log(page)).toContainText('[fake-fast] done.')
    await expect(indicator(page).last()).toHaveText('Flash')
  })

  test('the mode survives a reload and a server restart @mobile', async ({ page, request }) => {
    await page.goto('/'); await openRepo(page, repo)
    await chooseMode(page, 'Pro')
    await send(page, SIMPLE)
    await expect(log(page)).toContainText('[fake-pro] done.')
    await page.reload()
    await ctl.post(request, 'backend/restart')
    await expect(log(page)).toContainText('[fake-pro] done.', { timeout: 20_000 })
    await send(page, SIMPLE)
    await expect(log(page).getByText('[fake-pro] done.')).toHaveCount(2, { timeout: 20_000 })
  })

  test('Settings offers Auto (recommended), Flash and Pro, and keeps manual model access @mobile', async ({ page }) => {
    await page.goto('/')
    if (await onPhone(page)) {
      const dlg = await openModelControls(page)
      const group = dlg.getByRole('radiogroup', { name: 'Model mode' })
      await expect(group.getByRole('radio')).toHaveCount(3)
      await expect(group).toContainText('Recommended')
      await expect(group.getByRole('radio', { name: /^Auto/ })).toBeChecked()
      await expect(dlg.getByText('Choose a specific model')).toBeVisible()
      await expect(page.locator('.mhead').getByRole('combobox')).toHaveCount(0) // no big selector in the header
    } else {
      const select = page.getByRole('combobox', { name: 'Model' })
      await expect(select.locator('option', { hasText: 'Auto (recommended)' })).toHaveCount(1)
      await expect(select).toHaveValue('mode:auto')
    }
  })
})

test('without routing configured nothing changes: no mode controls, no indicator @mobile', async ({ page, request }) => {
  await ctl.post(request, 'routing', '?on=0')
  await page.goto('/'); await openRepo(page, repo)
  await send(page, 'hello')
  await expect(log(page)).toContainText('Hello from the scripted model.')
  await expect(indicator(page)).toHaveCount(0)
  if (!(await onPhone(page))) await expect(page.getByRole('combobox', { name: 'Model' }).locator('option', { hasText: 'Auto' })).toHaveCount(0)
})
