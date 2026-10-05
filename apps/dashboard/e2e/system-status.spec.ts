import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// Public page: reachable without signing in.

const degradedReport = {
  status: 'unavailable',
  service: 'contextlayer-api',
  version: '0.0.0',
  timestamp: '2026-10-04T12:00:00.000Z',
  uptimeSeconds: 10,
  checks: { database: { status: 'down', latencyMs: 2000 } },
}

test('reports the real API and database as operational', async ({ page }) => {
  await page.goto('/status')

  await expect(page.getByRole('heading', { level: 1, name: 'System status' })).toBeVisible()
  await expect(page.getByTestId('api-status')).toHaveText('Operational')
  await expect(page.getByTestId('database-status')).toContainText('Up')
})

test('shows a degraded API when the health check answers 503', async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({ status: 503, json: degradedReport }))

  await page.goto('/status')

  await expect(page.getByTestId('api-status')).toHaveText('Degraded')
  await expect(page.getByTestId('database-status')).toHaveText('Down')
})

test('announces an error when the API cannot be reached', async ({ page }) => {
  await page.route('**/api/health', (route) => route.abort('connectionrefused'))

  await page.goto('/status')

  await expect(page.getByTestId('api-status')).toHaveText('Unreachable')
  await expect(page.getByRole('alert')).toContainText('could not be reached')
})

test('lets the user re-run the health check', async ({ page }) => {
  let calls = 0
  await page.route('**/api/health', async (route) => {
    calls += 1
    await route.continue()
  })

  await page.goto('/status')
  await expect(page.getByTestId('api-status')).toHaveText('Operational')
  await page.getByRole('button', { name: 'Check again' }).click()

  await expect.poll(() => calls).toBe(2)
  await expect(page.getByTestId('api-status')).toHaveText('Operational')
})

test('status page has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/status')
  await expect(page.getByTestId('api-status')).toHaveText('Operational')

  const results = await new AxeBuilder({ page }).analyze()

  expect(results.violations).toEqual([])
})
