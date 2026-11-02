import { useSyncExternalStore } from 'react'
import { wlsCredentialCacheKey, type WlsCredentials } from '../client.ts'
import type { ServerMetricResourceSnapshot, ServerMetricSampleInput } from './server-metrics.ts'

export const SERVER_METRIC_CAPTURE_RETENTION_MS = 6 * 60 * 60 * 1000
export const SERVER_METRIC_CAPTURE_MAX_TICKS = 4_320
export const SERVER_METRIC_CAPTURE_CADENCES_MS = [5_000, 10_000, 30_000] as const

export type ServerMetricCaptureCadenceMs = typeof SERVER_METRIC_CAPTURE_CADENCES_MS[number]
export type ServerMetricCaptureStatus = 'active' | 'stopped'

export interface ServerMetricCaptureTick {
  timestamp: number
  gapBefore: boolean
}

export interface ServerMetricCapturedPoint {
  timestamp: number
  family: ServerMetricSampleInput['family']
  resourceId: string
  resourceLabel: string
  metric: string
  value: number
  gapBefore: boolean
}

export interface ServerMetricCaptureSession {
  id: string
  scopeKey: string
  serverName: string
  status: ServerMetricCaptureStatus
  pollingIntervalMs: ServerMetricCaptureCadenceMs
  pollWhileHidden: boolean
  startedAt: number
  stoppedAt: number | null
  ticks: ServerMetricCaptureTick[]
  samples: ServerMetricCapturedPoint[]
  resources: Record<string, ServerMetricResourceSnapshot>
  sampleCount: number
  pointCount: number
  gapCount: number
  omitted: {
    jdbc: number
    jms: number
  }
}

export interface ServerMetricCaptureState {
  scopeKey: string | null
  sessions: Record<string, ServerMetricCaptureSession>
}

export interface ServerMetricCaptureAppendOptions {
  retentionMs?: number
  maxTicks?: number
  omitted?: Partial<ServerMetricCaptureSession['omitted']>
  resources?: ServerMetricResourceSnapshot[]
}

export interface ServerMetricCaptureStartOptions {
  pollWhileHidden?: boolean
}

type ServerMetricCaptureSubscriber = () => void

let serverMetricCaptureState = emptyServerMetricCaptureState()
const subscribers = new Set<ServerMetricCaptureSubscriber>()

export function serverMetricCaptureScopeKey(creds: WlsCredentials | null | undefined) {
  return creds ? wlsCredentialCacheKey(creds) : null
}

export function isServerMetricCaptureCadence(value: number): value is ServerMetricCaptureCadenceMs {
  return SERVER_METRIC_CAPTURE_CADENCES_MS.includes(value as ServerMetricCaptureCadenceMs)
}

export function emptyServerMetricCaptureState(scopeKey: string | null = null): ServerMetricCaptureState {
  return {
    scopeKey,
    sessions: {},
  }
}

function emitServerMetricCaptureChange() {
  subscribers.forEach((subscriber) => subscriber())
}

export function subscribeToServerMetricCaptures(subscriber: ServerMetricCaptureSubscriber) {
  subscribers.add(subscriber)
  return () => subscribers.delete(subscriber)
}

export function getServerMetricCaptureSnapshot() {
  return serverMetricCaptureState
}

export function resetServerMetricCaptures(scopeKey: string | null = null) {
  serverMetricCaptureState = emptyServerMetricCaptureState(scopeKey)
  emitServerMetricCaptureChange()
}

export function resetServerMetricCaptureScopeOnChange(
  previousScopeKey: string | null | undefined,
  scopeKey: string | null,
) {
  if (previousScopeKey && previousScopeKey !== scopeKey) {
    resetServerMetricCaptures(scopeKey)
  } else if (serverMetricCaptureState.scopeKey !== scopeKey) {
    serverMetricCaptureState = {
      ...serverMetricCaptureState,
      scopeKey,
    }
    emitServerMetricCaptureChange()
  }
  return scopeKey
}

function sessionId(scopeKey: string, serverName: string, startedAt: number) {
  return [scopeKey, serverName, String(startedAt)].map(encodeURIComponent).join('|')
}

function emptySession(
  scopeKey: string,
  serverName: string,
  pollingIntervalMs: ServerMetricCaptureCadenceMs,
  startedAt: number,
  options: ServerMetricCaptureStartOptions = {},
): ServerMetricCaptureSession {
  return {
    id: sessionId(scopeKey, serverName, startedAt),
    scopeKey,
    serverName,
    status: 'active',
    pollingIntervalMs,
    pollWhileHidden: options.pollWhileHidden === true,
    startedAt,
    stoppedAt: null,
    ticks: [],
    samples: [],
    resources: {},
    sampleCount: 0,
    pointCount: 0,
    gapCount: 0,
    omitted: { jdbc: 0, jms: 0 },
  }
}

function ensureScope(scopeKey: string) {
  if (serverMetricCaptureState.scopeKey === scopeKey) return serverMetricCaptureState
  serverMetricCaptureState = emptyServerMetricCaptureState(scopeKey)
  return serverMetricCaptureState
}

function normalizeCadence(value: number): ServerMetricCaptureCadenceMs {
  return isServerMetricCaptureCadence(value) ? value : 10_000
}

export function startServerMetricCapture(
  scopeKey: string | null | undefined,
  serverName: string,
  pollingIntervalMs: number,
  timestamp: number,
  options: ServerMetricCaptureStartOptions = {},
) {
  if (!scopeKey || !serverName || timestamp <= 0) return null

  const state = ensureScope(scopeKey)
  const session = emptySession(scopeKey, serverName, normalizeCadence(pollingIntervalMs), timestamp, options)
  serverMetricCaptureState = {
    ...state,
    sessions: {
      ...state.sessions,
      [serverName]: session,
    },
  }
  emitServerMetricCaptureChange()
  return session
}

export function stopServerMetricCapture(
  scopeKey: string | null | undefined,
  serverName: string,
  timestamp: number,
) {
  const session = scopeKey && serverMetricCaptureState.scopeKey === scopeKey
    ? serverMetricCaptureState.sessions[serverName]
    : null
  if (!session || session.status === 'stopped') return session

  const stopped = {
    ...session,
    status: 'stopped' as const,
    stoppedAt: timestamp > 0 ? timestamp : session.stoppedAt,
  }
  serverMetricCaptureState = {
    ...serverMetricCaptureState,
    sessions: {
      ...serverMetricCaptureState.sessions,
      [serverName]: stopped,
    },
  }
  emitServerMetricCaptureChange()
  return stopped
}

export function clearServerMetricCapture(scopeKey: string | null | undefined, serverName: string) {
  if (!scopeKey || serverMetricCaptureState.scopeKey !== scopeKey) return

  const sessions = { ...serverMetricCaptureState.sessions }
  delete sessions[serverName]
  serverMetricCaptureState = {
    ...serverMetricCaptureState,
    sessions,
  }
  emitServerMetricCaptureChange()
}

export function updateServerMetricCaptureCadence(
  scopeKey: string | null | undefined,
  serverName: string,
  pollingIntervalMs: number,
) {
  const session = scopeKey && serverMetricCaptureState.scopeKey === scopeKey
    ? serverMetricCaptureState.sessions[serverName]
    : null
  if (!session || session.status !== 'active') return session

  const updated = {
    ...session,
    pollingIntervalMs: normalizeCadence(pollingIntervalMs),
  }
  serverMetricCaptureState = {
    ...serverMetricCaptureState,
    sessions: {
      ...serverMetricCaptureState.sessions,
      [serverName]: updated,
    },
  }
  emitServerMetricCaptureChange()
  return updated
}

export function updateServerMetricCaptureHiddenPolling(
  scopeKey: string | null | undefined,
  serverName: string,
  pollWhileHidden: boolean,
) {
  const session = scopeKey && serverMetricCaptureState.scopeKey === scopeKey
    ? serverMetricCaptureState.sessions[serverName]
    : null
  if (!session || session.status !== 'active') return session

  const updated = {
    ...session,
    pollWhileHidden,
  }
  serverMetricCaptureState = {
    ...serverMetricCaptureState,
    sessions: {
      ...serverMetricCaptureState.sessions,
      [serverName]: updated,
    },
  }
  emitServerMetricCaptureChange()
  return updated
}

function trimSession(
  session: ServerMetricCaptureSession,
  timestamp: number,
  retentionMs: number,
  maxTicks: number,
): ServerMetricCaptureSession {
  const cutoff = timestamp - retentionMs
  let ticks = session.ticks.filter((tick) => tick.timestamp >= cutoff && tick.timestamp <= timestamp)

  while (ticks.length > maxTicks) {
    ticks = ticks.slice(1)
  }

  const retainedTimestamps = new Set(ticks.map((tick) => tick.timestamp))
  const samples = session.samples.filter((sample) => retainedTimestamps.has(sample.timestamp))

  return {
    ...session,
    ticks,
    samples,
    sampleCount: ticks.length,
    pointCount: samples.length,
    gapCount: ticks.filter((tick) => tick.gapBefore).length,
  }
}

export function appendServerMetricCaptureSamples(
  scopeKey: string | null | undefined,
  serverName: string,
  samples: ServerMetricSampleInput[],
  timestamp: number,
  options: ServerMetricCaptureAppendOptions = {},
) {
  const session = scopeKey && serverMetricCaptureState.scopeKey === scopeKey
    ? serverMetricCaptureState.sessions[serverName]
    : null
  if (!session || session.status !== 'active' || timestamp <= 0) return session

  const previousTick = session.ticks.at(-1)
  const gapBefore = previousTick
    ? timestamp - previousTick.timestamp > session.pollingIntervalMs * 1.5
    : false
  const tick = { timestamp, gapBefore }
  const points = samples.flatMap<ServerMetricCapturedPoint>((sample) => {
    if (sample.value === null || !Number.isFinite(sample.value)) return []
    return [{
      timestamp,
      family: sample.family,
      resourceId: sample.resourceId,
      resourceLabel: sample.resourceLabel,
      metric: sample.metric,
      value: sample.value,
      gapBefore,
    }]
  })
  const resources = Object.fromEntries((options.resources ?? []).map((resource) => [resource.resourceId, resource]))
  const updated = trimSession(
    {
      ...session,
      ticks: [...session.ticks, tick],
      samples: [...session.samples, ...points],
      resources: {
        ...session.resources,
        ...resources,
      },
      omitted: {
        jdbc: options.omitted?.jdbc ?? session.omitted.jdbc,
        jms: options.omitted?.jms ?? session.omitted.jms,
      },
    },
    timestamp,
    options.retentionMs ?? SERVER_METRIC_CAPTURE_RETENTION_MS,
    options.maxTicks ?? SERVER_METRIC_CAPTURE_MAX_TICKS,
  )

  serverMetricCaptureState = {
    ...serverMetricCaptureState,
    sessions: {
      ...serverMetricCaptureState.sessions,
      [serverName]: updated,
    },
  }
  emitServerMetricCaptureChange()
  return updated
}

export function getServerMetricCaptureSession(
  scopeKey: string | null | undefined,
  serverName: string,
) {
  if (!scopeKey || serverMetricCaptureState.scopeKey !== scopeKey) return null
  return serverMetricCaptureState.sessions[serverName] ?? null
}

export function useServerMetricCaptureSnapshot() {
  return useSyncExternalStore(
    subscribeToServerMetricCaptures,
    getServerMetricCaptureSnapshot,
    getServerMetricCaptureSnapshot,
  )
}
