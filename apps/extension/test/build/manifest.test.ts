import { describe, expect, it } from 'vitest'

import {
  CONTENT_SCRIPT_MATCHES,
  createManifest,
  originPattern,
  parseApiBaseUrl,
} from '../../manifest.config'

describe('createManifest', () => {
  const manifest = createManifest({
    version: '0.1.0',
    apiBaseUrl: new URL('https://api.contextlayer.example:8443'),
  })
  const defaultPortManifest = createManifest({
    version: '0.1.0',
    apiBaseUrl: new URL('https://api.contextlayer.example'),
  })

  it('declares a Manifest V3 extension with a module service worker', () => {
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' })
  })

  it('only grants host access to the exact API origin, port included', () => {
    expect(manifest.host_permissions).toEqual(['https://api.contextlayer.example:8443/*'])
    expect(defaultPortManifest.host_permissions).toEqual(['https://api.contextlayer.example:443/*'])
    expect(manifest.permissions).toBeUndefined()
  })

  it('restricts the Phase 1 content script to the local dashboard, ports pinned', () => {
    expect(manifest.content_scripts).toEqual([
      { matches: CONTENT_SCRIPT_MATCHES, js: ['content.js'], run_at: 'document_idle' },
    ])
    // Content-script matches grant host access too: no wildcard hosts or ports.
    for (const pattern of CONTENT_SCRIPT_MATCHES) {
      expect(pattern).toMatch(/^http:\/\/localhost:\d+\/\*$/)
    }
  })
})

describe('originPattern', () => {
  it('always pins the port, including scheme defaults that URL.origin omits', () => {
    expect(originPattern(new URL('http://localhost:3000'))).toBe('http://localhost:3000/*')
    expect(originPattern(new URL('http://localhost'))).toBe('http://localhost:80/*')
    expect(originPattern(new URL('https://api.example.com'))).toBe('https://api.example.com:443/*')
  })
})

describe('parseApiBaseUrl', () => {
  it('defaults to the local API when unset or empty', () => {
    expect(parseApiBaseUrl(undefined).origin).toBe('http://localhost:3000')
    expect(parseApiBaseUrl('  ').origin).toBe('http://localhost:3000')
  })

  it('accepts an http(s) origin, with or without a trailing slash', () => {
    expect(parseApiBaseUrl('https://api.example.com/').origin).toBe('https://api.example.com')
  })

  it('rejects paths, queries, fragments and other schemes instead of dropping them', () => {
    for (const value of [
      'https://app.example.com/api',
      'https://api.example.com/?v=1',
      'https://api.example.com/#x',
      'ftp://api.example.com',
      'not a url',
    ]) {
      expect(() => parseApiBaseUrl(value)).toThrow(/EXTENSION_API_BASE_URL/)
    }
  })
})
