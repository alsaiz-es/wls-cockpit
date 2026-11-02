import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CornerDownLeft, Search, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { DashboardSnapshot } from '@/api/queries/domain-dashboard'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { MonoText } from './mono-text'
import {
  buildQuickJumpEntries,
  filterQuickJumpEntries,
  hasLiveQuickJumpResources,
  type QuickJumpEntry,
} from './quick-jump-model'

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

export function QuickJump({ snapshot }: { snapshot: DashboardSnapshot | undefined }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const entries = useMemo(() => buildQuickJumpEntries(snapshot), [snapshot])
  const results = useMemo(() => filterQuickJumpEntries(entries, query), [entries, query])
  const boundedActiveIndex = results.length > 0 ? Math.min(activeIndex, results.length - 1) : 0
  const hasLiveResources = hasLiveQuickJumpResources(snapshot)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (!isEditableTarget(event.target)) {
          event.preventDefault()
          setActiveIndex(0)
          setOpen(true)
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  function select(entry: QuickJumpEntry | undefined) {
    if (!entry) return
    setOpen(false)
    setQuery('')
    navigate(entry.href)
  }

  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)))
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      select(results[boundedActiveIndex])
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setActiveIndex(0)
          setOpen(true)
        }}
      >
        <Search className="size-4" strokeWidth={1.5} />
        Jump
      </Button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[10vh]" onKeyDown={onDialogKeyDown}>
          <div role="dialog" aria-modal="true" aria-label="Quick jump" className="border-border bg-surface-2 w-full max-w-[620px] border shadow-xl">
            <div className="flex h-11 items-center gap-2 border-b border-border px-3">
              <Search className="text-muted-foreground size-4 shrink-0" strokeWidth={1.5} aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActiveIndex(0)
                }}
                placeholder="Jump to server, deployment, datasource, JMS, logs..."
                className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle-foreground"
              />
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Close quick jump" onClick={() => setOpen(false)}>
                <X className="size-3.5" strokeWidth={1.5} />
              </Button>
            </div>

            <div className="max-h-[420px] overflow-auto py-2">
              {!hasLiveResources ? (
                <div className="text-muted-foreground border-b border-border px-3 pb-2 text-[12px] leading-4">
                  Live resource results appear after the dashboard snapshot is available.
                </div>
              ) : null}

              {results.length === 0 ? (
                <div className="text-muted-foreground px-3 py-6 text-center text-[13px]">No matching Cockpit route or resource.</div>
              ) : (
                <div className="grid gap-1 px-2">
                  {results.map((entry, index) => (
                    <button
                      key={entry.id}
                      type="button"
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => select(entry)}
                      className={cn(
                        'flex min-h-9 min-w-0 items-center justify-between gap-3 px-2 py-1 text-left text-[13px] outline-none',
                        index === boundedActiveIndex ? 'bg-accent/12 text-foreground' : 'text-muted-foreground hover:bg-white/4 hover:text-foreground',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-foreground">{entry.label}</span>
                        <span className="block truncate text-[12px] text-subtle-foreground">{entry.detail}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <MonoText className="text-[11px] text-subtle-foreground">{entry.family}</MonoText>
                        {index === boundedActiveIndex ? <CornerDownLeft className="size-3.5 text-muted-foreground" strokeWidth={1.5} /> : null}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
