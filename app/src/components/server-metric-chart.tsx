import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import {
  DEFAULT_SERVER_METRIC_CHART_BOUNDS,
  buildServerMetricChartModel,
  relativeMetricTimeLabel,
  type ServerMetricChartPoint,
} from './server-metric-chart-model'
import { MonoText } from './mono-text'

export interface ServerMetricChartProps {
  title: string
  points: ServerMetricChartPoint[]
  unit?: string
  unavailableLabel?: string
  className?: string
  formatValue?: (value: number) => string
}

function defaultFormat(value: number, unit?: string) {
  const formatted = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)
  return unit ? `${formatted}${unit}` : formatted
}

export function ServerMetricChart({
  title,
  points,
  unit,
  unavailableLabel = 'Unavailable',
  className,
  formatValue = (value) => defaultFormat(value, unit),
}: ServerMetricChartProps) {
  const chartContainerRef = useRef<HTMLDivElement | null>(null)
  const chartSvgRef = useRef<SVGSVGElement | null>(null)
  const [chartWidth, setChartWidth] = useState(DEFAULT_SERVER_METRIC_CHART_BOUNDS.width)
  const chartBounds = useMemo(
    () => ({ ...DEFAULT_SERVER_METRIC_CHART_BOUNDS, width: chartWidth }),
    [chartWidth],
  )
  const model = useMemo(() => buildServerMetricChartModel(points, chartBounds), [chartBounds, points])
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const activePoint = hoverIndex === null ? model.points.at(-1) : model.points[hoverIndex]
  const hoveredPoint = hoverIndex === null ? null : model.points[hoverIndex]
  const endTimestamp = model.points.at(-1)?.timestamp ?? 0

  useEffect(() => {
    const element = chartContainerRef.current
    if (!element) return

    const updateWidth = (width: number) => {
      const minWidth = DEFAULT_SERVER_METRIC_CHART_BOUNDS.paddingX * 2 + 1
      const nextWidth = Math.max(minWidth, Math.round(width))
      setChartWidth((current) => (current === nextWidth ? current : nextWidth))
    }

    updateWidth(element.getBoundingClientRect().width)

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (typeof width === 'number') updateWidth(width)
    })
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (model.points.length === 0) return

    const rect = chartSvgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return

    const viewBoxX = ((event.clientX - rect.left) / rect.width) * chartBounds.width
    let nearestIndex = 0
    let nearestDistance = Math.abs(model.points[0].x - viewBoxX)

    for (let index = 1; index < model.points.length; index += 1) {
      const distance = Math.abs(model.points[index].x - viewBoxX)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearestIndex = index
      }
    }

    setHoverIndex((current) => (current === nearestIndex ? current : nearestIndex))
  }

  return (
    <div className={cn('border-border bg-surface-1 min-h-[220px] border px-3 py-3', className)}>
      <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[14px] font-medium leading-5" title={title}>{title}</h3>
          <div className="text-muted-foreground mt-1 text-[12px] leading-4">
            {model.state === 'empty' ? unavailableLabel : `${model.points.length.toLocaleString()} samples${model.hasGap ? ' · gap' : ''}`}
          </div>
        </div>
        <div className="text-right tabular-nums">
          <MonoText className="block text-[16px] leading-5">
            {model.latest === null ? '-' : formatValue(model.latest)}
          </MonoText>
          <MonoText className="text-muted-foreground block text-[12px] leading-4">
            {model.delta === null ? 'delta vs previous sample -' : `delta vs previous sample ${model.delta >= 0 ? '+' : ''}${formatValue(model.delta)}`}
          </MonoText>
        </div>
      </div>

      <div className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2">
        <div className="text-muted-foreground flex h-[132px] min-w-12 flex-col justify-between text-right text-[11px] leading-[14px] tabular-nums">
          <span>{model.max === null ? '' : formatValue(model.max)}</span>
          <span>{model.min === null ? '' : formatValue(model.min)}</span>
        </div>
        <div ref={chartContainerRef} className="min-w-0">
          {model.state === 'empty' ? (
            <div className="border-border bg-background flex h-[132px] items-center justify-center border text-[13px] text-muted-foreground">
              {unavailableLabel}
            </div>
          ) : (
            <div className="relative">
              <svg
                ref={chartSvgRef}
                viewBox={`0 0 ${chartBounds.width} ${chartBounds.height}`}
                className="h-[132px] w-full text-accent"
                role="img"
                aria-label={`${title} time series`}
                tabIndex={0}
                onPointerMove={handlePointerMove}
                onPointerLeave={() => setHoverIndex(null)}
                onFocus={() => setHoverIndex(model.points.length - 1)}
                onBlur={() => setHoverIndex(null)}
              >
                <title>{`${title} time series`}</title>
                <line
                  x1={chartBounds.paddingX}
                  x2={chartBounds.width - chartBounds.paddingX}
                  y1={chartBounds.height - chartBounds.paddingY}
                  y2={chartBounds.height - chartBounds.paddingY}
                  stroke="currentColor"
                  strokeOpacity="0.18"
                />
                {model.segments.map((segment, index) => (
                  <path
                    key={index}
                    d={segment.path}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {hoveredPoint ? (
                  <line
                    x1={hoveredPoint.x}
                    x2={hoveredPoint.x}
                    y1={chartBounds.paddingY}
                    y2={chartBounds.height - chartBounds.paddingY}
                    stroke="currentColor"
                    strokeOpacity="0.28"
                    strokeDasharray="3 3"
                  />
                ) : null}
                {model.points.map((point, index) => (
                  <circle
                    key={`${point.timestamp}-${index}`}
                    cx={point.x}
                    cy={point.y}
                    r={index === hoverIndex ? 3.4 : model.state === 'single' ? 3 : 1.8}
                    fill="currentColor"
                    opacity={index === hoverIndex || index === model.points.length - 1 ? 1 : 0.42}
                  />
                ))}
              </svg>
              {hoveredPoint ? (
                <div
                  className="border-border bg-background pointer-events-none absolute z-10 border px-2 py-1 text-[12px] leading-4 shadow-sm"
                  style={{
                    left: `${(hoveredPoint.x / chartBounds.width) * 100}%`,
                    top: `${Math.max(4, Math.min(chartBounds.height - 44, hoveredPoint.y - 22))}px`,
                    transform: hoveredPoint.x > chartBounds.width * 0.68 ? 'translateX(-100%)' : 'translateX(8px)',
                  }}
                >
                  <MonoText className="block">{new Date(hoveredPoint.timestamp).toLocaleTimeString()}</MonoText>
                  <MonoText className="block">{formatValue(hoveredPoint.value)}</MonoText>
                  {hoveredPoint.gapBefore ? (
                    <span className="text-muted-foreground">gap before sample</span>
                  ) : null}
                </div>
              ) : null}
              <div className="text-muted-foreground mt-1 flex items-center justify-between text-[11px] leading-[14px]">
                <span>{relativeMetricTimeLabel(model.points[0]?.timestamp ?? endTimestamp, endTimestamp)}</span>
                <span>now</span>
              </div>
              {activePoint ? (
                <div className="border-border bg-background mt-2 flex items-center justify-between gap-3 border px-2 py-1 text-[12px] leading-4">
                  <MonoText>{new Date(activePoint.timestamp).toLocaleTimeString()}</MonoText>
                  <MonoText>{formatValue(activePoint.value)}</MonoText>
                  {activePoint.gapBefore ? (
                    <span className="text-muted-foreground">gap before sample</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
