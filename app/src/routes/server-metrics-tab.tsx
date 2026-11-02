import { Download, Play, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WlsCredentials } from '@/api/client'
import {
  serverMetricCaptureCsv,
  serverMetricCaptureFilename,
  serverMetricCaptureJson,
} from '@/api/queries/server-metric-capture-export'
import {
  clearServerMetricCapture,
  SERVER_METRIC_CAPTURE_CADENCES_MS,
  serverMetricCaptureScopeKey,
  startServerMetricCapture,
  stopServerMetricCapture,
  updateServerMetricCaptureCadence,
  updateServerMetricCaptureHiddenPolling,
  useServerMetricCaptureSnapshot,
  type ServerMetricCapturedPoint,
  type ServerMetricCaptureCadenceMs,
  type ServerMetricCaptureSession,
} from '@/api/queries/server-metric-capture-store'
import { serverMetricResourceId } from '@/api/queries/metric-history'
import { ServerMetricChart } from '@/components/server-metric-chart'
import {
  buildServerMetricChartModel,
  type ServerMetricChartPoint,
} from '@/components/server-metric-chart-model'
import { Button } from '@/components/ui/button'
import { MonoText, StatusBadge } from '@/components'
import { serverMetricCaptureVisualFixture, type ServerMetricCaptureFixtureName } from './server-metrics-fixtures'

interface ServerMetricsTabProps {
  serverName: string
  creds: WlsCredentials | null
  fixtureName?: ServerMetricCaptureFixtureName | null
}

interface MetricPointIndex {
  latest: Map<string, number>
  points: Map<string, ServerMetricChartPoint[]>
}

const MINI_CHART_BOUNDS = { width: 96, height: 24, paddingX: 2, paddingY: 2 }

function formatBytes(value: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${scaled >= 10 || unit === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unit]}`
}

function formatNumber(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? '-' : value.toLocaleString()
}

function formatPercent(value: number) {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [enabled])

  return now
}

function pointKey(resourceId: string, metric: string) {
  return `${resourceId}\u0000${metric}`
}

function buildMetricPointIndex(samples: ServerMetricCapturedPoint[]): MetricPointIndex {
  const points = new Map<string, ServerMetricChartPoint[]>()
  const latest = new Map<string, number>()

  samples.forEach((sample) => {
    const key = pointKey(sample.resourceId, sample.metric)
    const series = points.get(key) ?? []
    series.push({
      timestamp: sample.timestamp,
      value: sample.value,
      gapBefore: sample.gapBefore,
    })
    points.set(key, series)
    latest.set(key, sample.value)
  })

  return { latest, points }
}

function metricPoints(index: MetricPointIndex, resourceId: string, metric: string) {
  return index.points.get(pointKey(resourceId, metric)) ?? []
}

function latestMetric(index: MetricPointIndex, resourceId: string, metric: string) {
  return index.latest.get(pointKey(resourceId, metric)) ?? null
}

function downloadTextFile(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type })
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(href)
}

function MiniSparkline({
  primary,
  secondary,
}: {
  primary: ServerMetricChartPoint[]
  secondary?: ServerMetricChartPoint[]
}) {
  const primaryModel = useMemo(() => buildServerMetricChartModel(primary, MINI_CHART_BOUNDS), [primary])
  const secondaryModel = useMemo(
    () => buildServerMetricChartModel(secondary ?? [], MINI_CHART_BOUNDS),
    [secondary],
  )

  if (primaryModel.state === 'empty' && secondaryModel.state === 'empty') {
    return <span className="text-muted-foreground inline-block w-24 text-right text-[12px]">no samples</span>
  }

  return (
    <svg width="96" height="24" viewBox="0 0 96 24" className="h-6 w-24 text-accent" aria-hidden>
      {primaryModel.segments.map((segment, index) => (
        <path key={`p-${index}`} d={segment.path} fill="none" stroke="currentColor" strokeWidth="1.6" />
      ))}
      {secondaryModel.segments.map((segment, index) => (
        <path key={`s-${index}`} d={segment.path} fill="none" stroke="currentColor" strokeWidth="1.4" className="text-status-warning" />
      ))}
    </svg>
  )
}

function CaptureControls({
  session,
  scopeKey,
  serverName,
  creds,
  cadence,
  setCadence,
  pollWhileHidden,
  setPollWhileHidden,
  includeRawTarget,
  setIncludeRawTarget,
}: {
  session: ServerMetricCaptureSession | null
  scopeKey: string | null
  serverName: string
  creds: WlsCredentials | null
  cadence: ServerMetricCaptureCadenceMs
  setCadence: (cadence: ServerMetricCaptureCadenceMs) => void
  pollWhileHidden: boolean
  setPollWhileHidden: (pollWhileHidden: boolean) => void
  includeRawTarget: boolean
  setIncludeRawTarget: (includeRawTarget: boolean) => void
}) {
  const now = useNow(session?.status === 'active')
  const elapsed = session
    ? (session.status === 'active' ? now : session.stoppedAt ?? now) - session.startedAt
    : 0
  const canExport = !!session && session.pointCount > 0 && !!creds

  const start = useCallback(() => {
    if (!scopeKey) return
    startServerMetricCapture(scopeKey, serverName, cadence, Date.now(), { pollWhileHidden })
  }, [cadence, pollWhileHidden, scopeKey, serverName])

  const stop = useCallback(() => {
    if (!scopeKey) return
    stopServerMetricCapture(scopeKey, serverName, Date.now())
  }, [scopeKey, serverName])

  const clear = useCallback(() => {
    if (!scopeKey) return
    clearServerMetricCapture(scopeKey, serverName)
  }, [scopeKey, serverName])

  const exportCsv = useCallback(() => {
    if (!session || !creds) return
    downloadTextFile(
      serverMetricCaptureFilename(session, 'csv'),
      serverMetricCaptureCsv(session, creds, includeRawTarget),
      'text/csv;charset=utf-8',
    )
  }, [creds, includeRawTarget, session])

  const exportJson = useCallback(() => {
    if (!session || !creds) return
    downloadTextFile(
      serverMetricCaptureFilename(session, 'json'),
      `${JSON.stringify(serverMetricCaptureJson(session, creds, includeRawTarget), null, 2)}\n`,
      'application/json;charset=utf-8',
    )
  }, [creds, includeRawTarget, session])

  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-medium leading-5">Metric Capture</h2>
          <p className="text-muted-foreground text-[13px] leading-[18px]">
            In-memory capture for this server; background polling is opt-in.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Capture cadence"
            className="h-8 border border-border bg-background px-2 text-[13px]"
            value={session?.status === 'active' ? session.pollingIntervalMs : cadence}
            disabled={!scopeKey}
            onChange={(event) => {
              const next = Number(event.target.value) as ServerMetricCaptureCadenceMs
              setCadence(next)
              if (scopeKey && session?.status === 'active') {
                updateServerMetricCaptureCadence(scopeKey, serverName, next)
              }
            }}
          >
            {SERVER_METRIC_CAPTURE_CADENCES_MS.map((value) => (
              <option key={value} value={value}>{value / 1000}s</option>
            ))}
          </select>
          {session?.status === 'active' ? (
            <Button type="button" size="sm" variant="secondary" onClick={stop}>
              <Square className="size-3.5" strokeWidth={1.5} />
              Stop
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={!scopeKey} onClick={start}>
              <Play className="size-3.5" strokeWidth={1.5} />
              Start
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" disabled={!session} onClick={clear}>
            <Trash2 className="size-3.5" strokeWidth={1.5} />
            Clear
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={!canExport} onClick={exportCsv}>
            <Download className="size-3.5" strokeWidth={1.5} />
            CSV
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={!canExport} onClick={exportJson}>
            <Download className="size-3.5" strokeWidth={1.5} />
            JSON
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-5">
        <MetricStat label="Status" value={session?.status ?? 'idle'} />
        <MetricStat label="Elapsed" value={session ? formatDuration(elapsed) : '-'} />
        <MetricStat label="Samples" value={session?.sampleCount.toLocaleString() ?? '0'} />
        <MetricStat label="Points" value={session?.pointCount.toLocaleString() ?? '0'} />
        <MetricStat label="Gaps" value={session?.gapCount.toLocaleString() ?? '0'} />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        <label className="text-muted-foreground inline-flex items-center gap-2 text-[12px] leading-4">
          <input
            type="checkbox"
            checked={session?.status === 'active' ? session.pollWhileHidden : pollWhileHidden}
            disabled={!scopeKey}
            onChange={(event) => {
              const next = event.target.checked
              setPollWhileHidden(next)
              if (scopeKey && session?.status === 'active') {
                updateServerMetricCaptureHiddenPolling(scopeKey, serverName, next)
              }
            }}
          />
          Keep polling while tab is hidden
        </label>
        <label className="text-muted-foreground inline-flex items-center gap-2 text-[12px] leading-4">
        <input
          type="checkbox"
          checked={includeRawTarget}
          onChange={(event) => setIncludeRawTarget(event.target.checked)}
        />
        Include raw target URL in export metadata
        </label>
      </div>
    </section>
  )
}

function MetricStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border bg-background min-h-[58px] border px-3 py-2">
      <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">{label}</div>
      <MonoText className="mt-1 block truncate text-[16px] leading-5">{value}</MonoText>
    </div>
  )
}

function ResourceRows({
  title,
  family,
  session,
  index,
}: {
  title: string
  family: 'jdbc' | 'jms'
  session: ServerMetricCaptureSession | null
  index: MetricPointIndex
}) {
  const resources = Object.values(session?.resources ?? {})
    .filter((resource) => resource.family === family)
    .sort((a, b) => {
      const metric = family === 'jdbc' ? 'connections.waiting' : 'messages.pending'
      return (latestMetric(index, b.resourceId, metric) ?? 0) - (latestMetric(index, a.resourceId, metric) ?? 0)
    })
  const omitted = session?.omitted[family] ?? 0

  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-medium leading-5">{title}</h2>
        {omitted > 0 ? <MonoText className="text-muted-foreground text-[12px]">{omitted} omitted</MonoText> : null}
      </div>
      {resources.length === 0 ? (
        <div className="border-border bg-background px-3 py-3 text-[13px] text-muted-foreground">
          No captured {family.toUpperCase()} resources for this server.
        </div>
      ) : (
        <div className="overflow-x-auto border border-border bg-background">
          <table className="min-w-full border-collapse text-left text-[13px] leading-[18px]">
            <thead className="text-muted-foreground border-b border-border text-[11px] uppercase leading-[14px] tracking-[0.04em]">
              <tr>
                <th className="px-3 py-2 font-medium">Resource</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 text-right font-medium">{family === 'jdbc' ? 'Active' : 'Current'}</th>
                <th className="px-3 py-2 text-right font-medium">{family === 'jdbc' ? 'Waiting' : 'Pending'}</th>
                <th className="px-3 py-2 text-right font-medium">{family === 'jdbc' ? 'Leaked' : 'Consumers'}</th>
                <th className="px-3 py-2 text-right font-medium">Trend</th>
              </tr>
            </thead>
            <tbody>
              {resources.map((resource) => {
                const primaryMetric = family === 'jdbc' ? 'connections.active' : 'messages.current'
                const secondaryMetric = family === 'jdbc' ? 'connections.waiting' : 'messages.pending'
                const thirdMetric = family === 'jdbc' ? 'connections.leaked' : 'consumers.current'
                return (
                  <tr key={resource.resourceId} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">
                      <MonoText className="block max-w-[320px] truncate" title={resource.resourceLabel}>
                        {resource.resourceLabel}
                      </MonoText>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge kind="custom" tone={resource.severity === 'critical' ? 'negative' : resource.severity === 'warning' ? 'warning' : 'neutral'} label={resource.state ?? '-'} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{formatNumber(latestMetric(index, resource.resourceId, primaryMetric))}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{formatNumber(latestMetric(index, resource.resourceId, secondaryMetric))}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{formatNumber(latestMetric(index, resource.resourceId, thirdMetric))}</td>
                    <td className="px-3 py-2 text-right">
                      <MiniSparkline
                        primary={metricPoints(index, resource.resourceId, primaryMetric)}
                        secondary={metricPoints(index, resource.resourceId, secondaryMetric)}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function ServerMetricsTab({ serverName, creds, fixtureName = null }: ServerMetricsTabProps) {
  const scopeKey = serverMetricCaptureScopeKey(creds)
  const state = useServerMetricCaptureSnapshot()
  const fixtureSession = useMemo(
    () => (import.meta.env.DEV && scopeKey && fixtureName
      ? serverMetricCaptureVisualFixture(fixtureName, scopeKey, serverName)
      : null),
    [fixtureName, scopeKey, serverName],
  )
  const session = fixtureSession ?? (scopeKey && state.scopeKey === scopeKey ? state.sessions[serverName] ?? null : null)
  const serverResourceId = serverMetricResourceId(serverName)
  const [cadence, setCadence] = useState<ServerMetricCaptureCadenceMs>(10_000)
  const [pollWhileHidden, setPollWhileHidden] = useState(false)
  const [includeRawTarget, setIncludeRawTarget] = useState(false)
  const index = useMemo(() => buildMetricPointIndex(session?.samples ?? []), [session?.samples])

  const chart = useCallback(
    (metric: string): ServerMetricChartPoint[] => metricPoints(index, serverResourceId, metric),
    [index, serverResourceId],
  )

  return (
    <div className="space-y-4">
      <CaptureControls
        session={session}
        scopeKey={scopeKey}
        serverName={serverName}
        creds={creds}
        cadence={cadence}
        setCadence={setCadence}
        pollWhileHidden={pollWhileHidden}
        setPollWhileHidden={setPollWhileHidden}
        includeRawTarget={includeRawTarget}
        setIncludeRawTarget={setIncludeRawTarget}
      />

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[14px] font-medium leading-5">JVM</h2>
          <MonoText className="text-muted-foreground text-[12px]">
            Uptime {formatDuration(latestMetric(index, serverResourceId, 'uptime.ms') ?? 0)}
          </MonoText>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <ServerMetricChart title="Heap Utilization" points={chart('heap.percent')} unit="%" formatValue={formatPercent} />
          <ServerMetricChart title="Process CPU" points={chart('cpu.process')} unit="%" formatValue={formatPercent} />
          <ServerMetricChart title="Heap Used" points={chart('heap.used')} formatValue={formatBytes} />
          <ServerMetricChart title="Heap Max" points={chart('heap.max')} formatValue={formatBytes} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-[14px] font-medium leading-5">Threads</h2>
        <div className="grid gap-3 lg:grid-cols-3">
          <ServerMetricChart title="Total Threads" points={chart('threads.total')} />
          <ServerMetricChart title="Idle Threads" points={chart('threads.idle')} />
          <ServerMetricChart title="Standby Threads" points={chart('threads.standby')} />
          <ServerMetricChart title="Pending Requests" points={chart('threads.pending')} />
          <ServerMetricChart title="Queue Length" points={chart('threads.queue')} />
          <ServerMetricChart title="Hogging Threads" points={chart('threads.hogging')} />
          <ServerMetricChart title="Stuck Threads" points={chart('threads.stuck')} />
        </div>
      </section>

      <ResourceRows title="JDBC Pools" family="jdbc" session={session} index={index} />
      <ResourceRows title="JMS Destinations" family="jms" session={session} index={index} />
    </div>
  )
}
