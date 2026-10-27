import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import path from 'node:path'
import type { OutlineLine } from '../shared/workOutlineTypes'

const directory = process.env.CHRONICLE_TEST_DATA_DIR
if (!directory || !path.resolve(directory).startsWith(path.resolve('.dev-data') + path.sep)) throw new Error('Isolated work-outline runner required')
const uid = () => crypto.randomUUID()
const line = (text: string): OutlineLine => ({ type: 'outlineLine', attrs: { id: uid(), depth: 0 }, content: text ? [{ type: 'text', text }] : [] })
async function saveDocument(request: APIRequestContext, rows: OutlineLine[]) {
  const current = await (await request.get('/api/work-outlines/default')).json()
  const response = await request.put('/api/work-outlines/default', { data: { expectedRevision: current.revision, expectedEpoch: current.epoch, mutationId: uid(), document: { type: 'doc', schemaVersion: 1, content: rows } } })
  expect(response.ok(), await response.text()).toBe(true)
}
const rowTexts = (page: Page) => page.getByTestId('outline-editor').locator('[data-outline-row]').evaluateAll(rows => rows.map(row => row.textContent))
async function focusEnd(page: Page, id: string) {
  await page.locator(`[data-outline-row="${id}"]`).evaluate(element => {
    (element.closest('[contenteditable="true"]') as HTMLElement).focus()
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(false)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  })
}

// WebKit (the desktop client) commits a composition in two steps: deleteCompositionText, then
// insertFromComposition. ProseMirror reads the first step as an Enter (last row) or Backspace (row below) key
// press and calls handleKeyDown with an untrusted event while the composition is active. Replay that sequence:
// the marked text leaves the DOM, the fake key arrives, then the committed text is inserted. Acting on the key
// split or joined rows; swallowing it without removing the marked text kept the pinyin next to the result.
for (const [key, keyCode, below] of [['Enter', 13, false], ['Backspace', 8, true], ['Delete', 46, true]] as const) {
  for (const committed of ['haha', '哈哈']) {
    test(`a fake ${key} during a WebKit-style commit ${below ? 'above another row' : 'on the last row'} leaves only the committed ${committed}`, async ({ page, request }) => {
      const current = line("ha'ha")
      await saveDocument(request, below ? [line('first'), current, line('hehehe')] : [line('first'), current])
      await page.goto('/work-outline')
      await focusEnd(page, current.attrs.id)
      const handled = await page.getByTestId('outline-editor').evaluate((dom, [key, keyCode, id]) => {
        const view = (dom as any).editor.view
        dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
        dom.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: "ha'ha" }))
        if (!view.composing) throw new Error('composition did not start')
        // Step 1 in the page: the marked text disappears.
        ;(dom.querySelector(`[data-outline-row="${id}"]`)!.firstChild as Text).data = ''
        // ProseMirror consumes the pending mutation records before it calls the key handler (DOMObserver.flush), so
        // a handler that claims the key makes it drop this deletion; the later insertion is then applied to a
        // document that still holds the pinyin.
        view.domObserver.pendingRecords()
        // Same shape as prosemirror-view's internal keyEvent().
        const event: any = document.createEvent('Event'); event.initEvent('keydown', true, true); event.keyCode = keyCode; event.key = event.code = key
        const handled = view.someProp('handleKeyDown', (handler: any) => handler(view, event)) === true
        // The document, not the page, must now agree that the pinyin is gone.
        const doc = view.state.doc
        return { handled, docRows: Array.from({ length: doc.childCount }, (_, index) => doc.child(index).textContent) }
      }, [key, keyCode, current.attrs.id] as const)
      expect(handled.handled).toBe(true)
      expect(handled.docRows).toEqual(below ? ['first', '', 'hehehe'] : ['first', ''])
      // Step 2: the committed text is inserted, then the composition ends.
      await page.evaluate(text => document.execCommand('insertText', false, text), committed)
      await page.getByTestId('outline-editor').evaluate((dom, text) => dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text })), committed)
      await page.waitForTimeout(300)
      expect(await rowTexts(page)).toEqual(below ? ['first', committed, 'hehehe'] : ['first', committed])
    })
  }
}
