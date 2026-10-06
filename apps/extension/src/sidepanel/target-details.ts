import type { TargetDescriptor, TargetLocator, UrlPattern } from '@contextlayer/shared'

/**
 * Every value a target descriptor stores, as lines of text for the author to
 * review before saving (ADR 0014, privacy). Shown with text interpolation
 * only, never as HTML.
 */
export interface DetailLine {
  label: string
  value: string
}

const matches = (count: number) => `${String(count)} match${count === 1 ? '' : 'es'}`

function locatorLine(locator: TargetLocator): DetailLine {
  const count = matches(locator.matchCount)
  switch (locator.strategy) {
    case 'testId':
      return { label: 'Test attribute', value: `${locator.attr}="${locator.value}" · ${count}` }
    case 'id':
      return { label: 'Id', value: `${locator.value} · ${count}` }
    case 'role':
      return { label: 'Role and name', value: `${locator.role} “${locator.name}” · ${count}` }
    case 'label':
      return { label: 'Label', value: `“${locator.text}” · ${count}` }
    case 'placeholder':
      return { label: 'Placeholder', value: `“${locator.text}” · ${count}` }
    case 'altText':
      return { label: 'Alternative text', value: `“${locator.text}” · ${count}` }
    case 'title':
      return { label: 'Title', value: `“${locator.text}” · ${count}` }
    case 'text':
      return { label: 'Text', value: `“${locator.text}” · ${count}` }
    case 'css':
      return { label: 'CSS selector', value: `${locator.selector} · ${count}` }
    case 'cssPath':
      return { label: 'Page structure', value: `${locator.selector} · ${count}` }
    case 'xpath':
      return { label: 'XPath', value: `${locator.expression} · ${count}` }
  }
}

export function patternText(pattern: UrlPattern): string {
  const host = `${pattern.hostname ?? '*'}${pattern.port ? `:${pattern.port}` : ''}`
  return `${pattern.protocol ?? '*'}://${host}${pattern.pathname ?? '/*'}`
}

export function targetDetails(descriptor: TargetDescriptor): DetailLine[] {
  const { element } = descriptor
  const lines: DetailLine[] = [
    { label: 'Page', value: patternText(descriptor.page.urlPattern) },
    { label: 'Element', value: element.role ? `${element.tag} (${element.role})` : element.tag },
  ]
  if (element.accessibleName) lines.push({ label: 'Name', value: element.accessibleName })
  if (element.text && element.text !== element.accessibleName) {
    lines.push({ label: 'Visible text', value: element.text })
  }
  for (const [attr, value] of Object.entries(element.attributes)) {
    if (value !== null) lines.push({ label: `Attribute ${attr}`, value })
  }
  if (element.classes?.stable.length) {
    lines.push({ label: 'Classes', value: element.classes.stable.join(' ') })
  }
  if (descriptor.container) {
    const name = descriptor.container.accessibleName
    lines.push({
      label: 'Inside',
      value: name ? `${descriptor.container.kind} “${name}”` : descriptor.container.kind,
    })
  }
  for (const anchor of descriptor.anchors) {
    if (anchor.relation === 'precedingHeading') {
      lines.push({ label: 'Heading before it', value: anchor.text })
    } else if (anchor.relation === 'label') {
      lines.push({ label: 'Label', value: anchor.text })
    } else {
      const id = anchor.id ?? (anchor.testId && `${anchor.testId.attr}="${anchor.testId.value}"`)
      lines.push({ label: 'Inside element', value: id ? `${anchor.tag} ${id}` : anchor.tag })
    }
  }
  for (const locator of descriptor.locators) lines.push(locatorLine(locator))
  return lines
}
