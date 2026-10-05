import { describe, expect, it } from 'vitest'

import {
  isGeneratedId,
  isRecordId,
  isStableClass,
  isStableTestId,
} from '../src/content/capture/identity'
import { attributeSelector, cssEscape } from '../src/content/capture/selectors'
import { capturedText, exactText } from '../src/content/capture/text'

describe('generated identifiers', () => {
  it.each([
    ':r1:', // React 18 useId
    '«r1»', // React 19.1
    '_r_1_', // React 19.2
    'v-3', // Vue 3.5 useId
    'v-3-1',
    '3f2a9c1e-7b4d-4c1a-9e2f-0a1b2c3d4e5f',
    'row-48213',
    'mat-input-3',
    'headlessui-menu-button-12',
    'save-7f3a9c21',
    'ember412',
    'ext-gen123',
    'j_idt42',
    'kPxNtw9Q',
    '',
  ])('treats %j as generated', (value) => {
    expect(isGeneratedId(value)).toBe(true)
  })

  it.each(['save-customer', 'billing-form', 'customerEmail', 'main', 'nav-primary', 'step2'])(
    'keeps %j',
    (value) => {
      expect(isGeneratedId(value)).toBe(false)
    },
  )

  it('never keeps record ids, even as flagged hints', () => {
    expect(isRecordId('customer-3f2a9c1e-7b4d-4c1a-9e2f-0a1b2c3d4e5f')).toBe(true)
    expect(isRecordId('invoice-2026')).toBe(true)
    expect(isRecordId(':r1:')).toBe(false)
  })

  it('accepts hand-written test ids and rejects counters and row ids', () => {
    expect(isStableTestId('save-customer')).toBe(true)
    expect(isStableTestId('customer "VIP" list')).toBe(true)
    expect(isStableTestId('row-48213')).toBe(false)
    expect(isStableTestId('a1B2c3D4')).toBe(false)
    expect(isStableTestId(' ')).toBe(false)
  })
})

describe('stable classes', () => {
  it.each(['btn', 'btn-primary', 'customer-form', 'Card', 'nav__link'])('keeps %j', (name) => {
    expect(isStableClass(name)).toBe(true)
  })

  it.each([
    'css-1q2w3e', // Emotion
    'sc-bdfBwQ', // styled-components
    'jss12',
    'makeStyles-root-12',
    'Button_primary__3xYz1', // CSS Modules
    '_3xYz1a',
    'is-active',
    'selected',
    'ng-touched',
    'px-4', // utilities
    'hover:bg-blue-500',
    'md:flex',
    'flex',
    'text-sm',
    'a8Kq2xZ',
  ])('drops %j', (name) => {
    expect(isStableClass(name)).toBe(false)
  })
})

describe('CSS escaping', () => {
  it('escapes like CSS.escape', () => {
    expect(cssEscape('save.customer')).toBe('save\\.customer')
    expect(cssEscape('2fa')).toBe('\\32 fa')
    expect(cssEscape('-2x')).toBe('-\\32 x')
    expect(cssEscape('-')).toBe('\\-')
    expect(cssEscape('a:b c')).toBe('a\\:b\\ c')
    expect(cssEscape('ñandú')).toBe('ñandú')
    expect(cssEscape('a\u0000b')).toBe('a�b')
  })

  it('quotes attribute values so quotes and newlines stay literal', () => {
    expect(attributeSelector('data-testid', 'say "hi"')).toBe('[data-testid="say \\"hi\\""]')
    expect(attributeSelector('title', 'a\\b\nc')).toBe('[title="a\\\\b\\a c"]')
  })
})

describe('captured text', () => {
  it('normalizes, redacts and caps, and says when it changed the value', () => {
    expect(capturedText('  Save\n  customer ')).toEqual({ text: 'Save customer', exact: true })
    expect(capturedText('Write to ana@example.test')).toEqual({
      text: 'Write to [email]',
      exact: false,
    })
    expect(capturedText('Card 4111 1111 1111 1111')).toEqual({
      text: 'Card [number]',
      exact: false,
    })
    expect(capturedText('Order 1234')).toEqual({ text: 'Order 1234', exact: true })
    expect(capturedText('x'.repeat(81))?.text).toHaveLength(80)
    expect(capturedText('   ')).toBeUndefined()
    expect(exactText('x'.repeat(81))).toBeUndefined()
  })
})
