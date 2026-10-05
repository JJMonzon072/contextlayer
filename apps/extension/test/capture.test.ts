import { targetDescriptorSchema, type TargetDescriptor } from '@contextlayer/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { summarizeTarget } from '../src/authoring/target-summary'
import { accessibleName, contentText, labelText, roleOf } from '../src/content/capture/accessible'
import { captureTarget, countText, promote } from '../src/content/capture/descriptor'
import { pagePattern } from '../src/content/capture/page'

const CONTEXT = {
  extensionVersion: '0.1.0',
  capturedAt: new Date('2026-10-05T10:00:00Z'),
  href: 'http://localhost:4179/customers/48213/edit?token=abc&email=ana%40example.test#notes',
  viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
  chromeMajor: 153,
}

function page(html: string): void {
  document.body.innerHTML = html
}

function element(selector: string): Element {
  const found = document.querySelector(selector)
  if (!found) throw new Error(`No element for ${selector}`)
  return found
}

/** Captures and checks the result against the shared contract, as the worker does. */
function capture(selector: string): TargetDescriptor {
  const outcome = captureTarget(element(selector), CONTEXT)
  if (!outcome.ok) throw new Error(outcome.reason)
  expect(targetDescriptorSchema.safeParse(outcome.descriptor).success).toBe(true)
  return outcome.descriptor
}

function locator(descriptor: TargetDescriptor, strategy: string) {
  return descriptor.locators.find((candidate) => candidate.strategy === strategy)
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('captureTarget', () => {
  it('prefers test attributes in contract order and counts each one', () => {
    page(`
      <button data-testid="save-customer" data-qa="save">Save customer</button>
      <span data-qa="save">Also save</span>
    `)

    const descriptor = capture('button')

    expect(descriptor.element.testIds).toEqual([
      { attr: 'data-testid', value: 'save-customer' },
      { attr: 'data-qa', value: 'save' },
    ])
    expect(descriptor.locators.slice(0, 2)).toEqual([
      {
        strategy: 'testId',
        attr: 'data-testid',
        value: 'save-customer',
        scope: 'root',
        matchCount: 1,
      },
      { strategy: 'testId', attr: 'data-qa', value: 'save', scope: 'root', matchCount: 2 },
    ])
    expect(summarizeTarget(descriptor)).toEqual({
      label: 'Button — Save customer',
      strength: 'stable',
      notes: ['Stable test attribute'],
    })
  })

  it('promotes an icon span or svg path to the button around it', () => {
    page(`
      <form id="customer-form">
        <button type="submit"><span class="icon">✓</span> <span>Save customer</span></button>
        <button type="button"><svg viewBox="0 0 1 1"><g><path d="M0 0"/></g></svg></button>
      </form>
    `)

    const fromSpan = capture('button span.icon')
    expect(fromSpan.capture).toMatchObject({ pickedTag: 'span', promotion: 'interactive-ancestor' })
    expect(fromSpan.element).toMatchObject({
      tag: 'button',
      role: 'button',
      accessibleName: '✓ Save customer',
    })

    const { picked, element: promoted } = promote(element('path'))
    expect(picked.localName).toBe('svg')
    expect(promoted.localName).toBe('button')
  })

  it('never promotes past body or further than a few levels', () => {
    page(
      `<button><div><div><div><div><div><div><div><span>deep</span></div></div></div></div></div></div></div></button><p>plain</p>`,
    )

    expect(promote(element('span')).element.localName).toBe('span')
    expect(promote(element('p'))).toMatchObject({ promotion: 'none' })
    expect(promote(element('p')).element.localName).toBe('p')
  })

  it('ignores generated ids and flags them, and never stores a record id', () => {
    page(`
      <button id=":r1:">Edit</button>
      <button id="v-3">Edit</button>
      <button id="customer-3f2a9c1e-7b4d-4c1a-9e2f-0a1b2c3d4e5f">Open</button>
      <button id="save-customer">Save customer</button>
    `)

    const react = capture('button')
    expect(locator(react, 'id')).toBeUndefined()
    expect(react.element.id).toEqual({ value: ':r1:', generated: true })
    expect(summarizeTarget(react).notes).toContain('Dynamic identifiers were ignored')

    const uuid = capture('button:nth-of-type(3)')
    expect(uuid.element.id).toBeUndefined()
    expect(JSON.stringify(uuid)).not.toContain('3f2a9c1e')

    const stable = capture('#save-customer')
    expect(locator(stable, 'id')).toEqual({
      strategy: 'id',
      value: 'save-customer',
      scope: 'root',
      matchCount: 1,
    })
    expect(stable.element.id).toEqual({ value: 'save-customer', generated: false })
  })

  it('keeps hashed, state and utility classes out of selectors and paths', () => {
    page(`
      <main>
        <div id=":r7:" class="css-1q2w3e">
          <section class="Panel_root__3xYz1">
            <button class="btn btn-primary is-active px-4 sc-bdfBwQ Button_primary__a8Kq2">Save</button>
          </section>
        </div>
      </main>
    `)

    const descriptor = capture('button')
    const serialized = JSON.stringify(descriptor.locators)

    expect(descriptor.element.classes).toEqual({ stable: ['btn', 'btn-primary'], droppedCount: 4 })
    expect(locator(descriptor, 'css')).toMatchObject({
      selector: 'button.btn.btn-primary',
      matchCount: 1,
    })
    expect(locator(descriptor, 'cssPath')).toMatchObject({
      selector: 'body > main > div > section > button',
      matchCount: 1,
    })
    for (const fragment of [
      ':r7:',
      'r7',
      'css-1q2w3e',
      'Panel_root',
      'is-active',
      'px-4',
      'sc-bdfBwQ',
    ]) {
      expect(serialized).not.toContain(fragment)
    }
  })

  it('anchors a structural path on a stable ancestor id', () => {
    page(`
      <form id="billing-form"><div></div><div><button>One</button><button>Two</button></div></form>
    `)

    expect(locator(capture('button:nth-of-type(2)'), 'cssPath')).toMatchObject({
      selector: 'form#billing-form > div:nth-of-type(2) > button:nth-of-type(2)',
      matchCount: 1,
    })
  })

  it('names form controls from their labels, never from their values', () => {
    page(`
      <form>
        <label for="customer-email">Email</label>
        <input id="customer-email" type="email" value="ana.ruiz@example.test" placeholder="name@company.test">
        <label>Password <input type="password" value="hunter2-secret"></label>
        <label for="notes">Notes</label>
        <textarea id="notes">Ana prefers calls after 5pm</textarea>
        <div contenteditable="true" aria-label="Comment">Private draft comment</div>
      </form>
    `)
    const email = element('#customer-email') as HTMLInputElement
    email.value = 'typed.by.user@example.test'

    const emailTarget = capture('#customer-email')
    expect(emailTarget.element).toMatchObject({
      tag: 'input',
      role: 'textbox',
      accessibleName: 'Email',
    })
    expect(locator(emailTarget, 'label')).toEqual({
      strategy: 'label',
      text: 'Email',
      exact: true,
      scope: 'root',
      matchCount: 1,
    })
    expect(emailTarget.anchors).toContainEqual({ relation: 'label', text: 'Email' })

    const everything = JSON.stringify([
      emailTarget,
      capture('input[type="password"]'),
      capture('textarea'),
      capture('[contenteditable]'),
    ])
    for (const secret of [
      'ana.ruiz',
      'typed.by.user',
      'hunter2',
      'prefers calls',
      'Private draft',
    ]) {
      expect(everything).not.toContain(secret)
    }
    // The placeholder looked like an email: redacted, so not an exact locator.
    expect(locator(emailTarget, 'placeholder')).toBeUndefined()
    expect(emailTarget.element.attributes.placeholder).toBe('[email]')
  })

  it('reports how many elements share a name and calls the target weak', () => {
    page(`
      <ul>
        <li><span>Ana</span> <button>Edit</button></li>
        <li><span>Luis</span> <button>Edit</button></li>
      </ul>
    `)

    const descriptor = capture('li:nth-of-type(2) button')

    expect(locator(descriptor, 'role')).toMatchObject({ name: 'Edit', matchCount: 2 })
    expect(locator(descriptor, 'text')).toMatchObject({ text: 'Edit', matchCount: 2 })
    expect(locator(descriptor, 'cssPath')).toMatchObject({ matchCount: 1 })
    const summary = summarizeTarget(descriptor)
    expect(summary.strength).toBe('weak')
    expect(summary.notes).toEqual([
      'Weak target: depends on page structure',
      'Several elements share this label',
    ])
  })

  it('describes a positional-only element with structural selectors alone', () => {
    page(`<div><div></div><div></div><div class="col-3"></div></div>`)

    const descriptor = capture('div > div:nth-of-type(3)')

    expect(descriptor.locators.map((candidate) => candidate.strategy)).toEqual(['cssPath'])
    expect(summarizeTarget(descriptor)).toMatchObject({
      label: '<div> element',
      strength: 'weak',
      notes: ['Weak target: depends on page structure', 'Only structural selectors are available'],
    })
  })

  it('escapes special characters so every selector counts what it says', () => {
    page(`
      <button data-testid='customer "VIP" list'>VIP</button>
      <button id="save.customer">Save</button>
      <section id="2fa-settings"><div></div><div><button>Path</button></div></section>
    `)

    expect(locator(capture('button'), 'testId')).toMatchObject({
      value: 'customer "VIP" list',
      matchCount: 1,
    })
    expect(locator(capture('button:nth-of-type(2)'), 'id')).toMatchObject({
      value: 'save.customer',
      matchCount: 1,
    })
    expect(locator(capture('section button'), 'cssPath')).toMatchObject({
      selector: 'section#\\32 fa-settings > div:nth-of-type(2) > button',
      matchCount: 1,
    })
  })

  it('redacts personal data and never uses redacted or cut text as a locator', () => {
    page(`
      <button>Call +34 612 345 678</button>
      <a href="/profile">ana.ruiz@example.test</a>
      <button>${'Very long label '.repeat(10)}</button>
    `)

    const phone = capture('button')
    expect(phone.element.text).toBe('Call +[number]')
    expect(locator(phone, 'text')).toBeUndefined()
    expect(locator(phone, 'role')).toBeUndefined()
    expect(summarizeTarget(phone).notes).toContain('Some text was hidden for privacy')

    expect(JSON.stringify(capture('a'))).not.toContain('ana.ruiz')

    const long = capture('button:nth-of-type(2)')
    expect(long.element.text).toHaveLength(80)
    expect(long.element.text?.endsWith('…')).toBe(true)
    expect(locator(long, 'text')).toBeUndefined()
  })

  it('stores the page as a pattern without query, fragment, credentials or record ids', () => {
    page(`<button>Save</button>`)

    expect(capture('button').page.urlPattern).toEqual({
      protocol: 'http',
      hostname: 'localhost',
      port: '4179',
      pathname: '/customers/:id/edit',
    })
    expect(
      pagePattern('https://user:pass@app.test/orgs/acme/users/ana%40example.test/c3f2a9c1e7b4'),
    ).toEqual({
      protocol: 'https',
      hostname: 'app.test',
      pathname: '/orgs/acme/users/:id/:id2',
    })
    expect(pagePattern('https://app.test/')).toEqual({
      protocol: 'https',
      hostname: 'app.test',
      pathname: '/',
    })
  })

  it('refuses what Phase 5 cannot describe instead of describing something else', () => {
    page(`<iframe title="Embedded"></iframe><div id="host"></div><p>Gone</p>`)
    element('#host').attachShadow({ mode: 'open' }).innerHTML = '<button>Inside</button>'
    const gone = element('p')
    gone.remove()
    const inside = element('#host').shadowRoot?.querySelector('button')
    if (!inside) throw new Error('No shadow button')

    expect(captureTarget(element('iframe'), CONTEXT)).toEqual({
      ok: false,
      reason: 'Elements inside frames are not supported yet.',
    })
    expect(captureTarget(element('#host'), CONTEXT)).toMatchObject({ ok: false })
    expect(captureTarget(inside, CONTEXT)).toMatchObject({ ok: false })
    expect(captureTarget(gone, CONTEXT)).toEqual({
      ok: false,
      reason: 'The element is no longer on the page.',
    })
    expect(captureTarget(document.body, CONTEXT)).toMatchObject({ ok: false })
    expect(
      captureTarget(element('iframe').parentElement ?? document.body, CONTEXT, () => true),
    ).toMatchObject({ ok: false })
  })

  it('records the dialog, heading and ancestor around the target', () => {
    page(`
      <h2>Payment method</h2>
      <div role="dialog" aria-modal="true" aria-label="Billing details">
        <form id="billing-form" data-testid="billing">
          <div><button type="submit">Save changes</button></div>
        </form>
      </div>
    `)

    const descriptor = capture('button')

    expect(descriptor.container).toEqual({
      kind: 'dialog',
      role: 'dialog',
      accessibleName: 'Billing details',
      modal: true,
    })
    expect(descriptor.anchors).toEqual([
      {
        relation: 'ancestor',
        distance: 2,
        tag: 'form',
        id: 'billing-form',
        testId: { attr: 'data-testid', value: 'billing' },
      },
      { relation: 'precedingHeading', level: 2, text: 'Payment method' },
    ])
    expect(descriptor).toMatchObject({
      version: 1,
      framePath: [],
      shadowPath: [],
      capturedAt: '2026-10-05T10:00:00.000Z',
      capture: {
        extensionVersion: '0.1.0',
        chromeMajor: 153,
        pickedTag: 'button',
        promotion: 'none',
      },
      resolution: { minScore: 0.65, minMargin: 0.15, timeoutMs: 10_000 },
    })
    expect(descriptor.locators.some((candidate) => candidate.strategy === 'xpath')).toBe(false)
  })

  it('gives up counting on huge pages instead of guessing', () => {
    page(`${'<i></i>'.repeat(5_001)}<button>Save</button>`)

    expect(countText(document, 'Save')).toBeUndefined()
    expect(locator(capture('button'), 'text')).toBeUndefined()
  })
})

describe('accessible name', () => {
  it('follows aria-labelledby but skips what users typed', () => {
    page(`
      <span id="prefix">Search</span><input id="query" value="private query">
      <button aria-labelledby="prefix query">Go</button>
      <a href="/x"><img alt="Home"></a>
      <div role="button" title="More">⋯</div>
      <input type="submit" value="Send">
    `)

    expect(accessibleName(element('button'))).toBe('Search')
    expect(accessibleName(element('a'))).toBe('Home')
    expect(accessibleName(element('[role="button"]'))).toBe('⋯')
    expect(accessibleName(element('input[type="submit"]'))).toBe('Send')
    expect(roleOf(element('a'))).toBe('link')
    expect(roleOf(element('input[type="submit"]'))).toBe('button')
  })
})

/**
 * Text a user may have typed (form-control values and editable regions,
 * whether editable themselves or by inheritance) is never read, by any path
 * that builds the descriptor. All fixtures are fictitious.
 */
describe('editable content', () => {
  /** Every string a descriptor stores, in one place, to check nothing private got in. */
  const everything = (descriptor: TargetDescriptor) => JSON.stringify(descriptor)

  it('never reads an editable heading before the target', () => {
    page(`
      <h2 contenteditable="true">Private draft for the merger</h2>
      <button id="save">Save</button>
    `)

    const descriptor = capture('#save')

    expect(everything(descriptor)).not.toContain('Private draft')
    expect(everything(descriptor)).not.toContain('merger')
    expect(descriptor.anchors.some((anchor) => anchor.relation === 'precedingHeading')).toBe(false)
    expect(descriptor.element).toMatchObject({
      tag: 'button',
      accessibleName: 'Save',
      text: 'Save',
    })
  })

  it('never reads a heading that is editable through its container', () => {
    page(`
      <div contenteditable="true">
        <h2>Private notes about the acquisition</h2>
      </div>
      <button id="save">Save</button>
    `)

    expect(everything(capture('#save'))).not.toMatch(/Private notes|acquisition/)
  })

  it('treats plaintext-only and inherited editability as editable', () => {
    page(`
      <h2 contenteditable="plaintext-only">Plaintext pricing idea</h2>
      <div contenteditable="true"><section contenteditable="inherit"><h3>Inherited board memo</h3></section></div>
      <div contenteditable="true"><span contenteditable="false"><h4>Mention of Dana Ficticia</h4></span></div>
      <button id="save">Save</button>
    `)

    expect(everything(capture('#save'))).not.toMatch(/pricing idea|board memo|Dana Ficticia/)
    expect(contentText(element('h2'))).toBe('')
    expect(contentText(element('h3'))).toBe('')
    expect(contentText(element('h4'))).toBe('')
  })

  it('returns nothing when the extractor is given an editable root directly', () => {
    page(`
      <div id="editor" contenteditable="true"><p>Typed by a user</p></div>
      <div id="island" contenteditable=""><b>Also typed</b></div>
      <textarea id="notes">Textarea default text</textarea>
      <p id="plain">Written by the page</p>
    `)

    expect(contentText(element('#editor'))).toBe('')
    expect(contentText(element('#editor p'))).toBe('')
    expect(contentText(element('#island'))).toBe('')
    expect(contentText(element('#notes'))).toBe('')
    expect(contentText(element('#plain'))).toBe('Written by the page')
  })

  it('never reads labels or aria-labelledby references inside an editable region', () => {
    page(`
      <div contenteditable="true">
        <label for="email">Private label for Dana</label>
        <span id="caption">Private caption about Dana</span>
      </div>
      <input id="email" type="email" value="dana.ficticia@example.test" placeholder="Email">
      <button id="go" aria-labelledby="caption">Go</button>
    `)
    const email = capture('#email')
    const go = capture('#go')

    expect(labelText(element('#email'))).toBe('')
    expect(everything(email)).not.toMatch(/Private label|dana\.ficticia|Dana/)
    expect(email.element.accessibleName).toBe('Email')
    expect(locator(email, 'label')).toBeUndefined()
    expect(email.anchors.some((anchor) => anchor.relation === 'label')).toBe(false)
    expect(everything(go)).not.toContain('Private caption')
    expect(go.element.accessibleName).toBe('Go')
  })

  it('never names a container from an editable heading', () => {
    page(`
      <section role="region" aria-labelledby="region-title">
        <h2 id="region-title" contenteditable="true">Private region title</h2>
        <button id="save">Save</button>
      </section>
    `)

    const descriptor = capture('#save')

    expect(everything(descriptor)).not.toContain('Private region title')
    expect(descriptor.container).toEqual({ kind: 'region', role: 'region' })
  })

  it('reads nothing from a node inside an editable region, not even its attributes', () => {
    page(`
      <div contenteditable="true">
        <p id="typed" title="Private title" data-testid="private-note" class="note">Private paragraph</p>
      </div>
    `)

    const descriptor = capture('#typed')

    expect(everything(descriptor)).not.toMatch(/Private|private-note/)
    expect(descriptor.element.accessibleName).toBeUndefined()
    expect(descriptor.element.text).toBeUndefined()
    expect(descriptor.element.attributes).toEqual({})
    expect(descriptor.element.testIds).toEqual([])
    // Only what was counted on the page is stored: no invented exact locator.
    expect(descriptor.locators.map((candidate) => candidate.strategy)).toEqual(['cssPath'])
    expect(locator(descriptor, 'cssPath')?.matchCount).toBe(1)
  })

  it('keeps the page-authored attributes of an editing host itself', () => {
    page(
      `<div contenteditable="true" aria-label="Comment" data-testid="comment-box">Typed text</div>`,
    )

    const descriptor = capture('[contenteditable]')

    expect(everything(descriptor)).not.toContain('Typed text')
    expect(descriptor.element.accessibleName).toBe('Comment')
    expect(locator(descriptor, 'testId')).toMatchObject({ value: 'comment-box', matchCount: 1 })
  })

  it('does not count editable copies of a text as matches', () => {
    page(`
      <div contenteditable="true"><span>Save</span></div>
      <button id="save">Save</button>
    `)

    expect(countText(document, 'Save')).toBe(1)
    expect(locator(capture('#save'), 'text')).toMatchObject({ text: 'Save', matchCount: 1 })
  })

  it('reads nothing on a document in design mode', () => {
    page(
      `<h2>Heading typed in design mode</h2><button id="save">Button typed in design mode</button>`,
    )
    document.designMode = 'on'
    try {
      const descriptor = capture('#save')

      expect(everything(descriptor)).not.toContain('typed in design mode')
      expect(descriptor.locators.map((candidate) => candidate.strategy)).toEqual(['cssPath'])
    } finally {
      document.designMode = 'off'
    }
  })

  it('still reads a regular heading, and never form values', () => {
    page(`
      <h2>Customer details</h2>
      <label for="name">Name</label><input id="name" value="Dana Ficticia">
      <textarea aria-label="Notes">Private notes</textarea>
      <button id="save">Save</button>
    `)
    const save = capture('#save')

    expect(save.anchors).toContainEqual({
      relation: 'precedingHeading',
      level: 2,
      text: 'Customer details',
    })
    expect(everything(capture('#name'))).not.toContain('Dana')
    expect(everything(capture('textarea'))).not.toContain('Private notes')
  })
})
