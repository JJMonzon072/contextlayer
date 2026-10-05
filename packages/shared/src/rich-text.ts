import { z } from 'zod'

import { hasControlCharacters, isValidHostname, parseUrl } from './url.js'

/**
 * Step instructions are rendered inside customer applications, so they are a
 * restricted document, never HTML: renderers build DOM nodes and set
 * `textContent`. Version 1 allows paragraphs and lists of text runs with bold,
 * italic and code marks, and `https:` links (docs/data-model.md, section 6).
 */
export const RICH_TEXT_MARKS = ['bold', 'italic', 'code'] as const
export const RICH_TEXT_MAX_BLOCKS = 20
export const RICH_TEXT_MAX_CHARACTERS = 2000
/** Text and link nodes per document, so the JSON stays small even with one character per node. */
export const RICH_TEXT_MAX_NODES = 200

const textValue = z
  .string()
  .min(1)
  .max(RICH_TEXT_MAX_CHARACTERS)
  .refine((value) => !hasControlCharacters(value), {
    message: 'Text cannot contain control characters.',
  })

const marksSchema = z
  .array(z.enum(RICH_TEXT_MARKS))
  .max(RICH_TEXT_MARKS.length)
  .refine((marks) => new Set(marks).size === marks.length, { message: 'Repeated mark.' })

export const richTextTextSchema = z.strictObject({
  type: z.literal('text'),
  text: textValue,
  marks: marksSchema.optional(),
})

/** Only absolute `https:` links without credentials. */
export const httpsHrefSchema = z
  .string()
  .max(2048)
  .refine(
    (value) => {
      const url = parseUrl(value)
      return (
        url?.protocol === 'https:' &&
        url.username === '' &&
        url.password === '' &&
        isValidHostname(url.hostname) &&
        !/\s/.test(value)
      )
    },
    { message: 'Links must be https:// addresses.' },
  )

export const richTextLinkSchema = z.strictObject({
  type: z.literal('link'),
  href: httpsHrefSchema,
  children: z.array(richTextTextSchema).min(1).max(20),
})

export const richTextInlineSchema = z.discriminatedUnion('type', [
  richTextTextSchema,
  richTextLinkSchema,
])

const inlineList = z.array(richTextInlineSchema).min(1).max(100)

export const richTextParagraphSchema = z.strictObject({
  type: z.literal('paragraph'),
  children: inlineList,
})

export const richTextListSchema = z.strictObject({
  type: z.literal('list'),
  ordered: z.boolean(),
  items: z.array(inlineList).min(1).max(50),
})

export const richTextBlockSchema = z.discriminatedUnion('type', [
  richTextParagraphSchema,
  richTextListSchema,
])

function inlineText(inline: readonly RichTextInline[]): string {
  return inline
    .map((node) => (node.type === 'text' ? node.text : inlineText(node.children)))
    .join('')
}

function inlineNodeCount(inline: readonly RichTextInline[]): number {
  return inline.reduce(
    (total, node) => total + 1 + (node.type === 'link' ? node.children.length : 0),
    0,
  )
}

/** Inline nodes of the whole document (a link counts with its text runs). */
export function richTextNodeCount(document: RichText): number {
  return document.blocks.reduce(
    (total, block) =>
      total +
      (block.type === 'paragraph'
        ? inlineNodeCount(block.children)
        : block.items.reduce((sum, item) => sum + inlineNodeCount(item), 0)),
    0,
  )
}

/** Every character of visible text, for the length limit and for previews. */
export function richTextCharacterCount(document: RichText): number {
  return document.blocks.reduce(
    (total, block) =>
      total +
      (block.type === 'paragraph'
        ? inlineText(block.children).length
        : block.items.reduce((sum, item) => sum + inlineText(item).length, 0)),
    0,
  )
}

export const richTextV1Schema = z
  .strictObject({
    version: z.literal(1),
    blocks: z.array(richTextBlockSchema).max(RICH_TEXT_MAX_BLOCKS),
  })
  .superRefine((document, ctx) => {
    if (richTextCharacterCount(document) > RICH_TEXT_MAX_CHARACTERS) {
      ctx.addIssue({
        code: 'custom',
        message: `Use at most ${String(RICH_TEXT_MAX_CHARACTERS)} characters.`,
      })
    }
    if (richTextNodeCount(document) > RICH_TEXT_MAX_NODES) {
      ctx.addIssue({
        code: 'custom',
        message: `Use at most ${String(RICH_TEXT_MAX_NODES)} formatted runs of text.`,
      })
    }
  })

/** Discriminated on `version`: unknown versions are rejected. */
export const richTextSchema = z.discriminatedUnion('version', [richTextV1Schema])

export type RichText = z.infer<typeof richTextSchema>
export type RichTextBlock = z.infer<typeof richTextBlockSchema>
export type RichTextInline = z.infer<typeof richTextInlineSchema>
export type RichTextText = z.infer<typeof richTextTextSchema>
export type RichTextMark = (typeof RICH_TEXT_MARKS)[number]

export const EMPTY_RICH_TEXT: RichText = { version: 1, blocks: [] }
