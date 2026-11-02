import { createClient12, createClient14, type WlsCredentials } from '../client.ts'
import { createWlsHttpError, withWlsRestTimeout } from '../wls-errors.ts'
import {
  normalizeJdbcPool,
  type JdbcPoolRuntime,
} from './dashboard-jdbc-normalization.ts'
import { shouldFetchJmsDestinations } from './dashboard-jms-gating.ts'
import { classifyDashboardJms } from './dashboard-jms-classification.ts'
import type { ServerMetricCaptureSession } from './server-metric-capture-store.ts'
import { fetchServerRuntimeDetail, type ServerRuntimeRow } from './server-runtimes.ts'
import type { JmsRuntimeSummary } from './domain-dashboard.ts'

export interface ServerMetricCaptureSnapshot {
  server: ServerRuntimeRow
  jdbc: JdbcPoolRuntime[]
  jms: JmsRuntimeSummary[]
  failures: string[]
}

export const SERVER_METRIC_CAPTURE_JDBC_RUNTIME_FIELDS =
  'name,state,deploymentState,activeConnectionsCurrentCount,currCapacity,waitingForConnectionCurrentCount,leakedConnectionCount'
export const SERVER_METRIC_CAPTURE_JMS_SERVER_FIELDS =
  'name,state,messagesCurrentCount,messagesPendingCount,destinationsCurrentCount,consumptionPaused,productionPaused,insertionPaused,consumptionPausedState,productionPausedState,insertionPausedState'
export const SERVER_METRIC_CAPTURE_JMS_DESTINATION_FIELDS =
  'name,destinationType,state,messagesCurrentCount,messagesPendingCount,consumersCurrentCount,consumptionPaused,productionPaused,insertionPaused,consumptionPausedState,productionPausedState,insertionPausedState'

export const SERVER_METRIC_CAPTURE_SELECTED_ENDPOINTS = [
  'serverRuntime',
  'jvmRuntime',
  'threadPoolRuntime',
  'jdbcDataSourceRuntimeMBeans',
  'jmsServers',
  'jmsDestinations',
] as const

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readItems(value: unknown): unknown[] {
  if (!isObject(value) || !Array.isArray(value.items)) return []
  return value.items
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function isRuntimeServer(server: ServerRuntimeRow) {
  return server.state === 'RUNNING'
}

function normalizeJmsSummary(
  serverName: string,
  jmsServerName: string,
  item: unknown,
  fallbackDestinationName?: string | null,
): JmsRuntimeSummary | null {
  if (!isObject(item)) return null

  const destinationName = fallbackDestinationName === undefined ? readString(item.name) : fallbackDestinationName
  const summary = {
    serverName,
    jmsServerName,
    destinationName,
    destinationType: readString(item.destinationType),
    state: readString(item.state),
    destinationsCurrentCount: readNumber(item.destinationsCurrentCount),
    messagesCurrentCount: readNumber(item.messagesCurrentCount),
    messagesPendingCount: readNumber(item.messagesPendingCount),
    consumersCurrentCount: readNumber(item.consumersCurrentCount),
    consumptionPaused: readBoolean(item.consumptionPaused),
    productionPaused: readBoolean(item.productionPaused),
    insertionPaused: readBoolean(item.insertionPaused),
    consumptionPausedState: readString(item.consumptionPausedState),
    productionPausedState: readString(item.productionPausedState),
    insertionPausedState: readString(item.insertionPausedState),
  }

  return { ...summary, severity: classifyDashboardJms(summary) }
}

async function fetchJdbcConfiguredMaxCapacities(creds: WlsCredentials) {
  const client = clientFor(creds)
  const resources = await withWlsRestTimeout('JDBC configuration', (signal) =>
    client.GET('/management/weblogic/{version}/edit/JDBCSystemResources', {
      signal,
      params: {
        path: { version: creds.version },
        query: { fields: 'name', links: 'none' },
      },
    }),
  )

  if (resources.error) throw createWlsHttpError('JDBC configuration', resources.response, resources.error)

  const outcomes = await Promise.allSettled(
    readItems(resources.data).map(async (item) => {
      if (!isObject(item)) return null
      const systemResourceName = readString(item.name)
      if (!systemResourceName) return null
      const pool = await withWlsRestTimeout(`JDBC pool ${systemResourceName}`, (signal) =>
        client.GET(
          '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCConnectionPoolParams',
          {
            signal,
            params: {
              path: { version: creds.version, systemResourceName },
              query: { fields: 'maxCapacity', links: 'none' },
            },
          },
        ),
      )
      if (pool.error) throw createWlsHttpError(`JDBC pool ${systemResourceName}`, pool.response, pool.error)
      return [systemResourceName, readNumber(isObject(pool.data) ? pool.data.maxCapacity : null)] as const
    }),
  )

  return new Map(
    outcomes.flatMap((outcome) => {
      if (outcome.status !== 'fulfilled' || !outcome.value) return []
      return [outcome.value]
    }),
  )
}

async function fetchSelectedJdbcPools(creds: WlsCredentials, serverName: string) {
  const client = clientFor(creds)
  const configOutcome = await Promise.allSettled([fetchJdbcConfiguredMaxCapacities(creds)])
  const configuredMaxCapacities =
    configOutcome[0]?.status === 'fulfilled' ? configOutcome[0].value : new Map<string, number | null>()
  const res = await withWlsRestTimeout(`JDBC ${serverName}`, (signal) =>
    client.GET(
      '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans',
      {
        signal,
        params: {
          path: { version: creds.version, serverName },
          query: { fields: SERVER_METRIC_CAPTURE_JDBC_RUNTIME_FIELDS, links: 'none' },
        },
      },
    ),
  )

  if (res.error) throw createWlsHttpError(`JDBC ${serverName}`, res.response, res.error)
  return readItems(res.data).flatMap((item) => {
    const name = isObject(item) ? readString(item.name) : null
    const pool = normalizeJdbcPool(serverName, item, name ? (configuredMaxCapacities.get(name) ?? null) : null)
    return pool ? [pool] : []
  })
}

async function fetchSelectedJmsRuntime(creds: WlsCredentials, serverName: string) {
  const client = clientFor(creds)
  const res = await withWlsRestTimeout(`JMS ${serverName}`, (signal) =>
    client.GET('/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JMSRuntime/JMSServers', {
      signal,
      params: {
        path: { version: creds.version, serverName },
        query: { fields: SERVER_METRIC_CAPTURE_JMS_SERVER_FIELDS, links: 'none' },
      },
    }),
  )

  if (res.error) throw createWlsHttpError(`JMS ${serverName}`, res.response, res.error)

  const jmsServers = readItems(res.data).flatMap((item) => {
    if (!isObject(item)) return []
    const name = readString(item.name)
    return name ? [{ name, item }] : []
  })
  const rows = await Promise.allSettled(
    jmsServers.map(async ({ name, item }) => {
      const serverRow = normalizeJmsSummary(serverName, name, item, null)
      if (!serverRow || !shouldFetchJmsDestinations(serverRow)) return serverRow ? [serverRow] : []

      const destinations = await withWlsRestTimeout(`JMS destinations ${serverName}/${name}`, (signal) =>
        client.GET(
          '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JMSRuntime/JMSServers/{JMSServerName}/destinations',
          {
            signal,
            params: {
              path: { version: creds.version, serverName, JMSServerName: name },
              query: { fields: SERVER_METRIC_CAPTURE_JMS_DESTINATION_FIELDS, links: 'none' },
            },
          },
        ),
      )

      if (destinations.error) {
        throw createWlsHttpError(`JMS destinations ${serverName}/${name}`, destinations.response, destinations.error)
      }

      const destinationRows = readItems(destinations.data).flatMap((destination) => {
        const row = normalizeJmsSummary(serverName, name, destination)
        return row ? [row] : []
      })

      return destinationRows.length > 0 ? destinationRows : [serverRow]
    }),
  )

  return rows.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []))
}

export async function fetchServerMetricCaptureSnapshot(
  creds: WlsCredentials,
  serverName: string,
): Promise<ServerMetricCaptureSnapshot | null> {
  const server = await fetchServerRuntimeDetail(creds, serverName)
  if (!server) return null
  if (!isRuntimeServer(server)) return { server, jdbc: [], jms: [], failures: [] }

  const [jdbc, jms] = await Promise.allSettled([
    fetchSelectedJdbcPools(creds, server.name),
    fetchSelectedJmsRuntime(creds, server.name),
  ])

  return serverMetricCaptureSnapshotFromSettled(server, jdbc, jms)
}

export function serverMetricCaptureFailureMessage(family: 'jdbc' | 'jms', reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason)
  return `${family}: ${message}`
}

export function serverMetricCaptureSnapshotFromSettled(
  server: ServerRuntimeRow,
  jdbc: PromiseSettledResult<JdbcPoolRuntime[]>,
  jms: PromiseSettledResult<JmsRuntimeSummary[]>,
): ServerMetricCaptureSnapshot {
  return {
    server,
    jdbc: jdbc.status === 'fulfilled' ? jdbc.value : [],
    jms: jms.status === 'fulfilled' ? jms.value : [],
    failures: [
      ...(jdbc.status === 'rejected' ? [serverMetricCaptureFailureMessage('jdbc', jdbc.reason)] : []),
      ...(jms.status === 'rejected' ? [serverMetricCaptureFailureMessage('jms', jms.reason)] : []),
    ],
  }
}

export function serverMetricCapturePollQueryKey(
  scopeKey: string | null | undefined,
  serverName: string,
  sessionId: string,
) {
  return ['serverMetricCapturePoll', scopeKey ?? '', serverName, sessionId] as const
}

export function serverMetricCapturePollInterval(
  visible: boolean,
  session: Pick<ServerMetricCaptureSession, 'status' | 'pollingIntervalMs' | 'pollWhileHidden'> | null | undefined,
) {
  return (visible || session?.pollWhileHidden === true) && session?.status === 'active'
    ? session.pollingIntervalMs
    : false
}
