import { useEffect, useMemo, useReducer, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  createClient12,
  createClient14,
  wlsCredentialCacheKey,
  type WlsCredentials,
} from '@/api/client'
import {
  useRefreshStaleQueryOnVisibleReturn,
  useVisiblePollingInterval,
} from '@/api/query-polling'
import { fetchServerRuntimeRows, type ServerRuntimeRow } from '@/api/queries/server-runtimes'
import { createWlsHttpError, isWlsRestError, withWlsRestTimeout } from '@/api/wls-errors'
import { useAuth } from '@/auth/useAuth'
import { WLS_LIFECYCLE_STATES, type WlsLifecycleState } from '@/components'
import {
  buildSelectedLogRuntimeSnapshot,
  buildMultiLogTailSources,
  buildMultiLogTailSnapshot,
  classifyLogArchiveName,
  buildLogRecordSearchWindow,
  applyLogArchiveSummaries,
  buildLogDetailMetadataSnapshot,
  buildLogRecordTailSearchWindow,
  classifyLogSignals,
  latestMultiLogTailCursors,
  latestLogRecordTailCursor,
  isHttpAccessLogArchiveName,
  logArchiveRuntimeQueryParams,
  logBroadcasterQueryParams,
  logDataAccessDetailQueryParams,
  logDataAccessSummaryQueryParams,
  mergeMultiLogTailBuffer,
  logRecordSearchPayload,
  logServerRuntimeQueryParams,
  logTailArchiveUrlValue,
  logTailSelectionKey,
  LOG_TAIL_ARCHIVE_SEARCH_PARAM,
  mergeLogRecordTailBuffer,
  multiLogTailSourceId,
  normalizeLogRecordPreviewSnapshot,
  normalizeArchive,
  normalizeLogArchiveRuntimeCounters,
  normalizeLogDataAccessRuntimeDetail,
  parseHttpAccessLogMessage,
  parseHttpAccessLogRecord,
  readBoolean,
  readNumber,
  resolveLogTailArchiveSelection,
  serverLogRuntimeQueryParams,
  selectDefaultLogTailArchive,
  wldfLogRecordSearchRequest,
  type LogArchiveRuntime,
  type LogArchiveKind,
  type LogArchiveRuntimeCounters,
  type LogDataAccessRuntimeDetail,
  type LogDetailMetadataSnapshot,
  type HttpAccessLogFields,
  type LogRecordTailCursor,
  type MultiLogTailSource,
  type MultiLogTailRecord,
  type MultiLogTailSourceFailure,
  type LogRecordPreviewRow,
  type LogRecordPreviewSnapshot,
  type LogSignalSeverity,
} from './log-runtime-detail-normalization'
import {
  LOG_TAIL_PAGE_SIZE,
  filterBySeverityFloor,
  logSeverityQuery,
  mergeTailFailures,
  pollableTailSources,
  readLogTail,
  type LogSeverityFloor,
  type WldfRecordSearchBody,
} from './log-tail'

export {
  buildLogDetailMetadataSnapshot,
  buildMultiLogTailSnapshot,
  buildLogRecordTailSearchWindow,
  buildSelectedLogRuntimeSnapshot,
  buildMultiLogTailSources,
  classifyLogArchiveName,
  applyLogArchiveSummaries,
  classifyLogSignals,
  latestMultiLogTailCursors,
  latestLogRecordTailCursor,
  isHttpAccessLogArchiveName,
  logArchiveRuntimeQueryParams,
  logBroadcasterQueryParams,
  logDataAccessDetailQueryParams,
  logDataAccessSummaryQueryParams,
  logRecordSearchPayload,
  logServerRuntimeQueryParams,
  logTailArchiveUrlValue,
  logTailSelectionKey,
  LOG_TAIL_ARCHIVE_SEARCH_PARAM,
  mergeMultiLogTailBuffer,
  mergeLogRecordTailBuffer,
  multiLogTailSourceId,
  normalizeLogRecordPreviewSnapshot,
  normalizeLogArchiveRuntimeCounters,
  normalizeLogDataAccessRuntimeDetail,
  parseHttpAccessLogMessage,
  parseHttpAccessLogRecord,
  resolveLogTailArchiveSelection,
  serverLogRuntimeQueryParams,
  selectDefaultLogTailArchive,
  wldfLogRecordSearchRequest,
}
export type {
  LogArchiveRuntime,
  LogArchiveKind,
  LogArchiveRuntimeCounters,
  LogDataAccessRuntimeDetail,
  LogDetailMetadataSnapshot,
  HttpAccessLogFields,
  LogRecordTailCursor,
  MultiLogTailSource,
  MultiLogTailRecord,
  MultiLogTailSourceFailure,
  LogRecordPreviewRow,
  LogRecordPreviewSnapshot,
  LogSignalSeverity,
}

export type LogsStatus = 'available' | 'empty' | 'partial'

export interface LogRuntimeRow {
  id: string
  serverName: string
  state: WlsLifecycleState
  messagesLogged: number | null
  logFileStreamOpened: boolean | null
  broadcasterAvailable: boolean
  serverLogAvailable: boolean
  archives: LogArchiveRuntime[]
  serverLogLatestTimestamp: number | null
  severity: LogSignalSeverity
}

export interface LogsSnapshot {
  status: LogsStatus
  rows: LogRuntimeRow[]
  partialFailures: Array<{ serverName: string; signal: string; message: string }>
}

export interface LogArchiveSummariesSnapshot {
  archivesByServer: Map<string, LogArchiveRuntime[]>
  partialFailures: Array<{ serverName: string; signal: string; message: string }>
}

export interface LogRuntimeDetailSnapshot {
  status: LogsStatus
  row: LogRuntimeRow | null
  partialFailures: Array<{ serverName: string; signal: string; message: string }>
}

const LOG_ARCHIVE_LIST_TIMEOUT_MS = 30_000
const EMPTY_LOG_ARCHIVE_SUMMARIES = new Map<string, LogArchiveRuntime[]>()
const WLDF_LOG_RECORD_SEARCH_PATH =
  '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/WLDFRuntime/WLDFAccessRuntime/WLDFDataAccessRuntimes/{WLDFDataAccessName}/search'

export function logsQueryKey(creds: WlsCredentials | null | undefined) {
  return ['logs', wlsCredentialCacheKey(creds)] as const
}

export function logArchiveSummariesQueryKey(creds: WlsCredentials | null | undefined) {
  return ['logs', 'archive-summaries', wlsCredentialCacheKey(creds)] as const
}

export function logRuntimeDetailQueryKey(creds: WlsCredentials | null | undefined, serverName: string | null | undefined) {
  return ['logs', 'runtime-detail', wlsCredentialCacheKey(creds), serverName ?? ''] as const
}

export function logDetailMetadataQueryKey(creds: WlsCredentials | null | undefined, serverName: string | null | undefined) {
  return ['logs', 'detail-metadata', wlsCredentialCacheKey(creds), serverName ?? ''] as const
}

export function logRecordPreviewQueryKey(
  creds: WlsCredentials | null | undefined,
  serverName: string | null | undefined,
  archiveName: string | null | undefined,
  latestAvailableTimestamp: number | null | undefined,
) {
  return [
    'logs',
    'record-preview',
    wlsCredentialCacheKey(creds),
    serverName ?? '',
    archiveName ?? '',
    latestAvailableTimestamp ?? 'unknown',
  ] as const
}

export function logRecordTailQueryKey(
  creds: WlsCredentials | null | undefined,
  serverName: string | null | undefined,
  archiveName: string | null | undefined,
) {
  return ['logs', 'record-tail', wlsCredentialCacheKey(creds), serverName ?? '', archiveName ?? ''] as const
}

export function multiLogRecordTailQueryKey(
  creds: WlsCredentials | null | undefined,
  sources: MultiLogTailSource[],
  severityFloor: LogSeverityFloor = 'all',
) {
  return [
    'logs',
    'multi-record-tail',
    wlsCredentialCacheKey(creds),
    sources.map((source) => source.id).join(','),
    severityFloor,
  ] as const
}

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isRuntimeServer(row: ServerRuntimeRow) {
  return row.state === 'RUNNING' || row.state === 'ADMIN' || row.state === 'STANDBY'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error'
}

function isOptionalArchiveRuntimeCountersUnavailable(error: unknown) {
  return isWlsRestError(error) && error.kind === 'http' && error.status === 404
}

function normalizeLifecycle(value: unknown): WlsLifecycleState {
  return WLS_LIFECYCLE_STATES.includes(value as WlsLifecycleState)
    ? (value as WlsLifecycleState)
    : 'UNKNOWN'
}

async function fetchServerLogSignals(creds: WlsCredentials, server: ServerRuntimeRow) {
  const client = clientFor(creds)
  const [broadcaster, serverLog] = await Promise.allSettled([
    withWlsRestTimeout(`Log broadcaster ${server.name}`, async (signal) => {
      const res = await client.GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/logBroadcasterRuntime',
        {
          signal,
          params: {
            path: { version: creds.version, serverName: server.name },
            query: logBroadcasterQueryParams(),
          },
        },
      )
      if (res.error) throw createWlsHttpError(`Log broadcaster ${server.name}`, res.response, res.error)
      return readNumber(res.data?.messagesLogged)
    }),
    withWlsRestTimeout(`Server log ${server.name}`, async (signal) => {
      const res = await client.GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/serverLogRuntime',
        {
          signal,
          params: {
            path: { version: creds.version, serverName: server.name },
            query: serverLogRuntimeQueryParams(),
          },
        },
      )
      if (res.error) throw createWlsHttpError(`Server log ${server.name}`, res.response, res.error)
      return readBoolean(res.data?.logFileStreamOpened)
    }),
  ])

  const failures = [
    broadcaster.status === 'rejected'
      ? { serverName: server.name, signal: 'broadcaster', message: errorMessage(broadcaster.reason) }
      : null,
    serverLog.status === 'rejected'
      ? { serverName: server.name, signal: 'serverLog', message: errorMessage(serverLog.reason) }
      : null,
  ].filter((failure): failure is { serverName: string; signal: string; message: string } => failure !== null)

  const row = {
    serverName: server.name,
    state: server.state,
    messagesLogged: broadcaster.status === 'fulfilled' ? broadcaster.value : null,
    logFileStreamOpened: serverLog.status === 'fulfilled' ? serverLog.value : null,
    broadcasterAvailable: broadcaster.status === 'fulfilled',
    serverLogAvailable: serverLog.status === 'fulfilled',
    archives: [],
    serverLogLatestTimestamp: null,
  } satisfies Omit<LogRuntimeRow, 'id' | 'severity'>

  return {
    row: {
      id: server.name,
      ...row,
      severity: classifyLogSignals(row),
    },
    failures,
  }
}

async function fetchServerLogArchiveSummaries(creds: WlsCredentials, server: ServerRuntimeRow) {
  const res = await withWlsRestTimeout(`Log archives ${server.name}`, async (signal) => {
    const response = await clientFor(creds).GET(
      '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/WLDFRuntime/WLDFAccessRuntime/dataAccessRuntimes',
      {
        signal,
        params: {
          path: { version: creds.version, serverName: server.name },
          query: logDataAccessSummaryQueryParams(),
        },
      },
    )
    if (response.error) throw createWlsHttpError(`Log archives ${server.name}`, response.response, response.error)
    return response
    // Listing every WLDF archive of a busy FMW server took over 15 s on a cold first load.
  }, LOG_ARCHIVE_LIST_TIMEOUT_MS)

  return (res.data?.items ?? []).flatMap((item) => {
    const archive = normalizeArchive(item)
    return archive ? [archive] : []
  })
}

async function fetchSelectedServerState(creds: WlsCredentials, serverName: string) {
  const res = await withWlsRestTimeout(`Log server runtime ${serverName}`, (signal) =>
    clientFor(creds).GET('/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}', {
      signal,
      params: {
        path: { version: creds.version, serverName },
        query: logServerRuntimeQueryParams(),
      },
    }),
  )

  if (res.error) throw createWlsHttpError(`Log server runtime ${serverName}`, res.response, res.error)
  return normalizeLifecycle(res.data?.state)
}

export function logRecordSearchPath(version: string, serverName: string, archiveName: string) {
  const params = new URLSearchParams({
    internal: 'true',
    expandedValues: 'false',
    saveChanges: 'false',
    enableConsoleRestExtension: 'true',
  })
  return `/management/weblogic/${encodeURIComponent(version)}/domainRuntime/serverRuntimes/${encodeURIComponent(serverName)}/WLDFRuntime/WLDFAccessRuntime/WLDFDataAccessRuntimes/${encodeURIComponent(archiveName)}/search?${params.toString()}`
}

async function fetchWldfLogRecords(
  creds: WlsCredentials,
  serverName: string,
  archiveName: string,
  window: ReturnType<typeof buildLogRecordSearchWindow>,
  body?: WldfRecordSearchBody,
) {
  const request = wldfLogRecordSearchRequest(creds.version, serverName, archiveName, window)
  const res = await withWlsRestTimeout(`Log records ${serverName}/${archiveName}`, (signal) =>
    clientFor(creds).POST(WLDF_LOG_RECORD_SEARCH_PATH, {
      signal,
      ...request,
      // `fromId` and `query` are accepted by the action but missing from the pinned spec.
      ...(body ? { body: body as typeof request.body } : {}),
    }),
  )

  if (res.error) throw createWlsHttpError(`Log records ${serverName}/${archiveName}`, res.response, res.error)
  return res.data
}

async function fetchLatestLogRecordId(creds: WlsCredentials, serverName: string, archive: LogArchiveRuntime) {
  try {
    const res = await withWlsRestTimeout(`Log archive ${serverName}/${archive.name}`, (signal) =>
      clientFor(creds).GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/WLDFRuntime/WLDFAccessRuntime/dataAccessRuntimes/{dataAccessName}',
        {
          signal,
          params: {
            path: { version: creds.version, serverName, dataAccessName: archive.name },
            query: { fields: 'latestRecordId', links: 'none' },
          },
        },
      ),
    )
    if (!res.error) return readNumber((res.data as { latestRecordId?: unknown } | undefined)?.latestRecordId)
  } catch {
    // Fall back to the id reported when the archive list was loaded.
  }
  return archive.latestRecordId
}

export async function fetchLogRecordPreview(
  creds: WlsCredentials,
  serverName: string,
  archive: LogArchiveRuntime,
): Promise<LogRecordPreviewSnapshot> {
  // The newest records, not the oldest of the last 15 minutes (the search pages ascending).
  const limit = buildLogRecordSearchWindow(archive).limit
  const newest = await fetchLogRecordTail(creds, serverName, archive, null)
  const records = newest.records.slice(-limit)
  const first = records[0]?.timestamp
  const last = records.at(-1)?.timestamp
  return {
    ...newest,
    records,
    window: {
      since: first ? new Date(first).toISOString() : null,
      until: last ? new Date(last).toISOString() : null,
      limit,
    },
  }
}

async function fetchLogRecordTailByTime(
  creds: WlsCredentials,
  serverName: string,
  archive: LogArchiveRuntime,
  cursor: LogRecordTailCursor | null,
): Promise<LogRecordPreviewSnapshot> {
  const archiveName = archive.name
  const window = buildLogRecordTailSearchWindow(archive, cursor)
  const data = await fetchWldfLogRecords(creds, serverName, archiveName, window)

  return normalizeLogRecordPreviewSnapshot(archiveName, window, data)
}

export async function fetchLogRecordTail(
  creds: WlsCredentials,
  serverName: string,
  archive: LogArchiveRuntime,
  cursor: LogRecordTailCursor | null,
  options: { severityFloor?: LogSeverityFloor } = {},
): Promise<LogRecordPreviewSnapshot> {
  const archiveName = archive.name
  // Records without ids (plain-text access logs) can only be followed by time.
  if (cursor && cursor.latestRecordId === null) return fetchLogRecordTailByTime(creds, serverName, archive, cursor)

  const window = { since: null, until: null, limit: LOG_TAIL_PAGE_SIZE }
  const query = archive.kind === 'server' || archive.kind === 'domain'
    ? logSeverityQuery(options.severityFloor ?? 'all')
    : undefined
  try {
    const tail = await readLogTail({
      cursor,
      query,
      latestRecordId: () => fetchLatestLogRecordId(creds, serverName, archive),
      search: async (body) => {
        const data = await fetchWldfLogRecords(creds, serverName, archiveName, window, body)
        const page = normalizeLogRecordPreviewSnapshot(archiveName, window, data)
        return { records: page.records, nextRecordId: page.nextRecordId }
      },
    })
    return {
      status: tail.records.length ? 'available' : 'empty',
      archiveName,
      records: tail.records,
      nextRecordId: null,
      window,
      skippedAhead: tail.skippedAhead,
    }
  } catch (error) {
    // Releases that reject `fromId` or `query` answer 400; keep tailing by time there and apply
    // the severity floor in the browser.
    if (isWlsRestError(error) && error.kind === 'http' && error.status === 400) {
      const byTime = await fetchLogRecordTailByTime(creds, serverName, archive, cursor)
      if (!query) return byTime
      const records = filterBySeverityFloor(byTime.records, options.severityFloor ?? 'all')
      return { ...byTime, records, status: records.length ? 'available' : 'empty' }
    }
    throw error
  }
}

export async function fetchMultiLogRecordTail(
  creds: WlsCredentials,
  sources: MultiLogTailSource[],
  cursors: Record<string, LogRecordTailCursor | null | undefined>,
  options: { severityFloor?: LogSeverityFloor } = {},
) {
  const outcomes = await Promise.allSettled(
    sources.map((source) =>
      fetchLogRecordTail(creds, source.serverName, source.archive, cursors[source.id] ?? null, options),
    ),
  )

  return buildMultiLogTailSnapshot(
    outcomes.map((outcome, index) => ({
      source: sources[index],
      outcome,
    })),
  )
}

export async function fetchLogRuntimeDetail(creds: WlsCredentials, serverName: string): Promise<LogRuntimeDetailSnapshot> {
  const client = clientFor(creds)
  const [serverState, broadcaster, serverLog, archives] = await Promise.allSettled([
    fetchSelectedServerState(creds, serverName),
    withWlsRestTimeout(`Log broadcaster ${serverName}`, async (signal) => {
      const res = await client.GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/logBroadcasterRuntime',
        {
          signal,
          params: {
            path: { version: creds.version, serverName },
            query: logBroadcasterQueryParams(),
          },
        },
      )
      if (res.error) throw createWlsHttpError(`Log broadcaster ${serverName}`, res.response, res.error)
      return readNumber(res.data?.messagesLogged)
    }),
    withWlsRestTimeout(`Server log ${serverName}`, async (signal) => {
      const res = await client.GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/serverLogRuntime',
        {
          signal,
          params: {
            path: { version: creds.version, serverName },
            query: serverLogRuntimeQueryParams(),
          },
        },
      )
      if (res.error) throw createWlsHttpError(`Server log ${serverName}`, res.response, res.error)
      return readBoolean(res.data?.logFileStreamOpened)
    }),
    withWlsRestTimeout(`Log archives ${serverName}`, async (signal) => {
      const res = await client.GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/WLDFRuntime/WLDFAccessRuntime/dataAccessRuntimes',
        {
          signal,
          params: {
            path: { version: creds.version, serverName },
            query: logDataAccessSummaryQueryParams(),
          },
        },
      )
      if (res.error) throw createWlsHttpError(`Log archives ${serverName}`, res.response, res.error)
      return (res.data?.items ?? []).flatMap((item) => {
        const archive = normalizeArchive(item)
        return archive ? [archive] : []
      })
    }),
  ])
  const snapshot = buildSelectedLogRuntimeSnapshot(
    serverName,
    serverState.status === 'fulfilled' ? serverState.value : 'UNKNOWN',
    broadcaster,
    serverLog,
    archives,
  )
  const stateFailure =
    serverState.status === 'rejected'
      ? [{ serverName, signal: 'serverRuntime', message: errorMessage(serverState.reason) }]
      : []

  return {
    ...snapshot,
    row: snapshot.row ? ({ ...snapshot.row, state: normalizeLifecycle(snapshot.row.state) } satisfies LogRuntimeRow) : null,
    partialFailures: [...stateFailure, ...snapshot.partialFailures],
    status: stateFailure.length || snapshot.status === 'partial' ? 'partial' : snapshot.status,
  }
}

export async function fetchLogDetailMetadata(creds: WlsCredentials, serverName: string): Promise<LogDetailMetadataSnapshot> {
  const client = clientFor(creds)
  const [dataAccess, archiveRuntimes] = await Promise.allSettled([
    withWlsRestTimeout(`Log data access detail ${serverName}`, async (signal) => {
      const res = await client.GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/WLDFRuntime/WLDFAccessRuntime/dataAccessRuntimes',
        {
          signal,
          params: {
            path: { version: creds.version, serverName },
            query: logDataAccessDetailQueryParams(),
          },
        },
      )
      if (res.error) throw createWlsHttpError(`Log data access detail ${serverName}`, res.response, res.error)
      return (res.data?.items ?? []).flatMap((item) => {
        const detail = normalizeLogDataAccessRuntimeDetail(item)
        return detail ? [detail] : []
      })
    }),
    withWlsRestTimeout(`Log archive runtimes ${serverName}`, async (signal) => {
      const res = await client.GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/WLDFRuntime/WLDFArchiveRuntimes',
        {
          signal,
          params: {
            path: { version: creds.version, serverName },
            query: logArchiveRuntimeQueryParams(),
          },
        },
      )
      if (res.error) throw createWlsHttpError(`Log archive runtimes ${serverName}`, res.response, res.error)
      return (res.data?.items ?? []).flatMap((item) => {
        const detail = normalizeLogArchiveRuntimeCounters(item)
        return detail ? [detail] : []
      })
    }),
  ])

  return buildLogDetailMetadataSnapshot(serverName, dataAccess, archiveRuntimes, {
    isOptionalArchiveRuntimeFailure: isOptionalArchiveRuntimeCountersUnavailable,
  })
}

export async function fetchLogsSnapshot(creds: WlsCredentials): Promise<LogsSnapshot> {
  const servers = await fetchServerRuntimeRows(creds)
  const runningServers = servers.filter(isRuntimeServer)
  const outcomes = await Promise.allSettled(runningServers.map((server) => fetchServerLogSignals(creds, server)))

  const rows = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value.row] : []))
  const partialFailures = outcomes.flatMap((outcome, index) => {
    if (outcome.status === 'fulfilled') return outcome.value.failures
    const serverName = runningServers[index]?.name ?? 'unknown'
    return [{ serverName, signal: 'logs', message: errorMessage(outcome.reason) }]
  })

  return {
    status: partialFailures.length ? 'partial' : rows.length ? 'available' : 'empty',
    rows,
    partialFailures,
  }
}

export async function fetchLogArchiveSummaries(creds: WlsCredentials): Promise<LogArchiveSummariesSnapshot> {
  const servers = await fetchServerRuntimeRows(creds)
  const runningServers = servers.filter(isRuntimeServer)
  const outcomes = await Promise.allSettled(runningServers.map((server) => fetchServerLogArchiveSummaries(creds, server)))
  const archivesByServer = new Map<string, LogArchiveRuntime[]>()
  const partialFailures = outcomes.flatMap((outcome, index) => {
    const serverName = runningServers[index]?.name ?? 'unknown'
    if (outcome.status === 'fulfilled') {
      archivesByServer.set(serverName, outcome.value)
      return []
    }
    return [{ serverName, signal: 'archives', message: errorMessage(outcome.reason) }]
  })

  return {
    archivesByServer,
    partialFailures,
  }
}

export function useLogs() {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval()

  const archiveQuery = useQuery({
    queryKey: logArchiveSummariesQueryKey(creds),
    enabled: !!creds,
    staleTime: 60_000,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchLogArchiveSummaries(creds)
    },
  })

  const snapshotQuery = useQuery({
    queryKey: logsQueryKey(creds),
    enabled: !!creds,
    staleTime: 0,
    refetchInterval: livePollingInterval,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchLogsSnapshot(creds)
    },
  })

  const data = useMemo(() => {
    if (!snapshotQuery.data) return undefined
    const archiveFailures =
      archiveQuery.isError
        ? [
            {
              serverName: 'dataAccessRuntimes',
              signal: 'archives',
              message:
                archiveQuery.error instanceof Error
                  ? archiveQuery.error.message
                  : 'Log archive summary discovery unavailable',
            },
          ]
        : (archiveQuery.data?.partialFailures ?? [])

    return {
      ...snapshotQuery.data,
      rows: applyLogArchiveSummaries(
        snapshotQuery.data.rows,
        archiveQuery.data?.archivesByServer ?? EMPTY_LOG_ARCHIVE_SUMMARIES,
      ),
      partialFailures: [...archiveFailures, ...snapshotQuery.data.partialFailures],
      status: archiveFailures.length ? 'partial' : snapshotQuery.data.status,
    } satisfies LogsSnapshot
  }, [archiveQuery.data, archiveQuery.error, archiveQuery.isError, snapshotQuery.data])

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds,
    isFetching: snapshotQuery.isFetching || archiveQuery.isFetching,
    isStale: snapshotQuery.isStale || archiveQuery.isStale,
    refetch: async () => {
      const [snapshotResult] = await Promise.all([snapshotQuery.refetch(), archiveQuery.refetch()])
      return snapshotResult
    },
  })

  return {
    ...snapshotQuery,
    data,
    dataUpdatedAt: Math.max(snapshotQuery.dataUpdatedAt, archiveQuery.dataUpdatedAt),
    isFetching: snapshotQuery.isFetching || archiveQuery.isFetching,
    refetch: async () => {
      const [snapshotResult] = await Promise.all([snapshotQuery.refetch(), archiveQuery.refetch()])
      return snapshotResult
    },
  }
}

export function useLogRuntimeDetail(serverName: string | null | undefined) {
  const { creds } = useAuth()
  const normalizedServerName = serverName?.trim() ?? ''
  const livePollingInterval = useVisiblePollingInterval()

  const query = useQuery({
    queryKey: logRuntimeDetailQueryKey(creds, normalizedServerName),
    enabled: !!creds && normalizedServerName.length > 0,
    staleTime: 0,
    refetchInterval: livePollingInterval,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchLogRuntimeDetail(creds, normalizedServerName)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds && normalizedServerName.length > 0,
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}

export function useLogDetailMetadata(serverName: string | null | undefined, options: { enabled?: boolean } = {}) {
  const { creds } = useAuth()
  const normalizedServerName = serverName?.trim() ?? ''
  const livePollingInterval = useVisiblePollingInterval()

  const query = useQuery({
    queryKey: logDetailMetadataQueryKey(creds, normalizedServerName),
    enabled: !!creds && normalizedServerName.length > 0 && (options.enabled ?? true),
    staleTime: 0,
    refetchInterval: livePollingInterval,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchLogDetailMetadata(creds, normalizedServerName)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds && normalizedServerName.length > 0 && (options.enabled ?? true),
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}

export function useLogRecordPreview(
  serverName: string | null | undefined,
  archive: LogArchiveRuntime | null | undefined,
  options: { enabled?: boolean } = {},
) {
  const { creds } = useAuth()
  const normalizedServerName = serverName?.trim() ?? ''
  const livePollingInterval = useVisiblePollingInterval()

  const query = useQuery({
    queryKey: logRecordPreviewQueryKey(creds, normalizedServerName, archive?.name, archive?.latestAvailableTimestamp),
    enabled:
      !!creds &&
      normalizedServerName.length > 0 &&
      !!archive &&
      archive.name.length > 0 &&
      (options.enabled ?? true),
    staleTime: 0,
    refetchInterval: livePollingInterval,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      if (!archive) throw new Error('Log archive not available')
      return fetchLogRecordPreview(creds, normalizedServerName, archive)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds && normalizedServerName.length > 0 && !!archive && (options.enabled ?? true),
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}

interface LogRecordTailState {
  key: string
  records: LogRecordPreviewRow[]
  cursor: LogRecordTailCursor | null
  blockedAfterError: boolean
}

type LogRecordTailAction =
  | { type: 'reset'; key: string }
  | { type: 'records'; records: LogRecordPreviewRow[] }
  | { type: 'error' }
  | { type: 'retry' }

const EMPTY_LOG_RECORD_TAIL_STATE: LogRecordTailState = {
  key: '',
  records: [],
  cursor: null,
  blockedAfterError: false,
}

function logRecordTailReducer(
  state: LogRecordTailState,
  action: LogRecordTailAction,
): LogRecordTailState {
  if (action.type === 'reset') return { ...EMPTY_LOG_RECORD_TAIL_STATE, key: action.key }
  if (action.type === 'error') return { ...state, blockedAfterError: true }
  if (action.type === 'retry') return { ...state, blockedAfterError: false }

  const records = mergeLogRecordTailBuffer(state.records, action.records)
  return {
    key: state.key,
    records,
    cursor: latestLogRecordTailCursor(records),
    blockedAfterError: false,
  }
}

export function useLogRecordTail(
  serverName: string | null | undefined,
  archive: LogArchiveRuntime | null | undefined,
  options: { enabled?: boolean; paused?: boolean } = {},
) {
  const { creds } = useAuth()
  const normalizedServerName = serverName?.trim() ?? ''
  const visiblePollingInterval = useVisiblePollingInterval()
  const [tailState, dispatchTailState] = useReducer(logRecordTailReducer, EMPTY_LOG_RECORD_TAIL_STATE)
  const archiveName = archive?.name ?? ''
  const tailSelectionKey = logTailSelectionKey(normalizedServerName, archive)
  const baseEnabled =
    !!creds &&
    normalizedServerName.length > 0 &&
    !!archive &&
    archive.name.length > 0 &&
    (options.enabled ?? true)
  const pollingEnabled = baseEnabled && !(options.paused ?? false) && !tailState.blockedAfterError

  useEffect(() => {
    dispatchTailState({ type: 'reset', key: tailSelectionKey })
  }, [tailSelectionKey])

  const query = useQuery({
    queryKey: logRecordTailQueryKey(creds, normalizedServerName, archiveName),
    enabled: pollingEnabled,
    staleTime: 0,
    refetchInterval: visiblePollingInterval,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      if (!archive) throw new Error('Log archive not available')
      const cursor = tailState.key === tailSelectionKey ? tailState.cursor : null
      return fetchLogRecordTail(creds, normalizedServerName, archive, cursor)
    },
  })

  useEffect(() => {
    if (!query.data) return
    dispatchTailState({ type: 'records', records: query.data.records })
  }, [query.data, query.dataUpdatedAt])

  useEffect(() => {
    if (query.isError) dispatchTailState({ type: 'error' })
  }, [query.isError])

  useRefreshStaleQueryOnVisibleReturn({
    enabled: pollingEnabled,
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return {
    ...query,
    records: tailState.records,
    cursor: tailState.cursor,
    blockedAfterError: tailState.blockedAfterError,
    reset: () => {
      dispatchTailState({ type: 'reset', key: tailSelectionKey })
    },
    retry: async () => {
      dispatchTailState({ type: 'retry' })
      return query.refetch()
    },
  }
}

interface MultiLogRecordTailState {
  // Sources + severity the buffer belongs to; cursors from another selection must not be reused.
  key: string
  records: MultiLogTailRecord[]
  cursors: Record<string, LogRecordTailCursor | null>
  partialFailures: MultiLogTailSourceFailure[]
}

type MultiLogRecordTailAction =
  | { type: 'reset'; key: string }
  | { type: 'retryFailed' }
  | { type: 'records'; records: MultiLogTailRecord[]; partialFailures: MultiLogTailSourceFailure[] }

const EMPTY_MULTI_LOG_RECORD_TAIL_STATE: MultiLogRecordTailState = {
  key: '',
  records: [],
  cursors: {},
  partialFailures: [],
}

function multiLogRecordTailReducer(
  state: MultiLogRecordTailState,
  action: MultiLogRecordTailAction,
): MultiLogRecordTailState {
  if (action.type === 'reset') return { ...EMPTY_MULTI_LOG_RECORD_TAIL_STATE, key: action.key }
  if (action.type === 'retryFailed') return { ...state, partialFailures: [] }

  const records = mergeMultiLogTailBuffer(state.records, action.records)
  return {
    key: state.key,
    records,
    cursors: latestMultiLogTailCursors(records),
    partialFailures: mergeTailFailures(state.partialFailures, action.partialFailures),
  }
}

export function useMultiLogRecordTail(
  sources: MultiLogTailSource[],
  options: { enabled?: boolean; paused?: boolean; severityFloor?: LogSeverityFloor } = {},
) {
  const severityFloor = options.severityFloor ?? 'all'
  const { creds } = useAuth()
  const visiblePollingInterval = useVisiblePollingInterval()
  const [tailState, dispatchTailState] = useReducer(multiLogRecordTailReducer, EMPTY_MULTI_LOG_RECORD_TAIL_STATE)
  // The query function reads the tail state through a ref: a Retry clears the failures and
  // refetches in the same handler, before a render would hand the query a fresh closure.
  const tailStateRef = useRef(tailState)
  useEffect(() => {
    tailStateRef.current = tailState
  }, [tailState])
  const sourceKey = sources.map((source) => source.id).join(',')
  const baseEnabled = !!creds && sources.length > 0 && (options.enabled ?? true)
  const pollingEnabled = baseEnabled && !(options.paused ?? false)

  const tailKey = `${sourceKey}|${severityFloor}`
  useEffect(() => {
    dispatchTailState({ type: 'reset', key: tailKey })
  }, [tailKey])

  const query = useQuery({
    queryKey: multiLogRecordTailQueryKey(creds, sources, severityFloor),
    enabled: pollingEnabled,
    staleTime: 0,
    refetchInterval: visiblePollingInterval,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      const state = tailStateRef.current
      const current = state.key === tailKey
      const cursors = current ? state.cursors : {}
      const pollable = pollableTailSources(sources, current ? state.partialFailures : [])
      return fetchMultiLogRecordTail(creds, pollable, cursors, { severityFloor })
    },
  })

  useEffect(() => {
    if (!query.data) return
    dispatchTailState({
      type: 'records',
      records: query.data.records,
      partialFailures: query.data.partialFailures,
    })
  }, [query.data, query.dataUpdatedAt])

  useRefreshStaleQueryOnVisibleReturn({
    enabled: pollingEnabled,
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return {
    ...query,
    records: tailState.records,
    cursors: tailState.cursors,
    partialFailures: tailState.partialFailures,
    reset: () => dispatchTailState({ type: 'reset', key: tailKey }),
    retryFailed: () => {
      tailStateRef.current = { ...tailStateRef.current, partialFailures: [] }
      dispatchTailState({ type: 'retryFailed' })
      void query.refetch()
    },
  }
}
