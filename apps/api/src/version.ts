import { readFileSync } from 'node:fs'

/**
 * Version of the running API, read from its package.json. The path resolves the
 * same way from `src/` (tsx) and `dist/` (compiled), both one level deep.
 */
export function readApiVersion(): string {
  const packageJson: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )

  if (
    typeof packageJson === 'object' &&
    packageJson !== null &&
    'version' in packageJson &&
    typeof packageJson.version === 'string'
  ) {
    return packageJson.version
  }
  return '0.0.0'
}
