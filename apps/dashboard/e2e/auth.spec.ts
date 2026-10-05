import { randomUUID } from 'node:crypto'

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

/**
 * Runs against the real API and database. Every run registers a fresh account
 * (unique email), so nothing has to be cleaned up and runs never collide.
 */
const PASSWORD = 'correct horse battery staple'
const WORKSPACE_URL = /\/workspaces\/[0-9a-f-]{36}$/

async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze()
  expect(violations).toEqual([])
}

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('register, create a workspace, sign out and sign back in', async ({ page, context }) => {
  const email = `e2e-${randomUUID()}@example.test`

  // 1. A clean browser lands on the sign-in page.
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
  await expectAccessible(page)

  // 2. Register.
  await page.getByRole('link', { name: 'Create an account' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Create your account' })).toBeVisible()
  await expectAccessible(page)
  await page.getByLabel('Name').fill('E2E Owner')
  await page.getByLabel('Work email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Confirm password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()

  // 3. A new account has no workspace yet: onboarding creates the first one.
  await expect(page).toHaveURL(/\/workspaces\/new$/)
  await expect(
    page.getByRole('heading', { level: 1, name: 'Create your first workspace' }),
  ).toBeVisible()
  await expectAccessible(page)
  await page.getByLabel('Workspace name').fill('Acme Support')
  await page.getByRole('button', { name: 'Create workspace' }).click()

  // 4. The authenticated dashboard shows the workspace, the user and their role.
  await expect(page).toHaveURL(WORKSPACE_URL)
  const workspaceUrl = new URL(page.url()).pathname
  await expect(page.getByTestId('workspace-name')).toHaveText('Acme Support')
  await expect(page.getByTestId('current-user')).toContainText(email)
  await expectAccessible(page)

  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Members' })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible()
  await expect(page.getByTestId('member-row')).toHaveCount(1)
  await expect(page.getByTestId('member-row')).toContainText(email)
  await expect(page.getByTestId('member-row')).toContainText('Owner')
  await expectAccessible(page)

  // The session lives only in an HttpOnly cookie: invisible to page scripts.
  const cookies = await context.cookies()
  expect(cookies).toEqual([
    expect.objectContaining({ httpOnly: true, sameSite: 'Strict', path: '/' }),
  ])
  // (String expressions: the e2e project is typed for Node, not the DOM.)
  expect(await page.evaluate('document.cookie')).toBe('')
  expect(await page.evaluate('localStorage.length + sessionStorage.length')).toBe(0)

  // 5. Sign out: the session is gone, protected pages send back to sign-in.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goto(`${workspaceUrl}/members`)
  await expect(page).toHaveURL(/\/login\?redirect=/)

  // 6. Sign in again: the user returns to where they were going.
  await signIn(page, email)
  await expect(page).toHaveURL(new RegExp(`${workspaceUrl}/members$`))
  await expect(page.getByTestId('member-row')).toContainText(email)

  // 7. The workspace still exists, and `/` opens it.
  await page.goto('/')
  await expect(page).toHaveURL(WORKSPACE_URL)
  await expect(page.getByTestId('workspace-name')).toHaveText('Acme Support')
})

test('rejects wrong credentials without revealing whether the account exists', async ({ page }) => {
  await page.goto('/login')

  await signIn(page, `unknown-${randomUUID()}@example.test`, 'not the password')

  await expect(page.getByRole('alert')).toHaveText('Invalid email or password.')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByLabel('Password')).toHaveValue('')
})

test('validates the registration form before calling the API', async ({ page }) => {
  let registerCalls = 0
  await page.route('**/api/v1/auth/register', async (route) => {
    registerCalls += 1
    await route.continue()
  })
  await page.goto('/register')

  await page.getByLabel('Name').fill('Someone')
  await page.getByLabel('Work email').fill('not-an-email')
  await page.getByLabel('Password', { exact: true }).fill('short')
  await page.getByLabel('Confirm password').fill('different')
  await page.getByRole('button', { name: 'Create account' }).click()

  await expect(page.getByLabel('Work email')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('Confirm password')).toHaveAttribute('aria-invalid', 'true')
  await expectAccessible(page)
  expect(registerCalls).toBe(0)
})
