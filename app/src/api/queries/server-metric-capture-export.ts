import type { WlsCredentials } from '../client.ts'
import type { ServerMetricCaptureSession } from './server-metric-capture-store.ts'

export interface ServerMetricCaptureExportMetadata {
  target: string
  version: string
  server: string
  startedAt: string
  stoppedAt: string | null
  pollingIntervalMs: number
  pollWhileHidden: boolean
  sampleCount: number
  pointCount: number
  gapCount: number
  omittedJdbcCount: number
  omittedJmsCount: number
}

export interface ServerMetricCaptureJsonExport {
  metadata: ServerMetricCaptureExportMetadata
  samples: Array<{
    timestampIso: string
    timestampMs: number
    server: string
    family: string
    resourceId: string
    resourceLabel: string
    metric: string
    value: number
    gapBefore: boolean
  }>
}

function isoOrNull(timestamp: number | null) {
  return timestamp && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function targetWithoutCredentials(rawTarget: string, includeRawTarget: boolean) {
  try {
    const url = new URL(rawTarget)
    url.username = ''
    url.password = ''
    if (includeRawTarget) return url.toString().replace(/\/$/, '')
    return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    return 'unknown'
  }
}

function csvValue(value: string | number | boolean | null) {
  const text = value === null ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function safeFilePart(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'server'
}

export function serverMetricCaptureExportMetadata(
  session: ServerMetricCaptureSession,
  creds: Pick<WlsCredentials, 'targetUrl' | 'version'>,
  includeRawTarget = false,
): ServerMetricCaptureExportMetadata {
  return {
    target: targetWithoutCredentials(creds.targetUrl, includeRawTarget),
    version: creds.version,
    server: session.serverName,
    startedAt: new Date(session.startedAt).toISOString(),
    stoppedAt: isoOrNull(session.stoppedAt),
    pollingIntervalMs: session.pollingIntervalMs,
    pollWhileHidden: session.pollWhileHidden,
    sampleCount: session.sampleCount,
    pointCount: session.pointCount,
    gapCount: session.gapCount,
    omittedJdbcCount: session.omitted.jdbc,
    omittedJmsCount: session.omitted.jms,
  }
}

export function serverMetricCaptureRows(session: ServerMetricCaptureSession) {
  return session.samples.map((sample) => ({
    timestampIso: new Date(sample.timestamp).toISOString(),
    timestampMs: sample.timestamp,
    server: session.serverName,
    family: sample.family,
    resourceId: sample.resourceId,
    resourceLabel: sample.resourceLabel,
    metric: sample.metric,
    value: sample.value,
    gapBefore: sample.gapBefore,
  }))
}

export function serverMetricCaptureCsv(
  session: ServerMetricCaptureSession,
  creds: Pick<WlsCredentials, 'targetUrl' | 'version'>,
  includeRawTarget = false,
) {
  const metadata = serverMetricCaptureExportMetadata(session, creds, includeRawTarget)
  const metadataLines = Object.entries(metadata).map(([key, value]) => `# ${key}=${value ?? ''}`)
  const header = 'timestampIso,timestampMs,server,family,resourceId,resourceLabel,metric,value,gapBefore'
  const rows = serverMetricCaptureRows(session).map((row) => [
    row.timestampIso,
    row.timestampMs,
    row.server,
    row.family,
    row.resourceId,
    row.resourceLabel,
    row.metric,
    row.value,
    row.gapBefore,
  ].map(csvValue).join(','))

  return [...metadataLines, header, ...rows].join('\n')
}

export function serverMetricCaptureJson(
  session: ServerMetricCaptureSession,
  creds: Pick<WlsCredentials, 'targetUrl' | 'version'>,
  includeRawTarget = false,
): ServerMetricCaptureJsonExport {
  return {
    metadata: serverMetricCaptureExportMetadata(session, creds, includeRawTarget),
    samples: serverMetricCaptureRows(session),
  }
}

export function serverMetricCaptureFilename(
  session: Pick<ServerMetricCaptureSession, 'serverName' | 'startedAt'>,
  extension: 'csv' | 'json',
) {
  const started = new Date(session.startedAt).toISOString().replace(/[:.]/g, '-')
  return `server-metrics-${safeFilePart(session.serverName)}-${started}.${extension}`
}
