import { DEVELOPMENT_EXTENSION_ID } from '@contextlayer/shared'

import { sessionCookieName, type AppConfig } from '../../src/config/env.js'

/** Configuration for tests that build the app directly (no environment variables). */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    env: 'test',
    server: { host: 'localhost', port: 0 },
    logLevel: 'silent',
    database: { url: 'postgres://unused@localhost/unused_test' },
    session: {
      cookieName: sessionCookieName('test'),
      idleTimeoutMs: 30 * 60_000,
      absoluteTimeoutMs: 8 * 3_600_000,
    },
    http: { dashboardOrigins: ['http://localhost:5173', 'http://localhost:4173'], trustProxy: [] },
    rateLimits: {
      windowMs: 15 * 60_000,
      loginMax: 10,
      registerMax: 20,
      extensionTokenMax: 120,
      extensionCodeMax: 30,
    },
    extension: {
      id: DEVELOPMENT_EXTENSION_ID,
      accessTokenTtlMs: 15 * 60_000,
      grantTtlMs: 30 * 86_400_000,
    },
    ...overrides,
  }
}
