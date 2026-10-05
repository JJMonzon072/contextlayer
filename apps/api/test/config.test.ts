import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from '../src/config/env.js'

const DATABASE_URL = 'postgres://contextlayer:contextlayer@localhost:5432/contextlayer'

describe('loadConfig', () => {
  it('applies defaults when only DATABASE_URL is provided', () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      env: 'development',
      server: { host: 'localhost', port: 3000 },
      logLevel: 'info',
      database: { url: DATABASE_URL },
      session: {
        cookieName: 'cl_session',
        idleTimeoutMs: 30 * 60_000,
        absoluteTimeoutMs: 8 * 3_600_000,
      },
      http: {
        dashboardOrigins: ['http://localhost:5173', 'http://localhost:4173'],
        trustProxy: [],
      },
      rateLimits: { windowMs: 900_000, loginMax: 10, registerMax: 20 },
    })
  })

  it('names the session cookie with the __Host- prefix only in production', () => {
    const production = loadConfig({
      DATABASE_URL,
      NODE_ENV: 'production',
      DASHBOARD_ORIGIN: 'https://app.example.com',
    })

    expect(production.session.cookieName).toBe('__Host-cl_session')
    expect(loadConfig({ DATABASE_URL, NODE_ENV: 'development' }).session.cookieName).toBe(
      'cl_session',
    )
  })

  it('reads session lifetimes from the environment', () => {
    const { session } = loadConfig({
      DATABASE_URL,
      SESSION_IDLE_MINUTES: '15',
      SESSION_ABSOLUTE_HOURS: '4',
    })

    expect(session.idleTimeoutMs).toBe(15 * 60_000)
    expect(session.absoluteTimeoutMs).toBe(4 * 3_600_000)
  })

  it('coerces API_PORT from a string', () => {
    expect(loadConfig({ DATABASE_URL, API_PORT: '4000' }).server.port).toBe(4000)
  })

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
  })

  it('rejects non-PostgreSQL connection strings', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://user@localhost/db' })).toThrow(/DATABASE_URL/)
  })

  it('rejects out-of-range ports', () => {
    expect(() => loadConfig({ DATABASE_URL, API_PORT: '70000' })).toThrow(ConfigError)
  })

  it('requires an explicit dashboard origin allow-list in production', () => {
    expect(() => loadConfig({ DATABASE_URL, NODE_ENV: 'production' })).toThrow(/DASHBOARD_ORIGIN/)
  })

  it('parses the dashboard origins and trusted proxies as comma-separated lists', () => {
    const config = loadConfig({
      DATABASE_URL,
      DASHBOARD_ORIGIN: 'https://app.example.com, https://staging.example.com',
      TRUST_PROXY: '10.0.0.0/8, 192.168.1.10',
    })

    expect(config.http).toEqual({
      dashboardOrigins: ['https://app.example.com', 'https://staging.example.com'],
      trustProxy: ['10.0.0.0/8', '192.168.1.10'],
    })
  })

  it('rejects dashboard origins with a path or a trailing slash', () => {
    for (const value of [
      'https://app.example.com/',
      'https://app.example.com/api',
      'app.example.com',
    ]) {
      expect(() => loadConfig({ DATABASE_URL, DASHBOARD_ORIGIN: value })).toThrow(ConfigError)
    }
  })
})
