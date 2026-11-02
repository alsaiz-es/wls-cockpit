import { useQuery } from '@tanstack/react-query'
import {
  WLS_REST_PROXY_BASE_URL,
  wlsBasicAuthHeader,
  wlsCredentialCacheKey,
  type WlsCredentials,
} from '../client.ts'
import { WLS_TARGET_HEADER } from '../proxy-target.ts'
import { useRefreshStaleQueryOnVisibleReturn, useVisiblePollingInterval } from '../query-polling.ts'
import { normalizeWlsRestError, WlsRestError, withWlsRestTimeout } from '../wls-errors.ts'
import { useAuth } from '../../auth/useAuth.ts'
import {
  WLS_HEALTH_STATES,
  WLS_LIFECYCLE_STATES,
  type WlsHealthState,
  type WlsLifecycleState,
} from '../../components/status-model.ts'
import type { ServerRuntimeRow } from './server-runtimes.ts'

export const CLUSTER_CONFIG_FIELDS = [
  'name',
  'clusterAddress',
  'clusterMessagingMode',
  'clusterType',
  'servers',
].join(',')

export const CLUSTER_RUNTIME_FIELDS = [
  'name',
  'healthState',
  'serverNames',
  'aliveServerCount',
  'primaryCount',
  'secondaryCount',
  'detailedSecondariesDistribution',
  'secondaryServerDetails',
  'activeSingletonServices',
].join(',')

export const CLUSTER_SERVER_LIFECYCLE_FIELDS = ['name', 'state'].join(',')

export const CLUSTER_SERVER_RUNTIME_FIELDS = [
  'name',
  'state',
  'healthState',
  'listenAddress',
  'listenPort',
  'defaultURL',
].join(',')

export const ASYNC_REPLICATION_FIELDS = [
  'name',
  'primaryCount',
  'secondaryCount',
  'detailedSecondariesDistribution',
  'secondaryServerDetails',
  'lastSessionsFlushTime',
  'sessionsWaitingForFlushCount',
].join(',')

export const MAN_REPLICATION_FIELDS = [
  'name',
  'primaryCount',
  'secondaryCount',
  'detailedSecondariesDistribution',
  'secondaryServerDetails',
  'activeServersInRemoteCluster',
  'remoteClusterReachable',
  'secondaryServerName',
].join(',')

export const WAN_REPLICATION_FIELDS = [
  'name',
  'primaryCount',
  'secondaryCount',
  'detailedSecondariesDistribution',
  'secondaryServerDetails',
  'numberOfSessionsFlushedToTheDatabase',
  'numberOfSessionsRetrievedFromTheDatabase',
  'remoteClusterReachable',
].join(',')

export const CLUSTER_REQUEST_TIMEOUT_MS = 7_500

export interface ClusterPartialFailure {
  clusterName: string
  serverName: string | null
  family: string
  message: string
}

export interface ClusterMemberRow {
  id: string
  clusterName: string
  serverName: string
  configured: boolean
  alive: boolean
  lifecycleState: WlsLifecycleState
  healthState: WlsHealthState
  listenAddress: string | null
  listenPort: number | null
  runtimeAvailable: boolean
}

export interface ClusterRuntimeRow {
  id: string
  clusterName: string
  serverName: string
  healthState: WlsHealthState
  aliveServerCount: number | null
  serverNames: string[]
  primaryCount: number | null
  secondaryCount: number | null
  detailedSecondariesDistribution: string[]
  secondaryServerDetails: string | null
  activeSingletonServices: string[]
}

export type ClusterReplicationFamily = 'async' | 'man' | 'wan'

export interface ClusterReplicationRow {
  id: string
  clusterName: string
  serverName: string
  family: ClusterReplicationFamily
  name: string
  primaryCount: number | null
  secondaryCount: number | null
  detailedSecondariesDistribution: string[]
  secondaryServerDetails: string | null
  lastSessionsFlushTime: number | null
  sessionsWaitingForFlushCount: number | null
  remoteClusterReachable: boolean | null
  activeServersInRemoteCluster: string[]
  secondaryServerName: string | null
  numberOfSessionsFlushedToTheDatabase: number | null
  numberOfSessionsRetrievedFromTheDatabase: number | null
}

export interface ClusterRow {
  id: string
  name: string
  clusterAddress: string | null
  clusterMessagingMode: string | null
  clusterType: string | null
  configuredMemberNames: string[]
  runtimeServerNames: string[]
  aliveServerCount: number | null
  healthState: WlsHealthState
  stateCounts: Partial<Record<WlsLifecycleState, number>>
  primaryCount: number | null
  secondaryCount: number | null
  activeSingletonServices: string[]
  members: ClusterMemberRow[]
  runtimeRows: ClusterRuntimeRow[]
  replicationRows: ClusterReplicationRow[]
  partialFailures: ClusterPartialFailure[]
}

export interface ClusterSnapshot {
  clusters: ClusterRow[]
  partialFailures: ClusterPartialFailure[]
}

export interface ClusterConfigRow {
  name: string
  clusterAddress: string | null
  clusterMessagingMode: string | null
  clusterType: string | null
  memberNames: string[]
}

interface ClusterServerRuntimeFailure {
  serverName: string
  family: string
  message: string
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

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => (typeof item === 'string' ? [item] : [])) : []
}

function normalizeHealth(value: unknown): WlsHealthState {
  if (typeof value !== 'string') return 'unknown'
  const normalized = value.toLowerCase() === 'warning' ? 'warn' : value.toLowerCase()
  return WLS_HEALTH_STATES.includes(normalized as WlsHealthState)
    ? (normalized as WlsHealthState)
    : 'unknown'
}

function healthFrom(value: unknown) {
  const health = isObject(value) ? value.healthState : null
  return normalizeHealth(isObject(health) ? health.state : null)
}

function normalizeLifecycle(value: unknown): WlsLifecycleState {
  return WLS_LIFECYCLE_STATES.includes(value as WlsLifecycleState)
    ? (value as WlsLifecycleState)
    : 'UNKNOWN'
}

function queryString(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}

function managementPath(creds: WlsCredentials, path: string, params?: Record<string, string>) {
  const suffix = params ? `?${queryString(params)}` : ''
  return `/management/weblogic/${encodeURIComponent(creds.version)}${path}${suffix}`
}

function serverRuntimePath(creds: WlsCredentials, serverName: string, suffix = '', params?: Record<string, string>) {
  return managementPath(
    creds,
    `/domainRuntime/serverRuntimes/${encodeURIComponent(serverName)}${suffix}`,
    params,
  )
}

async function fetchWlsJson(creds: WlsCredentials, operation: string, path: string, timeoutMs = CLUSTER_REQUEST_TIMEOUT_MS) {
  try {
    const response = await withWlsRestTimeout(
      operation,
      (signal) =>
        fetch(`${WLS_REST_PROXY_BASE_URL}${path}`, {
          signal,
          headers: {
            Accept: 'application/json',
            Authorization: wlsBasicAuthHeader(creds),
            [WLS_TARGET_HEADER]: creds.targetUrl,
          },
        }),
      timeoutMs,
    )

    if (!response.ok) {
      throw new WlsRestError({
        kind: 'http',
        operation,
        status: response.status,
        statusText: response.statusText,
        message: `${operation}: HTTP ${response.status} ${response.statusText || 'HTTP error'}`,
      })
    }

    return response.status === 204 ? null : response.json()
  } catch (error) {
    throw normalizeWlsRestError(operation, error, timeoutMs)
  }
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Cluster request failed.'
}

function hasRuntimeMBean(state: WlsLifecycleState) {
  return state === 'RUNNING' || state === 'ADMIN' || state === 'STANDBY'
}

function listenFromDefaultUrl(value: unknown) {
  const raw = readString(value)
  if (!raw) return { address: null, port: null }

  try {
    const url = new URL(raw)
    return {
      address: readString(url.hostname),
      port: url.port ? Number(url.port) : null,
    }
  } catch {
    const match = raw.match(/^[a-z][a-z0-9+.-]*:\/\/([^:/]+):(\d+)/i)
    return {
      address: match?.[1] ?? null,
      port: match?.[2] ? Number(match[2]) : null,
    }
  }
}

function synthesizeServerRuntimeRow(serverName: string, state: WlsLifecycleState): ServerRuntimeRow {
  return {
    name: serverName,
    state,
    healthState: 'unknown',
    listenAddress: null,
    listenPort: null,
    restartRequired: null,
    heap: null,
    jvm: null,
    threads: null,
  }
}

function normalizeClusterServerRuntime(data: unknown, fallbackName: string, lifecycleState: WlsLifecycleState): ServerRuntimeRow {
  if (!isObject(data)) return synthesizeServerRuntimeRow(fallbackName, lifecycleState)
  const health = isObject(data.healthState) ? data.healthState : null
  const defaultListen = listenFromDefaultUrl(data.defaultURL)
  return {
    name: readString(data.name) ?? fallbackName,
    state: normalizeLifecycle(data.state) === 'UNKNOWN' ? lifecycleState : normalizeLifecycle(data.state),
    healthState: normalizeHealth(health?.state),
    listenAddress: readString(data.listenAddress) ?? defaultListen.address,
    listenPort: readNumber(data.listenPort) ?? defaultListen.port,
    restartRequired: typeof data.restartRequired === 'boolean' ? data.restartRequired : null,
    heap: null,
    jvm: null,
    threads: null,
  }
}

function readServerIdentityNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isObject(item) || !Array.isArray(item.identity)) return []
    const kind = readString(item.identity[0])
    const name = readString(item.identity[1])
    return kind === 'servers' && name ? [name] : []
  })
}

export function normalizeClusterConfigs(data: unknown): ClusterConfigRow[] {
  const items = isObject(data) && Array.isArray(data.items) ? data.items : []
  return items.flatMap((item): ClusterConfigRow[] => {
    if (!isObject(item)) return []
    const name = readString(item.name)
    if (!name) return []
    return [{
      name,
      clusterAddress: readString(item.clusterAddress),
      clusterMessagingMode: readString(item.clusterMessagingMode),
      clusterType: readString(item.clusterType),
      memberNames: readServerIdentityNames(item.servers),
    }]
  })
}

export function normalizeClusterRuntime(data: unknown, clusterName: string, serverName: string): ClusterRuntimeRow | null {
  if (!isObject(data)) return null
  const name = readString(data.name) ?? clusterName
  return {
    id: `${clusterName}:runtime:${serverName}`,
    clusterName: name,
    serverName,
    healthState: healthFrom(data),
    aliveServerCount: readNumber(data.aliveServerCount),
    serverNames: readStringArray(data.serverNames),
    primaryCount: readNumber(data.primaryCount),
    secondaryCount: readNumber(data.secondaryCount),
    detailedSecondariesDistribution: readStringArray(data.detailedSecondariesDistribution),
    secondaryServerDetails: readString(data.secondaryServerDetails),
    activeSingletonServices: readStringArray(data.activeSingletonServices),
  }
}

export function normalizeClusterReplication(
  data: unknown,
  clusterName: string,
  serverName: string,
  family: ClusterReplicationFamily,
): ClusterReplicationRow | null {
  if (!isObject(data)) return null
  const name = readString(data.name) ?? family
  return {
    id: `${clusterName}:replication:${serverName}:${family}`,
    clusterName,
    serverName,
    family,
    name,
    primaryCount: readNumber(data.primaryCount),
    secondaryCount: readNumber(data.secondaryCount),
    detailedSecondariesDistribution: readStringArray(data.detailedSecondariesDistribution),
    secondaryServerDetails: readString(data.secondaryServerDetails),
    lastSessionsFlushTime: readNumber(data.lastSessionsFlushTime),
    sessionsWaitingForFlushCount: readNumber(data.sessionsWaitingForFlushCount),
    remoteClusterReachable: readBoolean(data.remoteClusterReachable),
    activeServersInRemoteCluster: readStringArray(data.activeServersInRemoteCluster),
    secondaryServerName: readString(data.secondaryServerName),
    numberOfSessionsFlushedToTheDatabase: readNumber(data.numberOfSessionsFlushedToTheDatabase),
    numberOfSessionsRetrievedFromTheDatabase: readNumber(data.numberOfSessionsRetrievedFromTheDatabase),
  }
}

const healthSeverity: WlsHealthState[] = ['ok', 'unknown', 'warn', 'overloaded', 'critical', 'failed']

function worstHealth(values: WlsHealthState[]) {
  if (values.length === 0) return 'unknown' as WlsHealthState
  return values.reduce((worst, value) =>
    healthSeverity.indexOf(value) > healthSeverity.indexOf(worst) ? value : worst,
  )
}

function sumNullable(values: Array<number | null>) {
  const numbers = values.filter((value): value is number => value !== null)
  if (numbers.length === 0) return null
  return numbers.reduce((sum, value) => sum + value, 0)
}

function maxNullable(values: Array<number | null>) {
  const numbers = values.filter((value): value is number => value !== null)
  if (numbers.length === 0) return null
  return Math.max(...numbers)
}

function serverListen(row: ServerRuntimeRow | undefined) {
  return {
    listenAddress: row?.listenAddress ?? null,
    listenPort: row?.listenPort ?? null,
  }
}

function memberRow(
  clusterName: string,
  serverName: string,
  server: ServerRuntimeRow | undefined,
  runtimeServerNames: Set<string>,
): ClusterMemberRow {
  const listen = serverListen(server)
  return {
    id: `${clusterName}:member:${serverName}`,
    clusterName,
    serverName,
    configured: true,
    alive: runtimeServerNames.has(serverName),
    lifecycleState: server?.state ?? 'UNKNOWN',
    healthState: server?.healthState ?? 'unknown',
    listenAddress: listen.listenAddress,
    listenPort: listen.listenPort,
    runtimeAvailable: !!server && hasRuntimeMBean(server.state),
  }
}

export function buildClusterRows({
  configs,
  servers,
  runtimes,
  replications,
  partialFailures,
}: {
  configs: ClusterConfigRow[]
  servers: ServerRuntimeRow[]
  runtimes: ClusterRuntimeRow[]
  replications: ClusterReplicationRow[]
  partialFailures: ClusterPartialFailure[]
}): ClusterRow[] {
  const serversByName = new Map(servers.map((server) => [server.name, server]))
  return configs.map((config) => {
    const runtimeRows = runtimes.filter((runtime) => runtime.clusterName === config.name)
    const runtimeServerNames = new Set(runtimeRows.flatMap((runtime) => runtime.serverNames))
    const configuredMemberNames = [...new Set(config.memberNames)].sort((a, b) => a.localeCompare(b))
    const members = configuredMemberNames.map((serverName) =>
      memberRow(config.name, serverName, serversByName.get(serverName), runtimeServerNames),
    )
    const stateCounts = members.reduce<Partial<Record<WlsLifecycleState, number>>>((counts, member) => {
      counts[member.lifecycleState] = (counts[member.lifecycleState] ?? 0) + 1
      return counts
    }, {})
    const activeSingletonServices = [...new Set(runtimeRows.flatMap((runtime) => runtime.activeSingletonServices))]
      .sort((a, b) => a.localeCompare(b))
    const clusterFailures = partialFailures.filter((failure) => failure.clusterName === config.name)
    const replicationRows = replications.filter((replication) => replication.clusterName === config.name)

    return {
      id: config.name,
      name: config.name,
      clusterAddress: config.clusterAddress,
      clusterMessagingMode: config.clusterMessagingMode,
      clusterType: config.clusterType,
      configuredMemberNames,
      runtimeServerNames: [...runtimeServerNames].sort((a, b) => a.localeCompare(b)),
      aliveServerCount: maxNullable(runtimeRows.map((runtime) => runtime.aliveServerCount)),
      healthState: worstHealth([
        ...members.map((member) => member.healthState),
        ...runtimeRows.map((runtime) => runtime.healthState),
      ]),
      stateCounts,
      primaryCount: sumNullable(runtimeRows.map((runtime) => runtime.primaryCount)),
      secondaryCount: sumNullable(runtimeRows.map((runtime) => runtime.secondaryCount)),
      activeSingletonServices,
      members,
      runtimeRows,
      replicationRows,
      partialFailures: clusterFailures,
    }
  })
}

async function fetchClusterConfigs(creds: WlsCredentials) {
  const data = await fetchWlsJson(
    creds,
    'Cluster configuration',
    managementPath(creds, '/edit/clusters', { fields: CLUSTER_CONFIG_FIELDS, links: 'none' }),
  )
  return normalizeClusterConfigs(data)
}

async function fetchClusterLifecycleStates(creds: WlsCredentials) {
  const data = await fetchWlsJson(
    creds,
    'Server lifecycle runtimes',
    managementPath(creds, '/domainRuntime/serverLifeCycleRuntimes', {
      fields: CLUSTER_SERVER_LIFECYCLE_FIELDS,
      links: 'none',
    }),
  )
  const states = new Map<string, WlsLifecycleState>()
  const items = isObject(data) && Array.isArray(data.items) ? data.items : []
  items.forEach((item) => {
    if (!isObject(item)) return
    const name = readString(item.name)
    if (name) states.set(name, normalizeLifecycle(item.state))
  })
  return states
}

async function fetchClusterServerRuntime(
  creds: WlsCredentials,
  serverName: string,
  lifecycleState: WlsLifecycleState,
): Promise<{ row: ServerRuntimeRow; failure: ClusterServerRuntimeFailure | null }> {
  if (!hasRuntimeMBean(lifecycleState)) {
    return { row: synthesizeServerRuntimeRow(serverName, lifecycleState), failure: null }
  }

  try {
    const data = await fetchWlsJson(
      creds,
      `Server runtime ${serverName}`,
      serverRuntimePath(creds, serverName, '', {
        fields: CLUSTER_SERVER_RUNTIME_FIELDS,
        links: 'none',
      }),
    )
    return { row: normalizeClusterServerRuntime(data, serverName, lifecycleState), failure: null }
  } catch (error) {
    return {
      row: synthesizeServerRuntimeRow(serverName, lifecycleState),
      failure: {
        serverName,
        family: 'serverRuntime',
        message: failureMessage(error),
      },
    }
  }
}

async function fetchClusterServerRows(creds: WlsCredentials) {
  const lifecycleStates = await fetchClusterLifecycleStates(creds)
  const results = await Promise.all(
    Array.from(lifecycleStates.entries()).map(([serverName, lifecycleState]) =>
      fetchClusterServerRuntime(creds, serverName, lifecycleState),
    ),
  )
  return {
    servers: results.map((result) => result.row),
    failures: results.flatMap((result) => result.failure ? [result.failure] : []),
  }
}

async function fetchOptionalReplication(
  creds: WlsCredentials,
  clusterName: string,
  serverName: string,
  family: ClusterReplicationFamily,
  path: string,
  fields: string,
) {
  try {
    const data = await fetchWlsJson(
      creds,
      `${family} replication ${serverName}`,
      serverRuntimePath(creds, serverName, path, { fields, links: 'none' }),
    )
    return { row: normalizeClusterReplication(data, clusterName, serverName, family), failure: null }
  } catch (error) {
    const status = error instanceof WlsRestError && error.kind === 'http' ? error.status : null
    if (status === 404) return { row: null, failure: null }
    return {
      row: null,
      failure: { clusterName, serverName, family: `${family}Replication`, message: failureMessage(error) },
    }
  }
}

async function fetchRuntimeForMember(
  creds: WlsCredentials,
  clusterName: string,
  server: ServerRuntimeRow,
): Promise<{
  runtime: ClusterRuntimeRow | null
  replications: ClusterReplicationRow[]
  failures: ClusterPartialFailure[]
}> {
  if (!hasRuntimeMBean(server.state)) {
    return {
      runtime: null,
      replications: [],
      failures: [{
        clusterName,
        serverName: server.name,
        family: 'clusterRuntime',
        message: `Server is ${server.state}; cluster runtime is unavailable.`,
      }],
    }
  }

  const failures: ClusterPartialFailure[] = []
  let runtime: ClusterRuntimeRow | null
  try {
    const data = await fetchWlsJson(
      creds,
      `Cluster runtime ${server.name}`,
      serverRuntimePath(creds, server.name, '/clusterRuntime', { fields: CLUSTER_RUNTIME_FIELDS, links: 'none' }),
    )
    runtime = normalizeClusterRuntime(data, clusterName, server.name)
  } catch (error) {
    return {
      runtime: null,
      replications: [],
      failures: [{ clusterName, serverName: server.name, family: 'clusterRuntime', message: failureMessage(error) }],
    }
  }

  const replicationResults = await Promise.all([
    fetchOptionalReplication(creds, clusterName, server.name, 'async', '/asyncReplicationRuntime', ASYNC_REPLICATION_FIELDS),
    fetchOptionalReplication(creds, clusterName, server.name, 'man', '/MANReplicationRuntime', MAN_REPLICATION_FIELDS),
    fetchOptionalReplication(creds, clusterName, server.name, 'wan', '/WANReplicationRuntime', WAN_REPLICATION_FIELDS),
  ])
  replicationResults.forEach((result) => {
    if (result.failure) failures.push(result.failure)
  })

  return {
    runtime,
    replications: replicationResults.flatMap((result) => result.row ? [result.row] : []),
    failures,
  }
}

export function clustersQueryKey(creds: WlsCredentials | null | undefined) {
  return ['clusters', wlsCredentialCacheKey(creds)] as const
}

export async function fetchClusterSnapshot(creds: WlsCredentials): Promise<ClusterSnapshot> {
  const configs = await fetchClusterConfigs(creds)
  const partialFailures: ClusterPartialFailure[] = []
  let servers: ServerRuntimeRow[] = []
  try {
    const serverRows = await fetchClusterServerRows(creds)
    servers = serverRows.servers
    serverRows.failures.forEach((failure) => {
      configs.forEach((config) => {
        if (!config.memberNames.includes(failure.serverName)) return
        partialFailures.push({
          clusterName: config.name,
          serverName: failure.serverName,
          family: failure.family,
          message: failure.message,
        })
      })
    })
  } catch (error) {
    partialFailures.push(...configs.map((config) => ({
      clusterName: config.name,
      serverName: null,
      family: 'serverRuntimes',
      message: failureMessage(error),
    })))
  }

  const serversByName = new Map(servers.map((server) => [server.name, server]))
  const runtimeCandidates = configs.flatMap((config) =>
    config.memberNames.flatMap((serverName) => {
      const server = serversByName.get(serverName)
      return server ? [{ clusterName: config.name, server }] : []
    }),
  )
  const runtimeResults = await Promise.all(
    runtimeCandidates.map((candidate) => fetchRuntimeForMember(creds, candidate.clusterName, candidate.server)),
  )
  partialFailures.push(...runtimeResults.flatMap((result) => result.failures))

  const clusters = buildClusterRows({
    configs,
    servers,
    runtimes: runtimeResults.flatMap((result) => result.runtime ? [result.runtime] : []),
    replications: runtimeResults.flatMap((result) => result.replications),
    partialFailures,
  })

  return { clusters, partialFailures }
}

export function useClusterSnapshot() {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval(60_000)
  const query = useQuery({
    queryKey: clustersQueryKey(creds),
    enabled: !!creds,
    staleTime: 30_000,
    refetchInterval: livePollingInterval,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchClusterSnapshot(creds)
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
