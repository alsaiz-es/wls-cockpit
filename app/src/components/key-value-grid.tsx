import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface KeyValueItem {
  label: string
  value: ReactNode
  // Identifiers (server, target, path, version) are monospace; states and prose are not (§5).
  mono?: boolean
  // Full value for the tooltip when the cell truncates.
  title?: string
}

export interface KeyValueGridProps {
  items: KeyValueItem[]
  columns?: 2 | 3 | 4
  className?: string
}

const COLUMN_CLASSES: Record<NonNullable<KeyValueGridProps['columns']>, string> = {
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-2 xl:grid-cols-3',
  4: 'md:grid-cols-2 xl:grid-cols-4',
}

// Detail-page facts as label–value rows (§7.9): one 32 px row each instead of a tile each.
export function KeyValueGrid({ items, columns = 3, className }: KeyValueGridProps) {
  return (
    <dl className={cn('grid grid-cols-1 gap-x-8', COLUMN_CLASSES[columns], className)}>
      {items.map((item) => (
        <div key={item.label} className="flex h-8 min-w-0 items-center justify-between gap-3 border-b border-border">
          <dt className="text-muted-foreground shrink-0 text-[11px] uppercase leading-[14px] tracking-[0.04em]">
            {item.label}
          </dt>
          <dd
            className={cn('min-w-0 truncate text-right text-[13px] leading-[18px]', item.mono && 'font-mono')}
            title={item.title ?? (typeof item.value === 'string' ? item.value : undefined)}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
