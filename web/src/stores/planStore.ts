import { create } from 'zustand'
import type { PlanItem, BatchCreatePlanItem } from '@/types'
import * as api from '@/services/api'

interface PlanState {
  planItems: PlanItem[]
  selectedItemIndex: number
  planDate: string
  loading: boolean
  error: string | null
  startOfDayOffset: number

  wizardStep: 1 | 2
  wizardItems: BatchCreatePlanItem[]
}

export const usePlanStore = create<PlanState>(() => ({
  planItems: [],
  selectedItemIndex: -1,
  planDate: '',
  loading: false,
  error: null,
  startOfDayOffset: 5,

  wizardStep: 1,
  wizardItems: [],
}))

let cachedOffset = 5

export async function loadStartOfDayOffset() {
  try {
    const offset = await api.fetchStartOfDayOffset()
    cachedOffset = offset
    usePlanStore.setState({ startOfDayOffset: offset })
  } catch { /* use cached default */ }
}

export function getTodayDate(): string {
  const now = new Date()
  // Shift back by offset hours so times before the offset belong to the previous day
  const adjusted = new Date(now.getTime() - cachedOffset * 3600_000)
  return `${adjusted.getFullYear()}-${String(adjusted.getMonth() + 1).padStart(2, '0')}-${String(adjusted.getDate()).padStart(2, '0')}`
}

// --- Today plan actions ---

export async function loadPlanItems(date: string) {
  usePlanStore.setState({ loading: true, error: null, planDate: date })
  try {
    const items = await api.fetchPlanItems(date)
    usePlanStore.setState({ planItems: items, loading: false })
  } catch (e: any) {
    usePlanStore.setState({ error: e.message, loading: false })
  }
}

export async function checkHasPlanForDate(date: string): Promise<boolean> {
  try {
    return await api.hasPlanForDate(date)
  } catch {
    return false
  }
}

export function selectPlanItem(index: number) {
  usePlanStore.setState({ selectedItemIndex: index })
}

export async function startPlanItem(index: number) {
  const { planItems } = usePlanStore.getState()
  const item = planItems[index]
  if (!item) return

  try {
    const { takeOverTask } = await import('@/services/api')
    await takeOverTask(item.taskId)
    const now = Date.now()
    const detail = await api.updatePlanItem(item.detailId, {
      status: 'DOING',
      actualStartedAt: item.actualStartedAt ?? now,
    })
    usePlanStore.setState({
      planItems: planItems.map((p, i) =>
        i === index ? { ...p, planStatus: 'DOING', actualStartedAt: detail.actualStartedAt } : p
      ),
    })
  } catch (e: any) {
    usePlanStore.setState({ error: e.message })
  }
}

export async function completePlanItem(index: number) {
  const { planItems } = usePlanStore.getState()
  const item = planItems[index]
  if (!item) return

  try {
    const now = Date.now()
    const detail = await api.updatePlanItem(item.detailId, {
      status: 'DONE',
      actualCompletedAt: now,
    })
    usePlanStore.setState({
      planItems: planItems.map((p, i) =>
        i === index ? { ...p, planStatus: 'DONE', actualCompletedAt: detail.actualCompletedAt } : p
      ),
    })
  } catch (e: any) {
    usePlanStore.setState({ error: e.message })
  }
}

export async function updatePlanItemContent(index: number, content: string) {
  const { planItems } = usePlanStore.getState()
  const item = planItems[index]
  if (!item) return

  try {
    await api.updatePlanItem(item.detailId, { content })
    usePlanStore.setState({
      planItems: planItems.map((p, i) => (i === index ? { ...p, content } : p)),
    })
  } catch (e: any) {
    usePlanStore.setState({ error: e.message })
  }
}

// --- Wizard actions ---

export function setWizardStep(step: 1 | 2) {
  usePlanStore.setState({ wizardStep: step })
}

export function setWizardItems(items: BatchCreatePlanItem[]) {
  usePlanStore.setState({ wizardItems: items })
}

export function addWizardItem(item: BatchCreatePlanItem) {
  usePlanStore.setState({ wizardItems: [...usePlanStore.getState().wizardItems, item] })
}

export function reorderWizardItems(items: BatchCreatePlanItem[]) {
  usePlanStore.setState({ wizardItems: items })
}

export async function savePlan(planDate: string, items: BatchCreatePlanItem[]) {
  usePlanStore.setState({ loading: true, error: null })
  try {
    const created = await api.batchCreatePlanItems({ planDate, items })
    usePlanStore.setState({ planItems: created, planDate, wizardStep: 1, wizardItems: [], loading: false })
    return created
  } catch (e: any) {
    usePlanStore.setState({ error: e.message, loading: false })
    throw e
  }
}
