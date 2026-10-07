import { describe, expect, it, vi } from 'vitest'

import { followNavigation } from '../src/content/navigation'

/** Same-document navigation as the content script follows it (ADR 0019). */
describe('following navigation in the page', () => {
  it('follows the Navigation API when the page has it, and stops on demand', () => {
    const navigation = new EventTarget()
    const fake = Object.assign(new EventTarget(), { navigation }) as unknown as Window
    const changed = vi.fn()

    const stop = followNavigation(fake, changed)
    // pushState, replaceState, the hash and back / forward all end in this event.
    navigation.dispatchEvent(new Event('currententrychange'))
    // The fallbacks are not used alongside it: no double call.
    fake.dispatchEvent(new Event('popstate'))
    expect(changed).toHaveBeenCalledOnce()

    stop()
    navigation.dispatchEvent(new Event('currententrychange'))
    expect(changed).toHaveBeenCalledOnce()
  })

  it('falls back to popstate and hashchange without the Navigation API', () => {
    const fake = new EventTarget() as unknown as Window
    const changed = vi.fn()

    const stop = followNavigation(fake, changed)
    fake.dispatchEvent(new Event('popstate'))
    fake.dispatchEvent(new Event('hashchange'))
    expect(changed).toHaveBeenCalledTimes(2)

    stop()
    fake.dispatchEvent(new Event('popstate'))
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
