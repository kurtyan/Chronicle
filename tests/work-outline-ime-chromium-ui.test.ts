import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import path from 'node:path'
import type { OutlineLine } from '../shared/workOutlineTypes'

const directory = process.env.CHRONICLE_TEST_DATA_DIR
if (!directory || !path.resolve(directory).startsWith(path.resolve('.dev-data') + path.sep)) throw new Error('Isolated work-outline runner required')
// Guards for ordinary composition in Chromium, driven through CDP (Playwright has no IME API for WebKit).
test.use({ browserName: 'chromium' })
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

for (const below of [false, true]) {
  for (const [name, committed] of [['English', 'haha'], ['Chinese', '哈哈']] as const) {
    test(`committing an IME composition ${below ? 'above another row' : 'on the last row'} (${name}) edits only the current row`, async ({ page, request }) => {
      const current = line('')
      await saveDocument(request, below ? [line('first'), current, line('hehehe')] : [line('first'), current])
      await page.goto('/work-outline')
      await focusEnd(page, current.attrs.id)
      const client = await page.context().newCDPSession(page)
      await client.send('Input.imeSetComposition', { text: "ha'ha", selectionStart: 5, selectionEnd: 5 })
      await expect.poll(() => rowTexts(page)).toContain("ha'ha")
      await client.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
      await client.send('Input.insertText', { text: committed })
      await page.waitForTimeout(300)
      expect(await rowTexts(page)).toEqual(below ? ['first', committed, 'hehehe'] : ['first', committed])
    })
  }
}

test('a real Enter after a committed composition still splits the row', async ({ page, request }) => {
  const current = line('')
  await saveDocument(request, [current])
  await page.goto('/work-outline')
  await focusEnd(page, current.attrs.id)
  const client = await page.context().newCDPSession(page)
  await client.send('Input.imeSetComposition', { text: 'haha', selectionStart: 4, selectionEnd: 4 })
  await client.send('Input.insertText', { text: 'haha' })
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.keyboard.type('next')
  expect(await rowTexts(page)).toEqual(['haha', 'next'])
})
