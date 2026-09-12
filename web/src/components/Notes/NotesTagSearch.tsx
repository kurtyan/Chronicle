import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useProjectStore } from '@/stores/projectStore'
import { cn } from '@/lib/utils'
import { parseNotesSearchInput, type NotesSearchValue } from './notesSearchState'

export function NotesTagSearch({ value, onChange }: { value: NotesSearchValue; onChange: (value: NotesSearchValue) => void }) {
  const { areas, milestones, loaded, load, error } = useProjectStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const listId = useId()
  const parsed = parseNotesSearchInput(value.input)
  const targets = useMemo(() => [
    ...areas.map(area => ({ value: `area:${area.id}`, name: area.name, kind: '方向', parent: '', archived: area.archived })),
    ...milestones.map(milestone => ({ value: `milestone:${milestone.id}`, name: milestone.name, kind: '里程碑', parent: areas.find(area => area.id === milestone.areaId)?.name || '', archived: milestone.archived })),
  ], [areas, milestones])
  const matches = useMemo(() => {
    const text = (parsed.tagQuery || '').toLocaleLowerCase()
    return targets.filter(target => !value.filters.includes(target.value) && `${target.name} ${target.parent}`.toLocaleLowerCase().includes(text))
  }, [targets, parsed.tagQuery, value.filters])
  const open = focused && parsed.tagQuery !== null && !dismissed
  const activeIndex = Math.min(highlight, Math.max(0, matches.length - 1))

  useEffect(() => { if (!loaded) void load() }, [loaded, load])
  useEffect(() => { setHighlight(0); setDismissed(false) }, [value.input])
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex, listId])

  const choose = (filter: string) => {
    onChange({ input: parsed.prefix ? `${parsed.prefix} ` : '', filters: [...value.filters, filter] })
    setDismissed(false)
    inputRef.current?.focus()
  }
  const remove = (filter: string) => onChange({ ...value, filters: value.filters.filter(item => item !== filter) })

  return <div data-notes-tag-search="true" className="relative">
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background p-2 focus-within:ring-1 focus-within:ring-primary/40">
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      {value.filters.map(filter => {
        const target = targets.find(item => item.value === filter)
        return <span key={filter} data-testid="notes-filter-token" className="inline-flex max-w-full items-center gap-1 rounded-md bg-primary/10 px-1.5 py-1 text-xs text-primary" title={target?.parent ? `${target.parent} › ${target.name}` : target?.name || filter}>
          <span className="shrink-0 text-[10px] opacity-70">{target?.kind || (filter.startsWith('area:') ? '方向' : '里程碑')}</span>
          <span className="truncate">#{target?.name || filter.slice(filter.indexOf(':') + 1)}</span>
          <button type="button" className="shrink-0 rounded p-0.5 hover:bg-primary/10" aria-label={`移除筛选 ${target?.name || filter}`} onClick={() => remove(filter)}><X className="h-3 w-3" /></button>
        </span>
      })}
      <input ref={inputRef} role="combobox" aria-label="搜索 Notes 或输入 # 标签" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open && matches.length ? `${listId}-${activeIndex}` : undefined}
        value={value.input} placeholder="搜索文字，或输入 #方向 / 里程碑"
        className="h-7 min-w-[130px] flex-1 bg-transparent text-sm outline-none"
        onChange={event => onChange({ ...value, input: event.target.value })}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={event => {
          if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation(); setDismissed(true); return
          }
          if (parsed.tagQuery !== null && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault(); event.stopPropagation(); setDismissed(false)
            setHighlight(index => matches.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0)
          } else if (open && event.key === 'Enter') {
            event.preventDefault(); event.stopPropagation()
            if (matches[activeIndex]) choose(matches[activeIndex].value)
          } else if (event.key === 'Backspace' && !value.input && value.filters.length) {
            event.preventDefault(); remove(value.filters[value.filters.length - 1])
          }
        }} />
    </div>
    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{value.filters.length ? `同时匹配全部 ${value.filters.length} 个标签（AND）` : '输入 # 后选择方向或里程碑'} · 方向包含其下里程碑的笔记</p>
    {parsed.tagQuery !== null && <p className="mt-1 text-[11px] text-muted-foreground">正在选择标签；按 Enter 确认后生效。普通文字继续全文搜索。</p>}
    {open && <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg" role="listbox" id={listId} aria-label="方向与里程碑标签建议" data-testid="notes-tag-options">
      {error ? <div role="alert" className="p-2 text-xs text-red-600">标签加载失败。<button className="underline" onMouseDown={event => event.preventDefault()} onClick={() => void load()}>重试</button></div> : !loaded ? <p className="p-2 text-xs text-muted-foreground">正在加载标签…</p> : !matches.length ? <p className="p-2 text-xs text-muted-foreground">没有匹配的方向或里程碑；修改 # 后的文字，或删除 # 恢复全文搜索。</p> : matches.map((target, index) => <button type="button" role="option" aria-selected={index === activeIndex} id={`${listId}-${index}`} key={target.value}
        className={cn('flex w-full items-start gap-2 rounded-md p-2 text-left text-sm', index === activeIndex ? 'bg-primary/10' : 'hover:bg-muted')}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(target.value)} onMouseMove={() => setHighlight(index)}>
        <span className="mt-0.5 shrink-0 rounded border px-1 text-[10px] text-muted-foreground">{target.kind}</span>
        <span className="min-w-0"><span className="block break-words">#{target.name}{target.archived ? '（已归档）' : ''}</span>{target.parent && <span className="block truncate text-xs text-muted-foreground">{target.parent}</span>}</span>
      </button>)}
    </div>}
  </div>
}
