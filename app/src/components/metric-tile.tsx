import type { AlertLevel } from '@/api/alert-rules'
import { cn } from '@/lib/utils'
import { alertTextClass } from './alert-tone'
import { MonoText } from './mono-text'

export interface MetricTileProps {
  label: string
  value: string
  detail?: string
  // The level this figure contributes to its resource's warning or critical status (§9.5).
  alertLevel?: AlertLevel | null
}

// One figure on a detail page. A figure that makes its resource warning or critical takes that
// colour, so the reason for the status badge is visible at a glance.
export function MetricTile({ label, value, detail, alertLevel }: MetricTileProps) {
  return (
    <div
      className={cn(
        'bg-surface-1 min-h-[72px] border px-3 py-2',
        alertLevel === 'critical' ? 'border-status-negative/60' : alertLevel === 'warning' ? 'border-status-warning/60' : 'border-border',
      )}
      data-alert-level={alertLevel ?? undefined}
    >
      <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">{label}</div>
      <MonoText className={cn('mt-2 block truncate text-[18px] leading-6', alertTextClass(alertLevel))} title={value}>
        {value}
      </MonoText>
      {detail ? <div className={cn('mt-1 truncate text-xs', alertTextClass(alertLevel) ?? 'text-muted-foreground')}>{detail}</div> : null}
    </div>
  )
}
