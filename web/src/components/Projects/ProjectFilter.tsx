import { useEffect, useState } from 'react'
import { useProjectStore } from '@/stores/projectStore'
import { projectRequest } from '@/services/projectApi'
import type { ProjectBacklinks } from '@/services/projectApi'
import { control, useProjectRefresh } from './common'
export function ProjectFilter({ value, onChange, allowUnassigned = false }: { value: string; onChange: (value: string) => void; allowUnassigned?: boolean }) {
  const { areas, milestones, loaded, load } = useProjectStore()
  useEffect(() => { if (!loaded) void load() }, [loaded, load])
  return <select aria-label="按方向或里程碑筛选" className={`${control} w-full !px-2 !py-1.5 text-xs`} value={value} onChange={e => onChange(e.target.value)}><option value="">全部方向 / 里程碑</option>{allowUnassigned && <option value="unassigned">未归属</option>}<optgroup label="方向">{areas.map(a => <option key={a.id} value={`area:${a.id}`}>{a.name}{a.archived ? '（已归档）' : ''}</option>)}</optgroup><optgroup label="里程碑">{milestones.map(m => <option key={m.id} value={`milestone:${m.id}`}>{areas.find(a => a.id === m.areaId)?.name} › {m.name}{m.archived ? '（已归档）' : ''}</option>)}</optgroup></select>
}
export function useProjectLinkedIds(filter: string, sourceType: 'task' | 'note') {
  const [ids, setIds] = useState<Set<string>>(new Set())
  const refresh = useProjectRefresh()
  useEffect(() => {
    let active = true
    const [targetType, targetId] = filter.split(':')
    if (!targetId) { setIds(new Set()); return }
    setIds(new Set())
    projectRequest<ProjectBacklinks>('get', '/api/project-references/backlinks', { targetType, targetId }).then(data => { if (active) setIds(new Set(data[sourceType === 'task' ? 'tasks' : 'notes'].map(item => item.sourceId))) }).catch(() => { if (active) setIds(new Set()) })
    return () => { active = false }
  }, [filter, sourceType, refresh])
  return ids
}
