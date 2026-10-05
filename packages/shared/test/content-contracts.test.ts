import { describe, expect, it } from 'vitest'

import {
  applicationListQuerySchema,
  createApplicationRequestSchema,
  createGuideRequestSchema,
  guideListQuerySchema,
  guideSnapshotSchema,
  originListSchema,
  originMatchPattern,
  parseOrigin,
  replaceStepsRequestSchema,
  richTextSchema,
  roleAtLeast,
  targetDescriptorSchema,
  updateApplicationRequestSchema,
  updateGuideRequestSchema,
  urlPatternSchema,
} from '../src/index.js'
import { richText, targetDescriptor } from './fixtures.js'

describe('parseOrigin', () => {
  it.each([
    ['https://app.example.com', 'https://app.example.com'],
    ['https://app.example.com:8443', 'https://app.example.com:8443'],
    ['http://localhost:5173', 'http://localhost:5173'],
    ['HTTPS://App.Example.COM', 'https://app.example.com'],
    ['https://app.example.com:443', 'https://app.example.com'],
    ['https://app.example.com/', 'https://app.example.com'],
    ['  https://crm.example.com  ', 'https://crm.example.com'],
    ['https://bücher.example', 'https://xn--bcher-kva.example'],
    ['http://10.0.0.12:8080', 'http://10.0.0.12:8080'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
  ])('accepts %s as %s', (input, origin) => {
    expect(parseOrigin(input)).toEqual({ ok: true, origin })
  })

  it.each([
    ['https://app.example.com/path', /path/],
    ['https://app.example.com?foo=bar', /query/],
    ['https://app.example.com?', /query/],
    ['https://app.example.com#top', /fragment/],
    ['https://app.example.com/.', /path/],
    ['*.example.com', /Wildcards/],
    ['https://*.example.com', /Wildcards/],
    ['example.com', /scheme/],
    ['//example.com', /scheme/],
    ['javascript:alert(1)', /scheme/],
    ['javascript://alert(1)', /http and https/],
    ['ftp://files.example.com', /http and https/],
    ['chrome-extension://abcdefghijklmnop', /http and https/],
    ['https://user:secret@app.example.com', /user name/],
    ['https://app.example.com.', /host name/],
    ['https://app_name.example.com', /host name/],
    ['https://app.example.com:0', /port/],
    ['https://app.example.com:99999', /host name/],
    ['https://app example.com', /spaces/],
    ['', /Enter/],
    [`https://${'a'.repeat(250)}.com`, /at most/],
  ])('rejects %s', (input, message) => {
    const result = parseOrigin(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(message)
  })
})

describe('originMatchPattern', () => {
  it('pins the port, including scheme defaults, so other ports never match', () => {
    expect(originMatchPattern('https://crm.acme.test')).toBe('https://crm.acme.test:443/*')
    expect(originMatchPattern('http://localhost:4179')).toBe('http://localhost:4179/*')
    expect(originMatchPattern('http://intranet.test')).toBe('http://intranet.test:80/*')
    expect(originMatchPattern(new URL('https://crm.acme.test:8443/path?q=1'))).toBe(
      'https://crm.acme.test:8443/*',
    )
  })
})

describe('originListSchema', () => {
  it('stores normalized origins', () => {
    expect(originListSchema.parse(['HTTPS://A.example.com/', 'http://localhost:3000'])).toEqual([
      'https://a.example.com',
      'http://localhost:3000',
    ])
  })

  it('rejects duplicates after normalization', () => {
    const result = originListSchema.safeParse([
      'https://a.example.com',
      'HTTPS://A.EXAMPLE.COM:443',
    ])
    expect(result.error?.issues[0]?.message).toBe('https://a.example.com is listed twice.')
  })

  it('needs 1 to 20 origins', () => {
    expect(originListSchema.safeParse([]).success).toBe(false)
    const many = Array.from({ length: 21 }, (_, i) => `https://app${String(i)}.example.com`)
    expect(originListSchema.safeParse(many).success).toBe(false)
  })
})

describe('application requests', () => {
  it('rejects keys the client may not set (mass assignment)', () => {
    const result = createApplicationRequestSchema.safeParse({
      name: 'CRM',
      origins: ['https://crm.example.com'],
      workspaceId: '01a10a2e-864b-75bc-8800-aa3f01a05314',
    })
    expect(result.success).toBe(false)
  })

  it('bounds the name and requires a change on update', () => {
    expect(
      createApplicationRequestSchema.safeParse({ name: ' ', origins: ['https://a.example.com'] })
        .success,
    ).toBe(false)
    expect(
      createApplicationRequestSchema.safeParse({
        name: 'x'.repeat(81),
        origins: ['https://a.example.com'],
      }).success,
    ).toBe(false)
    expect(updateApplicationRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe('richTextSchema', () => {
  it('accepts the documented example', () => {
    expect(richTextSchema.parse(richText())).toEqual(richText())
  })

  it('rejects unknown versions and block types', () => {
    expect(richTextSchema.safeParse({ ...richText(), version: 999 }).success).toBe(false)
    expect(
      richTextSchema.safeParse({ version: 1, blocks: [{ type: 'html', html: '<b>x</b>' }] })
        .success,
    ).toBe(false)
  })

  it.each([
    'javascript:alert(1)',
    'http://docs.example.com',
    'https://user:pw@example.com',
    '/relative',
  ])('rejects the link %s', (href) => {
    const document = {
      version: 1,
      blocks: [
        {
          type: 'paragraph',
          children: [{ type: 'link', href, children: [{ type: 'text', text: 'Help' }] }],
        },
      ],
    }
    expect(richTextSchema.safeParse(document).success).toBe(false)
  })

  it('rejects style or event attributes smuggled as extra keys', () => {
    const document = {
      version: 1,
      blocks: [
        { type: 'paragraph', children: [{ type: 'text', text: 'Hi', onclick: 'alert(1)' }] },
      ],
    }
    expect(richTextSchema.safeParse(document).success).toBe(false)
  })

  it('bounds the number of text runs, so one character per node cannot bloat a body', () => {
    const runs = (count: number) =>
      Array.from({ length: count }, () => ({ type: 'text', text: 'x', marks: ['bold'] }))
    expect(
      richTextSchema.safeParse({
        version: 1,
        blocks: [
          { type: 'paragraph', children: runs(100) },
          { type: 'paragraph', children: runs(100) },
        ],
      }).success,
    ).toBe(true)
    expect(
      richTextSchema.safeParse({
        version: 1,
        blocks: [
          { type: 'paragraph', children: runs(100) },
          { type: 'paragraph', children: runs(100) },
          { type: 'paragraph', children: runs(1) },
        ],
      }).success,
    ).toBe(false)
  })

  it('bounds total length, block count, marks and control characters', () => {
    const paragraph = (text: string) => ({ type: 'paragraph', children: [{ type: 'text', text }] })
    expect(
      richTextSchema.safeParse({
        version: 1,
        blocks: [paragraph('a'.repeat(1500)), paragraph('b'.repeat(501))],
      }).success,
    ).toBe(false)
    expect(
      richTextSchema.safeParse({
        version: 1,
        blocks: Array.from({ length: 21 }, () => paragraph('x')),
      }).success,
    ).toBe(false)
    expect(
      richTextSchema.safeParse({
        version: 1,
        blocks: [
          { type: 'paragraph', children: [{ type: 'text', text: 'x', marks: ['bold', 'bold'] }] },
        ],
      }).success,
    ).toBe(false)
    expect(
      richTextSchema.safeParse({ version: 1, blocks: [paragraph('bell\u0007')] }).success,
    ).toBe(false)
    expect(
      richTextSchema.safeParse({ version: 1, blocks: [paragraph('two\nlines')] }).success,
    ).toBe(true)
  })
})

describe('targetDescriptorSchema', () => {
  it('accepts the ADR 0014 example', () => {
    expect(targetDescriptorSchema.parse(targetDescriptor())).toEqual(targetDescriptor())
  })

  it('rejects an unknown version', () => {
    expect(targetDescriptorSchema.safeParse({ ...targetDescriptor(), version: 999 }).success).toBe(
      false,
    )
  })

  it('rejects unknown keys at any level', () => {
    const descriptor = targetDescriptor()
    expect(targetDescriptorSchema.safeParse({ ...descriptor, html: '<div>' }).success).toBe(false)
    expect(
      targetDescriptorSchema.safeParse({
        ...descriptor,
        element: { ...descriptor.element, outerHTML: '<button>' },
      }).success,
    ).toBe(false)
  })

  it('caps captured strings at 80 characters', () => {
    const descriptor = targetDescriptor()
    const long = {
      ...descriptor,
      element: { ...descriptor.element, accessibleName: 'x'.repeat(81) },
    }
    expect(targetDescriptorSchema.safeParse(long).success).toBe(false)
  })

  it('needs 1 to 12 locators and at most 6 anchors', () => {
    const descriptor = targetDescriptor()
    const locator = descriptor.locators[0]
    expect(targetDescriptorSchema.safeParse({ ...descriptor, locators: [] }).success).toBe(false)
    expect(
      targetDescriptorSchema.safeParse({ ...descriptor, locators: Array(13).fill(locator) })
        .success,
    ).toBe(false)
    expect(
      targetDescriptorSchema.safeParse({
        ...descriptor,
        anchors: Array(7).fill({ relation: 'label', text: 'Name' }),
      }).success,
    ).toBe(false)
  })

  it('rejects unknown locator strategies', () => {
    const descriptor = targetDescriptor()
    const locators = [
      { strategy: 'javascript', code: 'document.body', scope: 'root', matchCount: 1 },
    ]
    expect(targetDescriptorSchema.safeParse({ ...descriptor, locators }).success).toBe(false)
  })

  it('rejects a descriptor larger than 16 KB even when each field is in bounds', () => {
    const part = 'p'.repeat(256)
    const pattern = {
      protocol: part,
      hostname: part,
      port: part,
      pathname: part,
      search: part,
      hash: part,
    }
    const base = targetDescriptor()
    const attributes = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`data-attr-${String(i)}`, 'v'.repeat(80)]),
    )
    const descriptor = {
      ...base,
      element: { ...base.element, attributes },
      framePath: Array.from({ length: 5 }, () => ({ urlPattern: pattern })),
      locators: Array.from({ length: 12 }, () => ({
        strategy: 'xpath',
        expression: 'x'.repeat(512),
        scope: 'root',
        matchCount: 1,
      })),
    }
    const result = targetDescriptorSchema.safeParse(descriptor)
    expect(result.error?.issues[0]?.message).toMatch(/16384/)
  })
})

describe('urlPatternSchema', () => {
  it('accepts URLPattern init objects', () => {
    expect(urlPatternSchema.parse({ pathname: '/customers/:id' })).toEqual({
      pathname: '/customers/:id',
    })
  })

  it('rejects empty, unknown and whitespace components', () => {
    expect(urlPatternSchema.safeParse({}).success).toBe(false)
    expect(urlPatternSchema.safeParse({ baseURL: 'https://a.test' }).success).toBe(false)
    expect(urlPatternSchema.safeParse({ pathname: '/a b' }).success).toBe(false)
  })
})

describe('guide requests', () => {
  const step = { title: 'Open Customers', body: richText() }

  it('derives positions from array order and rejects a step listed twice', () => {
    const id = '01a10a2e-864b-75bc-8800-aa3f01a05399'
    expect(
      replaceStepsRequestSchema.safeParse({
        expectedRevision: 1,
        steps: [
          { ...step, id },
          { ...step, id },
        ],
      }).success,
    ).toBe(false)
    expect(
      replaceStepsRequestSchema.safeParse({
        expectedRevision: 1,
        steps: [{ ...step, position: 3 }],
      }).success,
    ).toBe(false)
  })

  it('caps a guide at 50 steps and requires the revision it was based on', () => {
    expect(
      replaceStepsRequestSchema.safeParse({ expectedRevision: 1, steps: Array(51).fill(step) })
        .success,
    ).toBe(false)
    expect(replaceStepsRequestSchema.safeParse({ steps: [step] }).success).toBe(false)
  })

  it('accepts steps without a target (captured later in Edit Mode)', () => {
    const parsed = replaceStepsRequestSchema.parse({ expectedRevision: 2, steps: [step] })
    expect(parsed.steps[0]?.target).toBeUndefined()
  })

  it('validates step targets with the descriptor contract', () => {
    expect(
      replaceStepsRequestSchema.safeParse({
        expectedRevision: 1,
        steps: [{ ...step, target: { ...targetDescriptor(), version: 999 } }],
      }).success,
    ).toBe(false)
  })

  it('rejects keys the client may not set', () => {
    expect(
      createGuideRequestSchema.safeParse({
        applicationId: '01a10a2e-864b-75bc-8800-aa3f01a05314',
        title: 'Create a customer',
        status: 'published',
      }).success,
    ).toBe(false)
    expect(updateGuideRequestSchema.safeParse({ expectedRevision: 3 }).success).toBe(false)
  })

  it('never accepts a snapshot without steps', () => {
    const snapshot = {
      version: 1,
      guide: {
        id: '01a10a2e-864b-75bc-8800-aa3f01a05314',
        applicationId: '01a10a2e-864b-75bc-8800-aa3f01a05315',
        title: 'T',
        description: '',
        startUrlPattern: null,
      },
      steps: [],
    }
    expect(guideSnapshotSchema.safeParse(snapshot).success).toBe(false)
  })
})

describe('pagination queries', () => {
  it('defaults and bounds the limit', () => {
    expect(applicationListQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(applicationListQuerySchema.parse({ limit: '100' }).limit).toBe(100)
    expect(applicationListQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(applicationListQuerySchema.safeParse({ limit: '101' }).success).toBe(false)
    expect(applicationListQuerySchema.safeParse({ limit: 'ten' }).success).toBe(false)
  })

  it('rejects malformed cursors and unexpected enum values', () => {
    expect(applicationListQuerySchema.safeParse({ cursor: "' or 1=1 --" }).success).toBe(false)
    expect(guideListQuerySchema.safeParse({ status: 'deleted' }).success).toBe(false)
    expect(guideListQuerySchema.safeParse({ applicationId: 'not-a-uuid' }).success).toBe(false)
  })
})

describe('roleAtLeast', () => {
  it('orders owner > admin > editor > member', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true)
    expect(roleAtLeast('admin', 'admin')).toBe(true)
    expect(roleAtLeast('editor', 'admin')).toBe(false)
    expect(roleAtLeast('editor', 'editor')).toBe(true)
    expect(roleAtLeast('member', 'editor')).toBe(false)
  })
})
