import { test, expect } from '@playwright/test'
import { systemLocale, urlLocale } from '../web/src/i18n/locale'
import { setRuntimeLocale, translateCurrent } from '../web/src/i18n/runtime'
import { projectErrorMessage, validateProjectCatalog, validateProjectReferences } from '../web/src/services/projectResponseValidation'

test.afterEach(() => setRuntimeLocale('en'))

test('automatic language follows the system while explicit supported URL language wins', () => {
  expect(systemLocale('en-US')).toBe('en')
  expect(systemLocale('zh-CN')).toBe('zh-CN')
  expect(systemLocale('zh-TW')).toBe('zh-CN')
  expect(systemLocale('ja-JP')).toBe('en')
  expect(urlLocale('?lang=en') || systemLocale('zh-CN')).toBe('en')
  expect(urlLocale('?lang=zh-CN') || systemLocale('en-US')).toBe('zh-CN')
  expect(urlLocale('?lang=auto') || systemLocale('en-US')).toBe('en')
})

test('malformed project responses and fallback errors are localized for English workspaces', () => {
  setRuntimeLocale('en')
  expect(() => validateProjectCatalog({ areas: null, milestones: [] })).toThrow('Unable to read area and milestone data. Please retry.')
  expect(() => validateProjectReferences({}, 'task', 'T-test')).toThrow('Unable to read project links. Please reload and retry.')
  expect(projectErrorMessage(null)).toBe('The operation failed. Please retry.')
  expect(translateCurrent('projectShell.unavailable', { feature: 'Project links' })).toBe('Project links is temporarily unavailable.')
})

test('retained validation errors use the current language at display time', () => {
  setRuntimeLocale('zh-CN')
  let retainedError: unknown
  try { validateProjectCatalog(null) } catch (error) { retainedError = error }
  expect(projectErrorMessage(retainedError)).toContain('方向与里程碑数据格式异常')
  setRuntimeLocale('en')
  expect(projectErrorMessage(retainedError)).toBe('Unable to read area and milestone data. Please retry.')
  expect(projectErrorMessage({ response: { data: { message: 'The milestone was changed in another window.' } } })).toBe('The milestone was changed in another window.')
})
