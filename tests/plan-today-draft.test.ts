import { test, expect, type Page } from '@playwright/test'

function uniqueScriptDate(dayOffset: number): string {
  const date = new Date(2099, 4, dayOffset)
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
  const currentRes = await page.request.get(`/api/day-scripts/${date}`)
  expect(currentRes.ok()).toBeTruthy()
  const current = await currentRes.json()
  const saveRes = await page.request.put(`/api/day-scripts/${date}`, {
    data: {
      expectedRevision: current.revision ?? 0,
      document,
    },
  })
  expect(saveRes.ok()).toBeTruthy()
  return saveRes.json()
}

function docText(node: any): string {
  if (!node) return ''
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(docText).join('\n')
}

test.describe('Plan Today draft', () => {
  test('includes task next steps and yesterday unfinished focus blocks', async ({ page }) => {
    const today = uniqueScriptDate(Date.now() % 20 + 1)
    const yesterday = uniqueScriptDate(Date.now() % 20)
    const originalSettings = await (await page.request.get('/api/settings/llm')).json()
    await page.request.put('/api/settings/llm', {
      data: { ...originalSettings, baseUrl: '', model: '' },
    })

    try {
      const task = await createTask(page, `PlanToday-${Date.now()}`)
      await page.request.post(`/api/tasks/${task.id}/logs`, {
        data: { content: '<p>下一步：整理发布检查清单</p>', type: 'log' },
      })
      const summarize = await page.request.post('/api/task-context/summarize', { data: { taskIds: [task.id] } })
      expect(summarize.ok()).toBeTruthy()

      await saveDayScript(page, yesterday, {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '09:00-10:00 昨日未完成事项' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '还需要补验证记录' }] },
        ],
      })

      const draftRes = await page.request.post(`/api/day-scripts/${today}/plan-today-draft`)
      expect(draftRes.ok()).toBeTruthy()
      const draft = await draftRes.json()
      const text = docText(draft.document)

      expect(text).toContain('整理发布检查清单')
      expect(text).toContain('昨日未完成事项')
      expect(text).toContain('还需要补验证记录')
    } finally {
      await page.request.put('/api/settings/llm', { data: originalSettings })
    }
  })
})
