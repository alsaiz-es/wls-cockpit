import type { ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { MonoText, type StatusTone } from '@/components'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function Section({
  title,
  detail,
  children,
  className,
}: {
  title: string
  detail?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('min-w-0 rounded-lg border border-border bg-surface-1 p-4', className)}>
      <div className="mb-3 flex min-h-6 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-semibold leading-5">{title}</h2>
          {detail ? <p className="text-muted-foreground mt-0.5 truncate text-xs">{detail}</p> : null}
        </div>
      </div>
      {children}
    </section>
  )
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: StatusTone }) {
  return (
    <div className="min-w-0 border-r border-border px-3 last:border-r-0 first:pl-0 last:pr-0">
      <div className="text-muted-foreground truncate text-[11px] uppercase leading-[14px] tracking-[0.04em]">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 truncate font-mono text-[18px] font-semibold leading-6 tabular-nums',
          tone === 'positive' && 'text-status-positive',
          tone === 'warning' && 'text-status-warning',
          tone === 'negative' && 'text-status-negative',
          tone === 'neutral' && 'text-status-neutral',
          tone === 'unknown' && 'text-status-unknown',
        )}
      >
        {value}
      </div>
    </div>
  )
}

export function CompactMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: StatusTone
}) {
  return (
    <div className="min-w-[116px] border-l border-border pl-3 first:border-l-0 first:pl-0">
      <div className="text-muted-foreground truncate text-[11px] uppercase leading-[14px] tracking-[0.04em]">
        {label}
      </div>
      <div
        className={cn(
          'mt-0.5 truncate font-mono text-[16px] font-semibold leading-5 tabular-nums',
          tone === 'positive' && 'text-status-positive',
          tone === 'warning' && 'text-status-warning',
          tone === 'negative' && 'text-status-negative',
          tone === 'neutral' && 'text-status-neutral',
          tone === 'unknown' && 'text-status-unknown',
        )}
      >
        {value}
      </div>
      {detail ? <div className="text-muted-foreground mt-0.5 truncate text-xs">{detail}</div> : null}
    </div>
  )
}

export function Banner({
  tone,
  children,
  onRetry,
}: {
  tone: 'negative' | 'warning'
  children: ReactNode
  onRetry?: () => void
}) {
  return (
    <div
      className={cn(
        'mb-4 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]',
        tone === 'negative' && 'border-status-negative/60 bg-status-negative/8',
        tone === 'warning' && 'border-status-warning/60 bg-status-warning/8',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AlertTriangle
          className={cn('size-3.5 shrink-0', tone === 'negative' ? 'text-status-negative' : 'text-status-warning')}
          strokeWidth={1.5}
        />
        <div className="min-w-0">{children}</div>
      </div>
      {onRetry ? (
        <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  )
}

export function Unavailable({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex h-24 items-center justify-center border-y border-border text-center">
      {message}
    </div>
  )
}

export function CompactStatusLine({
  label,
  value = 'OK',
  tone = 'positive',
}: {
  label: string
  value?: ReactNode
  tone?: StatusTone
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 border-y border-border py-2">
      <span className="text-muted-foreground min-w-0 truncate">{label}</span>
      <MonoText
        className={cn(
          'shrink-0 text-xs uppercase tracking-[0.05em]',
          tone === 'positive' && 'text-status-positive',
          tone === 'warning' && 'text-status-warning',
          tone === 'negative' && 'text-status-negative',
          tone === 'neutral' && 'text-status-neutral',
          tone === 'unknown' && 'text-status-unknown',
        )}
      >
        {value}
      </MonoText>
    </div>
  )
}

export function LoadingBlock({ heightClass = 'h-48' }: { heightClass?: string }) {
  return (
    <div className={cn('text-muted-foreground flex items-center justify-center border-y border-border', heightClass)}>
      <span className="inline-flex items-center gap-2">
        <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
        Loading...
      </span>
    </div>
  )
}

export function MissingValue({ children = '-' }: { children?: ReactNode }) {
  return <MonoText className="text-status-neutral">{children}</MonoText>
}
