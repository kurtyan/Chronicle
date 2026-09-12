import { test, expect } from '@playwright/test'
import { getWorkPeriodRange } from '../web/src/lib/workPeriod'

const previousTimezone = process.env.TZ
test.beforeAll(() => { process.env.TZ = 'Asia/Shanghai' })
test.afterAll(() => { if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone })

test('a Sunday report and project overview use the same complete Monday work week', () => {
  const selected = new Date('2026-09-13T12:00:00+08:00')
  const original = selected.getTime()
  expect(getWorkPeriodRange('week', selected, 5)).toEqual({
    start: new Date('2026-09-07T05:00:00+08:00').getTime(),
    end: new Date('2026-09-14T05:00:00+08:00').getTime(),
  })
  expect(selected.getTime()).toBe(original)
})

test('month boundaries follow the calendar rather than adding thirty days', () => {
  expect(getWorkPeriodRange('month', new Date('2028-02-15T12:00:00+08:00'), 5)).toEqual({
    start: new Date('2028-02-01T05:00:00+08:00').getTime(),
    end: new Date('2028-03-01T05:00:00+08:00').getTime(),
  })
  expect(getWorkPeriodRange('month', new Date('2026-12-31T12:00:00+08:00'), 0)).toEqual({
    start: new Date('2026-12-01T00:00:00+08:00').getTime(),
    end: new Date('2027-01-01T00:00:00+08:00').getTime(),
  })
})

test('adjacent custom report days meet exactly at the half-open work boundary', () => {
  const first = getWorkPeriodRange('day', new Date('2026-09-10T12:00:00+08:00'), 5)
  const next = getWorkPeriodRange('day', new Date('2026-09-11T12:00:00+08:00'), 5)
  expect(first.end).toBe(next.start)
  expect(first.start).toBe(new Date('2026-09-10T05:00:00+08:00').getTime())
  expect(next.end).toBe(new Date('2026-09-12T05:00:00+08:00').getTime())
})
