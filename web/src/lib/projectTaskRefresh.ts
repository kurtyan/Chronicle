import { getTaskById } from '@/services/api'
import { useTaskStore } from '@/stores/taskStore'
import type { Task } from '@/types'

const pending = new Map<string, symbol>()

/** Project events update relationship metadata, never reload editable logs. */
export async function refreshTaskProjectMetadata(taskIds: string[]): Promise<void> {
  const state = useTaskStore.getState()
  const knownIds = new Set(state.tasks.map(task => task.id))
  if (state.selectedTask) knownIds.add(state.selectedTask.id)
  await Promise.all([...new Set(taskIds)].filter(id => knownIds.has(id)).map(async id => {
    const request = Symbol(id)
    pending.set(id, request)
    try {
      const fresh = await getTaskById(id)
      if (!fresh || fresh.id !== id || !Number.isFinite(fresh.updatedAt)
        || pending.get(id) !== request || !Number.isInteger(fresh.projectRevision)
        || (fresh.projectRevision ?? 0) < 1
        || !(fresh.primaryMilestoneId === null || typeof fresh.primaryMilestoneId === 'string')) return
      const merge = (task: Task): Task => task.id === id && (task.projectRevision ?? 0) <= fresh.projectRevision!
        ? { ...task, primaryMilestoneId: fresh.primaryMilestoneId, projectRevision: fresh.projectRevision,
          updatedAt: Math.max(task.updatedAt, fresh.updatedAt) }
        : task
      useTaskStore.setState(current => ({
        tasks: current.tasks.map(merge),
        selectedTask: current.selectedTask ? merge(current.selectedTask) : null,
      }))
    } catch {
      // An optional metadata refresh cannot interrupt editing or timing.
    } finally {
      if (pending.get(id) === request) pending.delete(id)
    }
  }))
}
