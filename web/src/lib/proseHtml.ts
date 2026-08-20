/**
 * Normalize legacy code-first / nested-list-first list items
 * (<li><pre>…</pre></li>) to paragraph-first, matching the restored
 * `paragraph block*` content model. Applies to HTML loaded from older data.
 */
export function normalizeLegacyCodeFirstListItems(html: string): string {
  if (typeof document === 'undefined' || !/<(pre|ul|ol)\b/i.test(html)) return html

  const template = document.createElement('template')
  template.innerHTML = html

  template.content.querySelectorAll('li').forEach((li) => {
    const first = li.firstElementChild
    if (first && ['PRE', 'UL', 'OL'].includes(first.tagName)) {
      li.prepend(document.createElement('p'))
    }
  })

  return template.innerHTML
}

/**
 * Native list markers are clipped by WebKit when a list item starts directly
 * with a block-level <pre>. Add a real, non-editable marker to sanitized
 * display HTML so read-only views use the same stable rendering as editors.
 */
export function withCodeFirstListMarkers(html: string): string {
  if (typeof document === 'undefined' || !html.includes('<pre')) return html

  const template = document.createElement('template')
  template.innerHTML = html

  template.content.querySelectorAll('ol, ul').forEach((list) => {
    const isOrdered = list.tagName === 'OL'
    const parsedStart = Number.parseInt(list.getAttribute('start') || '1', 10)
    let nextNumber = Number.isFinite(parsedStart) ? parsedStart : 1

    Array.from(list.children).forEach((child) => {
      if (child.tagName !== 'LI') return

      const explicitValue = Number.parseInt(child.getAttribute('value') || '', 10)
      if (isOrdered && Number.isFinite(explicitValue)) nextNumber = explicitValue
      const marker = isOrdered ? `${nextNumber}.` : '\u2022'
      if (isOrdered) nextNumber += 1

      if (child.firstElementChild?.tagName !== 'PRE') return
      if (child.querySelector(':scope > .chronicle-code-list-marker')) return

      const markerElement = document.createElement('span')
      markerElement.className = 'chronicle-code-list-marker'
      markerElement.setAttribute('aria-hidden', 'true')
      markerElement.setAttribute('contenteditable', 'false')
      markerElement.textContent = marker
      child.prepend(markerElement)
    })
  })

  return template.innerHTML
}
