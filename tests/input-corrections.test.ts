import { expect, test, type Locator } from '@playwright/test'

async function expectCorrectionsDisabled(locator: Locator) {
  await expect(locator).toHaveAttribute('autocapitalize', 'none')
  await expect(locator).toHaveAttribute('autocorrect', 'off')
  await expect(locator).toHaveAttribute('spellcheck', 'false')
}

test.describe('Text correction policy', () => {
  test('disables corrections for search and dynamically mounted inputs', async ({ page }) => {
    await page.goto('/?lang=en')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+F' : 'Control+Shift+F')

    const searchInput = page.getByRole('dialog').getByPlaceholder('Search...')
    await expect(searchInput).toBeVisible()
    await expectCorrectionsDisabled(searchInput)

    await page.evaluate(() => {
      const container = document.createElement('div')
      container.id = 'dynamic-editables'
      container.innerHTML = [
        '<input id="dynamic-input">',
        '<textarea id="dynamic-textarea"></textarea>',
        '<div id="dynamic-editor" contenteditable="true"></div>',
      ].join('')
      document.body.appendChild(container)
    })

    for (const id of ['dynamic-input', 'dynamic-textarea', 'dynamic-editor']) {
      await expectCorrectionsDisabled(page.locator(`#${id}`))
    }

    await page.evaluate(() => {
      const input = document.querySelector('#dynamic-input')!
      input.setAttribute('autocapitalize', 'sentences')
      input.setAttribute('autocorrect', 'on')
      input.setAttribute('spellcheck', 'true')
    })
    await expectCorrectionsDisabled(page.locator('#dynamic-input'))
  })

  test('disables corrections in a TipTap note editor', async ({ page }) => {
    const unique = Date.now()
    const response = await page.request.post('/api/notes', {
      data: {
        title: `CorrectionPolicy-${unique}`,
        contentHtml: '<p>Editor content</p>',
        tags: [],
      },
    })
    expect(response.ok()).toBeTruthy()
    const note = await response.json()

    await page.goto(`/notes?id=${encodeURIComponent(note.id)}&lang=en`)
    const editor = page.locator('[data-rich-editor="true"] .ProseMirror[contenteditable="true"]')
    await expect(editor).toBeVisible()
    await expectCorrectionsDisabled(editor)
  })
})
