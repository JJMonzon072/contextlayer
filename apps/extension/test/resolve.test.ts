import type { TargetDescriptor } from '@contextlayer/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { captureTarget } from '../src/content/capture/descriptor'
import { resolveTarget, stepPagePattern, topModal, WEIGHTS } from '../src/content/resolve/resolver'

/**
 * The Phase 6a fixture corpus: each case captures a descriptor from a page
 * with the real Phase 5 capture, changes the page the way applications
 * change, and resolves. jsdom has no layout, so "rendered" is the hidden /
 * inert / removed state of the fixture; real geometry is covered by the
 * Playwright suite. All content is fictitious.
 */

const PAGE = 'http://127.0.0.1:4400/'

/** Rendered unless hidden, inert or detached (stand-in for layout). */
const isRendered = (element: Element) =>
  element.isConnected && !element.closest('[hidden], [inert], [data-collapsed]')

function page(html: string): void {
  document.body.innerHTML = html
}

function element(selector: string): Element {
  const found = document.querySelector(selector)
  if (!found) throw new Error(`No element for ${selector}`)
  return found
}

function capture(selector: string, href = PAGE): TargetDescriptor {
  const outcome = captureTarget(element(selector), {
    extensionVersion: '0.1.0',
    capturedAt: new Date('2026-10-06T10:00:00Z'),
    href,
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome.descriptor
}

function resolve(target: TargetDescriptor | null, href = PAGE) {
  return resolveTarget(target, stepPagePattern(null, target), { document, href, isRendered })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('resolving a captured target (Phase 6a corpus)', () => {
  it('1. resolves a unique test attribute directly', () => {
    page(`<button data-testid="new-customer">New customer</button><button>New</button>`)
    const target = capture('[data-testid="new-customer"]')

    const result = resolve(target)

    expect(result).toMatchObject({ outcome: 'resolved', reason: 'test-id' })
    expect(result.element).toBe(element('[data-testid="new-customer"]'))
  })

  it('2. resolves a stable id', () => {
    page(`<form><label for="customer-name">Name</label><input id="customer-name"></form>`)
    const target = capture('#customer-name')

    expect(resolve(target)).toMatchObject({
      outcome: 'resolved',
      element: element('#customer-name'),
    })
  })

  it('3. finds the element by its name when a generated id changed', () => {
    page(`<button id=":r1:">Save customer</button><button id=":r2:">Cancel</button>`)
    const target = capture('#\\:r1\\:')
    element('#\\:r1\\:').id = ':r7:'
    element('#\\:r2\\:').id = ':r8:'

    const result = resolve(target)

    expect(result.outcome).toBe('resolved')
    expect(result.element?.textContent).toBe('Save customer')
  })

  it('4. resolves by role and accessible name', () => {
    page(
      `<div role="button" aria-label="Archive customers">⋯</div><div role="button" aria-label="Export">⋯</div>`,
    )
    const target = capture('[aria-label="Archive customers"]')

    expect(resolve(target)).toMatchObject({
      outcome: 'resolved',
      element: element('[aria-label="Archive customers"]'),
    })
  })

  it('5. resolves a form control by its label', () => {
    page(
      `<label>Email <input type="email" name="email"></label><label>Phone <input name="phone"></label>`,
    )
    const target = capture('input[name="email"]')
    // The page changed the control's name; its label still says which one it is.
    element('input[name="email"]').setAttribute('name', 'contact-email')

    expect(resolve(target)).toMatchObject({
      outcome: 'resolved',
      element: element('input[type="email"]'),
    })
  })

  it('6. resolves by visible text', () => {
    page(`<p class="note">Imports run every night</p><p class="note">Exports run on demand</p>`)
    const target = capture('p:first-child')

    expect(resolve(target)).toMatchObject({
      outcome: 'resolved',
      element: element('p:first-child'),
    })
  })

  it('7. resolves a positional-only target while the structure is unchanged', () => {
    page(
      `<section><h2>Service status</h2><div class="lights"><div></div><div></div><div></div></div></section>`,
    )
    const target = capture('.lights div:nth-of-type(2)')

    expect(target.locators.map((locator) => locator.strategy)).toEqual(['cssPath'])
    expect(resolve(target)).toMatchObject({
      outcome: 'resolved',
      element: element('.lights div:nth-of-type(2)'),
    })
  })

  it('8. leaves a hidden copy out instead of calling the target ambiguous', () => {
    page(`
      <nav hidden><button>Save customer</button></nav>
      <form><button type="submit">Save customer</button></form>
    `)
    const target = capture('form button')

    const result = resolve(target)

    expect(result).toMatchObject({ outcome: 'resolved', element: element('form button') })
    expect(result.diagnostics.rendered).toBe(1)
  })

  it('9. leaves an inert copy out', () => {
    page(`
      <div inert><button>Save customer</button></div>
      <form><button type="submit">Save customer</button></form>
    `)
    const target = capture('form button')

    expect(resolve(target)).toMatchObject({ outcome: 'resolved', element: element('form button') })
  })

  it('10. reports not-found when nothing matches', () => {
    page(`<button data-testid="archive">Archive customers</button>`)
    const target = capture('button')
    page(`<p>Nothing to archive here</p>`)

    const result = resolve(target)

    expect(result).toMatchObject({ outcome: 'not-found', reason: 'no-candidates' })
    expect(result.element).toBeUndefined()
  })

  it('11. never picks one of two equal candidates', () => {
    page(`
      <ul>
        <li>Ana Ejemplo <button type="button">Edit</button></li>
        <li>Luis Prueba <button type="button">Edit</button></li>
      </ul>
    `)
    const target = capture('li:nth-of-type(2) button')

    const result = resolve(target)

    expect(result).toMatchObject({ outcome: 'ambiguous', reason: 'identical-candidates' })
    expect(result.element).toBeUndefined()
    expect(result.diagnostics.top).toHaveLength(2)
  })

  it('12. reports wrong-page when the step belongs to another page', () => {
    page(`<button data-testid="new-customer">New customer</button>`)
    const target = capture('button', 'http://127.0.0.1:4400/customers')

    const result = resolve(target, 'http://127.0.0.1:4400/reports')
    expect(result.outcome).toBe('wrong-page')
    expect(result.element).toBeUndefined()
    // The step's own pattern wins over the target's.
    expect(
      resolveTarget(target, stepPagePattern({ pathname: '/reports' }, target), {
        document,
        href: 'http://127.0.0.1:4400/reports',
        isRendered,
      }).outcome,
    ).toBe('resolved')
  })

  it('13. shows a step without a target as intentionally unanchored', () => {
    const result = resolve(null)

    expect(result.outcome).toBe('none')
    expect(result.element).toBeUndefined()
  })

  it('14. resolves a target below the viewport (it can be scrolled to)', () => {
    page(`<div style="height: 4000px"></div><button data-testid="archive">Archive</button>`)
    const target = capture('button')

    expect(resolve(target)).toMatchObject({ outcome: 'resolved', element: element('button') })
  })

  it('15. reports not-found for a target removed before the step is shown', () => {
    page(`<button type="button">Merge duplicates</button>`)
    const target = capture('button')
    element('button').remove()

    expect(resolve(target).outcome).toBe('not-found')
  })

  it('16. fails safely when a positional-only target moved', () => {
    page(
      `<section><h2>Service status</h2><div class="lights"><div></div><div></div><div></div></div></section>`,
    )
    const target = capture('.lights div:nth-of-type(2)')
    // A light is added first: the stored path now points at another element.
    element('.lights').prepend(document.createElement('div'))

    expect(resolve(target)).toMatchObject({ outcome: 'not-found', reason: 'structure-changed' })
  })
})

describe('scoring, vetoes and thresholds', () => {
  it('vetoes the same test attribute with another value', () => {
    page(`<button data-testid="save-customer">Save customer</button>`)
    const target = capture('button')
    element('button').setAttribute('data-testid', 'delete-customer')

    const result = resolve(target)

    expect(result.outcome).toBe('not-found')
    expect(result.diagnostics.vetoed).toBe(1)
  })

  it('vetoes a candidate with another role', () => {
    page(`<button type="button">Reports</button>`)
    const target = capture('button')
    page(`<a href="/reports">Reports</a>`)

    expect(resolve(target)).toMatchObject({ outcome: 'not-found' })
  })

  it('never resolves by position alone when the identifying signals all changed', () => {
    page(`<main><div><button type="button">Approve invoice</button></div></main>`)
    const target = capture('button')
    element('button').textContent = 'Delete invoice'

    expect(resolve(target)).toMatchObject({ outcome: 'not-found', reason: 'no-identity-match' })
  })

  it('still finds a button whose name gained a word', () => {
    page(`<button type="button">Save customer</button><button type="button">Cancel</button>`)
    const target = capture('button:first-child')
    element('button:first-child').textContent = 'Save the customer'

    expect(resolve(target)).toMatchObject({ outcome: 'resolved', reason: 'score' })
  })

  it('applies the stored minimum score and margin to close variants', () => {
    page(
      `<button type="button">Save customer</button><button type="button">Save customers</button>`,
    )
    const target = capture('button:first-child')
    const wideMargin = { ...target, resolution: { ...target.resolution, minMargin: 0.9 } }
    const tooStrict = { ...target, resolution: { ...target.resolution, minScore: 1.01 } }

    expect(resolve(target)).toMatchObject({ outcome: 'resolved', reason: 'score' })
    expect(resolve(target).element).toBe(element('button:first-child'))
    expect(resolve(wideMargin)).toMatchObject({ outcome: 'ambiguous', reason: 'margin' })
    expect(resolve(tooStrict)).toMatchObject({ outcome: 'not-found', reason: 'below-min-score' })
  })

  it('never separates identical candidates by position, whatever the margin', () => {
    page(`
      <ul>
        <li>Ana Ejemplo <button type="button">Edit</button></li>
        <li>Luis Prueba <button type="button">Edit</button></li>
      </ul>
    `)
    const target = capture('li:nth-of-type(2) button')
    const noMargin = { ...target, resolution: { ...target.resolution, minMargin: 0 } }

    expect(resolve(noMargin)).toMatchObject({
      outcome: 'ambiguous',
      reason: 'identical-candidates',
    })
  })

  it('tells identical candidates apart by a named region', () => {
    page(`
      <form aria-label="Customer"><button type="submit">Save</button></form>
      <form aria-label="Address"><button type="submit">Save</button></form>
    `)
    const target = capture('form[aria-label="Address"] button')

    const result = resolve(target)

    expect(result.outcome).toBe('resolved')
    expect(result.element).toBe(element('form[aria-label="Address"] button'))
  })

  it('reports frame and shadow paths as unsupported, never guessed', () => {
    page(`<button data-testid="new-customer">New customer</button>`)
    const target = capture('button')
    const framed = { ...target, framePath: [{ index: 0 }] }
    const shadowed = { ...target, shadowPath: [{ mode: 'open' as const, host: { tag: 'x-app' } }] }

    expect(resolve(framed)).toMatchObject({ outcome: 'unsupported', reason: 'frame-path' })
    expect(resolve(shadowed)).toMatchObject({ outcome: 'unsupported', reason: 'shadow-path' })
  })

  it('reports an invalid page pattern as unsupported', () => {
    page(`<button data-testid="new-customer">New customer</button>`)
    const target = capture('button')
    const broken = { ...target, page: { urlPattern: { pathname: '/(unclosed' } } }

    expect(resolve(broken)).toMatchObject({
      outcome: 'unsupported',
      reason: 'invalid-page-pattern',
    })
  })

  it('scores at most 50 candidates on a crowded page', () => {
    page('<button type="button">Edit</button>'.repeat(200))
    const target = capture('button:nth-of-type(7)')

    const result = resolve(target)

    expect(result.outcome).toBe('ambiguous')
    expect(result.diagnostics.rendered).toBeLessThanOrEqual(50)
  })

  it('keeps page text out of the diagnostics', () => {
    page(`<button type="button">Approve invoice 48213 for Dana Ficticia</button>`)
    const target = capture('button')

    const { diagnostics } = resolve(target)

    expect(JSON.stringify(diagnostics)).not.toMatch(/Approve|Dana|48213/)
  })

  it('starts from the ADR 0014 weights', () => {
    expect(WEIGHTS).toEqual({
      testId: 1,
      id: 0.8,
      roleName: 0.8,
      label: 0.7,
      text: 0.6,
      attributes: 0.5,
      anchors: 0.5,
      container: 0.4,
      cssPath: 0.3,
      classes: 0.25,
      xpath: 0.2,
      position: 0.1,
    })
  })
})

describe('modal dialogs (Phase 6b)', () => {
  const withModal = (target: TargetDescriptor, modal: Element) =>
    resolveTarget(target, stepPagePattern(null, target), {
      document,
      href: PAGE,
      isRendered,
      modal,
    })

  it('takes the copy inside an open modal dialog over an identical one it makes inert', () => {
    page(`
      <div role="dialog" aria-label="Customer"><button type="submit">Save</button></div>
      <dialog open aria-label="Customer"><button type="submit">Save</button></dialog>
    `)
    const inside = element('dialog button')
    const target = capture('dialog button')

    // Without knowing about the modal, nothing tells the two apart.
    expect(resolve(target)).toMatchObject({ outcome: 'ambiguous', reason: 'identical-candidates' })
    const result = withModal(target, element('dialog'))

    expect(result).toMatchObject({ outcome: 'resolved' })
    expect(result.element).toBe(inside)
    expect(result.diagnostics.blocked).toBe(1)
  })

  it('waits for a target behind an open modal instead of taking a copy inside it', () => {
    page(`
      <form aria-label="Customer"><button type="submit">Save</button></form>
      <dialog open aria-label="Confirm"><button type="submit">Save</button></dialog>
    `)
    const target = capture('form button')

    expect(resolve(target).element).toBe(element('form button'))
    expect(withModal(target, element('dialog'))).toMatchObject({
      outcome: 'not-found',
      reason: 'behind-modal',
    })
  })

  it('never resolves a unique test id behind an open modal', () => {
    page(
      `<button type="button" data-testid="archive">Archive</button><dialog open><p>Busy</p></dialog>`,
    )
    const target = capture('button')

    expect(withModal(target, element('dialog'))).toMatchObject({
      outcome: 'not-found',
      reason: 'behind-modal',
    })
  })

  it('never takes a copy outside a modal dialog for a target picked inside one', () => {
    page(`
      <section role="dialog" aria-label="Import"><button type="button">Confirm import</button></section>
      <div role="dialog" aria-modal="true" aria-label="Import" id="modal">
        <button type="button">Confirm import</button>
      </div>
    `)
    const target = capture('#modal button')
    expect(target.container).toMatchObject({ kind: 'dialog', modal: true })

    // The modal is closed: only the inline copy is on screen, and it does not qualify.
    element('#modal').setAttribute('hidden', '')
    const closed = resolve(target)
    expect(closed).toMatchObject({ outcome: 'not-found' })
    expect(closed.diagnostics.vetoed).toBe(1)

    // Open again: the copy inside the modal is the target.
    element('#modal').removeAttribute('hidden')
    const open = resolve(target)
    expect(open.outcome).toBe('resolved')
    expect(open.element).toBe(element('#modal button'))
  })

  it('treats a page without modal support as having no modal', () => {
    expect(topModal(document)).toBeNull()
  })
})

// Waiting, navigation and bfcache (Phase 6b) are the player's: test/player-ui.test.ts.
describe.skip('Phase 6c (planned)', () => {
  it.todo('resolves inside an open or closed shadow root')
  it.todo('resolves inside a same-origin iframe')
})
