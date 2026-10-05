/**
 * Content-script budget (Phase 5, roadmap R-15). Everything in
 * `CONTENT_SCRIPT_FILES` is injected into every page of every enabled site, so
 * its size is a cost paid on each navigation. The production build fails when
 * the minified total exceeds the limit; gzip is reported for reference only.
 *
 * Limit: 64 KiB minified. Measured at the start of Phase 5, `content.js` was
 * 105 472 bytes, about 86 % of it zod and 10 % shared schemas pulled in by the
 * message protocol; after replacing them with hand-written readers it holds
 * only ContextLayer's own code. The limit leaves room for the Phase 6 player
 * (resolution and popover) while staying well under the 100 KiB target, and it
 * is far below what zod alone would take, so reintroducing a schema library in
 * the content script fails the build.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { CONTENT_SCRIPT_FILES } from '../src/content-files'

export const CONTENT_SCRIPT_BUDGET_BYTES = 64 * 1024

export interface BudgetReport {
  files: { name: string; bytes: number; gzipBytes: number }[]
  bytes: number
  gzipBytes: number
  limit: number
}

export async function measureContentScripts(outDir: string): Promise<BudgetReport> {
  const files = await Promise.all(
    CONTENT_SCRIPT_FILES.map(async (name) => {
      const content = await readFile(join(outDir, name))
      return { name, bytes: content.byteLength, gzipBytes: gzipSync(content).byteLength }
    }),
  )
  return {
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
    limit: CONTENT_SCRIPT_BUDGET_BYTES,
  }
}

export function describeBudget(report: BudgetReport): string {
  const lines = report.files.map(
    (file) => `  ${file.name}: ${String(file.bytes)} bytes (${String(file.gzipBytes)} gzip)`,
  )
  return [
    `content scripts: ${String(report.bytes)} of ${String(report.limit)} bytes minified (${String(report.gzipBytes)} gzip)`,
    ...lines,
  ].join('\n')
}

/** Throws, with the breakdown, when the injected code is over budget. */
export function assertWithinBudget(report: BudgetReport): void {
  if (report.bytes > report.limit) {
    throw new Error(
      `Content-script budget exceeded.\n${describeBudget(report)}\nSee scripts/budget.ts.`,
    )
  }
}
