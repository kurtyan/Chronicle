import { test, expect } from '@playwright/test'

test.describe('GlobalSearchDialog and FindBar interaction', () => {
  test('ArrowDown inside global search results does not navigate task list', async ({ page }) => {
    const firstTask = await (await page.request.post('/api/tasks', {
      data: { title: 'SearchNavA', type: 'TODO', priority: 'MEDIUM' },
    })).json()
    const secondTask = await (await page.request.post('/api/tasks', {
      data: { title: 'SearchNavB', type: 'TODO', priority: 'MEDIUM' },
    })).json()

    await page.goto('/?lang=en')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: 'SearchNavA' }).first().click()
    await page.waitForTimeout(300)

    await page.keyboard.press('Meta+Shift+F')
    const searchInput = page.getByRole('dialog').getByPlaceholder('Search...')
    await expect(searchInput).toBeVisible()
    await searchInput.fill('SearchNav')
    await page.waitForTimeout(500)

    // Get the two result buttons before focusing
    const results = page.getByRole('dialog').getByRole('button').filter({ hasText: /SearchNav[AB]/ })
    await expect(results).toHaveCount(2)

    // Focus first result
    await page.keyboard.press('ArrowDown')
    await expect(results.first()).toBeFocused()

    // Focus second result without changing selected task
    await page.keyboard.press('ArrowDown')
    await expect(results.nth(1)).toBeFocused()

    // Task list selection should still be the first task
    await expect(page.locator('[data-task-id]').filter({ hasText: 'SearchNavA' }).first()).toHaveAttribute('data-task-id', firstTask.id)
  })

  test('Cmd+F find bar highlights and navigates matches in task detail', async ({ page }) => {
    const task = await (await page.request.post('/api/tasks', {
      data: { title: 'FindBarTarget', type: 'TODO', priority: 'MEDIUM' },
    })).json()
    await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content: '<p>This log contains the unique keyword findbar-test-token.</p>', type: 'log' },
    })

    await page.goto('/?lang=en')
    await page.waitForLoadState('load')
    await page.locator('h4').filter({ hasText: 'FindBarTarget' }).first().click()
    await page.waitForTimeout(300)

    await page.keyboard.press('Meta+f')
    const findBar = page.locator('[data-find-bar="true"]')
    await expect(findBar).toBeVisible()
    const input = findBar.locator('input')
    await input.fill('findbar-test-token')
    await page.waitForTimeout(500)

    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)

    await expect(findBar.getByText('1/1')).toBeVisible()
    await expect(page.locator('.search-highlight-current')).toHaveCount(1)
  })

  test('FindBar restores the current match when React replaces highlights at the same count', async ({ page }) => {
    const task = await (await page.request.post('/api/tasks', {
      data: { title: 'FindBarReplacementTarget', type: 'TODO', priority: 'MEDIUM' },
    })).json()
    await page.request.post(`/api/tasks/${task.id}/logs`, {
      data: { content: '<p>replacement-findbar-token</p>', type: 'log' },
    })

    await page.goto('/?lang=en')
    await page.locator(`[data-task-id="${task.id}"]`).click()
    await expect(page.locator('h1').filter({ hasText: 'FindBarReplacementTarget' })).toBeVisible()
    await page.keyboard.press('Meta+f')
    const findBar = page.locator('[data-find-bar="true"]')
    await expect(findBar).toBeVisible()
    await findBar.locator('input').fill('replacement-findbar-token')
    await expect(page.locator('.search-highlight-current')).toHaveCount(1)

    await page.locator('.search-highlight-current').evaluate((mark) => {
      const replacement = mark.cloneNode(true) as HTMLElement
      replacement.classList.remove('search-highlight-current')
      mark.replaceWith(replacement)
    })

    await expect(page.locator('.search-highlight-current')).toHaveCount(1)
  })

  test('FindBar title highlighting treats task titles as text, not HTML', async ({ page }) => {
    const task = await (await page.request.post('/api/tasks', {
      data: { title: 'title-xss-token<img src=x onerror="window.__findBarXss = true">', type: 'TODO', priority: 'MEDIUM' },
    })).json()

    await page.goto('/?lang=en')
    await page.locator(`[data-task-id="${task.id}"]`).click()
    await expect(page.locator('h1').filter({ hasText: 'title-xss-token' })).toBeVisible()
    await page.keyboard.press('Meta+f')
    await page.locator('[data-find-bar="true"] input').fill('title-xss-token')

    await expect(page.locator('h1 img')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => (window as Window & { __findBarXss?: boolean }).__findBarXss)).toBeUndefined()
  })


  test('Cmd+F in Notes keeps ProseMirror responsive while selecting a match', async ({ page }) => {
    const note = await (await page.request.post('/api/notes', {
      data: {
        title: 'FindBarNoteTarget',
        contentHtml: '<p>This note contains note-findbar-token.</p>',
        tags: [],
      },
    })).json()

    await page.goto(`/notes?id=${note.id}&lang=en`)
    await page.waitForLoadState('load')
    await expect(page.getByRole('heading', { name: 'FindBarNoteTarget', exact: true })).toBeVisible()

    await page.keyboard.press('Meta+f')
    const findBar = page.locator('[data-find-bar="true"]')
    await expect(findBar).toBeVisible()
    await findBar.locator('input').fill('note-findbar-token')

    await expect(findBar.getByText('1/1')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('.ProseMirror .search-highlight-current')).toHaveCount(1)
  })
})
