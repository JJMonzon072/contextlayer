import { randomUUID } from 'node:crypto'

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

/**
 * The connect page in a browser WITHOUT the extension (the full handoff runs in
 * apps/extension/e2e/connection.spec.ts). It must never pretend to connect.
 */
const PASSWORD = 'correct horse battery staple'
const LINK = `/extension/connect?state=${'s'.repeat(43)}&challenge=${'c'.repeat(43)}`

async function signUp(page: Page) {
  await page.goto('/register')
  await page.getByLabel('Name').fill('Extension User')
  await page.getByLabel('Work email').fill(`e2e-${randomUUID()}@example.test`)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Confirm password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Workspace name').fill('Acme')
  await page.getByRole('button', { name: 'Create workspace' }).click()
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}$/)
}

test('asks signed-out users to sign in and keeps the connect link', async ({ page }) => {
  await page.goto(LINK)

  await expect(page).toHaveURL(/\/login\?redirect=\/extension\/connect\?state=/)
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})

test('explains that the extension is missing instead of issuing a code', async ({ page }) => {
  let codeRequests = 0
  await page.route('**/api/v1/extension/codes', async (route) => {
    codeRequests += 1
    await route.continue()
  })
  await signUp(page)

  await page.goto(LINK)

  await expect(page.getByTestId('extension-missing')).toContainText('not installed')
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0)
  expect(codeRequests).toBe(0)
  const { violations } = await new AxeBuilder({ page }).analyze()
  expect(violations).toEqual([])
})

test('refuses an incomplete link', async ({ page }) => {
  await signUp(page)

  await page.goto('/extension/connect?state=abc')

  await expect(page.getByTestId('invalid-link')).toBeVisible()
})
