import { richTextSchema, type RichText } from '@contextlayer/shared'
import { describe, expect, it } from 'vitest'

import {
  plainTextLength,
  plainTextToRichText,
  richTextToPlainText,
} from '../src/features/guides/rich-text'

describe('plain-text instructions', () => {
  it('turns blank-line separated chunks into paragraphs and dash lines into a list', () => {
    const document = plainTextToRichText('Open Customers.\n\n- Name\n- Email\n\nThen save.')

    expect(document).toEqual({
      version: 1,
      blocks: [
        { type: 'paragraph', children: [{ type: 'text', text: 'Open Customers.' }] },
        {
          type: 'list',
          ordered: false,
          items: [[{ type: 'text', text: 'Name' }], [{ type: 'text', text: 'Email' }]],
        },
        { type: 'paragraph', children: [{ type: 'text', text: 'Then save.' }] },
      ],
    })
    expect(richTextSchema.safeParse(document).success).toBe(true)
  })

  it('round-trips what it produces', () => {
    const text = 'First line\nsecond line\n\n- a\n- b'
    expect(richTextToPlainText(plainTextToRichText(text))).toBe(text)
  })

  it('keeps markup-looking text as plain text', () => {
    const document = plainTextToRichText('<img src=x onerror=alert(1)>')
    expect(document.blocks[0]).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }],
    })
  })

  it('refuses to flatten formatting it cannot represent', () => {
    const bold: RichText = {
      version: 1,
      blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'Save', marks: ['bold'] }] }],
    }
    const link: RichText = {
      version: 1,
      blocks: [
        {
          type: 'paragraph',
          children: [
            { type: 'link', href: 'https://docs.test', children: [{ type: 'text', text: 'Help' }] },
          ],
        },
      ],
    }
    expect(richTextToPlainText(bold)).toBeUndefined()
    expect(richTextToPlainText(link)).toBeUndefined()
  })

  it('counts visible characters only', () => {
    expect(plainTextLength('ab\n\n- cd')).toBe(4)
  })
})
