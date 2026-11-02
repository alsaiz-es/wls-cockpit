import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../auth/useAuth.ts'
import {
  ADAPTIVE_POLL_FAST_INTERVAL_MS,
  ADAPTIVE_POLL_SLOW_INTERVAL_MS,
  createAdaptivePollingInterval,
  useDocumentVisible,
  useRefreshStaleQueryOnVisibleReturn,
} from '../query-polling.ts'
import { createClient12, createClient14, wlsCredentialCacheKey, type WlsCredentials } from '../client.ts'
import { createWlsHttpError, withWlsRestTimeout } from '../wls-errors.ts'

export interface ServerLifecycleHistoryTask {
  serverName: string
  name: string | null
  operation: string | null
  status: string | null
  progress: string | null
  running: boolean | null
  completed: boolean | null
  description: string | null
  startTime: number | null
  endTime: number | null
  errorMessage: string | null
}

export const SERVER_LIFECYCLE_TASK_REQUEST_TIMEOUT_MS = 15_000
export const SERVER_LIFECYCLE_TASK_QUERY_OPTIONS = {
  staleTime: 0,
  refetchInterval: ADAPTIVE_POLL_SLOW_INTERVAL_MS,
} as const

const LIFECYCLE_TASK_FIELDS = [
  'name',
  'serverName',
  'operation',
  'status',
  'taskStatus',
  'progress',
  'running',
  'completed',
  'beginTime',
  'startTimeAsLong',
  'startTime',
  'endTime',
  'endTimeAsLong',
  'description',
  'error',
  'taskError',
].join(',')

export function serverLifecycleTaskQueryParams() {
  return {
    fields: LIFECYCLE_TASK_FIELDS,
    links: 'none',
  } as const
}

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readEpochMillis(value: unknown) {
  const number = readNumber(value)
  if (number !== null) return number >= 0 ? number : null

  const text = readString(value)
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function redactSensitiveText(value: string) {
  return value
    .replace(/\bBasic\s+[A-Za-z0-9+/=._-]+/gi, 'Basic [redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, '$1[redacted]@')
    .replace(/\b(password|passwd|pwd)=([^&\s]+)/gi, '$1=[redacted]')
}

function firstMeaningfulString(value: unknown, depth = 0): string | null {
  if (depth > 3) return null

  const direct = readString(value)
  if (direct) return redactSensitiveText(direct)
  if (!isObject(value)) return null

  for (const key of ['message', 'localizedMessage', 'detail', 'details', 'reason', 'exception', 'cause']) {
    const found = firstMeaningfulString(value[key], depth + 1)
    if (found) return found
  }

  return null
}

function normalizeTaskError(value: unknown) {
  if (value === null || value === undefined) return null

  const message = firstMeaningfulString(value)
  if (message) return message

  if (isObject(value) && Object.keys(value).length === 0) {
    return 'Lifecycle task returned an error.'
  }

  try {
    return redactSensitiveText(JSON.stringify(value)).slice(0, 500)
  } catch {
    return 'Lifecycle task returned an error.'
  }
}

function normalizeLifecycleHistoryTask(value: unknown, fallbackServerName: string): ServerLifecycleHistoryTask | null {
  if (!isObject(value)) return null

  const startTime = readEpochMillis(value.beginTime) ?? readEpochMillis(value.startTimeAsLong) ?? readEpochMillis(value.startTime)
  const endTime = readEpochMillis(value.endTime) ?? readEpochMillis(value.endTimeAsLong)

  return {
    serverName: readString(value.serverName) ?? fallbackServerName,
    name: readString(value.name),
    operation: readString(value.operation),
    status: readString(value.status) ?? readString(value.taskStatus) ?? readString(value.progress),
    progress: readString(value.progress),
    running: readBoolean(value.running),
    completed: readBoolean(value.completed),
    description: readString(value.description),
    startTime,
    endTime,
    errorMessage: normalizeTaskError(value.error ?? value.taskError),
  }
}

export function normalizeServerLifecycleHistory(data: unknown, serverName: string): ServerLifecycleHistoryTask[] {
  if (!isObject(data) || !Array.isArray(data.items)) return []

  return data.items
    .flatMap((item) => {
      const task = normalizeLifecycleHistoryTask(item, serverName)
      return task ? [task] : []
    })
    .sort((a, b) => (b.endTime ?? b.startTime ?? 0) - (a.endTime ?? a.startTime ?? 0))
}

function hasActiveLifecycleTask(tasks: ServerLifecycleHistoryTask[]) {
  return tasks.some((task) => {
    if (task.running === true) return true
    if (task.completed === false) return true

    const state = `${task.status ?? ''} ${task.progress ?? ''}`.toLowerCase()
    return /\b(in[-\s]?progress|processing|running|pending|started|starting|stopping|suspending|resuming)\b/.test(state)
  })
}

function lifecycleTaskSnapshotKey(tasks: ServerLifecycleHistoryTask[]) {
  return tasks
    .map((task) =>
      [
        task.serverName,
        task.name,
        task.operation,
        task.status,
        task.progress,
        task.running,
        task.completed,
        task.startTime,
        task.endTime,
        task.errorMessage,
      ].join('\u0000'),
    )
    .join('\u0001')
}

export function createServerLifecycleTaskPollingInterval(scope = '') {
  return createAdaptivePollingInterval<ServerLifecycleHistoryTask[]>({
    fastIntervalMs: ADAPTIVE_POLL_FAST_INTERVAL_MS,
    slowIntervalMs: SERVER_LIFECYCLE_TASK_QUERY_OPTIONS.refetchInterval,
    initialIntervalMs: SERVER_LIFECYCLE_TASK_QUERY_OPTIONS.refetchInterval,
    isActiveSnapshot: hasActiveLifecycleTask,
    getSnapshotKey: (tasks) => `${scope}\u0002${lifecycleTaskSnapshotKey(tasks)}`,
  })
}

export function serverLifecycleTasksQueryKey(creds: WlsCredentials | null | undefined, serverName: string) {
  return ['serverLifecycleTasks', wlsCredentialCacheKey(creds), serverName] as const
}

export async function fetchServerLifecycleTasks(
  creds: WlsCredentials,
  serverName: string,
): Promise<ServerLifecycleHistoryTask[]> {
  const res = await withWlsRestTimeout(
    `Server lifecycle tasks ${serverName}`,
    (signal) =>
      clientFor(creds).GET('/management/weblogic/{version}/domainRuntime/serverLifeCycleRuntimes/{serverName}/tasks', {
        signal,
        params: {
          path: { version: creds.version, serverName },
          query: serverLifecycleTaskQueryParams(),
        },
      }),
    SERVER_LIFECYCLE_TASK_REQUEST_TIMEOUT_MS,
  )

  if (res.error) throw createWlsHttpError(`Server lifecycle tasks ${serverName}`, res.response, res.error)
  return normalizeServerLifecycleHistory(res.data, serverName)
}

export function useServerLifecycleTasks(serverName: string, enabled: boolean) {
  const { creds } = useAuth()
  const lifecycleTaskPollingInterval = useMemo(() => createServerLifecycleTaskPollingInterval(serverName), [serverName])
  const visible = useDocumentVisible()

  const query = useQuery({
    queryKey: serverLifecycleTasksQueryKey(creds, serverName),
    enabled: !!creds && enabled && serverName.length > 0,
    ...SERVER_LIFECYCLE_TASK_QUERY_OPTIONS,
    refetchInterval: (query) => (visible ? lifecycleTaskPollingInterval(query.state.data) : false),
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchServerLifecycleTasks(creds, serverName)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds && enabled && serverName.length > 0,
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}
