import { useEffect, useMemo, useReducer, useRef } from 'react'
import { wlsCredentialCacheKey, type WlsCredentials } from '../client.ts'

export const METRIC_HISTORY_RETENTION_MS = 60 * 60 * 1000
export const METRIC_HISTORY_MAX_SAMPLES = 720
export const METRIC_HISTORY_GAP_MS = 30 * 1000

export type MetricTrendDirection = 'up' | 'down' | 'flat' | 'unknown'

export interface MetricHistorySampleInput {
  family: string
  resourceId: string
  metric: string
  value: number | null | undefined
}

export interface MetricHistorySample {
  timestamp: number
  value: number
  gapBefore: boolean
}

export interface MetricHistorySeries {
  family: string
  resourceId: string
  metric: string
  samples: MetricHistorySample[]
  latest: number | null
  previous: number | null
  delta: number | null
  direction: MetricTrendDirection
  hasGap: boolean
}

export interface MetricHistoryOptions {
  retentionMs?: number
  maxSamples?: number
  gapMs?: number
}

interface MetricHistoryEntry {
  family: string
  resourceId: string
  metric: string
  samples: MetricHistorySample[]
}

const metricHistory = new Map<string, MetricHistoryEntry>()

function safePart(value: string) {
  return encodeURIComponent(value)
}

export function metricHistoryScopeKey(creds: WlsCredentials | null | undefined) {
  return creds ? wlsCredentialCacheKey(creds) : null
}

export function metricResourceId(...parts: Array<string | null | undefined>) {
  return parts.map((part) => safePart(part ?? '')).join('/')
}

export function serverMetricResourceId(serverName: string) {
  return metricResourceId('server', serverName)
}

export function jdbcMetricResourceId(serverName: string, poolName: string) {
  return metricResourceId('jdbc', serverName, poolName)
}

export function jmsMetricResourceId(
  serverName: string,
  jmsServerName: string,
  destinationName: string | null | undefined,
) {
  return metricResourceId('jms', serverName, jmsServerName, destinationName ?? '(server)')
}

function historyKey(scopeKey: string, family: string, resourceId: string, metric: string) {
  return [safePart(scopeKey), safePart(family), safePart(resourceId), safePart(metric)].join('|')
}

function emptySeries(family: string, resourceId: string, metric: string): MetricHistorySeries {
  return {
    family,
    resourceId,
    metric,
    samples: [],
    latest: null,
    previous: null,
    delta: null,
    direction: 'unknown',
    hasGap: false,
  }
}

function directionFor(delta: number | null): MetricTrendDirection {
  if (delta === null) return 'unknown'
  if (Math.abs(delta) < 0.000001) return 'flat'
  return delta > 0 ? 'up' : 'down'
}

function seriesFor(entry: MetricHistoryEntry | null | undefined): MetricHistorySeries {
  if (!entry) return emptySeries('', '', '')

  const samples = entry.samples.map((sample) => ({ ...sample }))
  const latest = samples.at(-1)?.value ?? null
  const previous = samples.length > 1 ? samples.at(-2)?.value ?? null : null
  const delta = latest === null || previous === null ? null : latest - previous

  return {
    family: entry.family,
    resourceId: entry.resourceId,
    metric: entry.metric,
    samples,
    latest,
    previous,
    delta,
    direction: directionFor(delta),
    hasGap: samples.some((sample) => sample.gapBefore),
  }
}

function normalizeOptions(options: MetricHistoryOptions | undefined) {
  return {
    retentionMs: options?.retentionMs ?? METRIC_HISTORY_RETENTION_MS,
    maxSamples: options?.maxSamples ?? METRIC_HISTORY_MAX_SAMPLES,
    gapMs: options?.gapMs ?? METRIC_HISTORY_GAP_MS,
  }
}

export function recordMetricSample(
  scopeKey: string | null | undefined,
  input: MetricHistorySampleInput,
  timestamp: number,
  options?: MetricHistoryOptions,
) {
  if (!scopeKey || !Number.isFinite(timestamp) || !Number.isFinite(input.value)) return false

  const { retentionMs, maxSamples, gapMs } = normalizeOptions(options)
  const key = historyKey(scopeKey, input.family, input.resourceId, input.metric)
  const entry = metricHistory.get(key) ?? {
    family: input.family,
    resourceId: input.resourceId,
    metric: input.metric,
    samples: [],
  }
  const cutoff = timestamp - retentionMs
  const samples = entry.samples.filter((sample) => sample.timestamp >= cutoff && sample.timestamp <= timestamp)
  const existing = samples.find((sample) => sample.timestamp === timestamp)

  if (existing) {
    if (existing.value === input.value) return false
    existing.value = input.value as number
    metricHistory.set(key, { ...entry, samples })
    return true
  }

  const previous = samples.at(-1)
  const gapBefore = previous ? timestamp - previous.timestamp > gapMs : false
  samples.push({ timestamp, value: input.value as number, gapBefore })

  while (samples.length > maxSamples) {
    samples.shift()
  }

  metricHistory.set(key, { ...entry, samples })
  return true
}

export function recordMetricSamples(
  scopeKey: string | null | undefined,
  samples: MetricHistorySampleInput[],
  timestamp: number,
  options?: MetricHistoryOptions,
) {
  return samples.reduce(
    (count, sample) => count + (recordMetricSample(scopeKey, sample, timestamp, options) ? 1 : 0),
    0,
  )
}

export function getMetricHistorySeries(
  scopeKey: string | null | undefined,
  family: string,
  resourceId: string,
  metric: string,
) {
  if (!scopeKey) return emptySeries(family, resourceId, metric)
  const key = historyKey(scopeKey, family, resourceId, metric)
  return seriesFor(metricHistory.get(key) ?? { family, resourceId, metric, samples: [] })
}

export function resetMetricHistory(scopeKey?: string) {
  if (!scopeKey) {
    metricHistory.clear()
    return
  }

  const prefix = `${safePart(scopeKey)}|`
  for (const key of metricHistory.keys()) {
    if (key.startsWith(prefix)) metricHistory.delete(key)
  }
}

export function resetMetricHistoryScopeOnChange(
  previousScopeKey: string | null | undefined,
  scopeKey: string | null,
) {
  if (previousScopeKey && previousScopeKey !== scopeKey) {
    resetMetricHistory(previousScopeKey)
  }
  return scopeKey
}

export function useMetricHistoryRecorder({
  creds,
  samples,
  timestamp,
  enabled = true,
}: {
  creds: WlsCredentials | null | undefined
  samples: MetricHistorySampleInput[]
  timestamp: number
  enabled?: boolean
}) {
  const scopeKey = useMemo(() => metricHistoryScopeKey(creds), [creds])
  const previousScopeRef = useRef<string | null>(null)
  const [, bumpRevision] = useReducer((value: number) => value + 1, 0)

  useEffect(() => {
    previousScopeRef.current = resetMetricHistoryScopeOnChange(previousScopeRef.current, scopeKey)
  }, [scopeKey])

  useEffect(() => {
    if (!enabled || !scopeKey || timestamp <= 0 || samples.length === 0) return
    const changed = recordMetricSamples(scopeKey, samples, timestamp)
    if (changed > 0) bumpRevision()
  }, [enabled, samples, scopeKey, timestamp])

  return { scopeKey }
}
