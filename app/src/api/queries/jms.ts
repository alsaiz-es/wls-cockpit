import { useQuery } from '@tanstack/react-query'
import {
  createClient12,
  createClient14,
  wlsBasicAuthHeader,
  wlsCredentialCacheKey,
  type WlsCredentials,
} from '@/api/client'
import { actionAuditHeaders } from '@/api/action-audit-headers'
import {
  useRefreshStaleQueryOnVisibleReturn,
  useVisiblePollingInterval,
} from '@/api/query-polling'
import { fetchServerRuntimeRows, type ServerRuntimeRow } from '@/api/queries/server-runtimes'
import { createWlsHttpError, withWlsRestTimeout } from '@/api/wls-errors'

// The local server kills the JMX helper after 30 s (plus up to 15 s to compile it on first use);
// the browser gives up a little later instead of waiting forever if the local server hangs.
const JMS_JMX_CLIENT_TIMEOUT_MS = 50_000
import { useAuth } from '@/auth/useAuth'
import { dashboardFanoutErrorMessage } from './dashboard-family-fanout.ts'
import {
  jmsDestinationDetailQueryParams,
  jmsDestinationsQueryParams,
  jmsServersQueryParams,
  jmsTasksQueryParams,
  normalizeJmsRuntimeRow,
  normalizeJmsMessageBrowseSnapshot,
  normalizeJmsMessageDeleteResult,
  normalizeJmsMessageDetailResult,
  normalizeJmsMessageProduceResult,
  normalizeJmsTaskSummary,
  jmsDestinationPauseOperationAvailable,
  jmsDestinationPauseOperationPath,
  jmsPausedStateLabel,
  jmsPausedValue,
  jmsPauseDimensionLabel,
  jmsPauseOperationName,
  normalizeJmsBrowseUrlState,
  formatJmsMessageProduceFeedback,
  formatJmsMessageDeleteFeedback,
  serializeJmsBrowseUrlState,
  unsupportedJmsMessageBrowseSnapshot,
  type JmsDestinationRow,
  type JmsMessageDeleteResult,
  type JmsMessageDetailResult,
  type JmsMessageProduceResult,
  type JmsMessageBrowseSnapshot,
  type JmsPartialFailure,
  type JmsPauseAction,
  type JmsPauseDimension,
  type JmsStatus,
  type JmsTaskSummary,
} from './jms-normalization.ts'

export {
  jmsDestinationDetailQueryParams,
  jmsDestinationsQueryParams,
  jmsServersQueryParams,
  jmsTasksQueryParams,
  normalizeJmsRuntimeRow,
  normalizeJmsMessageBrowseSnapshot,
  normalizeJmsMessageDeleteResult,
  normalizeJmsMessageDetailResult,
  normalizeJmsMessageProduceResult,
  normalizeJmsTaskSummary,
  jmsDestinationPauseOperationAvailable,
  jmsDestinationPauseOperationPath,
  jmsPausedStateLabel,
  jmsPausedValue,
  jmsPauseDimensionLabel,
  jmsPauseOperationName,
  normalizeJmsBrowseUrlState,
  formatJmsMessageProduceFeedback,
  formatJmsMessageDeleteFeedback,
  serializeJmsBrowseUrlState,
  unsupportedJmsMessageBrowseSnapshot,
}
export type {
  JmsBrowsedMessageRow,
  JmsDestinationRow,
  JmsMessageDeleteResult,
  JmsMessageDetailResult,
  JmsMessageDetailRow,
  JmsMessageProduceResult,
  JmsMessageBrowseSnapshot,
  JmsMessageBrowseSupport,
  JmsPartialFailure,
  JmsPauseAction,
  JmsPauseDimension,
  JmsRowKind,
  JmsSeverity,
  JmsStatus,
  JmsTaskSummary,
} from './jms-normalization.ts'

export interface JmsSnapshot {
  status: JmsStatus
  rows: JmsDestinationRow[]
  partialFailures: JmsPartialFailure[]
  // Servers without a JMS runtime to read (stopped, starting…), so the page can say they are
  // missing instead of silently leaving them out.
  notReporting: Array<{ serverName: string; state: string }>
}

export interface JmsDestinationDetailSnapshot {
  status: JmsStatus
  row: JmsDestinationRow | null
  tasks: JmsTaskSummary[]
  partialFailures: JmsPartialFailure[]
}

export interface JmsMessageBrowseOptions {
  selector?: string
  offset?: number
  limit?: number
}

export interface JmsMessageProduceRequest {
  body: string
  correlationId?: string
  properties?: Record<string, string>
  priority?: number
  deliveryMode?: 'NON_PERSISTENT' | 'PERSISTENT'
  ttlMillis?: number
}

export interface JmsPauseDestinationRequest {
  creds: WlsCredentials
  serverName: string
  jmsServerName: string
  destinationName: string
  dimension: JmsPauseDimension
  action: JmsPauseAction
}

export function jmsQueryKey(creds: WlsCredentials | null | undefined) {
  return ['jms', wlsCredentialCacheKey(creds)] as const
}

export function jmsDestinationDetailQueryKey(
  creds: WlsCredentials | null | undefined,
  serverName: string,
  jmsServerName: string,
  destinationName: string,
) {
  return ['jmsDestinationDetail', wlsCredentialCacheKey(creds), serverName, jmsServerName, destinationName] as const
}

export function jmsMessageBrowseQueryKey(
  creds: WlsCredentials | null | undefined,
  serverName: string,
  jmsServerName: string,
  destinationName: string,
  options: JmsMessageBrowseOptions = {},
) {
  return [
    'jmsMessageBrowse',
    wlsCredentialCacheKey(creds),
    serverName,
    jmsServerName,
    destinationName,
    options.selector ?? '',
    options.offset ?? 0,
    options.limit ?? 25,
  ] as const
}

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readItems(data: unknown): unknown[] {
  return isObject(data) && Array.isArray(data.items) ? data.items : []
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isOptionalNotFound(outcome: PromiseSettledResult<{ error?: unknown; response: Response }>) {
  return outcome.status === 'fulfilled' && !!outcome.value.error && outcome.value.response.status === 404
}

async function readLocalErrorDetail(response: Response) {
  try {
    const payload = (await response.json()) as unknown
    if (isObject(payload)) {
      if (typeof payload.error === 'string') return { message: payload.error, diagnostics: [] as string[] }
      if (isObject(payload.error)) {
        const diagnostics = Array.isArray(payload.error.diagnostics)
          ? payload.error.diagnostics.filter((item): item is string => typeof item === 'string')
          : []
        if (typeof payload.error.message === 'string') return { message: payload.error.message, diagnostics }
      }
    }
  } catch {
    // Ignore non-JSON error bodies from local helper failures.
  }
  return { message: `HTTP ${response.status} ${response.statusText}`.trim(), diagnostics: [] as string[] }
}

async function readLocalErrorMessage(response: Response) {
  return (await readLocalErrorDetail(response)).message
}

function isRuntimeServer(row: ServerRuntimeRow) {
  return row.state === 'RUNNING' || row.state === 'ADMIN' || row.state === 'STANDBY'
}

async function fetchServerJmsDestinations(creds: WlsCredentials, server: ServerRuntimeRow) {
  const client = clientFor(creds)
  const res = await withWlsRestTimeout(`JMS ${server.name}`, (signal) =>
    client.GET('/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JMSRuntime/JMSServers', {
      signal,
      params: {
        path: { version: creds.version, serverName: server.name },
        query: jmsServersQueryParams(),
      },
    }),
  )

  if (res.error) throw createWlsHttpError(`JMS ${server.name}`, res.response, res.error)

  const jmsServers = readItems(res.data).flatMap((item) => {
    if (!isObject(item)) return []
    const name = readString(item.name)
    const row = name ? normalizeJmsRuntimeRow({ serverName: server.name, jmsServerName: name, item, destinationName: null }) : null
    return name && row ? [{ name, row }] : []
  })

  const outcomes = await Promise.allSettled(
    jmsServers.map(async ({ name, row }) => {
      const destinations = await withWlsRestTimeout(`JMS destinations ${server.name}/${name}`, (signal) =>
        client.GET(
          '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JMSRuntime/JMSServers/{JMSServerName}/destinations',
          {
            signal,
            params: {
              path: { version: creds.version, serverName: server.name, JMSServerName: name },
              query: jmsDestinationsQueryParams(),
            },
          },
        ),
      )

      if (destinations.error) {
        throw createWlsHttpError(`JMS destinations ${server.name}/${name}`, destinations.response, destinations.error)
      }

      const destinationRows = readItems(destinations.data).flatMap((destination) => {
        const destinationRow = normalizeJmsRuntimeRow({
          serverName: server.name,
          jmsServerName: name,
          item: destination,
        })
        return destinationRow ? [destinationRow] : []
      })

      return {
        rows: destinationRows.length > 0 ? destinationRows : [row],
        failures: [] as JmsPartialFailure[],
      }
    }),
  )

  return outcomes.reduce<{ rows: JmsDestinationRow[]; failures: JmsPartialFailure[] }>(
    (payload, outcome, index) => {
      if (outcome.status === 'fulfilled') {
        payload.rows.push(...outcome.value.rows)
        return payload
      }

      const summary = jmsServers[index]
      if (summary) payload.rows.push(summary.row)
      payload.failures.push({
        serverName: server.name,
        jmsServerName: summary?.name,
        family: 'destinations',
        message: dashboardFanoutErrorMessage(outcome.reason),
      })
      return payload
    },
    { rows: [], failures: [] },
  )
}

export async function fetchJmsSnapshot(creds: WlsCredentials): Promise<JmsSnapshot> {
  const servers = await fetchServerRuntimeRows(creds)
  const runningServers = servers.filter(isRuntimeServer)
  const outcomes = await Promise.allSettled(runningServers.map((server) => fetchServerJmsDestinations(creds, server)))
  const rows = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value.rows : []))
  const partialFailures = outcomes.flatMap((outcome, index) => {
    if (outcome.status === 'fulfilled') return outcome.value.failures
    const serverName = runningServers[index]?.name ?? 'unknown'
    return [{ serverName, family: 'jmsServers' as const, message: dashboardFanoutErrorMessage(outcome.reason) }]
  })

  return {
    status: partialFailures.length ? 'partial' : rows.length ? 'available' : 'empty',
    rows,
    partialFailures,
    notReporting: servers.filter((server) => !isRuntimeServer(server)).map((server) => ({ serverName: server.name, state: server.state })),
  }
}

export async function fetchJmsDestinationDetail(
  creds: WlsCredentials,
  serverName: string,
  jmsServerName: string,
  destinationName: string,
): Promise<JmsDestinationDetailSnapshot> {
  const client = clientFor(creds)
  const [detailOutcome, tasksOutcome] = await Promise.allSettled([
    withWlsRestTimeout(`JMS destination ${serverName}/${jmsServerName}/${destinationName}`, (signal) =>
      client.GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JMSRuntime/JMSServers/{JMSServerName}/destinations/{destinationName}',
        {
          signal,
          params: {
            path: { version: creds.version, serverName, JMSServerName: jmsServerName, destinationName },
            query: jmsDestinationDetailQueryParams(),
          },
        },
      ),
    ),
    withWlsRestTimeout(`JMS tasks ${serverName}/${jmsServerName}/${destinationName}`, (signal) =>
      client.GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JMSRuntime/JMSServers/{JMSServerName}/destinations/{destinationName}/tasks',
        {
          signal,
          params: {
            path: { version: creds.version, serverName, JMSServerName: jmsServerName, destinationName },
            query: jmsTasksQueryParams(),
          },
        },
      ),
    ),
  ])

  const partialFailures: JmsPartialFailure[] = []
  let row: JmsDestinationRow | null = null
  let tasks: JmsTaskSummary[] = []

  if (detailOutcome.status === 'fulfilled' && !detailOutcome.value.error) {
    row = normalizeJmsRuntimeRow({
      serverName,
      jmsServerName,
      item: detailOutcome.value.data,
    })
  } else {
    const reason =
      detailOutcome.status === 'rejected'
        ? detailOutcome.reason
        : createWlsHttpError(`JMS destination ${serverName}/${jmsServerName}/${destinationName}`, detailOutcome.value.response)
    partialFailures.push({
      serverName,
      jmsServerName,
      family: 'destinationDetail',
      message: dashboardFanoutErrorMessage(reason),
    })
  }

  if (tasksOutcome.status === 'fulfilled' && !tasksOutcome.value.error) {
    tasks = readItems(tasksOutcome.value.data).flatMap((item) => {
      const task = normalizeJmsTaskSummary(item)
      return task ? [task] : []
    })
  } else if (isOptionalNotFound(tasksOutcome)) {
    tasks = []
  } else {
    const reason =
      tasksOutcome.status === 'rejected'
        ? tasksOutcome.reason
        : createWlsHttpError(`JMS tasks ${serverName}/${jmsServerName}/${destinationName}`, tasksOutcome.value.response)
    partialFailures.push({
      serverName,
      jmsServerName,
      family: 'tasks',
      message: dashboardFanoutErrorMessage(reason),
    })
  }

  return {
    status: partialFailures.length ? 'partial' : row ? 'available' : 'empty',
    row,
    tasks,
    partialFailures,
  }
}

export async function fetchJmsMessageBrowse(
  creds: WlsCredentials,
  serverName: string,
  jmsServerName: string,
  destinationName: string,
  options: JmsMessageBrowseOptions = {},
): Promise<JmsMessageBrowseSnapshot> {
  const selector = options.selector ?? ''
  const offset = options.offset ?? 0
  const limit = options.limit ?? 25

  const response = await withWlsRestTimeout(`JMS /api/jms/messages`, (signal) =>
    fetch('/api/jms/messages', {
      method: 'POST',
      signal,
      headers: {
        Accept: 'application/json',
        Authorization: wlsBasicAuthHeader(creds),
        'Content-Type': 'application/json',
        ...actionAuditHeaders(creds),
      },
      body: JSON.stringify({ serverName, jmsServerName, destinationName, selector, offset, limit }),
    }),
    JMS_JMX_CLIENT_TIMEOUT_MS,
  )

  if (!response.ok) {
    const detail = await readLocalErrorDetail(response)
    return unsupportedJmsMessageBrowseSnapshot(serverName, jmsServerName, detail.message, detail.diagnostics)
  }

  return normalizeJmsMessageBrowseSnapshot({
    input: await response.json(),
    serverName,
    jmsServerName,
    selector,
    offset,
    limit,
  })
}

export async function deleteJmsMessage({
  creds,
  serverName,
  jmsServerName,
  destinationName,
  messageId,
}: {
  creds: WlsCredentials
  serverName: string
  jmsServerName: string
  destinationName: string
  messageId: string
}): Promise<JmsMessageDeleteResult> {
  return deleteJmsMessages({ creds, serverName, jmsServerName, destinationName, messageIds: [messageId] })
}

export async function deleteJmsMessages({
  creds,
  serverName,
  jmsServerName,
  destinationName,
  messageIds,
}: {
  creds: WlsCredentials
  serverName: string
  jmsServerName: string
  destinationName: string
  messageIds: string[]
}): Promise<JmsMessageDeleteResult> {
  const response = await withWlsRestTimeout(`JMS /api/jms/messages/delete`, (signal) =>
    fetch('/api/jms/messages/delete', {
      method: 'POST',
      signal,
      headers: {
        Accept: 'application/json',
        Authorization: wlsBasicAuthHeader(creds),
        'Content-Type': 'application/json',
        ...actionAuditHeaders(creds),
      },
      body: JSON.stringify({ serverName, jmsServerName, destinationName, messageIds }),
    }),
    JMS_JMX_CLIENT_TIMEOUT_MS,
  )

  if (!response.ok) throw new Error(await readLocalErrorMessage(response))
  return normalizeJmsMessageDeleteResult(await response.json())
}

export async function pauseJmsDestination({
  creds,
  serverName,
  jmsServerName,
  destinationName,
  dimension,
  action,
}: JmsPauseDestinationRequest): Promise<void> {
  const operation = `${action} ${jmsPauseDimensionLabel(dimension).toLowerCase()}`
  const path = jmsDestinationPauseOperationPath({
    version: creds.version,
    serverName,
    jmsServerName,
    destinationName,
    dimension,
    action,
  })
  const response = await withWlsRestTimeout(`JMS destination ${operation}`, (signal) =>
    fetch(`/api/wls${path}`, {
      method: 'POST',
      signal,
      headers: {
        Accept: 'application/json',
        Authorization: wlsBasicAuthHeader(creds),
        'Content-Type': 'application/json',
        'X-Requested-By': 'wls-cockpit',
        ...actionAuditHeaders(creds),
      },
      body: JSON.stringify({}),
    }),
  )

  if (!response.ok) throw createWlsHttpError(`JMS destination ${operation}`, response)
}

export async function fetchJmsMessageDetail({
  creds,
  serverName,
  jmsServerName,
  destinationName,
  messageId,
}: {
  creds: WlsCredentials
  serverName: string
  jmsServerName: string
  destinationName: string
  messageId: string
}): Promise<JmsMessageDetailResult> {
  const response = await withWlsRestTimeout(`JMS /api/jms/messages/detail`, (signal) =>
    fetch('/api/jms/messages/detail', {
      method: 'POST',
      signal,
      headers: {
        Accept: 'application/json',
        Authorization: wlsBasicAuthHeader(creds),
        'Content-Type': 'application/json',
        ...actionAuditHeaders(creds),
      },
      body: JSON.stringify({ serverName, jmsServerName, destinationName, messageId }),
    }),
    JMS_JMX_CLIENT_TIMEOUT_MS,
  )

  if (!response.ok) throw new Error(await readLocalErrorMessage(response))
  return normalizeJmsMessageDetailResult(await response.json())
}

export async function produceJmsMessage({
  creds,
  serverName,
  jmsServerName,
  destinationName,
  destinationType,
  request,
}: {
  creds: WlsCredentials
  serverName: string
  jmsServerName: string
  destinationName: string
  destinationType: string
  request: JmsMessageProduceRequest
}): Promise<JmsMessageProduceResult> {
  const response = await withWlsRestTimeout(`JMS /api/jms/messages/produce`, (signal) =>
    fetch('/api/jms/messages/produce', {
      method: 'POST',
      signal,
      headers: {
        Accept: 'application/json',
        Authorization: wlsBasicAuthHeader(creds),
        'Content-Type': 'application/json',
        ...actionAuditHeaders(creds),
      },
      body: JSON.stringify({ serverName, jmsServerName, destinationName, destinationType, ...request }),
    }),
    JMS_JMX_CLIENT_TIMEOUT_MS,
  )

  if (!response.ok) throw new Error(await readLocalErrorMessage(response))
  return normalizeJmsMessageProduceResult(await response.json())
}

export function useJmsDestinations() {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval()

  const query = useQuery({
    queryKey: jmsQueryKey(creds),
    enabled: !!creds,
    staleTime: 0,
    refetchInterval: livePollingInterval,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchJmsSnapshot(creds)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds,
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}

export function useJmsDestinationDetail(serverName: string, jmsServerName: string, destinationName: string) {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval()

  const query = useQuery({
    queryKey: jmsDestinationDetailQueryKey(creds, serverName, jmsServerName, destinationName),
    enabled: !!creds && !!serverName && !!jmsServerName && !!destinationName,
    staleTime: 0,
    refetchInterval: livePollingInterval,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchJmsDestinationDetail(creds, serverName, jmsServerName, destinationName)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds && !!serverName && !!jmsServerName && !!destinationName,
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}

export function useJmsMessageBrowse(
  serverName: string,
  jmsServerName: string,
  destinationName: string,
  options: JmsMessageBrowseOptions = {},
) {
  const { creds } = useAuth()

  return useQuery({
    queryKey: jmsMessageBrowseQueryKey(creds, serverName, jmsServerName, destinationName, options),
    enabled: !!creds && !!serverName && !!jmsServerName && !!destinationName,
    staleTime: 60_000,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchJmsMessageBrowse(creds, serverName, jmsServerName, destinationName, options)
    },
  })
}
