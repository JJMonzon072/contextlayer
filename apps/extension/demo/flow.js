// The flow demo's own behaviour: a single-page application with two views,
// a list (/flow/) and a form (/flow/customers/new), reached in the app
// (history.pushState) or by a link (a new document). Kept to DOM APIs.
// `window.flowDemo` lets the end-to-end tests change the page on purpose.
'use strict'

const view = document.getElementById('view')
const counter = document.getElementById('target-clicks')
const base = location.pathname.slice(0, location.pathname.indexOf('/flow/') + '/flow/'.length)
const late = new URLSearchParams(location.search).has('late')
let clicks = 0

const element = (tag, attributes, text) => {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
  if (text) node.textContent = text
  return node
}

// Clicks on the guide's targets are counted: the guide must never click.
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null
  if (!target?.closest('[data-target]')) return
  clicks += 1
  counter.textContent = String(clicks)
})

function newCustomerButton() {
  return element(
    'button',
    { type: 'button', 'data-testid': 'new-customer', 'data-target': '' },
    'New customer',
  )
}

function renderList(withButton) {
  const heading = element('h1', {}, 'Customers')
  const slot = element('div', { id: 'slot' })
  if (withButton) slot.append(newCustomerButton())
  view.replaceChildren(heading, slot, element('p', {}, 'Ana Ejemplo · Luis Prueba'))
}

function renderForm() {
  const form = element('form', { 'aria-label': 'New customer', id: 'customer-form' })
  form.append(
    element('label', { for: 'name' }, 'Name'),
    element('input', { id: 'name', name: 'name', autocomplete: 'off', 'data-target': '' }),
    element(
      'button',
      { type: 'button', 'data-testid': 'save-customer', 'data-target': '' },
      'Save customer',
    ),
  )
  view.replaceChildren(element('h1', {}, 'New customer'), form)
}

const onForm = () => location.pathname.endsWith('/customers/new')

function render() {
  if (onForm()) renderForm()
  else renderList(!late)
}

function go(path) {
  history.pushState(null, '', path)
  render()
}

const flowDemo = {
  /** The New customer button appears (it was left out with `?late`). */
  reveal() {
    const slot = document.getElementById('slot')
    if (slot && !slot.querySelector('[data-testid="new-customer"]'))
      slot.append(newCustomerButton())
  },
  /** A framework re-render: the same button, a new node, laid out a little further right. */
  rerender() {
    const next = newCustomerButton()
    next.style.marginLeft = '48px'
    document.querySelector('[data-testid="new-customer"]')?.replaceWith(next)
  },
  remove() {
    document.querySelector('[data-testid="new-customer"]')?.remove()
  },
  toForm() {
    go(`${base}customers/new`)
  },
  toList() {
    go(base)
  },
  openConfirm() {
    document.getElementById('confirm').showModal()
  },
  closeConfirm() {
    document.getElementById('confirm').close()
  },
}
window.flowDemo = flowDemo

document.getElementById('nav-list').href = base
document.getElementById('link-new').href = `${base}customers/new`
document.getElementById('show-later').addEventListener('click', () => {
  setTimeout(flowDemo.reveal, 2000)
})
document.getElementById('rerender').addEventListener('click', flowDemo.rerender)
document.getElementById('remove').addEventListener('click', flowDemo.remove)
document.getElementById('go-new').addEventListener('click', flowDemo.toForm)
document.getElementById('go-list').addEventListener('click', flowDemo.toList)
document.getElementById('open-confirm').addEventListener('click', flowDemo.openConfirm)
document.getElementById('close-confirm').addEventListener('click', flowDemo.closeConfirm)
addEventListener('popstate', render)
render()
