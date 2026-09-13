import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Check, ChevronDown, Search } from 'lucide-react'
import { useI18n } from '@/i18n/context'
import { cn } from '@/lib/utils'

export interface ProjectSelectOption {
  value: string
  label: string
  description?: string
  keywords?: string
  disabled?: boolean
}

interface ProjectSelectProps {
  value: string
  onChange: (value: string) => void
  options: ProjectSelectOption[]
  label: string
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  disabled?: boolean
  className?: string
  triggerClassName?: string
  compact?: boolean
  testId?: string
}

/** A keyboard-first, searchable selector shared by project forms and filters. */
export function ProjectSelect({ value, onChange, options, label, placeholder, searchPlaceholder, emptyMessage, disabled, className, triggerClassName, compact = false, testId }: ProjectSelectProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, maxHeight: 300 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const selected = options.find(option => option.value === value)
  const filtered = useMemo(() => {
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
    return options.filter(option => words.every(word => `${option.label} ${option.description || ''} ${option.keywords || ''}`.toLocaleLowerCase().includes(word)))
  }, [options, query])

  useLayoutEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 24)
      const below = window.innerHeight - rect.bottom - 12
      const above = rect.top - 12
      const contentHeight = 50 + (filtered.length ? filtered.reduce((height, option) => height + (option.description ? 54 : 36), 0) : 56)
      const height = Math.min(330, contentHeight, Math.max(below, above))
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: below >= Math.min(330, contentHeight, above) ? rect.bottom + 5 : Math.max(12, rect.top - height - 5),
        width,
        maxHeight: Math.max(120, height),
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, filtered])

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-option-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const select = (option?: ProjectSelectOption) => {
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
  }
  const move = (step: number) => {
    if (!filtered.length) return
    for (let offset = 1; offset <= filtered.length; offset++) {
      const index = (active + step * offset + filtered.length) % filtered.length
      if (!filtered[index].disabled) { setActive(index); break }
    }
  }

  return <DialogPrimitive.Root modal={false} open={open} onOpenChange={next => {
    setOpen(next)
    if (next) { setQuery(''); setActive(Math.max(0, options.findIndex(option => option.value === value && !option.disabled))) }
  }}>
    <span className={cn('inline-flex min-w-0', className)}>
      <DialogPrimitive.Trigger asChild>
        <button ref={triggerRef} type="button" disabled={disabled} aria-label={label} aria-haspopup="dialog" title={selected?.description ? `${selected.description} · ${selected.label}` : selected?.label || label} className={cn('inline-flex min-w-0 items-center justify-between gap-2 rounded-md border border-border/70 bg-background text-left text-sm transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50', compact ? 'h-7 px-2 text-xs' : 'h-9 px-3', triggerClassName)}>
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>{selected?.label || placeholder || label}</span>
          <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        </button>
      </DialogPrimitive.Trigger>
    </span>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Content data-project-select-popup data-testid={testId} aria-describedby={undefined} className="fixed z-[120] flex flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-[0_8px_30px_-10px_hsl(var(--foreground)/0.3)] outline-none" style={position} onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus() }} onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus() }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) event.stopPropagation()
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1) }
        if (event.key === 'Enter') { event.preventDefault(); select(filtered[active]) }
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
      }}>
        <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input ref={inputRef} role="combobox" aria-label={searchPlaceholder || t('project.select.search')} aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-list`} aria-activedescendant={filtered[active] ? `${id}-option-${active}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setActive(0) }} placeholder={searchPlaceholder || t('project.select.search')} className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          <kbd className="rounded border border-border/60 px-1 text-[10px] text-muted-foreground">esc</kbd>
        </div>
        <div ref={listRef} id={`${id}-list`} role="listbox" aria-label={label} className="min-h-0 overflow-y-auto p-1">
          {filtered.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} data-option-index={index} className={cn('flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm', index === active && 'bg-muted', option.disabled && 'opacity-40')} onPointerMove={() => { if (!option.disabled) setActive(index) }} onPointerDown={event => event.preventDefault()} onClick={() => select(option)}>
            <span className="min-w-0 flex-1"><span className="block truncate">{option.label}</span>{option.description && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{option.description}</span>}</span>
            {option.value === value && <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />}
          </div>)}
          {!filtered.length && <p role="status" className="px-3 py-5 text-center text-xs text-muted-foreground">{emptyMessage || t('project.select.noResults')}</p>}
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>
}
