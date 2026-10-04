import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { StatusBadge } from '../src/index'

describe('StatusBadge', () => {
  it('renders its label and defaults to the neutral tone', () => {
    const wrapper = mount(StatusBadge, { slots: { default: 'Checking' } })

    expect(wrapper.text()).toBe('Checking')
    expect(wrapper.attributes('data-tone')).toBe('neutral')
  })

  it('applies the classes of the requested tone', () => {
    const wrapper = mount(StatusBadge, { props: { tone: 'success' }, slots: { default: 'Up' } })

    expect(wrapper.attributes('data-tone')).toBe('success')
    expect(wrapper.classes()).toContain('bg-emerald-50')
  })

  it('hides the decorative dot from assistive technology', () => {
    const wrapper = mount(StatusBadge, { props: { tone: 'danger' }, slots: { default: 'Down' } })

    expect(wrapper.find('[aria-hidden="true"]').exists()).toBe(true)
  })
})
