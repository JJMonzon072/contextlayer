import type { RichText, TargetDescriptor } from '../src/index.js'

/** The ADR 0014 example: a light-DOM button in a modal. */
export function targetDescriptor(): TargetDescriptor {
  return {
    version: 1,
    capturedAt: '2026-10-04T15:21:07Z',
    capture: {
      extensionVersion: '0.1.0',
      viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
      pickedTag: 'span',
      promotion: 'interactive-ancestor',
    },
    page: {
      urlPattern: {
        protocol: 'https',
        hostname: 'app.acme.test',
        pathname: '/projects/:projectId/settings',
      },
    },
    framePath: [],
    shadowPath: [],
    container: { kind: 'dialog', role: 'dialog', accessibleName: 'Billing details', modal: true },
    element: {
      tag: 'button',
      role: 'button',
      accessibleName: 'Save changes',
      text: 'Save changes',
      testIds: [{ attr: 'data-testid', value: 'billing-save' }],
      id: { value: 'save-7f3a9c21', generated: true },
      attributes: { type: 'submit', title: null, placeholder: null },
      classes: { stable: ['btn', 'btn-primary'], droppedCount: 4 },
      nthOfType: { index: 2, count: 2 },
      rect: { x: 1180, y: 640, width: 120, height: 36 },
    },
    anchors: [
      { relation: 'ancestor', distance: 2, tag: 'form', id: 'billing-form' },
      { relation: 'precedingHeading', level: 2, text: 'Payment method' },
    ],
    locators: [
      {
        strategy: 'testId',
        attr: 'data-testid',
        value: 'billing-save',
        scope: 'root',
        matchCount: 1,
      },
      {
        strategy: 'role',
        role: 'button',
        name: 'Save changes',
        exact: true,
        scope: 'container',
        matchCount: 1,
      },
      {
        strategy: 'cssPath',
        selector: 'form#billing-form > div:nth-of-type(4) > button:nth-of-type(2)',
        scope: 'root',
        matchCount: 1,
      },
      {
        strategy: 'xpath',
        expression: "//form[@id='billing-form']/div[4]/button[2]",
        scope: 'root',
        matchCount: 1,
      },
    ],
    resolution: {
      minScore: 0.65,
      minMargin: 0.15,
      timeoutMs: 10000,
      textPolicy: 'normalized',
      onAmbiguous: 'show-unanchored',
      onNotFound: 'show-unanchored',
    },
  }
}

/** The data-model.md example. */
export function richText(): RichText {
  return {
    version: 1,
    blocks: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'Click ' },
          { type: 'text', text: 'Save changes', marks: ['bold'] },
          { type: 'text', text: ' to store the billing details.' },
        ],
      },
      {
        type: 'list',
        ordered: false,
        items: [[{ type: 'text', text: 'The card must be valid for 30 more days.' }]],
      },
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            href: 'https://docs.acme.test/billing',
            children: [{ type: 'text', text: 'Billing help' }],
          },
        ],
      },
    ],
  }
}
