import { randomUUID } from 'node:crypto'

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type Page } from '@playwright/test'

/**
 * The Phase 3 authoring loop against the real API and database: register an
 * application, write a guide, publish version 1, keep editing, publish
 * version 2, and check that version 1 never changed.
 */
const PASSWORD = 'correct horse battery staple'

async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze()
  expect(violations).toEqual([])
}

/** A fresh account with its first workspace; returns the workspace URL. */
async function signUpWithWorkspace(page: Page, workspaceName: string) {
  await page.goto('/register')
  await page.getByLabel('Name').fill('Guide Author')
  await page.getByLabel('Work email').fill(`e2e-${randomUUID()}@example.test`)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Confirm password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Workspace name').fill(workspaceName)
  await page.getByRole('button', { name: 'Create workspace' }).click()
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}$/)
  return new URL(page.url()).pathname
}

function step(page: Page, index: number) {
  return page.getByTestId('step-card').nth(index)
}

async function fillStep(page: Page, index: number, title: string, instructions: string) {
  await step(page, index).getByLabel('Step title').fill(title)
  await step(page, index).getByLabel('Instructions').fill(instructions)
}

async function stepTitles(page: Page) {
  return page
    .getByTestId('step-card')
    .getByLabel('Step title')
    .evaluateAll((inputs) => inputs.map((input) => (input as unknown as { value: string }).value))
}

async function otherUser(browser: Browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signUpWithWorkspace(page, 'Globex')
  return { context, page }
}

test('author a guide, publish two versions and keep version 1 intact', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000)
  const workspaceUrl = await signUpWithWorkspace(page, 'Acme Training')

  // Register the application; an origin with a path is explained, not sent.
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Applications' })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Applications' })).toBeVisible()
  await expect(page.getByText('No applications yet.')).toBeVisible()
  await expectAccessible(page)
  await page.getByRole('button', { name: 'Register application' }).click()
  await page.getByLabel('Application name').fill('Acme CRM')
  await page.getByLabel('Origins').fill('https://crm.acme.test/customers')
  await page.getByRole('button', { name: 'Register application' }).click()
  await expect(page.getByText('https://crm.acme.test/customers — Remove the path')).toBeVisible()
  await expect(page.getByLabel('Origins')).toHaveAttribute('aria-invalid', 'true')
  await expectAccessible(page)
  await page.getByLabel('Origins').fill('HTTPS://CRM.Acme.test/\nhttps://crm.acme.test:8443')
  await page.getByRole('button', { name: 'Register application' }).click()

  await expect(page.getByTestId('application-name')).toHaveText('Acme CRM')
  await expect(page.getByTestId('application-origin')).toHaveText([
    'https://crm.acme.test',
    'https://crm.acme.test:8443',
  ])

  // Create the guide and its three steps.
  await page.getByLabel('New guide title').fill('Create a customer')
  await expectAccessible(page)
  await page.getByRole('button', { name: 'Create guide' }).click()
  await expect(page.getByTestId('guide-title')).toHaveText('Create a customer')
  await expect(page.getByTestId('guide-status')).toHaveText('Draft')
  const guideUrl = new URL(page.url()).pathname

  for (let index = 0; index < 3; index += 1) {
    await page.getByRole('button', { name: 'Add step' }).click()
  }
  await fillStep(page, 0, 'Open Customers', 'Open the Customers section.')
  await fillStep(page, 1, 'Click New customer', 'Click New customer in the top bar.')
  await fillStep(
    page,
    2,
    'Complete the details',
    "Enter the customer's information:\n\n- Name\n- Email",
  )
  await expect(page.getByTestId('unsaved')).toBeVisible()
  await expect(page.getByTestId('publish')).toBeDisabled()
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByTestId('notice')).toHaveText('Draft saved.')
  await expectAccessible(page)

  // Version 1.
  await page.getByTestId('publish').click()
  await expect(page.getByTestId('notice')).toContainText('Version 1 published')
  await expect(page.getByTestId('notice')).toContainText('read-only snapshot')
  await expect(page.getByTestId('guide-status')).toHaveText('Published · v1')

  // Keep editing the draft: rename step 2, move step 3 up, add step 4.
  await step(page, 1).getByLabel('Step title').fill('Click New business customer')
  await page.getByRole('button', { name: 'Move step 3 up' }).click()
  await page.getByRole('button', { name: 'Add step' }).click()
  await fillStep(page, 3, 'Save the customer', 'Click Save.')
  expect(await stepTitles(page)).toEqual([
    'Open Customers',
    'Complete the details',
    'Click New business customer',
    'Save the customer',
  ])
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByTestId('notice')).toHaveText('Draft saved.')
  await expect(page.getByText('Unpublished changes')).toBeVisible()

  // Version 2.
  await page.getByTestId('publish').click()
  await expect(page.getByTestId('notice')).toContainText('Version 2 published')
  await expect(page.getByTestId('version-item')).toHaveCount(2)
  await expectAccessible(page)

  // Version 1 is exactly what was published first.
  await page.getByRole('link', { name: 'Version 1' }).click()
  await expect(page.getByTestId('version-number')).toHaveText('Version 1')
  await expect(page.getByTestId('version-step').getByRole('heading')).toHaveText([
    'Open Customers',
    'Click New customer',
    'Complete the details',
  ])
  await expect(page.getByTestId('version-step').nth(2).getByRole('listitem')).toHaveText([
    'Name',
    'Email',
  ])
  await expect(page.getByText('Read-only snapshot')).toBeVisible()
  await expect(
    page.getByTestId('version-snapshot').locator('input, textarea, select, button'),
  ).toHaveCount(0)
  await expectAccessible(page)

  await page.goto(`${guideUrl}/versions/2`)
  await expect(page.getByTestId('version-step').getByRole('heading')).toHaveText([
    'Open Customers',
    'Complete the details',
    'Click New business customer',
    'Save the customer',
  ])

  // Another tenant cannot reach any of it, in the dashboard or through the API.
  const other = await otherUser(browser)
  await other.page.goto(guideUrl)
  await expect(other.page.getByRole('heading', { name: 'Workspace not found' })).toBeVisible()
  const apiStatus = await other.page.evaluate(
    `fetch('/api/v1${guideUrl}').then((response) => response.status)`,
  )
  expect(apiStatus).toBe(404)
  await other.context.close()

  // The original workspace still lists the guide with its latest version.
  await page.goto(`${workspaceUrl}/applications`)
  await page.getByTestId('application-card').click()
  await expect(page.getByTestId('guide-row')).toHaveCount(1)
  await expect(page.getByTestId('guide-row').getByTestId('guide-status')).toHaveText(
    'Published · v2',
  )
})
