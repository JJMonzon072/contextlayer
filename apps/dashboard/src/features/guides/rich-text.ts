import { richTextCharacterCount, type RichText, type RichTextBlock } from '@contextlayer/shared'

/**
 * The dashboard edits step instructions as plain text until a rich-text editor
 * exists: blank lines separate paragraphs, and a paragraph whose lines all
 * start with "- " becomes a bulleted list. Formatting the plain-text editor
 * cannot express (marks, links, numbered lists) is detected so it is never
 * silently dropped.
 */

export function plainTextToRichText(text: string): RichText {
  const blocks = text
    .replaceAll('\r\n', '\n')
    .split(/\n[ \t]*\n/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map((chunk): RichTextBlock => {
      const lines = chunk.split('\n')
      if (lines.every((line) => line.startsWith('- ') && line.slice(2).trim() !== '')) {
        return {
          type: 'list',
          ordered: false,
          items: lines.map((line) => [{ type: 'text', text: line.slice(2).trim() }]),
        }
      }
      return { type: 'paragraph', children: [{ type: 'text', text: chunk }] }
    })
  return { version: 1, blocks }
}

/** `undefined` when the document uses formatting plain text cannot represent. */
export function richTextToPlainText(document: RichText): string | undefined {
  const parts: string[] = []
  for (const block of document.blocks) {
    if (block.type === 'paragraph') {
      const [only, ...rest] = block.children
      if (!only || rest.length > 0 || only.type !== 'text' || only.marks?.length) return undefined
      parts.push(only.text)
    } else {
      if (block.ordered) return undefined
      const lines: string[] = []
      for (const item of block.items) {
        const [only, ...rest] = item
        if (!only || rest.length > 0 || only.type !== 'text' || only.marks?.length) return undefined
        lines.push(`- ${only.text}`)
      }
      parts.push(lines.join('\n'))
    }
  }
  return parts.join('\n\n')
}

/** Visible characters, for the 2000-character limit shown next to the editor. */
export function plainTextLength(text: string): number {
  return richTextCharacterCount(plainTextToRichText(text))
}
