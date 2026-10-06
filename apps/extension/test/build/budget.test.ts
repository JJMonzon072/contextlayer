import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assertWithinBudget,
  CONTENT_SCRIPT_BUDGET_BYTES,
  measureContentScripts,
} from '../../scripts/budget'

describe('content-script budget', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('measures every injected file and fails the build above the limit', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cl-budget-'))
    await writeFile(join(dir, 'content.js'), 'x'.repeat(CONTENT_SCRIPT_BUDGET_BYTES))
    const atLimit = await measureContentScripts(dir)
    expect(atLimit.bytes).toBe(CONTENT_SCRIPT_BUDGET_BYTES)
    expect(() => {
      assertWithinBudget(atLimit)
    }).not.toThrow()

    await writeFile(join(dir, 'content.js'), 'x'.repeat(CONTENT_SCRIPT_BUDGET_BYTES + 1))
    expect(() => {
      assertWithinBudget(atLimit)
    }).not.toThrow()
    const over = await measureContentScripts(dir)
    expect(() => {
      assertWithinBudget(over)
    }).toThrow(/Content-script budget exceeded/)
  })

  it('stays well under the 100 KiB target', () => {
    expect(CONTENT_SCRIPT_BUDGET_BYTES).toBeLessThan(100 * 1024)
  })
})

describe('extension entry points', () => {
  it('configure zod jitless before any other import', async () => {
    for (const entry of ['src/background/index.ts', 'src/popup/main.ts']) {
      const source = await readFile(join(import.meta.dirname, '../..', entry), 'utf8')
      const firstImport = source.split('\n').find((line) => line.startsWith('import '))
      expect(firstImport, entry).toBe("import '../lib/zod-jitless'")
    }
  })
})
