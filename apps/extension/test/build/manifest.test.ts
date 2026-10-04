import { describe, expect, it } from 'vitest'

import { CONTENT_SCRIPT_MATCHES, createManifest } from '../../manifest.config'

describe('createManifest', () => {
  const manifest = createManifest({
    version: '0.1.0',
    apiBaseUrl: new URL('https://api.contextlayer.example:8443'),
  })

  it('declares a Manifest V3 extension with a module service worker', () => {
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' })
  })

  it('only grants host access to the API origin', () => {
    expect(manifest.host_permissions).toEqual(['https://api.contextlayer.example/*'])
    expect(manifest.permissions).toBeUndefined()
  })

  it('restricts the Phase 1 content script to local development hosts', () => {
    expect(manifest.content_scripts).toEqual([
      { matches: CONTENT_SCRIPT_MATCHES, js: ['content.js'], run_at: 'document_idle' },
    ])
    expect(
      CONTENT_SCRIPT_MATCHES.every((pattern) =>
        /^http:\/\/(localhost|127\.0\.0\.1)\//.test(pattern),
      ),
    ).toBe(true)
  })
})
