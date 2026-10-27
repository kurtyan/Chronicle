import { test, expect } from '@playwright/test'
import path from 'node:path'

const directory = process.env.CHRONICLE_TEST_DATA_DIR
if (!directory || !path.resolve(directory).startsWith(path.resolve('.dev-data') + path.sep)) throw new Error('Isolated work-outline runner required')
const uid = () => crypto.randomUUID()
const line = (text: string) => ({ type: 'outlineLine' as const, attrs: { id: uid(), depth: 0 }, content: text ? [{ type: 'text' as const, text }] : [] })

test('adding rows at the bottom keeps scrolling so the new row stays clear of the bottom edge', async ({ page, request }) => {
  const rows = Array.from({ length: 45 }, (_, index) => line(`Row ${index}`))
  const current = await (await request.get('/api/work-outlines/default')).json()
  const response = await request.put('/api/work-outlines/default', { data: { expectedRevision: current.revision, expectedEpoch: current.epoch, mutationId: uid(), document: { type: 'doc', schemaVersion: 1, content: rows } } })
  expect(response.ok(), await response.text()).toBe(true)
  await page.goto('/work-outline')
  const last = page.locator(`[data-outline-row="${rows[rows.length - 1].attrs.id}"]`)
  await last.scrollIntoViewIfNeeded()
  await last.click()
  await page.keyboard.press('End')
  const caretRow = () => page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="outline-grid-scroll"]') as HTMLElement
    const node = window.getSelection()!.anchorNode as Node
    const row = (node.nodeType === 1 ? node as HTMLElement : node.parentElement!).closest('[data-outline-row]') as HTMLElement
    const box = scroller.getBoundingClientRect(), rect = row.getBoundingClientRect()
    return { bottomGap: box.bottom - rect.bottom, topGap: rect.top - (box.top + 50), scrollTop: scroller.scrollTop }
  })
  let previous = (await caretRow()).scrollTop
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Enter')
    await page.keyboard.type(`added ${index}`)
    // The row is fully visible with the editor's bottom padding in view, not flush against (or under) the edge.
    await expect.poll(async () => (await caretRow()).bottomGap).toBeGreaterThanOrEqual(60)
    const state = await caretRow()
    expect(state.topGap).toBeGreaterThanOrEqual(0)
    expect(state.scrollTop).toBeGreaterThan(previous)
    previous = state.scrollTop
  }
})
