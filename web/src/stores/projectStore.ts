import { create } from 'zustand'
import { projectApi, projectError } from '@/services/projectApi'
import type { Area, Milestone } from '@/services/projectApi'
let request: Promise<void> | null = null
let generation = 0
export const useProjectStore = create<{
  areas: Area[]; milestones: Milestone[]; loaded: boolean; error: string | null
  load: () => Promise<void>; invalidate: () => void
}>((set, get) => ({
  areas: [], milestones: [], loaded: false, error: null,
  load: () => {
    if (request) return request
    const version = generation
    request = projectApi.catalog().then(data => { set({ areas: data.areas, milestones: data.milestones, loaded: true, error: null }) }).catch(error => { set({ error: projectError(error) }) }).finally(() => {
      request = null
      if (generation !== version) void get().load()
    })
    return request
  },
  invalidate: () => { generation++; void get().load() },
}))
if (typeof window !== 'undefined') window.addEventListener('chronicle:projects-changed', () => useProjectStore.getState().invalidate())
