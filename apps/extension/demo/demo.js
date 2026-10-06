// The demo page's own behaviour. Kept to DOM APIs (no innerHTML, no eval), so
// it also runs under the strict Content Security Policy of /strict/.
'use strict'

const counter = document.getElementById('page-clicks')
let clicks = 0

// Every click the page's own code receives on a control is counted: Edit Mode
// selecting an element must leave this number unchanged.
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null
  if (!target?.closest('button, a')) return
  clicks += 1
  counter.textContent = String(clicks)
})

// A form the page handles itself, as single-page applications do.
document.getElementById('customer-form').addEventListener('submit', (event) => {
  event.preventDefault()
  counter.dataset.submitted = 'true'
})

// A generated id in the shape React's useId gives (`:r5:`), new on every load.
// ContextLayer must not rely on it. (A random suffix made only of letters,
// like `export-qkzbfa`, cannot be told from a word; see ADR 0014.)
document.getElementById('export-button').id = `:r${Math.random().toString(36).slice(2, 6)}:`
