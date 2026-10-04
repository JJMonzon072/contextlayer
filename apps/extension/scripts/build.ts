/**
 * Builds the unpacked extension into `apps/extension/dist`.
 *
 *   tsx scripts/build.ts           production build
 *   tsx scripts/build.ts --watch   development build, rebuilt on change
 *
 * Load `dist/` with chrome://extensions → "Load unpacked". After a rebuild,
 * press the reload button on the extension card (and reload the page to get a
 * fresh content script).
 */
import { rm } from 'node:fs/promises'

import { build } from 'vite'

import { createContentScriptConfig, createPagesConfig, OUT_DIR } from '../vite.config'

const watch = process.argv.includes('--watch')
const mode = watch ? 'development' : 'production'

await rm(OUT_DIR, { recursive: true, force: true })
await build(createPagesConfig({ mode, watch }))
await build(createContentScriptConfig({ mode, watch }))
