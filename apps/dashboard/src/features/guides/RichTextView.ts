import type { RichText, RichTextInline, RichTextText } from '@contextlayer/shared'
import { defineComponent, h, type PropType, type VNode } from 'vue'

/**
 * Renders the restricted rich-text document with element and text nodes only:
 * every string becomes a text node, so guide content can never inject markup
 * (no `v-html`, R-11). Links are limited to https, as in the contract.
 */
const MARK_TAGS = { bold: 'strong', italic: 'em', code: 'code' } as const

function renderText(node: RichTextText): VNode | string {
  let content: VNode | string = node.text
  for (const mark of node.marks ?? []) content = h(MARK_TAGS[mark], [content])
  return content
}

function renderInline(nodes: readonly RichTextInline[]): (VNode | string)[] {
  return nodes.map((node) => {
    if (node.type === 'text') return renderText(node)
    const children = node.children.map(renderText)
    return node.href.startsWith('https://')
      ? h(
          'a',
          {
            href: node.href,
            rel: 'noopener noreferrer',
            target: '_blank',
            class: 'font-medium text-brand-700 underline underline-offset-2',
          },
          children,
        )
      : h('span', children)
  })
}

export default defineComponent({
  name: 'RichTextView',
  props: {
    document: { type: Object as PropType<RichText>, required: true },
  },
  setup(props) {
    return () =>
      h(
        'div',
        { class: 'space-y-2 text-sm leading-relaxed whitespace-pre-line text-slate-700' },
        props.document.blocks.map((block) =>
          block.type === 'paragraph'
            ? h('p', renderInline(block.children))
            : h(
                block.ordered ? 'ol' : 'ul',
                { class: block.ordered ? 'list-decimal pl-5' : 'list-disc pl-5' },
                block.items.map((item) => h('li', renderInline(item))),
              ),
        ),
      )
  },
})
