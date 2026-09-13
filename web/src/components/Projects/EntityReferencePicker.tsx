import { useEffect, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X, Link2 } from 'lucide-react'
import { useProjectStore } from '@/stores/projectStore'
import { entityPath } from '@/services/projectApi'
import type { ProjectReferenceInput, ProjectTargetType } from '@/services/projectApi'
import { ProjectSelect } from '@/components/ui/ProjectSelect'
import { useI18n } from '@/i18n/context'

export function EntityReferenceChip({ targetType, targetId, label, archived, onRemove, sourceTaskId }: { targetType: ProjectTargetType; targetId: string; label?: string; archived?: boolean; onRemove?: () => void; sourceTaskId?: string }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const { areas, milestones, loaded, load } = useProjectStore()
  useEffect(() => { if (!loaded) void load() }, [loaded, load])
  const milestone = milestones.find(m => m.id === targetId)
  const area = areas.find(a => a.id === (targetType === 'area' ? targetId : milestone?.areaId))
  const name = label || (targetType === 'area' ? area?.name : milestone?.name) || targetId
  return <span className="inline-flex max-w-full items-center rounded-md border border-primary/20 bg-primary/5 text-xs">
    <button type="button" className="flex min-w-0 items-center gap-1 px-2 py-1 hover:bg-primary/10" title={`${targetType === 'area' ? t('project.relations.area') : `${area?.name || t('project.relations.milestone')} ›`} ${name}`} onClick={() => {
      const returnTo = location.pathname + location.search
      const path = entityPath(targetType, targetId)
      navigate(sourceTaskId ? `${path}?${new URLSearchParams({ projectSourceReturn: returnTo, projectSourceTask: sourceTaskId })}` : path, { state: { returnTo, sourceTaskId } })
    }}>
      <Link2 className="h-3 w-3 shrink-0" /><span className="truncate">{targetType === 'milestone' && area ? `${area.name} › ` : ''}{name}{(archived || (targetType === 'area' ? area?.archived : milestone?.archived)) ? ` · ${t('project.relations.archived')}` : ''}</span>
    </button>
    {onRemove && <button type="button" aria-label={t('project.relations.remove', { name })} className="p-1.5 hover:bg-muted" onClick={onRemove}><X className="h-3 w-3" /></button>}
  </span>
}

export function EntityReferencePicker({ onSelect, milestoneOnly = false, exclude = [], disabled = false, label }: { onSelect: (ref: ProjectReferenceInput) => void; milestoneOnly?: boolean; exclude?: ProjectReferenceInput[]; disabled?: boolean; label?: string }) {
  const { t } = useI18n()
  const { areas, milestones, loaded, error, load } = useProjectStore()
  useEffect(() => { if (!loaded) void load() }, [loaded, load])
  const options = useMemo(() => [
    ...(!milestoneOnly ? areas.filter(a => !a.archived).map(a => ({ targetType: 'area' as const, targetId: a.id, name: a.name, subtitle: t('project.relations.area') })) : []),
    ...milestones.filter(m => !m.archived && !areas.find(a => a.id === m.areaId)?.archived).map(m => ({ targetType: 'milestone' as const, targetId: m.id, name: m.name, subtitle: `${areas.find(a => a.id === m.areaId)?.name || ''} · ${t(`project.relations.${m.kind === 'ongoing' ? 'ongoing' : 'bounded'}`)}` })),
  ].filter(o => !exclude.some(e => e.targetType === o.targetType && e.targetId === o.targetId)).map(o => ({ value: `${o.targetType}:${o.targetId}`, label: o.name, description: o.subtitle })), [areas, milestones, milestoneOnly, exclude, t])
  return <ProjectSelect compact value="" label={label || t('project.relations.add')} disabled={disabled} options={options} searchPlaceholder={t('project.relations.search')} emptyMessage={error || (loaded ? t('project.relations.empty') : t('project.relations.loading'))} testId="entity-reference-options" onChange={value => {
    const separator = value.indexOf(':')
    onSelect({ targetType: value.slice(0, separator) as ProjectTargetType, targetId: value.slice(separator + 1), role: 'related' })
  }} />
}
