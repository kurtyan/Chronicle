import { useEffect, useState } from 'react'
import { useProjectStore } from '@/stores/projectStore'
import { projectRequest } from '@/services/projectApi'
import type { ProjectBacklinks } from '@/services/projectApi'
import { useProjectRefresh } from './common'
import { ProjectSelect } from '@/components/ui/ProjectSelect'
import { useI18n } from '@/i18n/context'
export function ProjectFilter({ value, onChange, allowUnassigned = false }: { value: string; onChange: (value: string) => void; allowUnassigned?: boolean }) {
  const { t } = useI18n()
  const { areas, milestones, loaded, load } = useProjectStore()
  useEffect(() => { if (!loaded) void load() }, [loaded, load])
  return <ProjectSelect compact className="min-w-0 flex-1" triggerClassName={`max-w-full ${value ? 'border-primary/20 bg-primary/5 text-primary' : 'border-transparent bg-transparent text-muted-foreground'}`} label={t('project.filter.label')} value={value} onChange={onChange} searchPlaceholder={t('project.relations.search')} options={[
    { value: '', label: t('project.filter.all') },
    ...(allowUnassigned ? [{ value: 'unassigned', label: t('project.relations.unassigned') }] : []),
    ...areas.map(area => ({ value: `area:${area.id}`, label: area.name, description: `${t('project.relations.area')}${area.archived ? ` · ${t('project.relations.archived')}` : ''}` })),
    ...milestones.map(milestone => ({ value: `milestone:${milestone.id}`, label: milestone.name, description: `${areas.find(area => area.id === milestone.areaId)?.name || t('project.relations.milestone')}${milestone.archived ? ` · ${t('project.relations.archived')}` : ''}` })),
  ]} />
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
