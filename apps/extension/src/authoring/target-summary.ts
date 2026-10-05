import type { TargetDescriptor, TargetLocator } from '@contextlayer/shared'

/**
 * What the side panel says about a captured target, computed from the stored
 * descriptor alone so a step loaded from the server reads the same as one
 * just captured. Strength is a category, not a probability: ADR 0014's
 * weights are uncalibrated until Phase 6 measures them.
 */
export interface TargetSummary {
  /** "Button — Save customer". */
  label: string
  /**
   * `stable`: a unique test attribute or stable id; `semantic`: a unique
   * name, label or text; `weak`: only structure, or names other elements share.
   */
  strength: 'stable' | 'semantic' | 'weak'
  /** Why, in the author's terms. */
  notes: string[]
}

const ROLE_LABELS: Record<string, string> = {
  button: 'Button',
  link: 'Link',
  textbox: 'Text field',
  searchbox: 'Search field',
  checkbox: 'Checkbox',
  radio: 'Radio button',
  combobox: 'Dropdown',
  listbox: 'List',
  heading: 'Heading',
  img: 'Image',
  tab: 'Tab',
  menuitem: 'Menu item',
  option: 'Option',
  switch: 'Switch',
  slider: 'Slider',
  spinbutton: 'Number field',
  navigation: 'Navigation',
  dialog: 'Dialog',
}

const STRUCTURAL: TargetLocator['strategy'][] = ['css', 'cssPath', 'xpath']
const NAMED: TargetLocator['strategy'][] = [
  'role',
  'label',
  'placeholder',
  'altText',
  'title',
  'text',
]
/** The markers `capturedText` leaves where it removed personal data. */
const REDACTED = /\[(email|number)\]/

export function summarizeTarget(descriptor: TargetDescriptor): TargetSummary {
  const { element, locators } = descriptor
  const kind =
    (element.role !== undefined ? ROLE_LABELS[element.role] : undefined) ??
    `<${element.tag}> element`
  const name = element.accessibleName ?? element.text
  const unique = (strategies: TargetLocator['strategy'][]) =>
    locators.some((locator) => strategies.includes(locator.strategy) && locator.matchCount === 1)

  const notes: string[] = []
  let strength: TargetSummary['strength']
  if (unique(['testId'])) {
    strength = 'stable'
    notes.push('Stable test attribute')
  } else if (unique(['id'])) {
    strength = 'stable'
    notes.push('Stable id')
  } else if (unique(NAMED)) {
    strength = 'semantic'
    notes.push('Found by its name or label')
  } else {
    strength = 'weak'
    notes.push('Weak target: depends on page structure')
    if (locators.every((locator) => STRUCTURAL.includes(locator.strategy))) {
      notes.push('Only structural selectors are available')
    }
    if (locators.some((locator) => NAMED.includes(locator.strategy) && locator.matchCount > 1)) {
      notes.push('Several elements share this label')
    }
    if (!locators.some((locator) => locator.matchCount === 1)) {
      notes.push('No captured locator was unique on the page')
    }
  }
  if (element.id?.generated) notes.push('Dynamic identifiers were ignored')
  const texts = [element.accessibleName, element.text, ...Object.values(element.attributes)]
  if (texts.some((text) => REDACTED.test(text ?? ''))) {
    notes.push('Some text was hidden for privacy')
  }
  return { label: name ? `${kind} — ${name}` : kind, strength, notes }
}
