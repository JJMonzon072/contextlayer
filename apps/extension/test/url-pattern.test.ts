import { describe, expect, it } from 'vitest'

import { pagePattern } from '../src/content/capture/page'
import { matchPage } from '../src/lib/url-pattern'

describe('matchPage', () => {
  it('treats no pattern as any page of the origin', () => {
    expect(matchPage(null, 'http://127.0.0.1:4400/anything?q=1')).toBe('match')
  })

  it('matches the patterns capture stores, without query or fragment', () => {
    const pattern = pagePattern('http://127.0.0.1:4400/customers/48213/edit?tab=2#notes')

    expect(matchPage(pattern, 'http://127.0.0.1:4400/customers/7/edit')).toBe('match')
    expect(matchPage(pattern, 'http://127.0.0.1:4400/customers/7/edit?tab=9#x')).toBe('match')
    expect(matchPage(pattern, 'http://127.0.0.1:4400/customers/7')).toBe('no-match')
    expect(matchPage(pattern, 'http://127.0.0.1:4401/customers/7/edit')).toBe('no-match')
    expect(matchPage(pattern, 'https://127.0.0.1:4400/customers/7/edit')).toBe('no-match')
  })

  it('leaves out components as wildcards', () => {
    expect(matchPage({ pathname: '/demo/' }, 'http://localhost:4179/demo/')).toBe('match')
    expect(matchPage({ pathname: '/demo/' }, 'https://crm.acme.test/demo/')).toBe('match')
    expect(matchPage({ pathname: '/demo/' }, 'http://localhost:4179/demo/strict/')).toBe('no-match')
    expect(matchPage({ pathname: '/customers/*' }, 'http://x.test/customers/1/edit')).toBe('match')
  })

  it('never treats a pattern URLPattern refuses as a match', () => {
    expect(matchPage({ pathname: '/(unclosed' }, 'http://x.test/(unclosed')).toBe('invalid')
  })

  it('keeps literal characters capture escaped', () => {
    const pattern = pagePattern('http://x.test/help/q+a')

    expect(pattern.pathname).toBe('/help/q\\+a')
    expect(matchPage(pattern, 'http://x.test/help/q+a')).toBe('match')
    expect(matchPage(pattern, 'http://x.test/help/qqa')).toBe('no-match')
  })

  it('matches named parameters, the search and the hash where a pattern has them', () => {
    expect(matchPage({ pathname: '/customers/:id' }, 'http://x.test/customers/7')).toBe('match')
    expect(matchPage({ pathname: '/customers/:id' }, 'http://x.test/customers/7/edit')).toBe(
      'no-match',
    )
    expect(
      matchPage({ pathname: '/reports', search: 'tab=*' }, 'http://x.test/reports?tab=2'),
    ).toBe('match')
    expect(matchPage({ pathname: '/reports', search: 'tab=*' }, 'http://x.test/reports')).toBe(
      'no-match',
    )
    expect(matchPage({ hash: 'details' }, 'http://x.test/any#details')).toBe('match')
    expect(matchPage({ hash: 'details' }, 'http://x.test/any#other')).toBe('no-match')
  })

  it('follows a URL as the application changes it (Phase 6b): push, replace, back, hash, hard', () => {
    const form = { pathname: '/demo/flow/customers/new' }
    const list = 'http://localhost:4179/demo/flow/'
    const formUrl = 'http://localhost:4179/demo/flow/customers/new'
    // pushState or a link to the form, replaceState back to the list, the hash on the form.
    expect(
      [list, formUrl, list, `${formUrl}#details`, `${formUrl}?from=link`].map((url) =>
        matchPage(form, url),
      ),
    ).toEqual(['no-match', 'match', 'no-match', 'match', 'match'])
  })
})
