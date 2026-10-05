import { describe, expect, it } from 'vitest'

import { DEVELOPMENT_EXTENSION_ID, DEVELOPMENT_EXTENSION_PUBLIC_KEY } from '@contextlayer/shared'

import {
  createManifest,
  originPattern,
  parseApiBaseUrl,
  parseDashboardUrl,
  parseServiceOrigin,
  resolveExtensionIdentity,
} from '../../manifest.config'

const identity = resolveExtensionIdentity({})

describe('createManifest', () => {
  const manifest = createManifest({
    version: '0.1.0',
    apiBaseUrl: new URL('https://api.contextlayer.example:8443'),
    dashboardUrl: new URL('https://app.contextlayer.example'),
    identity,
  })
  const defaultPortManifest = createManifest({
    version: '0.1.0',
    apiBaseUrl: new URL('https://api.contextlayer.example'),
    dashboardUrl: new URL('https://app.contextlayer.example'),
    identity,
  })

  it('pins the extension id with the committed public key', () => {
    expect(manifest.key).toBe(DEVELOPMENT_EXTENSION_PUBLIC_KEY)
  })

  it('declares a Manifest V3 extension with a module service worker', () => {
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' })
  })

  it('only grants host access to the exact API origin, port included', () => {
    expect(manifest.host_permissions).toEqual(['https://api.contextlayer.example:8443/*'])
    expect(defaultPortManifest.host_permissions).toEqual(['https://api.contextlayer.example:443/*'])
  })

  it('asks for storage, scripting and activeTab, and customer sites only at runtime', () => {
    expect(manifest.permissions).toEqual(['storage', 'scripting', 'activeTab'])
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*'])
  })

  it('declares no static content script: they would grant host access too', () => {
    expect(manifest.content_scripts).toBeUndefined()
  })

  it('pre-grants test sites only when the e2e build asks for them', () => {
    const e2e = createManifest({
      version: '0.1.0',
      apiBaseUrl: new URL('http://localhost:3100'),
      dashboardUrl: new URL('http://localhost:4173'),
      identity,
      preGrantedSites: [new URL('http://localhost:4179')],
    })
    expect(e2e.host_permissions).toEqual(['http://localhost:3100/*', 'http://localhost:4179/*'])
  })

  it('lets only the exact dashboard origin message the extension, no other extension', () => {
    expect(manifest.externally_connectable).toEqual({
      matches: ['https://app.contextlayer.example:443/*'],
    })
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

describe('parseDashboardUrl', () => {
  it('defaults to the local dashboard and requires https elsewhere', () => {
    expect(parseDashboardUrl(undefined).origin).toBe('http://localhost:5173')
    expect(parseDashboardUrl('https://app.example.com').origin).toBe('https://app.example.com')
    expect(() => parseDashboardUrl('http://app.example.com')).toThrow(/EXTENSION_DASHBOARD_URL/)
    expect(() => parseDashboardUrl('https://app.example.com/connect')).toThrow(
      /EXTENSION_DASHBOARD_URL/,
    )
  })
})

describe('parseServiceOrigin', () => {
  it('allows plain http only for loopback development hosts', () => {
    expect(parseServiceOrigin('X', 'http://localhost:5173', '').origin).toBe(
      'http://localhost:5173',
    )
    expect(parseServiceOrigin('X', 'http://127.0.0.1:3000', '').origin).toBe(
      'http://127.0.0.1:3000',
    )
    expect(() => parseServiceOrigin('X', 'http://api.example.com', '')).toThrow(/https/)
    expect(parseServiceOrigin('X', 'https://api.example.com', '').origin).toBe(
      'https://api.example.com',
    )
  })

  it('rejects credentials, queries and fragments, even empty ones', () => {
    for (const value of [
      'https://user:pw@api.example.com',
      'https://api.example.com?',
      'https://api.example.com#',
    ]) {
      expect(() => parseServiceOrigin('X', value, '')).toThrow(/X must be/)
    }
  })
})

describe('resolveExtensionIdentity', () => {
  it('defaults to the committed development key and its id', () => {
    expect(resolveExtensionIdentity({})).toEqual({
      publicKey: DEVELOPMENT_EXTENSION_PUBLIC_KEY,
      id: DEVELOPMENT_EXTENSION_ID,
    })
  })

  it('accepts an EXTENSION_ID that matches the key and rejects one that does not', () => {
    expect(resolveExtensionIdentity({ EXTENSION_ID: DEVELOPMENT_EXTENSION_ID }).id).toBe(
      DEVELOPMENT_EXTENSION_ID,
    )
    expect(() => resolveExtensionIdentity({ EXTENSION_ID: 'a'.repeat(32) })).toThrow(
      /does not match/,
    )
  })

  it('rejects a key that is not base64 DER', () => {
    expect(() =>
      resolveExtensionIdentity({ EXTENSION_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----' }),
    ).toThrow(/base64 DER/)
  })
})
