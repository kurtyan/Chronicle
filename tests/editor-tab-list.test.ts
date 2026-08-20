import { test, expect, type Page } from '@playwright/test'

// Phase 1 target tests for unified Tab handling + wrap-button focus isolation.
// Runs in WebKit to match the desktop (Tauri) engine where the bugs surface.
//
// Current status (before phase 1 fix):
//   - "indents code on Tab"          -> RED
//   - "does not focus wrap button"   -> RED (DayScriptEditor lets Tab hit it)
//   - "wrap button out of tab order" -> RED (no tabindex/contenteditable)
//   - "Tab/Shift+Tab indent/outdent" -> GREEN (regression guard)
test.use({ browserName: 'webkit' })

function uniqueScriptDate(dayOffset: number): string {
  const date = new Date(2099, 1, dayOffset)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

async function createTask(page: Page, title: string) {
  const res = await page.request.post('/api/tasks', {
    data: { title, type: 'TODO', priority: 'MEDIUM' },
  })
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function saveDayScript(page: Page, date: string, document: Record<string, any>) {
  const currentRes = await page.request.get('/api/day-scripts/' + date)
  expect(currentRes.ok()).toBeTruthy()
  const current = await currentRes.json()
  const saveRes = await page.request.put('/api/day-scripts/' + date, {
    data: { expectedRevision: current.revision ?? 0, document },
  })
  expect(saveRes.ok()).toBeTruthy()
  return saveRes.json()
}

async function clearFocusEditor(page: Page) {
  const editor = page.locator('.day-script-editor.ProseMirror')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  return editor
}

async function activeElementIsWrapButton(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return Boolean(el && el.classList && el.classList.contains('code-block-wrap-toggle'))
  })
}

test.describe('editor Tab handling (WebKit) — phase 1 targets', () => {
  test('Tab inside a code block indents the code in the task log editor', async ({ page }) => {
    const title = 'TabCodeLog-' + Date.now()
    await createTask(page, title)
    await page.goto('/?lang=en')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: title }).first().click()
    await page.waitForTimeout(400)

    const editor = page.locator('[data-rich-editor="true"] .ProseMirror').first()
    await expect(editor).toBeVisible()
    await editor.click()

    await page.keyboard.type('1. ```')
    await page.keyboard.press('Enter')
    await expect(editor.locator('ol > li > pre > code')).toHaveCount(1)

    await page.keyboard.press('Tab')
    await page.keyboard.type('const x = 1')

    // TipTap code block default tabSize is 4 spaces. Read raw textContent —
    // toHaveText normalizes/trims whitespace and would miss the indent.
    const codeText = await editor.locator('ol > li > pre > code').textContent()
    expect(codeText).toBe('    const x = 1')
  })

  test('Tab inside a code block indents the code in the focus editor', async ({ page }) => {
    const date = uniqueScriptDate(21)
    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })
    await page.goto('/today?date=' + date + '&lang=en')
    await page.waitForLoadState('load')

    const editor = await clearFocusEditor(page)
    await page.keyboard.type('1. ```')
    await page.keyboard.press('Enter')
    await expect(editor.locator('ol > li > pre > code')).toHaveCount(1)

    await page.keyboard.press('Tab')
    await page.keyboard.type('const x = 1')

    const codeText = await editor.locator('ol > li > pre > code').textContent()
    expect(codeText).toBe('    const x = 1')
  })

  test('Tab inside a code block does not move focus to the wrap button', async ({ page }) => {
    const date = uniqueScriptDate(22)
    await saveDayScript(page, date, { type: 'doc', content: [{ type: 'paragraph' }] })
    await page.goto('/today?date=' + date + '&lang=en')
    await page.waitForLoadState('load')

    const editor = await clearFocusEditor(page)
    await page.keyboard.type('1. ```')
    await page.keyboard.press('Enter')
    await page.keyboard.type('const x = 1')

    // Best-effort behavioral smoke: native Tab focus traversal is
    // browser-dependent under synthetic keyboard events; the authoritative
    // guard is the static tabindex/contenteditable assertion below.
    await page.keyboard.press('Tab')
    expect(await activeElementIsWrapButton(page)).toBe(false)
  })

  test('code block wrap button is excluded from the tab order', async ({ page }) => {
    const title = 'TabWrapButton-' + Date.now()
    await createTask(page, title)
    await page.goto('/?lang=en')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: title }).first().click()
    await page.waitForTimeout(400)

    const editor = page.locator('[data-rich-editor="true"] .ProseMirror').first()
    await editor.click()
    await page.keyboard.type('```')
    await page.keyboard.press('Enter')

    const button = editor.locator('pre .code-block-wrap-toggle')
    await expect(button).toBeVisible()
    await expect(button).toHaveAttribute('tabindex', '-1')
  })

  test('Cmd+A in a code block selects only the code block content', async ({ page }) => {
    const title = 'CmdASelect-' + Date.now()
    await createTask(page, title)
    await page.goto('/?lang=en')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: title }).first().click()
    await page.waitForTimeout(400)

    const editor = page.locator('[data-rich-editor="true"] .ProseMirror').first()
    await editor.click()
    // A paragraph BEFORE the code block, so "select whole doc" vs "select
    // code block only" are distinguishable.
    await page.keyboard.type('before paragraph')
    await page.keyboard.press('Enter')
    await page.keyboard.type('```')
    await page.keyboard.press('Enter')
    await page.keyboard.type('const x = 1')

    await page.keyboard.press('ControlOrMeta+a')
    const selText = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    // Only the code block's text should be selected, not the preceding paragraph.
    expect(selText.trim()).toBe('const x = 1')
  })

  test('Enter in a code block inserts a newline without splitting the list item', async ({ page }) => {
    const title = 'EnterNewline-' + Date.now()
    await createTask(page, title)
    await page.goto('/?lang=en')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: title }).first().click()
    await page.waitForTimeout(400)

    const editor = page.locator('[data-rich-editor="true"] .ProseMirror').first()
    await editor.click()
    await page.keyboard.type('1. ```')
    await page.keyboard.press('Enter')
    await page.keyboard.type('line1')
    await page.keyboard.press('Enter')
    await page.keyboard.type('line2')

    // The list item should stay a single item, and the code block should hold
    // both lines instead of splitting the list.
    await expect(editor.locator('ol > li')).toHaveCount(1)
    // Exact text (not substring): proves the newline was really inserted.
    const codeText = await editor.locator('ol > li > pre > code').textContent()
    expect(codeText).toBe('line1\nline2')
  })

  test('Triple Enter exits a code block', async ({ page }) => {
    const title = 'TripleEnter-' + Date.now()
    await createTask(page, title)
    await page.goto('/?lang=en')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: title }).first().click()
    await page.waitForTimeout(400)

    const editor = page.locator('[data-rich-editor="true"] .ProseMirror').first()
    await editor.click()
    await page.keyboard.type('```')
    await page.keyboard.press('Enter')
    await page.keyboard.type('abc')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')

    // exitOnTripleEnter strips the trailing "\n\n" and moves the cursor into a
    // new paragraph after the code block. Without the fix, a code-block Enter
    // handler would keep appending newlines, leaving "abc\n\n\n".
    const codeText = await editor.locator('pre > code').textContent()
    expect(codeText).toBe('abc')
  })

  test('ArrowUp moves out of a code block to the block above', async ({ page }) => {
    const title = 'ArrowUp-' + Date.now()
    await createTask(page, title)
    await page.goto('/?lang=en')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: title }).first().click()
    await page.waitForTimeout(400)

    const editor = page.locator('[data-rich-editor="true"] .ProseMirror').first()
    await editor.click()
    await page.keyboard.type('above paragraph')
    await page.keyboard.press('Enter')
    await page.keyboard.type('```')
    await page.keyboard.press('Enter')
    await page.keyboard.type('line1')
    await page.keyboard.press('Enter')
    await page.keyboard.type('line2')

    // line2 -> line1 -> should exit to the paragraph above (not the wrap button)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    const activeNode = await page.evaluate(() => {
      const s = window.getSelection()
      const node = s && s.anchorNode
      const el = node && node.nodeType === 3 ? node.parentElement : node
      return el ? { nodeName: el.nodeName, textContent: el.textContent } : null
    })
    expect(activeNode?.nodeName).toBe('P')
    expect(activeNode?.textContent).toBe('above paragraph')
  })

  test('ArrowDown moves out of a code block to the block below', async ({ page }) => {
    const title = 'ArrowDown-' + Date.now()
    await createTask(page, title)
    await page.goto('/?lang=en')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: title }).first().click()
    await page.waitForTimeout(400)

    const editor = page.locator('[data-rich-editor="true"] .ProseMirror').first()
    await editor.click()
    await page.keyboard.type('```')
    await page.keyboard.press('Enter')
    await page.keyboard.type('line1')

    // At the last line, ArrowDown (exitOnArrowDown) should move the cursor into
    // the paragraph after the code block.
    await page.keyboard.press('ArrowDown')
    const active = await page.evaluate(() => {
      const s = window.getSelection()
      const node = s && s.anchorNode
      const el = node && node.nodeType === 3 ? node.parentElement : node
      return el ? el.tagName : null
    })
    expect(active).toBe('P')
  })

  test('Tab and Shift+Tab indent and outdent list items', async ({ page }) => {
    const title = 'TabList-' + Date.now()
    await createTask(page, title)
    await page.goto('/?lang=en')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: title }).first().click()
    await page.waitForTimeout(400)

    const editor = page.locator('[data-rich-editor="true"] .ProseMirror').first()
    await editor.click()

    await page.keyboard.type('1. first')
    await page.keyboard.press('Enter')
    await page.keyboard.type('second')

    await page.keyboard.press('Tab')
    await expect(editor.locator('ol > li > ol > li')).toHaveCount(1)
    await expect(editor.locator('ol > li > ol > li')).toContainText('second')

    await page.keyboard.press('Shift+Tab')
    await expect(editor.locator('ol > li > ol > li')).toHaveCount(0)
    await expect(editor.locator(':scope > ol > li')).toHaveCount(2)
  })
})
