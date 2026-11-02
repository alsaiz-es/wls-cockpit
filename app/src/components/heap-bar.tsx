import type { MetricHistorySeries } from '@/api/queries/metric-history'
import {
  heapSegments,
  heapThresholdMarks,
  heapUtilizationLabel,
  type HeapTone,
  type HeapUsage,
} from '@/api/queries/heap-utilization'
import { cn } from '@/lib/utils'
import { MetricSparkline } from './metric-trend'
import { MonoText } from './mono-text'

export interface HeapBarProps {
  value?: number | null
  max?: number | null
  committed?: number | null
  heap?: HeapUsage | null
  variant?: 'compact' | 'detail'
  series?: MetricHistorySeries
  className?: string
}

const toneClasses: Record<HeapTone, { text: string; fill: string; fillSoft: string }> = {
  positive: {
    text: 'text-status-positive',
    fill: 'bg-status-positive',
    fillSoft: 'bg-status-positive/35',
  },
  warning: {
    text: 'text-status-warning',
    fill: 'bg-status-warning',
    fillSoft: 'bg-status-warning/35',
  },
  negative: {
    text: 'text-status-negative',
    fill: 'bg-status-negative',
    fillSoft: 'bg-status-negative/35',
  },
  neutral: {
    text: 'text-status-neutral',
    fill: 'bg-status-neutral',
    fillSoft: 'bg-status-neutral/35',
  },
}

function heapFromProps({ heap, value, max, committed }: HeapBarProps): HeapUsage | null {
  if (heap !== undefined) return heap
  if (value === null || value === undefined || max === null || max === undefined) return null
  return { current: value, committed: committed ?? value, max }
}

function formatBytes(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${scaled >= 10 || unit === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unit]}`
}

function HeapMeter({ heap, size }: { heap: HeapUsage; size: 'compact' | 'detail' }) {
  const segments = heapSegments(heap)
  if (!segments) return null

  const tone = toneClasses[segments.tone]
  const height = size === 'detail' ? 'h-3' : 'h-2'

  return (
    <span
      className={cn(
        'relative block overflow-hidden rounded-[3px] bg-border-strong/45 ring-1 ring-border/80',
        height,
        size === 'detail' ? 'w-full' : 'w-20',
      )}
      data-heap-meter
      aria-hidden
    >
      {heapThresholdMarks().map((mark, index) => (
        <span
          key={mark}
          className={cn('absolute inset-y-0 z-10 w-px', index === 0 ? 'bg-foreground/45' : 'bg-foreground/55')}
          style={{ left: `${mark}%` }}
          data-heap-marker={mark}
        />
      ))}
      <span
        className={cn('absolute inset-y-0 left-0', tone.fill)}
        style={{ width: `${segments.usedPercent}%` }}
        data-heap-segment="used"
      />
      {segments.committedUnusedPercent > 0 ? (
        <span
          className={cn('absolute inset-y-0', tone.fillSoft)}
          style={{ left: `${segments.usedPercent}%`, width: `${segments.committedUnusedPercent}%` }}
          data-heap-segment="committed-unused"
        />
      ) : null}
    </span>
  )
}

function Unavailable({ className }: { className?: string }) {
  return <span className={cn('text-status-neutral', className)}>–</span>
}

function HeapLabels({ heap }: { heap: HeapUsage }) {
  const segments = heapSegments(heap)
  if (!segments) return null

  return (
    <div className="text-muted-foreground grid gap-2 text-[13px] md:grid-cols-3">
      <div>
        <span className="text-foreground">Used </span>
        <MonoText>{formatBytes(segments.used)}</MonoText>
      </div>
      <div>
        <span className="text-foreground">Committed </span>
        <MonoText>{formatBytes(segments.committed)}</MonoText>
      </div>
      <div>
        <span className="text-foreground">Max </span>
        <MonoText>{formatBytes(segments.max)}</MonoText>
      </div>
    </div>
  )
}

export function HeapBar(props: HeapBarProps) {
  const heap = heapFromProps(props)
  const segments = heapSegments(heap)
  if (!heap || !segments) return <Unavailable className={props.className} />

  const tone = toneClasses[segments.tone]
  const label = heapUtilizationLabel(heap)

  if (props.variant === 'detail') {
    return (
      <div className={cn('space-y-3', props.className)}>
        <div className="flex items-center gap-3">
          <HeapMeter heap={heap} size="detail" />
          <MonoText className={cn('w-12 shrink-0 text-right text-[13px] leading-[18px]', tone.text)}>{label}</MonoText>
        </div>
        {props.series && props.series.samples.length >= 2 ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <MetricSparkline samples={props.series.samples} className="h-[22px] w-full max-w-none flex-1" />
            <MonoText className="shrink-0 text-[12px] leading-[16px]">1h</MonoText>
          </div>
        ) : null}
        <HeapLabels heap={heap} />
      </div>
    )
  }

  return (
    <span className={cn('inline-flex items-center justify-end gap-1.5 tabular-nums', props.className)}>
      <HeapMeter heap={heap} size="compact" />
      <MonoText className={cn('inline-block w-10 text-right text-xs leading-[14px]', tone.text)}>{label}</MonoText>
    </span>
  )
}
