/**
 * Builds the unpacked extension into `apps/extension/dist`.
 *
 *   tsx scripts/build.ts           production build
 *   tsx scripts/build.ts --watch   development build, rebuilt on change
 *   tsx scripts/build.ts --e2e     end-to-end variant in dist-e2e/ (e2e/environment.ts)
 *
 * Load `dist/` with chrome://extensions → "Load unpacked". After a rebuild,
 * press the reload button on the extension card (and reload the page to get a
 * fresh content script).
 */
import { rm } from 'node:fs/promises'

import { build } from 'vite'

import { E2E_OUT_DIR } from '../e2e/environment'
import { createContentScriptConfig, createPagesConfig, OUT_DIR } from '../vite.config'
import { assertWithinBudget, describeBudget, measureContentScripts } from './budget'

const watch = process.argv.includes('--watch')
const e2e = process.argv.includes('--e2e')
const mode = watch ? 'development' : 'production'

await rm(e2e ? E2E_OUT_DIR : OUT_DIR, { recursive: true, force: true })
await build(createPagesConfig({ mode, watch, e2e }))
await build(createContentScriptConfig({ mode, watch, e2e }))

// Development builds are unminified with inline source maps: measuring them says nothing.
if (!watch) {
  const report = await measureContentScripts(e2e ? E2E_OUT_DIR : OUT_DIR)
  process.stdout.write(`${describeBudget(report)}\n`)
  assertWithinBudget(report)
}
