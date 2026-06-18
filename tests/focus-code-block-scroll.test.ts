import { expect, test } from '@playwright/test'

test('Focus Area code block expands to content height without internal vertical scrolling', async ({ page }) => {
  const date = '2099-12-24'
  const lines = Array.from({ length: 30 }, (_, index) => `line ${String(index + 1).padStart(2, '0')}`).join('\n')
  const script = {
    scriptDate: date,
    revision: 0,
    document: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'above text' }] },
        {
          type: 'codeBlock',
          attrs: { softWrap: true },
          content: [{ type: 'text', text: lines }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'below text' }] },
      ],
    },
    blocks: [],
    updatedAt: Date.now(),
  }

  await page.route(`**/api/day-scripts/${date}`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(script) })
      return
    }
    await route.continue()
  })

  await page.goto(`/today?date=${date}&lang=en`)
  const pre = page.locator('.day-script-editor.ProseMirror pre').first()
  await expect(pre).toBeVisible()

  const metrics = await pre.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    text: element.textContent,
  }))

  expect(metrics.text).toContain('line 30')
  expect(metrics.clientHeight).toBeGreaterThan(400)
  expect(metrics.scrollHeight - metrics.clientHeight).toBeLessThanOrEqual(1)

  const preBox = await pre.boundingBox()
  expect(preBox).not.toBeNull()

  await page.mouse.click(preBox!.x + 48, preBox!.y + 30)
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => page.evaluate(() => {
    const selection = window.getSelection()
    const node = selection?.anchorNode
    const element = node instanceof HTMLElement ? node : node?.parentElement
    return Boolean(element?.closest('pre'))
  })).toBe(false)

  await page.mouse.click(preBox!.x + 48, preBox!.y + preBox!.height - 30)
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => page.evaluate(() => {
    const selection = window.getSelection()
    const node = selection?.anchorNode
    const element = node instanceof HTMLElement ? node : node?.parentElement
    return Boolean(element?.closest('pre'))
  })).toBe(false)
  await expect(pre).toBeVisible()
})
