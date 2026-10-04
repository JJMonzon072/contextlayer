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
    })
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
})
