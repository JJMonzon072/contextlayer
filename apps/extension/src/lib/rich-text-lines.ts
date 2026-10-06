import type { RichText, RichTextInline } from '@contextlayer/shared'

import { PREVIEW_MAX_LINES } from '../messaging/protocol'

const inlineText = (nodes: readonly RichTextInline[]): string =>
  nodes.map((node) => (node.type === 'text' ? node.text : inlineText(node.children))).join('')

/**
 * A step's instructions as lines of plain text, for the on-page preview and
 * the Guide Player (links shown as their text; the page never parses markup).
 */
export function richTextLines(document: RichText): string[] {
  return document.blocks
    .flatMap((block) =>
      block.type === 'paragraph'
        ? [inlineText(block.children)]
        : block.items.map(
            (item, index) => `${block.ordered ? `${String(index + 1)}.` : '•'} ${inlineText(item)}`,
          ),
    )
    .slice(0, PREVIEW_MAX_LINES)
}
