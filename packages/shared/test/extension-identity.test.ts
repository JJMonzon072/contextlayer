import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  DEVELOPMENT_EXTENSION_ID,
  DEVELOPMENT_EXTENSION_PUBLIC_KEY,
  extensionIdFromDigestHex,
  extensionOrigin,
  isExtensionId,
} from '../src/index.js'

describe('extension identity', () => {
  it('derives the committed development id from the committed public key', () => {
    const digest = createHash('sha256')
      .update(Buffer.from(DEVELOPMENT_EXTENSION_PUBLIC_KEY, 'base64'))
      .digest('hex')

    expect(extensionIdFromDigestHex(digest)).toBe(DEVELOPMENT_EXTENSION_ID)
  })

  it('maps hex digits 0-f to letters a-p, as Chrome does', () => {
    expect(extensionIdFromDigestHex('0123456789abcdef0123456789abcdef99')).toBe(
      'abcdefghijklmnopabcdefghijklmnop',
    )
  })

  it('recognizes extension ids and builds their origin', () => {
    expect(isExtensionId(DEVELOPMENT_EXTENSION_ID)).toBe(true)
    expect(isExtensionId('ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP')).toBe(false)
    expect(isExtensionId('abcdefghijklmnopq')).toBe(false)
    expect(extensionOrigin(DEVELOPMENT_EXTENSION_ID)).toBe(
      `chrome-extension://${DEVELOPMENT_EXTENSION_ID}`,
    )
  })
})
