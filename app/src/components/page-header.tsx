import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface PageHeaderProps {
  title: string
  subtitle?: string
  action?: ReactNode
  meta?: ReactNode
  className?: string
}

export function PageHeader({ title, subtitle, action, meta, className }: PageHeaderProps) {
  return (
    <header className={cn('mb-4 space-y-3', className)}>
      <div className="flex min-h-8 items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-[18px] font-semibold leading-6">{title}</h1>
          {subtitle ? (
            <p className="text-muted-foreground mt-0.5 truncate text-[13px] leading-[18px]">{subtitle}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {meta ? <div className="flex items-center justify-between gap-3">{meta}</div> : null}
    </header>
  )
}
