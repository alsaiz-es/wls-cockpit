export interface ServerMetricChartPoint {
  timestamp: number
  value: number
  gapBefore: boolean
}

export interface ServerMetricChartBounds {
  width: number
  height: number
  paddingX: number
  paddingY: number
}

export interface ServerMetricChartSegment {
  path: string
  indexes: number[]
}

export interface ServerMetricChartModel {
  state: 'empty' | 'single' | 'series'
  points: Array<ServerMetricChartPoint & { x: number; y: number }>
  segments: ServerMetricChartSegment[]
  min: number | null
  max: number | null
  latest: number | null
  previous: number | null
  delta: number | null
  hasGap: boolean
}

export const DEFAULT_SERVER_METRIC_CHART_BOUNDS: ServerMetricChartBounds = {
  width: 360,
  height: 132,
  paddingX: 28,
  paddingY: 14,
}

function finitePoints(points: ServerMetricChartPoint[]) {
  return points
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value))
    .sort((a, b) => a.timestamp - b.timestamp)
}

function coordinateFor(
  point: ServerMetricChartPoint,
  index: number,
  points: ServerMetricChartPoint[],
  min: number,
  max: number,
  bounds: ServerMetricChartBounds,
) {
  const plotWidth = bounds.width - bounds.paddingX * 2
  const plotHeight = bounds.height - bounds.paddingY * 2
  const firstTimestamp = points[0]?.timestamp ?? point.timestamp
  const lastTimestamp = points.at(-1)?.timestamp ?? point.timestamp
  const timeRange = lastTimestamp - firstTimestamp
  const valueRange = max - min
  const xRatio = timeRange > 0 ? (point.timestamp - firstTimestamp) / timeRange : index / Math.max(1, points.length - 1)
  const yRatio = valueRange > 0 ? (point.value - min) / valueRange : 0.5

  return {
    x: bounds.paddingX + plotWidth * xRatio,
    y: bounds.paddingY + plotHeight - plotHeight * yRatio,
  }
}

function pathFor(points: Array<{ x: number; y: number }>) {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ')
}

export function buildServerMetricChartModel(
  inputPoints: ServerMetricChartPoint[],
  bounds = DEFAULT_SERVER_METRIC_CHART_BOUNDS,
): ServerMetricChartModel {
  const samples = finitePoints(inputPoints)
  if (samples.length === 0) {
    return {
      state: 'empty',
      points: [],
      segments: [],
      min: null,
      max: null,
      latest: null,
      previous: null,
      delta: null,
      hasGap: false,
    }
  }

  const values = samples.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const plotted = samples.map((point, index) => ({
    ...point,
    ...coordinateFor(point, index, samples, min, max, bounds),
  }))
  const segmentBuckets: Array<Array<(typeof plotted)[number] & { originalIndex: number }>> = []

  plotted.forEach((point, index) => {
    if (segmentBuckets.length === 0 || point.gapBefore) {
      segmentBuckets.push([{ ...point, originalIndex: index }])
      return
    }
    segmentBuckets.at(-1)?.push({ ...point, originalIndex: index })
  })

  const segments = segmentBuckets
    .filter((segment) => segment.length >= 2)
    .map((segment) => ({
      path: pathFor(segment),
      indexes: segment.map((point) => point.originalIndex),
    }))

  const latest = values.at(-1) ?? null
  const previous = values.length >= 2 ? values.at(-2) ?? null : null

  return {
    state: samples.length === 1 ? 'single' : 'series',
    points: plotted,
    segments,
    min,
    max,
    latest,
    previous,
    delta: latest !== null && previous !== null ? latest - previous : null,
    hasGap: samples.some((point) => point.gapBefore),
  }
}

export function relativeMetricTimeLabel(timestamp: number, endTimestamp: number) {
  const deltaSeconds = Math.max(0, Math.round((endTimestamp - timestamp) / 1000))
  if (deltaSeconds < 60) return deltaSeconds === 0 ? 'now' : `-${deltaSeconds}s`
  const deltaMinutes = Math.round(deltaSeconds / 60)
  if (deltaMinutes < 60) return `-${deltaMinutes}m`
  return `-${Math.round(deltaMinutes / 60)}h`
}
