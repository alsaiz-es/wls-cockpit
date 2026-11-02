import { type ReactNode } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { RelativeTime } from './relative-time'

export interface PageHeaderProps {
  title: string
  subtitle?: string
  action?: ReactNode
  meta?: ReactNode
  // Freshness of the page data: "Updated …", a spinner while a refetch runs, and Refresh. They sit
  // at the right end of the meta row, so every page shows them in the same place (§4, §9.1).
  updatedAt?: Date | number | null
  refreshing?: boolean
  onRefresh?: () => void
  className?: string
}

export function PageHeader({
  title,
  subtitle,
  action,
  meta,
  updatedAt,
  refreshing = false,
  onRefresh,
  className,
}: PageHeaderProps) {
  const showStatus = updatedAt !== undefined || !!onRefresh
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
      {meta || showStatus ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{meta}</div>
          {showStatus ? (
            <div className="flex shrink-0 items-center gap-2" data-page-freshness>
              {updatedAt !== undefined ? (
                <span className="text-muted-foreground flex items-center gap-1 text-[13px] leading-[18px]">
                  Updated <RelativeTime value={updatedAt} className="font-sans" />
                </span>
              ) : null}
              <span className="flex w-3.5 items-center" aria-live="polite">
                {refreshing ? (
                  <Loader2 className="text-muted-foreground size-3.5 animate-spin" strokeWidth={1.5} aria-label="Refreshing" />
                ) : null}
              </span>
              {onRefresh ? (
                <Button type="button" variant="ghost" size="sm" onClick={onRefresh}>
                  <RefreshCw className="size-3.5" strokeWidth={1.5} />
                  Refresh
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </header>
  )
}
