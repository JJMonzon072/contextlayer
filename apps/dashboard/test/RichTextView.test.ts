import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import RichTextView from '../src/features/guides/RichTextView'

describe('RichTextView', () => {
  it('renders marks, lists and safe links with text nodes only', () => {
    const wrapper = mount(RichTextView, {
      props: {
        document: {
          version: 1,
          blocks: [
            {
              type: 'paragraph',
              children: [
                { type: 'text', text: 'Click ' },
                { type: 'text', text: 'Save', marks: ['bold', 'italic'] },
                { type: 'text', text: ' <script>alert(1)</script>' },
              ],
            },
            { type: 'list', ordered: true, items: [[{ type: 'text', text: 'One' }]] },
            {
              type: 'paragraph',
              children: [
                {
                  type: 'link',
                  href: 'https://docs.acme.test/help',
                  children: [{ type: 'text', text: 'Help' }],
                },
              ],
            },
          ],
        },
      },
    })

    expect(wrapper.find('em strong, strong em').text()).toBe('Save')
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.text()).toContain('<script>alert(1)</script>')
    expect(wrapper.find('ol li').text()).toBe('One')
    const link = wrapper.get('a')
    expect(link.attributes()).toMatchObject({
      href: 'https://docs.acme.test/help',
      rel: 'noopener noreferrer',
      target: '_blank',
    })
  })

  it('never renders a non-https link as a link', () => {
    const wrapper = mount(RichTextView, {
      props: {
        document: {
          version: 1,
          blocks: [
            {
              type: 'paragraph',
              children: [
                {
                  type: 'link',
                  href: 'javascript:alert(1)',
                  children: [{ type: 'text', text: 'Bad' }],
                },
              ],
            },
          ],
        },
      },
    })

    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).toBe('Bad')
  })
})
