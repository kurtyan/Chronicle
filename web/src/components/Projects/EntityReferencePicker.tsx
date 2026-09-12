import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X, Link2 } from 'lucide-react'
import { useProjectStore } from '@/stores/projectStore'
import { entityPath } from '@/services/projectApi'
import type { ProjectReferenceInput, ProjectTargetType } from '@/services/projectApi'
import { button, control } from './common'

export function EntityReferenceChip({ targetType, targetId, label, archived, onRemove }: { targetType: ProjectTargetType; targetId: string; label?: string; archived?: boolean; onRemove?: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { areas, milestones, loaded, load } = useProjectStore()
  useEffect(() => { if (!loaded) void load() }, [loaded, load])
  const milestone = milestones.find(m => m.id === targetId)
  const area = areas.find(a => a.id === (targetType === 'area' ? targetId : milestone?.areaId))
  const name = label || (targetType === 'area' ? area?.name : milestone?.name) || targetId
  return <span className="inline-flex max-w-full items-center rounded-md border border-primary/20 bg-primary/5 text-xs">
    <button type="button" className="flex min-w-0 items-center gap-1 px-2 py-1.5 hover:bg-primary/10" title={`${targetType === 'area' ? '方向' : `${area?.name || '里程碑'} ›`} ${name}`} onClick={() => navigate(entityPath(targetType, targetId), { state: { returnTo: location.pathname + location.search } })}>
      <Link2 className="h-3 w-3 shrink-0" /><span className="truncate">{targetType === 'milestone' && area ? `${area.name} › ` : ''}{name}{(archived || (targetType === 'area' ? area?.archived : milestone?.archived)) ? '（已归档）' : ''}</span>
    </button>
    {onRemove && <button type="button" aria-label={`移除 ${name} 引用`} className="p-1.5 hover:bg-muted" onClick={onRemove}><X className="h-3 w-3" /></button>}
  </span>
}

export function EntityReferencePicker({ onSelect, milestoneOnly = false, exclude = [], disabled = false, label = '关联方向或里程碑' }: { onSelect: (ref: ProjectReferenceInput) => void; milestoneOnly?: boolean; exclude?: ProjectReferenceInput[]; disabled?: boolean; label?: string }) {
  const { areas, milestones, loaded, error, load } = useProjectStore()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => { if (!loaded) void load() }, [loaded, load])
  const options = useMemo(() => [
    ...(!milestoneOnly ? areas.filter(a => !a.archived).map(a => ({ targetType: 'area' as const, targetId: a.id, name: a.name, subtitle: '方向' })) : []),
    ...milestones.filter(m => !m.archived && !areas.find(a => a.id === m.areaId)?.archived).map(m => ({ targetType: 'milestone' as const, targetId: m.id, name: m.name, subtitle: `${areas.find(a => a.id === m.areaId)?.name || ''} › ${m.kind === 'ongoing' ? '持续型' : '阶段型'}` })),
  ].filter(o => !exclude.some(e => e.targetType === o.targetType && e.targetId === o.targetId) && `${o.name} ${o.subtitle}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [areas, milestones, milestoneOnly, exclude, query])
  return <div className="relative">
    <button type="button" className={button} disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
    {open && <div data-testid="entity-reference-options" className="absolute left-0 top-full z-40 mt-1 w-72 max-w-[calc(100vw-6rem)] rounded-lg border bg-popover p-2 shadow-lg" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }}>
      <input aria-label="搜索方向或里程碑" autoFocus className={`${control} w-full`} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索名称、方向…" />
      <div className="mt-2 max-h-56 overflow-y-auto">
        {options.map(o => <button type="button" key={`${o.targetType}:${o.targetId}`} className="block w-full rounded p-2 text-left text-sm hover:bg-muted focus:bg-muted" onClick={() => { onSelect({ targetType: o.targetType, targetId: o.targetId, role: 'related' }); setOpen(false); setQuery('') }}><div>{o.name}</div><div className="text-xs text-muted-foreground">{o.subtitle}</div></button>)}
        {!options.length && <p className="p-2 text-xs text-muted-foreground">{error || (loaded ? '没有可选对象，请先在项目页创建。' : '加载中…')}</p>}
      </div>
      <button type="button" className="mt-2 text-xs text-muted-foreground" onClick={() => setOpen(false)}>关闭</button>
    </div>}
  </div>
}
