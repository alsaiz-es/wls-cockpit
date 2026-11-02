import { useQuery } from '@tanstack/react-query'
import { createClient12, createClient14, wlsCredentialCacheKey, type WlsCredentials } from '@/api/client'
import {
  useRefreshStaleQueryOnVisibleReturn,
  useVisiblePollingInterval,
} from '@/api/query-polling'
import { fetchServerRuntimeRows, type ServerRuntimeRow } from '@/api/queries/server-runtimes'
import { createWlsHttpError, withWlsRestTimeout } from '@/api/wls-errors'
import { useAuth } from '@/auth/useAuth'
import { healthTone, lifecycleTone, type StatusTone, type WlsHealthState } from '@/components'
import {
  normalizeJdbcPool,
  type JdbcPoolRuntime as NormalizedJdbcPoolRuntime,
} from './dashboard-jdbc-normalization.ts'
import { hasJmsPauseSignal, shouldFetchJmsDestinations } from './dashboard-jms-gating.ts'
import { classifyDashboardJms } from './dashboard-jms-classification.ts'
import { buildObservedServerDownIssues, buildRestartRequiredIssues } from './dashboard-observed-servers.ts'
import {
  collectDashboardFamilyFanout,
  dashboardFanoutErrorMessage,
  dashboardPartialFailures,
  toDashboardFamilyResult,
  type OptionalFamilyPayload,
  type OptionalFamilyResult,
} from './dashboard-family-fanout.ts'
import { applicationHealthDetail, firstHealthReason } from './deployment-health-symptoms.ts'
import { heapUtilization } from './heap-utilization.ts'
import { AlertSustainTracker, getActiveAlertRules } from '../alert-rules.ts'
import {
  evaluateServerPressure,
  isDashboardIssueIgnored,
  sustainedJdbcSeverity,
  sustainedJmsSeverity,
  type DashboardAlertContext,
  type ServerAlertLevels,
} from './dashboard-alert-levels.ts'

export type DashboardSeverity = 'healthy' | 'warning' | 'critical' | 'unknown'
export type DashboardFamily = 'servers' | 'jvm' | 'threads' | 'jdbc' | 'jms' | 'applications' | 'logs'
export type FamilyStatus = 'available' | 'empty' | 'failed'

export interface DashboardIssue {
  id: string
  severity: Exclude<DashboardSeverity, 'healthy' | 'unknown'>
  family: DashboardFamily
  title: string
  detail: string
  hint?: string
  serverName?: string
  resourceName?: string
  deploymentName?: string
  jmsServerName?: string
  destinationName?: string
  snapshotServers?: string[]
}

export type FamilyResult<T> = OptionalFamilyResult<T>

export type JdbcPoolRuntime = NormalizedJdbcPoolRuntime

export interface ApplicationRuntimeSummary {
  serverName: string
  name: string
  deploymentName: string
  internal: boolean
  healthState: WlsHealthState
  overallHealthState: WlsHealthState
  activeVersionState: number | null
  deploymentState: string | number | null
  // First WebLogic health symptom, e.g. 'MDB application X is NOT connected to messaging system.'
  healthReason: string | null
  severity: DashboardSeverity
}

export interface LogActivityRuntime {
  serverName: string
  messagesLogged: number | null
  logFileStreamOpened: boolean | null
  status: 'available' | 'unavailable'
  error?: string
}

export interface JmsRuntimeSummary {
  serverName: string
  jmsServerName: string
  destinationName: string | null
  destinationType: string | null
  state: string | null
  destinationsCurrentCount: number | null
  messagesCurrentCount: number | null
  messagesPendingCount: number | null
  consumersCurrentCount: number | null
  consumptionPaused: boolean | null
  productionPaused: boolean | null
  insertionPaused: boolean | null
  consumptionPausedState: string | null
  productionPausedState: string | null
  insertionPausedState: string | null
  severity: DashboardSeverity
}

export interface ServerRollup {
  total: number
  running: number
  warning: number
  stopped: number
  failed: number
  unknown: number
}

export interface RuntimePressure {
  highestHeap: { serverName: string; current: number; max: number; percent: number } | null
  heapUnavailable: number
  heapUnavailableServers: string[]
  totalThreads: number | null
  idleThreads: number | null
  pendingUserRequests: number
  hoggingThreads: number
  queueLength: number
  stuckThreads: number
  threadsUnavailable: number
  threadsUnavailableServers: string[]
}

export interface ApplicationRollup {
  total: number
  internal: number
  external: number
  healthy: number
  unhealthy: number
}

export interface JmsRollup {
  jmsServers: number
  destinations: number
  messagesCurrent: number
  messagesPending: number
  zeroConsumerBacklog: number
  paused: number
}

export interface DashboardSnapshot {
  severity: DashboardSeverity
  servers: ServerRuntimeRow[]
  serverRollup: ServerRollup
  runtimePressure: RuntimePressure
  jdbc: FamilyResult<JdbcPoolRuntime>
  jms: FamilyResult<JmsRuntimeSummary>
  jmsRollup: JmsRollup
  applications: FamilyResult<ApplicationRuntimeSummary>
  applicationRollup: ApplicationRollup
  logs: FamilyResult<LogActivityRuntime>
  issues: DashboardIssue[]
  // Alert level per server and thresholded signal (absent in fixtures).
  serverAlerts?: Record<string, ServerAlertLevels>
  partialFailures: Array<{ family: DashboardFamily; resource?: string; message: string }>
}

export function domainDashboardQueryKey(creds: WlsCredentials | null | undefined) {
  return ['domainDashboard', wlsCredentialCacheKey(creds)] as const
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

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function normalizeHealth(value: unknown): WlsHealthState {
  if (typeof value !== 'string') return 'unknown'
  const normalized = value.toLowerCase() === 'warning' ? 'warn' : value.toLowerCase()
  return ['ok', 'warn', 'critical', 'failed', 'overloaded', 'unknown'].includes(normalized)
    ? (normalized as WlsHealthState)
    : 'unknown'
}

function healthFromObject(value: unknown): WlsHealthState {
  return normalizeHealth(isObject(value) ? value.state : null)
}

function isRuntimeServer(row: ServerRuntimeRow) {
  return row.state === 'RUNNING' || row.state === 'ADMIN' || row.state === 'STANDBY'
}

function severityFromTone(tone: StatusTone): DashboardSeverity {
  if (tone === 'negative') return 'critical'
  if (tone === 'warning') return 'warning'
  if (tone === 'positive' || tone === 'neutral') return 'healthy'
  return 'unknown'
}

function worseSeverity(a: DashboardSeverity, b: DashboardSeverity): DashboardSeverity {
  const order: DashboardSeverity[] = ['unknown', 'healthy', 'warning', 'critical']
  return order.indexOf(b) > order.indexOf(a) ? b : a
}

const observedRunningServers = new Set<string>()

function classifyApplication(app: Omit<ApplicationRuntimeSummary, 'severity'>): DashboardSeverity {
  const healthSeverity = worseSeverity(
    severityFromTone(healthTone(app.healthState)),
    severityFromTone(healthTone(app.overallHealthState)),
  )
  if (healthSeverity === 'critical') return 'critical'
  if (healthSeverity === 'warning') return 'warning'

  if (
    app.deploymentState !== null &&
    app.deploymentState !== 2 &&
    app.deploymentState !== 'ACTIVATED' &&
    app.deploymentState !== 'ACTIVE'
  ) {
    return 'warning'
  }

  return 'healthy'
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

function normalizeApplication(serverName: string, item: unknown): ApplicationRuntimeSummary | null {
  if (!isObject(item)) return null

  const deploymentName = readString(item.name)
  const name = readString(item.applicationName) ?? deploymentName
  if (!name) return null

  const app = {
    serverName,
    name,
    deploymentName: deploymentName ?? name,
    internal: readBoolean(item.internal) ?? false,
    healthState: healthFromObject(item.healthState),
    overallHealthState: healthFromObject(item.overallHealthState),
    activeVersionState: readNumber(item.activeVersionState),
    deploymentState: readString(item.deploymentState) ?? readNumber(item.deploymentState),
    healthReason: firstHealthReason(item.healthState, item.overallHealthState),
  }

  return { ...app, severity: classifyApplication(app) }
}

export function classifyJms(item: Omit<JmsRuntimeSummary, 'severity'>): DashboardSeverity {
  return classifyDashboardJms(item)
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

  return { ...summary, severity: classifyJms(summary) }
}

async function fetchJdbcPools(creds: WlsCredentials, servers: ServerRuntimeRow[]) {
  const client = clientFor(creds)
  const runningServers = servers.filter(isRuntimeServer)
  const configOutcome = await Promise.allSettled([fetchJdbcConfiguredMaxCapacities(creds)])
  const configuredMaxCapacities =
    configOutcome[0]?.status === 'fulfilled' ? configOutcome[0].value : new Map<string, number | null>()

  return collectDashboardFamilyFanout(
    runningServers,
    async (server) => {
      const res = await withWlsRestTimeout(`JDBC ${server.name}`, (signal) =>
        client.GET(
          '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans',
          {
            signal,
            params: {
              path: { version: creds.version, serverName: server.name },
              query: {
                fields:
                  'name,state,deploymentState,activeConnectionsCurrentCount,currCapacity,waitingForConnectionCurrentCount,leakedConnectionCount',
                links: 'none',
              },
            },
          },
        ),
      )

      if (res.error) throw createWlsHttpError(`JDBC ${server.name}`, res.response, res.error)
      return readItems(res.data).flatMap((item) => {
        const name = isObject(item) ? readString(item.name) : null
        const pool = normalizeJdbcPool(server.name, item, name ? (configuredMaxCapacities.get(name) ?? null) : null)
        return pool ? [pool] : []
      })
    },
    (server) => server.name,
  )
}

async function fetchApplications(creds: WlsCredentials, servers: ServerRuntimeRow[]) {
  const client = clientFor(creds)
  const runningServers = servers.filter(isRuntimeServer)

  return collectDashboardFamilyFanout(
    runningServers,
    async (server) => {
      const res = await withWlsRestTimeout(`Applications ${server.name}`, (signal) =>
        client.GET(
          '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/applicationRuntimes',
          {
            signal,
            params: {
              path: { version: creds.version, serverName: server.name },
              query: {
                fields:
                  'name,applicationName,internal,healthState,overallHealthState,activeVersionState,deploymentState',
                links: 'none',
              },
            },
          },
        ),
      )

      if (res.error) throw createWlsHttpError(`Applications ${server.name}`, res.response, res.error)
      return readItems(res.data).flatMap((item) => {
        const app = normalizeApplication(server.name, item)
        return app ? [app] : []
      })
    },
    (server) => server.name,
  )
}

async function fetchJmsRuntime(creds: WlsCredentials, servers: ServerRuntimeRow[]) {
  const client = clientFor(creds)
  const runningServers = servers.filter(isRuntimeServer)
  const jmsServerFields =
    'name,state,messagesCurrentCount,messagesPendingCount,destinationsCurrentCount,consumptionPaused,productionPaused,insertionPaused,consumptionPausedState,productionPausedState,insertionPausedState'
  const destinationFields =
    'name,destinationType,state,messagesCurrentCount,messagesPendingCount,consumersCurrentCount,consumptionPaused,productionPaused,insertionPaused,consumptionPausedState,productionPausedState,insertionPausedState'

  return collectDashboardFamilyFanout(
    runningServers,
    async (server) => {
      const res = await withWlsRestTimeout(`JMS ${server.name}`, (signal) =>
        client.GET('/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JMSRuntime/JMSServers', {
          signal,
          params: {
            path: { version: creds.version, serverName: server.name },
            query: { fields: jmsServerFields, links: 'none' },
          },
        }),
      )

      if (res.error) throw createWlsHttpError(`JMS ${server.name}`, res.response, res.error)

      const jmsServers = readItems(res.data).flatMap((item) => {
        if (!isObject(item)) return []
        const name = readString(item.name)
        return name ? [{ name, item }] : []
      })

      return collectDashboardFamilyFanout(
        jmsServers,
        async ({ name, item }) => {
          const serverRow = normalizeJmsSummary(server.name, name, item, null)
          if (!serverRow || !shouldFetchJmsDestinations(serverRow)) return serverRow ? [serverRow] : []

          try {
            const destinations = await withWlsRestTimeout(`JMS destinations ${server.name}/${name}`, (signal) =>
              client.GET(
                '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JMSRuntime/JMSServers/{JMSServerName}/destinations',
                {
                  signal,
                  params: {
                    path: { version: creds.version, serverName: server.name, JMSServerName: name },
                    query: { fields: destinationFields, links: 'none' },
                  },
                },
              ),
            )

            if (destinations.error) {
              throw createWlsHttpError(`JMS destinations ${server.name}/${name}`, destinations.response, destinations.error)
            }
            const destinationRows = readItems(destinations.data).flatMap((destination) => {
              const row = normalizeJmsSummary(server.name, name, destination)
              return row ? [row] : []
            })

            return destinationRows.length > 0 || !serverRow ? destinationRows : [serverRow]
          } catch (error) {
            return {
              attempted: 1,
              successful: serverRow ? 1 : 0,
              items: serverRow ? [serverRow] : [],
              failures: [{ resource: `${server.name}/${name}`, message: dashboardFanoutErrorMessage(error) }],
            }
          }
        },
        ({ name }) => `${server.name}/${name}`,
      )
    },
    (server) => server.name,
  )
}

async function fetchLogActivity(creds: WlsCredentials, servers: ServerRuntimeRow[]) {
  const client = clientFor(creds)
  const runningServers = servers.filter(isRuntimeServer)

  return collectDashboardFamilyFanout(
    runningServers,
    async (server): Promise<LogActivityRuntime[]> => {
      const [broadcaster, logRuntime] = await Promise.all([
        withWlsRestTimeout(`Log broadcaster ${server.name}`, (signal) =>
          client.GET(
            '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/logBroadcasterRuntime',
            {
              signal,
              params: {
                path: { version: creds.version, serverName: server.name },
                query: { fields: 'messagesLogged', links: 'none' },
              },
            },
          ),
        ),
        withWlsRestTimeout(`Server log ${server.name}`, (signal) =>
          client.GET('/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/serverLogRuntime', {
            signal,
            params: {
              path: { version: creds.version, serverName: server.name },
              query: { fields: 'logFileStreamOpened', links: 'none' },
            },
          }),
        ),
      ])

      if (broadcaster.error && logRuntime.error) {
        const broadcasterError = createWlsHttpError('Log broadcaster', broadcaster.response, broadcaster.error)
        const logRuntimeError = createWlsHttpError('server log', logRuntime.response, logRuntime.error)
        return [
          {
            serverName: server.name,
            messagesLogged: null,
            logFileStreamOpened: null,
            status: 'unavailable',
            error: `${broadcasterError.message}; ${logRuntimeError.message}`,
          },
        ]
      }

      return [
        {
          serverName: server.name,
          messagesLogged: broadcaster.error ? null : readNumber(broadcaster.data?.messagesLogged),
          logFileStreamOpened: logRuntime.error ? null : readBoolean(logRuntime.data?.logFileStreamOpened),
          status: 'available',
        },
      ]
    },
    (server) => server.name,
  )
}

async function familyResult<T>(
  family: DashboardFamily,
  fetcher: () => Promise<T[] | OptionalFamilyPayload<T>>,
): Promise<FamilyResult<T>> {
  try {
    return toDashboardFamilyResult(family, await fetcher())
  } catch (error) {
    return {
      status: 'failed',
      items: [],
      error: `${family}: ${dashboardFanoutErrorMessage(error)}`,
      failures: [{ resource: family, message: dashboardFanoutErrorMessage(error) }],
    }
  }
}

function buildServerRollup(servers: ServerRuntimeRow[]): ServerRollup {
  return servers.reduce<ServerRollup>(
    (rollup, server) => {
      rollup.total += 1
      const tone = lifecycleTone(server.state)
      if (tone === 'positive') rollup.running += 1
      else if (tone === 'warning') rollup.warning += 1
      else if (tone === 'negative') rollup.failed += 1
      else if (tone === 'neutral') rollup.stopped += 1
      else rollup.unknown += 1
      return rollup
    },
    { total: 0, running: 0, warning: 0, stopped: 0, failed: 0, unknown: 0 },
  )
}

function buildRuntimePressure(servers: ServerRuntimeRow[]): RuntimePressure {
  let highestHeap: RuntimePressure['highestHeap'] = null
  let heapUnavailable = 0
  const heapUnavailableServers: string[] = []
  let totalThreads = 0
  let idleThreads = 0
  let pendingUserRequests = 0
  let hoggingThreads = 0
  let queueLength = 0
  let threadsUnavailable = 0
  let idleUnavailable = 0
  let stuckThreads = 0
  const threadsUnavailableServers: string[] = []

  servers.forEach((server) => {
    const percent = heapUtilization(server.heap)
    if (server.heap && percent !== null) {
      if (!highestHeap || percent > highestHeap.percent) {
        highestHeap = { serverName: server.name, current: server.heap.current, max: server.heap.max, percent }
      }
    } else if (isRuntimeServer(server)) {
      heapUnavailable += 1
      heapUnavailableServers.push(server.name)
    }

    if (server.threads) {
      totalThreads += server.threads.total
      if (server.threads.idle === null) idleUnavailable += 1
      else idleThreads += server.threads.idle
      pendingUserRequests += server.threads.pending ?? 0
      hoggingThreads += server.threads.hogging ?? 0
      queueLength += server.threads.queueLength ?? 0
      stuckThreads += server.threads.stuck
    } else if (isRuntimeServer(server)) {
      threadsUnavailable += 1
      idleUnavailable += 1
      threadsUnavailableServers.push(server.name)
    }
  })

  return {
    highestHeap,
    heapUnavailable,
    heapUnavailableServers,
    totalThreads: threadsUnavailable === servers.length ? null : totalThreads,
    idleThreads: idleUnavailable === servers.length ? null : idleThreads,
    pendingUserRequests,
    hoggingThreads,
    queueLength,
    stuckThreads,
    threadsUnavailable,
    threadsUnavailableServers,
  }
}

function buildApplicationRollup(applications: ApplicationRuntimeSummary[]): ApplicationRollup {
  return applications.reduce<ApplicationRollup>(
    (rollup, app) => {
      rollup.total += 1
      if (app.internal) rollup.internal += 1
      else rollup.external += 1
      if (app.severity === 'healthy') rollup.healthy += 1
      else rollup.unhealthy += 1
      return rollup
    },
    { total: 0, internal: 0, external: 0, healthy: 0, unhealthy: 0 },
  )
}

function buildJmsRollup(items: JmsRuntimeSummary[]): JmsRollup {
  const jmsServers = new Set(items.map((item) => `${item.serverName}:${item.jmsServerName}`))
  return items.reduce<JmsRollup>(
    (rollup, item) => {
      if (item.destinationName) rollup.destinations += 1
      rollup.messagesCurrent += item.messagesCurrentCount ?? 0
      rollup.messagesPending += item.messagesPendingCount ?? 0
      if (item.destinationName && (item.messagesCurrentCount ?? 0) > 0 && item.consumersCurrentCount === 0) {
        rollup.zeroConsumerBacklog += 1
      }
      if (hasJmsPauseSignal(item)) {
        rollup.paused += 1
      }
      return rollup
    },
    {
      jmsServers: jmsServers.size,
      destinations: 0,
      messagesCurrent: 0,
      messagesPending: 0,
      zeroConsumerBacklog: 0,
      paused: 0,
    },
  )
}

function issueSeverity(severity: DashboardSeverity): DashboardIssue['severity'] {
  return severity === 'critical' ? 'critical' : 'warning'
}

function issueSnapshotServers(...serverNames: Array<string | null | undefined>) {
  const unique = new Set(serverNames.map((serverName) => serverName?.trim()).filter(Boolean) as string[])
  return unique.size > 0 ? Array.from(unique).sort((a, b) => a.localeCompare(b)) : undefined
}

export function resetDashboardObservedRunningServersForTest() {
  observedRunningServers.clear()
}

export function buildDashboardIssues(
  servers: ServerRuntimeRow[],
  jdbc: FamilyResult<JdbcPoolRuntime>,
  jms: FamilyResult<JmsRuntimeSummary>,
  applications: FamilyResult<ApplicationRuntimeSummary>,
  logs: FamilyResult<LogActivityRuntime>,
  context: DashboardAlertContext = { rules: getActiveAlertRules(), tracker: null, now: Date.now() },
  pressureIssues: DashboardIssue[] = evaluateServerPressure(servers, context).issues,
): DashboardIssue[] {
  const issues: DashboardIssue[] = []

  issues.push(...buildObservedServerDownIssues(servers, observedRunningServers))
  issues.push(...buildRestartRequiredIssues(servers))

  servers.forEach((server) => {
    const lifecycleSeverity = severityFromTone(lifecycleTone(server.state))
    const healthSeverity = severityFromTone(healthTone(server.healthState))
    const severity = worseSeverity(lifecycleSeverity, healthSeverity)
    if (severity !== 'healthy' && severity !== 'unknown') {
      issues.push({
        id: `server:${server.name}`,
        severity: issueSeverity(severity),
        family: 'servers',
        title: `${server.name} requires attention`,
        detail: `Lifecycle ${server.state}, health ${server.healthState}.`,
        hint: 'Open server detail to inspect lifecycle, health, JVM, and task history before acting.',
        serverName: server.name,
        snapshotServers: issueSnapshotServers(server.name),
      })
    }
  })

  issues.push(...pressureIssues)

  jdbc.items.forEach((pool) => {
    if (pool.severity === 'healthy' || pool.severity === 'unknown') return
    issues.push({
      id: `jdbc:${pool.serverName}:${pool.name}`,
      severity: issueSeverity(pool.severity),
      family: 'jdbc',
      title: `${pool.name} has JDBC pressure`,
      detail: `State ${pool.state}, active ${pool.activeConnectionsCurrentCount ?? 'n/a'}, max ${
        pool.utilizationCapacity ?? 'n/a'
      }, created ${pool.currCapacity ?? 'n/a'}, waiting ${pool.waitingForConnectionCurrentCount ?? 'n/a'}, leaked ${
        pool.leakedConnectionCount ?? 'n/a'
      }.`,
      hint: 'Open datasource detail to inspect pool pressure; use logs as the adjacent signal for application errors.',
      serverName: pool.serverName,
      resourceName: pool.name,
      snapshotServers: issueSnapshotServers(pool.serverName),
    })
  })

  jms.items.forEach((item) => {
    if (item.severity === 'healthy' || item.severity === 'unknown') return
    const resourceName = item.destinationName ?? item.jmsServerName
    issues.push({
      id: `jms:${item.serverName}:${item.jmsServerName}:${resourceName}`,
      severity: issueSeverity(item.severity),
      family: 'jms',
      title: `${resourceName} has JMS pressure`,
      detail: `Messages ${item.messagesCurrentCount ?? 'n/a'}, pending ${
        item.messagesPendingCount ?? 'n/a'
      }, consumers ${item.consumersCurrentCount ?? 'n/a'}, paused ${
        item.consumptionPaused || item.productionPaused || item.insertionPaused ? 'yes' : 'no'
      }.`,
      hint: 'Open JMS detail to inspect backlog, consumers, pause state, and optional message browsing support.',
      serverName: item.serverName,
      resourceName,
      jmsServerName: item.jmsServerName,
      destinationName: item.destinationName ?? undefined,
      snapshotServers: issueSnapshotServers(item.serverName),
    })
  })

  applications.items.forEach((app) => {
    if (app.severity === 'healthy' || app.severity === 'unknown') return
    issues.push({
      id: `app:${app.serverName}:${app.deploymentName}`,
      severity: issueSeverity(app.severity),
      family: 'applications',
      title: `${app.name} is not healthy`,
      detail: applicationHealthDetail(app),
      hint: 'Open deployment detail to inspect runtime health, request metrics, targets, and web module signals.',
      serverName: app.serverName,
      resourceName: app.name,
      deploymentName: app.deploymentName,
      snapshotServers: issueSnapshotServers(app.serverName),
    })
  })

  logs.items.forEach((log) => {
    if (log.status === 'available') return
    issues.push({
      id: `log:${log.serverName}`,
      severity: 'warning',
      family: 'logs',
      title: `${log.serverName} log activity unavailable`,
      detail: log.error ?? 'No log activity signal was returned.',
      hint: 'Open the server log route to verify archive availability and inspect recent records manually.',
      serverName: log.serverName,
      snapshotServers: issueSnapshotServers(log.serverName),
    })
  })

  return issues.filter((issue) => !isDashboardIssueIgnored(issue, context.rules)).sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1
    return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function buildSeverity(issues: DashboardIssue[], servers: ServerRuntimeRow[]): DashboardSeverity {
  if (servers.length === 0) return 'unknown'
  if (issues.some((issue) => issue.severity === 'critical')) return 'critical'
  if (issues.some((issue) => issue.severity === 'warning')) return 'warning'
  return 'healthy'
}

// One tracker per signed-in domain and user, kept across polls so durations span readings.
let liveAlertTracker: { scope: string; tracker: AlertSustainTracker } | null = null

function liveAlertTrackerFor(creds: WlsCredentials) {
  const scope = wlsCredentialCacheKey(creds)
  if (liveAlertTracker?.scope !== scope) liveAlertTracker = { scope, tracker: new AlertSustainTracker() }
  return liveAlertTracker.tracker
}

// Live polling passes the tracker; a one-off snapshot (the diagnostic export) judges each reading
// on its own and leaves the live durations untouched.
export async function fetchDomainDashboardSnapshot(
  creds: WlsCredentials,
  options: { tracker?: AlertSustainTracker | null } = {},
): Promise<DashboardSnapshot> {
  const servers = await fetchServerRuntimeRows(creds)
  const [rawJdbc, rawJms, applications, logs] = await Promise.all([
    familyResult('jdbc', () => fetchJdbcPools(creds, servers)),
    familyResult('jms', () => fetchJmsRuntime(creds, servers)),
    familyResult('applications', () => fetchApplications(creds, servers)),
    familyResult('logs', () => fetchLogActivity(creds, servers)),
  ])

  const context: DashboardAlertContext = { rules: getActiveAlertRules(), tracker: options.tracker ?? null, now: Date.now() }
  const jdbc = { ...rawJdbc, items: rawJdbc.items.map((pool) => ({ ...pool, severity: sustainedJdbcSeverity(pool, context) })) }
  const jms = { ...rawJms, items: rawJms.items.map((item) => ({ ...item, severity: sustainedJmsSeverity(item, context) })) }
  const pressure = evaluateServerPressure(servers, context)
  const issues = buildDashboardIssues(servers, jdbc, jms, applications, logs, context, pressure.issues)
  context.tracker?.prune(context.now)
  const partialFailures = dashboardPartialFailures([
    { family: 'jdbc', result: jdbc },
    { family: 'jms', result: jms },
    { family: 'applications', result: applications },
    { family: 'logs', result: logs },
  ])

  return {
    severity: buildSeverity(issues, servers),
    servers,
    serverRollup: buildServerRollup(servers),
    runtimePressure: buildRuntimePressure(servers),
    jdbc,
    jms,
    jmsRollup: buildJmsRollup(jms.items),
    applications,
    applicationRollup: buildApplicationRollup(applications.items),
    logs,
    issues,
    serverAlerts: pressure.levels,
    partialFailures,
  }
}

export function useDomainDashboard(options: { enabled?: boolean } = {}) {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval()

  const query = useQuery({
    queryKey: domainDashboardQueryKey(creds),
    enabled: !!creds && (options.enabled ?? true),
    staleTime: 0,
    refetchInterval: livePollingInterval,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchDomainDashboardSnapshot(creds, { tracker: liveAlertTrackerFor(creds) })
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds && (options.enabled ?? true),
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}

// The alert levels of the last dashboard poll (AppShell keeps it running), for heap bars outside
// the dashboard. Reads the cache only; it never starts a request of its own.
const NO_SERVER_ALERTS: Record<string, ServerAlertLevels> = {}

export function useServerAlertLevels(): Record<string, ServerAlertLevels> {
  const { creds } = useAuth()
  const query = useQuery({
    queryKey: domainDashboardQueryKey(creds),
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchDomainDashboardSnapshot(creds, { tracker: liveAlertTrackerFor(creds) })
    },
    enabled: false,
  })
  return query.data?.serverAlerts ?? NO_SERVER_ALERTS
}
