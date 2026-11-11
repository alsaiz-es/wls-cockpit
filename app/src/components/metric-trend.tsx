import { Minus, TrendingDown, TrendingUp } from 'lucide-react'
import { type ReactNode } from 'react'
import type { AlertLevel } from '@/api/alert-rules'
import { cn } from '@/lib/utils'
import { alertTextClass } from './alert-tone'
import type { MetricHistorySample, MetricHistorySeries, MetricTrendDirection } from '@/api/queries/metric-history'

export interface MetricTrendProps {
  series: MetricHistorySeries
  value: ReactNode
  title?: string
  higherIsWorse?: boolean
  // Colours the value when this figure makes its resource warning or critical (§9.5).
  alertLevel?: AlertLevel | null
  // Narrower sparkline and no minimum width, for tables with several trend columns (§7.1).
  compact?: boolean
  className?: string
}

const SPARKLINE_WIDTH = 64
const SPARKLINE_COMPACT_WIDTH = 40
const SPARKLINE_HEIGHT = 18
const SPARKLINE_PADDING = 2

function trendClass(direction: MetricTrendDirection, higherIsWorse: boolean) {
  if (direction === 'flat' || direction === 'unknown') return 'text-muted-foreground'
  if (direction === 'up') return higherIsWorse ? 'text-status-warning' : 'text-status-positive'
  return higherIsWorse ? 'text-status-positive' : 'text-status-warning'
}

function TrendIcon({ direction }: { direction: MetricTrendDirection }) {
  if (direction === 'up') return <TrendingUp className="size-3" strokeWidth={1.5} aria-hidden />
  if (direction === 'down') return <TrendingDown className="size-3" strokeWidth={1.5} aria-hidden />
  return <Minus className="size-3" strokeWidth={1.5} aria-hidden />
}

function pointFor(sample: MetricHistorySample, index: number, samples: MetricHistorySample[], min: number, range: number, width: number) {
  const availableWidth = width - SPARKLINE_PADDING * 2
  const availableHeight = SPARKLINE_HEIGHT - SPARKLINE_PADDING * 2
  const x = samples.length <= 1
    ? SPARKLINE_PADDING
    : SPARKLINE_PADDING + (availableWidth * index) / (samples.length - 1)
  // A flat series sits at mid-height; at the bottom it reads as an underline.
  const y = range === 0
    ? SPARKLINE_PADDING + availableHeight / 2
    : SPARKLINE_PADDING + availableHeight - ((sample.value - min) / range) * availableHeight
  return `${x.toFixed(1)},${y.toFixed(1)}`
}

function sparklineSegments(samples: MetricHistorySample[]) {
  const segments: MetricHistorySample[][] = []

  samples.forEach((sample) => {
    if (segments.length === 0 || sample.gapBefore) {
      segments.push([sample])
      return
    }
    segments.at(-1)?.push(sample)
  })

  return segments
}

export function MetricSparkline({
  samples,
  width = SPARKLINE_WIDTH,
  className,
}: {
  samples: MetricHistorySample[]
  width?: number
  className?: string
}) {
  if (samples.length < 2) return null

  const values = samples.map((sample) => sample.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min
  const segments = sparklineSegments(samples)

  return (
    <svg
      width={width}
      height={SPARKLINE_HEIGHT}
      viewBox={`0 0 ${width} ${SPARKLINE_HEIGHT}`}
      className={cn('h-[18px] shrink-0 text-muted-foreground', className)}
      aria-hidden
    >
      {segments.map((segment, segmentIndex) => {
        if (segment.length < 2) return null
        const firstIndex = samples.indexOf(segment[0])
        const points = segment
          .map((sample, index) => pointFor(sample, firstIndex + index, samples, min, range, width))
          .join(' ')
        return (
          <polyline
            key={segmentIndex}
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )
      })}
    </svg>
  )
}

function trendTitle(series: MetricHistorySeries, fallback: string | undefined) {
  const sampleCount = series.samples.length
  const gap = series.hasGap ? ' · gap detected' : ''
  const delta =
    series.delta === null
      ? ''
      : ` · delta vs previous sample ${series.delta >= 0 ? '+' : ''}${series.delta.toLocaleString()}`
  return `${fallback ?? 'Metric trend'} · ${sampleCount} samples${delta}${gap}`
}

export function MetricTrend({
  series,
  value,
  title,
  higherIsWorse = true,
  alertLevel,
  compact = false,
  className,
}: MetricTrendProps) {
  const direction = series.samples.length < 2 ? 'unknown' : series.direction
  const tone = trendClass(direction, higherIsWorse)
  const sparklineWidth = compact ? SPARKLINE_COMPACT_WIDTH : SPARKLINE_WIDTH

  return (
    <span
      className={cn('inline-flex items-center justify-end gap-1.5 tabular-nums', !compact && 'min-w-[112px]', className)}
      title={trendTitle(series, title)}
    >
      <span className={cn('font-mono', alertTextClass(alertLevel))}>{value}</span>
      {series.samples.length >= 2 ? (
        <MetricSparkline samples={series.samples} width={sparklineWidth} />
      ) : (
        // Keeps the slot while a row has no history yet, so values line up down the column.
        <span className="h-[18px] shrink-0" style={{ width: sparklineWidth }} aria-hidden />
      )}
      <span className={cn('inline-flex w-3 justify-center', tone)}>
        <TrendIcon direction={direction} />
      </span>
    </span>
  )
}
