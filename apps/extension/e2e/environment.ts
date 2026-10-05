import { fileURLToPath } from 'node:url'

/**
 * The end-to-end environment (playwright.config.ts starts every server):
 * the API on a dedicated database, the built dashboard, and two stand-ins for
 * customer web applications.
 */
export const E2E_API_URL = 'http://localhost:3100'
export const E2E_DASHBOARD_URL = 'http://localhost:4173'

/**
 * Customer site whose host permission the e2e build grants at install time.
 * Chrome's permission prompt cannot be answered under automation (Phase 4
 * spike), so the popup's real `permissions.request` resolves at once for this
 * origin, as it does for any origin the user already granted. The prompt
 * itself is covered by a manual check (docs/adr/0017-per-application-site-access.md).
 */
export const GRANTED_SITE = 'http://localhost:4179'
/** Customer site without a grant: the "permission missing" states. */
export const UNGRANTED_SITE = 'http://localhost:4180'

/** The e2e build (`scripts/build.ts --e2e`); the regular build stays in dist/. */
export const E2E_OUT_DIR = fileURLToPath(new URL('../dist-e2e', import.meta.url))
