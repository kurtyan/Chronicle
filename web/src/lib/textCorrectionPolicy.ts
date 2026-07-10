const EDITABLE_SELECTOR = 'input, textarea, [contenteditable]:not([contenteditable="false"])'

function disableTextCorrections(element: Element): void {
  if (!element.matches(EDITABLE_SELECTOR)) return
  if (element.getAttribute('autocapitalize') !== 'none') element.setAttribute('autocapitalize', 'none')
  if (element.getAttribute('autocorrect') !== 'off') element.setAttribute('autocorrect', 'off')
  if (element.getAttribute('spellcheck') !== 'false') element.setAttribute('spellcheck', 'false')
}

function applyPolicyToNode(node: Node): void {
  if (!(node instanceof Element)) return
  disableTextCorrections(node)
  node.querySelectorAll(EDITABLE_SELECTOR).forEach(disableTextCorrections)
}

/**
 * Disables browser/OS text corrections for every current and future editable
 * surface, including inputs rendered by dialogs and TipTap/ProseMirror.
 */
export function installTextCorrectionPolicy(): () => void {
  document.querySelectorAll(EDITABLE_SELECTOR).forEach(disableTextCorrections)

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        applyPolicyToNode(mutation.target)
        continue
      }
      mutation.addedNodes.forEach(applyPolicyToNode)
    }
  })

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['contenteditable', 'autocapitalize', 'autocorrect', 'spellcheck'],
  })

  return () => observer.disconnect()
}
