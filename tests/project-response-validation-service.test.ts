import { test, expect } from '@playwright/test'
import { projectErrorMessage, validateProjectCatalog, validateProjectReferences } from '../web/src/services/projectResponseValidation'
import type { Area, Milestone, ProjectReferencesResult } from '../shared/projectTypes'
import { setRuntimeLocale } from '../web/src/i18n/runtime'

test.beforeEach(() => setRuntimeLocale('zh-CN'))
test.afterEach(() => setRuntimeLocale('en'))

const area: Area = {
  id: 'A-test', name: '方向', description: '', focus: '', status: 'active',
  latestProgress: '', nextStep: '', summaryUpdatedAt: null, summarySource: null,
  summarySourceNoteId: null, summarySourceInsightId: null, summarySourceNoteRevision: null,
  archived: false, revision: 1, createdAt: 1, updatedAt: 1,
}
const milestone: Milestone = {
  id: 'M-test', areaId: area.id, name: '里程碑', kind: 'stage', goal: '', completionCriteria: '',
  status: 'planned', priority: null, startDate: null, targetDate: null, archived: false, revision: 1,
  latestProgress: '', nextStep: '', blockers: '', completedAt: null, completionEventId: null, createdAt: 1, updatedAt: 1,
}
const references: ProjectReferencesResult = {
  sourceType: 'note', sourceId: 'N-test', projectRevision: 2,
  references: [{ id: 'R-test', sourceType: 'note', sourceId: 'N-test', targetType: 'milestone',
    targetId: milestone.id, role: 'growth', origin: 'manual', name: milestone.name,
    areaId: area.id, areaName: area.name, archived: false, createdAt: 1 }],
}

test('catalog validation retains supported entity data and excludes unexpected store fields', () => {
  const value = validateProjectCatalog({ areas: [area], milestones: [milestone], load: null, invalidate: 'bad', error: { message: 'bad' } })
  expect(value).toEqual({ areas: [area], milestones: [milestone] })
  expect(Object.keys(value)).toEqual(['areas', 'milestones'])
  expect(validateProjectCatalog({ areas: [], milestones: [] })).toEqual({ areas: [], milestones: [] })
})

test('catalog validation rejects malformed arrays and nested display fields before store updates', () => {
  const malformed = [
    null, {}, { areas: null, milestones: null }, { areas: [], milestones: {} },
    { areas: [null], milestones: [] }, { areas: [], milestones: [null] },
    { areas: [{ ...area, name: { text: 'invalid React child' } }], milestones: [] },
    { areas: [area], milestones: [{ ...milestone, areaId: null }] },
    { areas: [{ ...area, revision: '1' }], milestones: [] },
    { areas: [], milestones: [{ ...milestone, targetDate: Number.NaN }] },
  ]
  for (const value of malformed) expect(() => validateProjectCatalog(value)).toThrow('方向与里程碑数据格式异常')
})

test('reference validation checks nested data, revisions, and the exact requested source', () => {
  expect(validateProjectReferences(references, 'note', 'N-test')).toEqual(references)
  expect(validateProjectReferences({ ...references, references: [] }, 'note', 'N-test').references).toEqual([])
  const malformed = [
    null, { ...references, references: null }, { ...references, references: [null] },
    { ...references, projectRevision: '2' }, { ...references, projectRevision: -1 },
    { ...references, sourceType: 'task' }, { ...references, sourceId: 'N-other' },
    { ...references, references: [{ ...references.references[0], sourceId: 'N-other' }] },
    { ...references, references: [{ ...references.references[0], name: {} }] },
    { ...references, references: [{ ...references.references[0], role: 'unknown' }] },
  ]
  for (const value of malformed) expect(() => validateProjectReferences(value, 'note', 'N-test')).toThrow('关联项目信息格式异常')
})

test('project failures always produce displayable text without hiding an ordinary write error', () => {
  expect(projectErrorMessage(new Error('revision conflict'))).toBe('revision conflict')
  expect(projectErrorMessage({ response: { data: { message: '需要重新确认', error: {} } }, message: 'Request failed' })).toBe('需要重新确认')
  expect(projectErrorMessage({ response: { data: { error: { message: 'invalid React child' } } }, message: 'Request failed' })).toBe('Request failed')
  for (const value of [null, undefined, {}, { response: { data: { error: {} } } }]) expect(typeof projectErrorMessage(value)).toBe('string')
})
