import { useQuery } from '@tanstack/react-query'
import { createClient12, createClient14, wlsCredentialCacheKey, type WlsCredentials } from '../client.ts'
import {
  useRefreshStaleQueryOnVisibleReturn,
  useVisiblePollingInterval,
} from '../query-polling.ts'
import { fetchServerRuntimeRows, type ServerRuntimeRow } from './server-runtimes.ts'
import { createWlsHttpError, withWlsRestTimeout } from '../wls-errors.ts'
import { useAuth } from '../../auth/useAuth.ts'
import type { DeploymentTargetRef } from './deployments'
import { classifyJdbcPool } from './dashboard-jdbc-normalization.ts'
import {
  dataSourceConfigCollectionQueryParams,
  dataSourceParamsQueryParams,
  normalizeDataSourceParamsMetadata,
  readDataSourceTargetRefs,
} from './data-source-config-normalization.ts'
import {
  resolveDataSourceUtilization,
  type DataSourceUtilizationCapacitySource,
} from './data-source-utilization.ts'
import {
  dataSourceRuntimeDetailQueryParams,
  dataSourceRuntimeQueryParams,
  normalizeDataSourceRuntimeCounters,
  normalizeDataSourceRuntimeDatabaseMetadata,
  normalizeDataSourceRuntimeStatementCacheCounters,
  type DataSourceRuntimeCounters,
  type DataSourceRuntimeDatabaseMetadata,
  type DataSourceRuntimeStatementCacheCounters,
} from './data-source-runtime-normalization.ts'
import {
  mergeDataSourceRuntimeDetailFields,
  type DataSourceRuntimeDetailFields,
} from './data-source-detail-merge.ts'

export type DataSourceSeverity = 'healthy' | 'warning' | 'critical' | 'unknown'
export type DataSourceStatus = 'available' | 'empty' | 'partial'

export interface DataSourceRuntimeRow
  extends DataSourceRuntimeCounters,
    DataSourceRuntimeDatabaseMetadata,
    DataSourceRuntimeStatementCacheCounters {
  id: string
  name: string
  serverName: string
  runtimeAvailable: boolean
  systemResourceName: string | null
  configurationSupported: boolean
  configuredTargets: DeploymentTargetRef[]
  jndiNames: string[]
  driverName: string | null
  url: string | null
  databaseUser: string | null
  configuredInitialCapacity: number | null
  configuredMinCapacity: number | null
  configuredMaxCapacity: number | null
  testTableName: string | null
  globalTransactionsProtocol: string | null
  useXaDataSourceInterface: boolean | null
  algorithmType: string | null
  scope: string | null
  dataSourceList: string | null
  keepConnAfterGlobalTx: boolean | null
  testConnectionsOnReserve: boolean | null
  testFrequencySeconds: number | null
  secondsToTrustAnIdlePoolConnection: number | null
  countOfTestFailuresTillFlush: number | null
  countOfRefreshFailuresTillDisable: number | null
  statementCacheSize: number | null
  statementCacheType: string | null
  statementTimeout: number | null
  shrinkFrequencySeconds: number | null
  inactiveConnectionTimeoutSeconds: number | null
  connectionReserveTimeoutSeconds: number | null
  connectionCreationRetryFrequencySeconds: number | null
  loginDelaySeconds: number | null
  highestNumWaiters: number | null
  removeInfectedConnections: boolean | null
  pinnedToThread: boolean | null
  wrapJdbc: boolean | null
  wrapTypes: boolean | null
  invokeBeginEndRequest: boolean | null
  state: string
  deploymentState: string | number | null
  activeConnectionsCurrentCount: number | null
  currCapacity: number | null
  waitingForConnectionCurrentCount: number | null
  leakedConnectionCount: number | null
  utilization: number | null
  utilizationCapacity: number | null
  utilizationCapacitySource: DataSourceUtilizationCapacitySource | null
  severity: DataSourceSeverity
}

export interface DataSourcesSnapshot {
  status: DataSourceStatus
  rows: DataSourceRuntimeRow[]
  runtimeRows: DataSourceRuntimeRow[]
  servers: ServerRuntimeRow[]
  partialFailures: Array<{ serverName: string; message: string }>
}

export type DataSourceRuntimeDetail = DataSourceRuntimeDetailFields

export interface DataSourceConfigsSnapshot {
  configs: Map<string, DataSourceConfig>
  failures: Array<{ serverName: string; message: string }>
}

export interface DataSourceSelectedDetailSnapshot {
  status: DataSourceStatus
  row: DataSourceRuntimeRow | null
  partialFailures: Array<{ serverName: string; message: string }>
}

export interface DataSourceConfig {
  systemResourceName: string
  configuredTargets: DeploymentTargetRef[]
  jndiNames: string[]
  driverName: string | null
  url: string | null
  databaseUser: string | null
  configuredInitialCapacity: number | null
  configuredMinCapacity: number | null
  configuredMaxCapacity: number | null
  testTableName: string | null
  globalTransactionsProtocol: string | null
  useXaDataSourceInterface: boolean | null
  algorithmType: string | null
  scope: string | null
  dataSourceList: string | null
  keepConnAfterGlobalTx: boolean | null
  testConnectionsOnReserve: boolean | null
  testFrequencySeconds: number | null
  secondsToTrustAnIdlePoolConnection: number | null
  countOfTestFailuresTillFlush: number | null
  countOfRefreshFailuresTillDisable: number | null
  statementCacheSize: number | null
  statementCacheType: string | null
  statementTimeout: number | null
  shrinkFrequencySeconds: number | null
  inactiveConnectionTimeoutSeconds: number | null
  connectionReserveTimeoutSeconds: number | null
  connectionCreationRetryFrequencySeconds: number | null
  loginDelaySeconds: number | null
  highestNumWaiters: number | null
  removeInfectedConnections: boolean | null
  pinnedToThread: boolean | null
  wrapJdbc: boolean | null
  wrapTypes: boolean | null
  invokeBeginEndRequest: boolean | null
}

const EMPTY_DATA_SOURCE_CONFIGS = new Map<string, DataSourceConfig>()
const RUNTIME_NOT_REPORTED_STATE = 'Runtime not reported'

interface DataSourceRuntimeMetrics {
  state: string
  deploymentState: string | number | null
  activeConnectionsCurrentCount: number | null
  currCapacity: number | null
  waitingForConnectionCurrentCount: number | null
  leakedConnectionCount: number | null
  utilization: number | null
  utilizationCapacity: number | null
  utilizationCapacitySource: DataSourceUtilizationCapacitySource | null
  numAvailable: number | null
  numUnavailable: number | null
  connectionsTotalCount: number | null
  reserveRequestCount: number | null
  failedReserveRequestCount: number | null
  waitingForConnectionHighCount: number | null
  waitingForConnectionTotal: number | null
  waitingForConnectionSuccessTotal: number | null
  waitingForConnectionFailureTotal: number | null
  connectionDelayTime: number | null
  runtimeEnabled: boolean | null
  databaseProductName: string | null
  databaseProductVersion: string | null
  runtimeDriverName: string | null
  runtimeDriverVersion: string | null
  jdbcDriverVersion: string | null
  prepStmtCacheCurrentSize: number | null
  prepStmtCacheAccessCount: number | null
  prepStmtCacheHitCount: number | null
  prepStmtCacheMissCount: number | null
  prepStmtCacheAddCount: number | null
  prepStmtCacheDeleteCount: number | null
}

export function dataSourcesQueryKey(creds: WlsCredentials | null | undefined) {
  return ['dataSources', wlsCredentialCacheKey(creds)] as const
}

export function dataSourceConfigsQueryKey(creds: WlsCredentials | null | undefined) {
  return ['dataSourceConfigs', wlsCredentialCacheKey(creds)] as const
}

export function dataSourceSelectedDetailQueryKey(
  creds: WlsCredentials | null | undefined,
  serverName: string,
  dataSourceName: string,
) {
  return ['dataSourceSelectedDetail', wlsCredentialCacheKey(creds), serverName, dataSourceName] as const
}

export function dataSourceRuntimeDetailQueryKey(
  creds: WlsCredentials | null | undefined,
  serverName: string,
  dataSourceName: string,
) {
  return ['dataSourceRuntimeDetail', wlsCredentialCacheKey(creds), serverName, dataSourceName] as const
}

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readItems(data: unknown): unknown[] {
  return isObject(data) && Array.isArray(data.items) ? data.items : []
}

function isRuntimeServer(row: ServerRuntimeRow) {
  return row.state === 'RUNNING' || row.state === 'ADMIN' || row.state === 'STANDBY'
}

// Same thresholds as the dashboard (see dashboard-jdbc-normalization.ts), judged on this reading.
function classifyDataSource(row: DataSourceRuntimeMetrics, runtimeAvailable = true): DataSourceSeverity {
  if (!runtimeAvailable) return 'unknown'
  return classifyJdbcPool(row)
}

function emptyConfig() {
  return {
    systemResourceName: null,
    configurationSupported: false,
    configuredTargets: [],
    jndiNames: [],
    driverName: null,
    url: null,
    databaseUser: null,
    configuredInitialCapacity: null,
    configuredMinCapacity: null,
    configuredMaxCapacity: null,
    testTableName: null,
    globalTransactionsProtocol: null,
    useXaDataSourceInterface: null,
    algorithmType: null,
    scope: null,
    dataSourceList: null,
    keepConnAfterGlobalTx: null,
    testConnectionsOnReserve: null,
    testFrequencySeconds: null,
    secondsToTrustAnIdlePoolConnection: null,
    countOfTestFailuresTillFlush: null,
    countOfRefreshFailuresTillDisable: null,
    statementCacheSize: null,
    statementCacheType: null,
    statementTimeout: null,
    shrinkFrequencySeconds: null,
    inactiveConnectionTimeoutSeconds: null,
    connectionReserveTimeoutSeconds: null,
    connectionCreationRetryFrequencySeconds: null,
    loginDelaySeconds: null,
    highestNumWaiters: null,
    removeInfectedConnections: null,
    pinnedToThread: null,
    wrapJdbc: null,
    wrapTypes: null,
    invokeBeginEndRequest: null,
  } satisfies Pick<
    DataSourceRuntimeRow,
    | 'systemResourceName'
    | 'configurationSupported'
    | 'configuredTargets'
    | 'jndiNames'
    | 'driverName'
    | 'url'
    | 'databaseUser'
    | 'configuredInitialCapacity'
    | 'configuredMinCapacity'
    | 'configuredMaxCapacity'
    | 'testTableName'
    | 'globalTransactionsProtocol'
    | 'useXaDataSourceInterface'
    | 'algorithmType'
    | 'scope'
    | 'dataSourceList'
    | 'keepConnAfterGlobalTx'
    | 'testConnectionsOnReserve'
    | 'testFrequencySeconds'
    | 'secondsToTrustAnIdlePoolConnection'
    | 'countOfTestFailuresTillFlush'
    | 'countOfRefreshFailuresTillDisable'
    | 'statementCacheSize'
    | 'statementCacheType'
    | 'statementTimeout'
    | 'shrinkFrequencySeconds'
    | 'inactiveConnectionTimeoutSeconds'
    | 'connectionReserveTimeoutSeconds'
    | 'connectionCreationRetryFrequencySeconds'
    | 'loginDelaySeconds'
    | 'highestNumWaiters'
    | 'removeInfectedConnections'
    | 'pinnedToThread'
    | 'wrapJdbc'
    | 'wrapTypes'
    | 'invokeBeginEndRequest'
  >
}

function rowConfig(config: DataSourceConfig | null) {
  return config
    ? {
        systemResourceName: config.systemResourceName,
        configurationSupported: true,
        configuredTargets: config.configuredTargets,
        jndiNames: config.jndiNames,
        driverName: config.driverName,
        url: config.url,
        databaseUser: config.databaseUser,
        configuredInitialCapacity: config.configuredInitialCapacity,
        configuredMinCapacity: config.configuredMinCapacity,
        configuredMaxCapacity: config.configuredMaxCapacity,
        testTableName: config.testTableName,
        globalTransactionsProtocol: config.globalTransactionsProtocol,
        useXaDataSourceInterface: config.useXaDataSourceInterface,
        algorithmType: config.algorithmType,
        scope: config.scope,
        dataSourceList: config.dataSourceList,
        keepConnAfterGlobalTx: config.keepConnAfterGlobalTx,
        testConnectionsOnReserve: config.testConnectionsOnReserve,
        testFrequencySeconds: config.testFrequencySeconds,
        secondsToTrustAnIdlePoolConnection: config.secondsToTrustAnIdlePoolConnection,
        countOfTestFailuresTillFlush: config.countOfTestFailuresTillFlush,
        countOfRefreshFailuresTillDisable: config.countOfRefreshFailuresTillDisable,
        statementCacheSize: config.statementCacheSize,
        statementCacheType: config.statementCacheType,
        statementTimeout: config.statementTimeout,
        shrinkFrequencySeconds: config.shrinkFrequencySeconds,
        inactiveConnectionTimeoutSeconds: config.inactiveConnectionTimeoutSeconds,
        connectionReserveTimeoutSeconds: config.connectionReserveTimeoutSeconds,
        connectionCreationRetryFrequencySeconds: config.connectionCreationRetryFrequencySeconds,
        loginDelaySeconds: config.loginDelaySeconds,
        highestNumWaiters: config.highestNumWaiters,
        removeInfectedConnections: config.removeInfectedConnections,
        pinnedToThread: config.pinnedToThread,
        wrapJdbc: config.wrapJdbc,
        wrapTypes: config.wrapTypes,
        invokeBeginEndRequest: config.invokeBeginEndRequest,
      }
    : emptyConfig()
}

function normalizeDataSource(
  serverName: string,
  item: unknown,
  configs: ReadonlyMap<string, DataSourceConfig>,
): DataSourceRuntimeRow | null {
  if (!isObject(item)) return null
  const name = readString(item.name)
  if (!name) return null
  const config = configs.get(name)

  const activeConnectionsCurrentCount = readNumber(item.activeConnectionsCurrentCount)
  const currCapacity = readNumber(item.currCapacity)
  const utilization = resolveDataSourceUtilization({
    activeConnectionsCurrentCount,
    configuredMaxCapacity: config?.configuredMaxCapacity ?? null,
    currCapacity,
  })
  const counters = normalizeDataSourceRuntimeCounters(item)
  const databaseMetadata = normalizeDataSourceRuntimeDatabaseMetadata(item)
  const statementCacheCounters = normalizeDataSourceRuntimeStatementCacheCounters(item)
  const row = {
    name,
    serverName,
    state: readString(item.state) ?? 'Unknown',
    deploymentState: readString(item.deploymentState) ?? readNumber(item.deploymentState),
    activeConnectionsCurrentCount,
    currCapacity,
    waitingForConnectionCurrentCount: readNumber(item.waitingForConnectionCurrentCount),
    leakedConnectionCount: readNumber(item.leakedConnectionCount),
    ...utilization,
    ...counters,
    ...databaseMetadata,
    ...statementCacheCounters,
  }

  return {
    id: `${serverName}:${name}`,
    runtimeAvailable: true,
    ...rowConfig(config ?? null),
    ...row,
    severity: classifyDataSource(row),
  }
}

function emptyRuntimeMetrics(): DataSourceRuntimeMetrics {
  return {
    state: RUNTIME_NOT_REPORTED_STATE,
    deploymentState: null,
    activeConnectionsCurrentCount: null,
    currCapacity: null,
    waitingForConnectionCurrentCount: null,
    leakedConnectionCount: null,
    utilization: null,
    utilizationCapacity: null,
    utilizationCapacitySource: null,
    numAvailable: null,
    numUnavailable: null,
    connectionsTotalCount: null,
    reserveRequestCount: null,
    failedReserveRequestCount: null,
    waitingForConnectionHighCount: null,
    waitingForConnectionTotal: null,
    waitingForConnectionSuccessTotal: null,
    waitingForConnectionFailureTotal: null,
    connectionDelayTime: null,
    runtimeEnabled: null,
    databaseProductName: null,
    databaseProductVersion: null,
    runtimeDriverName: null,
    runtimeDriverVersion: null,
    jdbcDriverVersion: null,
    prepStmtCacheCurrentSize: null,
    prepStmtCacheAccessCount: null,
    prepStmtCacheHitCount: null,
    prepStmtCacheMissCount: null,
    prepStmtCacheAddCount: null,
    prepStmtCacheDeleteCount: null,
  }
}

function normalizeConfiguredDataSource(serverName: string, config: DataSourceConfig): DataSourceRuntimeRow {
  const metrics = emptyRuntimeMetrics()

  return {
    id: `${serverName}:${config.systemResourceName}`,
    name: config.systemResourceName,
    serverName,
    runtimeAvailable: false,
    ...rowConfig(config),
    ...metrics,
    severity: classifyDataSource(metrics, false),
  }
}

function applyDataSourceConfig(
  row: DataSourceRuntimeRow,
  configs: ReadonlyMap<string, DataSourceConfig>,
): DataSourceRuntimeRow {
  const config = configs.get(row.name) ?? null
  const utilization = resolveDataSourceUtilization({
    activeConnectionsCurrentCount: row.activeConnectionsCurrentCount,
    configuredMaxCapacity: config?.configuredMaxCapacity ?? null,
    currCapacity: row.currCapacity,
  })
  const metrics = {
    ...row,
    ...utilization,
  } satisfies DataSourceRuntimeMetrics

  return {
    ...row,
    ...rowConfig(config),
    ...utilization,
    severity: classifyDataSource(metrics, row.runtimeAvailable),
  }
}

function runtimeIdentityKeys(row: DataSourceRuntimeRow) {
  const keys = [`${row.serverName}:${row.name}`]
  if (row.systemResourceName) keys.push(`${row.serverName}:${row.systemResourceName}`)
  return keys
}

function configTargetServerNames(config: DataSourceConfig, servers: ServerRuntimeRow[]) {
  const visibleServers = new Set(servers.map((server) => server.name))
  const names = new Set<string>()
  config.configuredTargets.forEach((target) => {
    if (target.kind === 'servers' && visibleServers.has(target.name)) names.add(target.name)
  })
  return Array.from(names)
}

function configTargetsServerName(config: DataSourceConfig, serverName: string) {
  return config.configuredTargets.some((target) => target.kind === 'servers' && target.name === serverName)
}

export function reconcileDataSourceRows(
  runtimeRows: DataSourceRuntimeRow[],
  servers: ServerRuntimeRow[],
  configs: ReadonlyMap<string, DataSourceConfig>,
) {
  const rows = runtimeRows.map((row) => applyDataSourceConfig(row, configs))
  const runtimeKeys = new Set(rows.flatMap(runtimeIdentityKeys))
  const configuredRows = Array.from(configs.values()).flatMap((config) =>
    configTargetServerNames(config, servers).flatMap((serverName) => {
      const key = `${serverName}:${config.systemResourceName}`
      if (runtimeKeys.has(key)) return []
      runtimeKeys.add(key)
      return [normalizeConfiguredDataSource(serverName, config)]
    }),
  )

  return [...rows, ...configuredRows]
}

function normalizeDataSourceRuntimeDetail(
  serverName: string,
  dataSourceName: string,
  item: unknown,
): DataSourceRuntimeDetail | null {
  if (!isObject(item)) return null
  const name = readString(item.name) ?? dataSourceName
  if (!name) return null

  return {
    name,
    serverName,
    state: readString(item.state) ?? 'Unknown',
    deploymentState: readString(item.deploymentState) ?? readNumber(item.deploymentState),
    activeConnectionsCurrentCount: readNumber(item.activeConnectionsCurrentCount),
    currCapacity: readNumber(item.currCapacity),
    waitingForConnectionCurrentCount: readNumber(item.waitingForConnectionCurrentCount),
    leakedConnectionCount: readNumber(item.leakedConnectionCount),
    ...normalizeDataSourceRuntimeCounters(item),
    ...normalizeDataSourceRuntimeDatabaseMetadata(item),
    ...normalizeDataSourceRuntimeStatementCacheCounters(item),
  }
}

export function mergeDataSourceRuntimeDetail(
  row: DataSourceRuntimeRow,
  detail: DataSourceRuntimeDetail,
): DataSourceRuntimeRow {
  return mergeDataSourceRuntimeDetailFields(row, detail)
}

async function fetchServerDataSources(
  creds: WlsCredentials,
  server: ServerRuntimeRow,
  configs: ReadonlyMap<string, DataSourceConfig>,
) {
  const res = await withWlsRestTimeout(`JDBC ${server.name}`, (signal) =>
    clientFor(creds).GET(
      '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans',
      {
        signal,
        params: {
          path: { version: creds.version, serverName: server.name },
          query: dataSourceRuntimeQueryParams(),
        },
      },
    ),
  )

  if (res.error) throw createWlsHttpError(`JDBC ${server.name}`, res.response, res.error)
  return readItems(res.data).flatMap((item) => {
    const row = normalizeDataSource(server.name, item, configs)
    return row ? [row] : []
  })
}

export async function fetchDataSourceRuntimeDetail(
  creds: WlsCredentials,
  serverName: string,
  dataSourceName: string,
): Promise<DataSourceRuntimeDetail> {
  const res = await withWlsRestTimeout(`JDBC detail ${serverName}/${dataSourceName}`, (signal) =>
    clientFor(creds).GET(
      '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans/{dataSourceName}',
      {
        signal,
        params: {
          path: { version: creds.version, serverName, dataSourceName },
          query: dataSourceRuntimeDetailQueryParams(),
        },
      },
    ),
  )

  if (res.error) throw createWlsHttpError(`JDBC detail ${serverName}/${dataSourceName}`, res.response, res.error)
  const detail = normalizeDataSourceRuntimeDetail(serverName, dataSourceName, res.data)
  if (!detail) throw new Error(`JDBC detail ${serverName}/${dataSourceName}: malformed response`)
  return detail
}

async function fetchDataSourceUserProperty(creds: WlsCredentials, systemResourceName: string) {
  const res = await withWlsRestTimeout(`JDBC user ${systemResourceName}`, (signal) =>
    clientFor(creds).GET(
      '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCDriverParams/properties/properties',
      {
        signal,
        params: {
          path: { version: creds.version, systemResourceName },
          query: { fields: 'name,value', links: 'none' },
        },
      },
    ),
  )

  if (res.error) throw createWlsHttpError(`JDBC user ${systemResourceName}`, res.response, res.error)
  const user = readItems(res.data).find((item) => isObject(item) && readString(item.name) === 'user')
  return isObject(user) ? readString(user.value) : null
}

async function fetchDataSourceConfigDetail(
  creds: WlsCredentials,
  item: unknown,
): Promise<DataSourceConfig | null> {
  if (!isObject(item)) return null
  const systemResourceName = readString(item.name)
  if (!systemResourceName) return null
  const client = clientFor(creds)
  const [paramsRes, driverRes, poolRes, user] = await Promise.all([
    withWlsRestTimeout(`JDBC params ${systemResourceName}`, (signal) =>
      client.GET(
        '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCDataSourceParams',
        {
          signal,
          params: {
            path: { version: creds.version, systemResourceName },
            query: dataSourceParamsQueryParams(),
          },
        },
      ),
    ),
    withWlsRestTimeout(`JDBC driver ${systemResourceName}`, (signal) =>
      client.GET(
        '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCDriverParams',
        {
          signal,
          params: {
            path: { version: creds.version, systemResourceName },
            query: { fields: 'driverName,url,useXaDataSourceInterface', links: 'none' },
          },
        },
      ),
    ),
    withWlsRestTimeout(`JDBC pool ${systemResourceName}`, (signal) =>
      client.GET(
        '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCConnectionPoolParams',
        {
          signal,
          params: {
            path: { version: creds.version, systemResourceName },
            query: {
              fields:
                'initialCapacity,minCapacity,maxCapacity,testTableName,testConnectionsOnReserve,testFrequencySeconds,secondsToTrustAnIdlePoolConnection,countOfTestFailuresTillFlush,countOfRefreshFailuresTillDisable,statementCacheSize,statementCacheType,statementTimeout,shrinkFrequencySeconds,inactiveConnectionTimeoutSeconds,connectionReserveTimeoutSeconds,connectionCreationRetryFrequencySeconds,loginDelaySeconds,highestNumWaiters,removeInfectedConnections,pinnedToThread,wrapJdbc,wrapTypes,invokeBeginEndRequest',
              links: 'none',
            },
          },
        },
      ),
    ),
    fetchDataSourceUserProperty(creds, systemResourceName),
  ])

  if (paramsRes.error) throw createWlsHttpError(`JDBC params ${systemResourceName}`, paramsRes.response, paramsRes.error)
  if (driverRes.error) throw createWlsHttpError(`JDBC driver ${systemResourceName}`, driverRes.response, driverRes.error)
  if (poolRes.error) throw createWlsHttpError(`JDBC pool ${systemResourceName}`, poolRes.response, poolRes.error)

  const paramsMetadata = normalizeDataSourceParamsMetadata(paramsRes.data)

  return {
    systemResourceName,
    configuredTargets: readDataSourceTargetRefs(item.targets),
    jndiNames: paramsMetadata.jndiNames,
    driverName: readString(isObject(driverRes.data) ? driverRes.data.driverName : null),
    url: readString(isObject(driverRes.data) ? driverRes.data.url : null),
    useXaDataSourceInterface: readBoolean(isObject(driverRes.data) ? driverRes.data.useXaDataSourceInterface : null),
    databaseUser: user,
    configuredInitialCapacity: readNumber(isObject(poolRes.data) ? poolRes.data.initialCapacity : null),
    configuredMinCapacity: readNumber(isObject(poolRes.data) ? poolRes.data.minCapacity : null),
    configuredMaxCapacity: readNumber(isObject(poolRes.data) ? poolRes.data.maxCapacity : null),
    testTableName: readString(isObject(poolRes.data) ? poolRes.data.testTableName : null),
    globalTransactionsProtocol: paramsMetadata.globalTransactionsProtocol,
    algorithmType: paramsMetadata.algorithmType,
    scope: paramsMetadata.scope,
    dataSourceList: paramsMetadata.dataSourceList,
    keepConnAfterGlobalTx: paramsMetadata.keepConnAfterGlobalTx,
    testConnectionsOnReserve: readBoolean(isObject(poolRes.data) ? poolRes.data.testConnectionsOnReserve : null),
    testFrequencySeconds: readNumber(isObject(poolRes.data) ? poolRes.data.testFrequencySeconds : null),
    secondsToTrustAnIdlePoolConnection: readNumber(isObject(poolRes.data) ? poolRes.data.secondsToTrustAnIdlePoolConnection : null),
    countOfTestFailuresTillFlush: readNumber(isObject(poolRes.data) ? poolRes.data.countOfTestFailuresTillFlush : null),
    countOfRefreshFailuresTillDisable: readNumber(isObject(poolRes.data) ? poolRes.data.countOfRefreshFailuresTillDisable : null),
    statementCacheSize: readNumber(isObject(poolRes.data) ? poolRes.data.statementCacheSize : null),
    statementCacheType: readString(isObject(poolRes.data) ? poolRes.data.statementCacheType : null),
    statementTimeout: readNumber(isObject(poolRes.data) ? poolRes.data.statementTimeout : null),
    shrinkFrequencySeconds: readNumber(isObject(poolRes.data) ? poolRes.data.shrinkFrequencySeconds : null),
    inactiveConnectionTimeoutSeconds: readNumber(isObject(poolRes.data) ? poolRes.data.inactiveConnectionTimeoutSeconds : null),
    connectionReserveTimeoutSeconds: readNumber(isObject(poolRes.data) ? poolRes.data.connectionReserveTimeoutSeconds : null),
    connectionCreationRetryFrequencySeconds: readNumber(isObject(poolRes.data) ? poolRes.data.connectionCreationRetryFrequencySeconds : null),
    loginDelaySeconds: readNumber(isObject(poolRes.data) ? poolRes.data.loginDelaySeconds : null),
    highestNumWaiters: readNumber(isObject(poolRes.data) ? poolRes.data.highestNumWaiters : null),
    removeInfectedConnections: readBoolean(isObject(poolRes.data) ? poolRes.data.removeInfectedConnections : null),
    pinnedToThread: readBoolean(isObject(poolRes.data) ? poolRes.data.pinnedToThread : null),
    wrapJdbc: readBoolean(isObject(poolRes.data) ? poolRes.data.wrapJdbc : null),
    wrapTypes: readBoolean(isObject(poolRes.data) ? poolRes.data.wrapTypes : null),
    invokeBeginEndRequest: readBoolean(isObject(poolRes.data) ? poolRes.data.invokeBeginEndRequest : null),
  }
}

export async function fetchDataSourceConfigs(creds: WlsCredentials): Promise<DataSourceConfigsSnapshot> {
  const res = await withWlsRestTimeout('JDBC configuration', (signal) =>
    clientFor(creds).GET('/management/weblogic/{version}/edit/JDBCSystemResources', {
      signal,
      params: {
        path: { version: creds.version },
        query: dataSourceConfigCollectionQueryParams(),
      },
    }),
  )

  if (res.error) throw createWlsHttpError('JDBC configuration', res.response, res.error)

  const outcomes = await Promise.allSettled(
    readItems(res.data).map((item) => fetchDataSourceConfigDetail(creds, item)),
  )
  const configs = new Map(
    outcomes.flatMap((outcome) => {
      if (outcome.status !== 'fulfilled' || !outcome.value) return []
      return [[outcome.value.systemResourceName, outcome.value] as const]
    }),
  )
  const failures = outcomes.flatMap((outcome) => {
    if (outcome.status === 'fulfilled') return []
    return [
      {
        serverName: 'edit/JDBCSystemResources',
        message: outcome.reason instanceof Error ? outcome.reason.message : 'Unknown error',
      },
    ]
  })

  return { configs, failures }
}

async function fetchSelectedDataSourceConfig(creds: WlsCredentials, dataSourceName: string) {
  const res = await withWlsRestTimeout(`JDBC configuration ${dataSourceName}`, (signal) =>
    clientFor(creds).GET('/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}', {
      signal,
      params: {
        path: { version: creds.version, systemResourceName: dataSourceName },
        query: dataSourceConfigCollectionQueryParams(),
      },
    }),
  )

  if (res.error) throw createWlsHttpError(`JDBC configuration ${dataSourceName}`, res.response, res.error)
  const config = await fetchDataSourceConfigDetail(creds, res.data)
  if (!config) throw new Error(`JDBC configuration ${dataSourceName}: malformed response`)
  return config
}

export async function fetchSelectedDataSourceDetail(
  creds: WlsCredentials,
  serverName: string,
  dataSourceName: string,
): Promise<DataSourceSelectedDetailSnapshot> {
  const [runtimeOutcome, configOutcome] = await Promise.allSettled([
    fetchDataSourceRuntimeDetail(creds, serverName, dataSourceName),
    fetchSelectedDataSourceConfig(creds, dataSourceName),
  ])
  const configs =
    configOutcome.status === 'fulfilled'
      ? new Map([
          [configOutcome.value.systemResourceName, configOutcome.value] as const,
          [dataSourceName, configOutcome.value] as const,
        ])
      : EMPTY_DATA_SOURCE_CONFIGS
  const config = configOutcome.status === 'fulfilled' ? configOutcome.value : null
  const row =
    runtimeOutcome.status === 'fulfilled'
      ? normalizeDataSource(serverName, runtimeOutcome.value, configs)
      : config && configTargetsServerName(config, serverName)
        ? normalizeConfiguredDataSource(serverName, config)
        : null
  const partialFailures = [
    ...(runtimeOutcome.status === 'fulfilled'
      ? []
      : [
          {
            serverName,
            message:
              runtimeOutcome.reason instanceof Error
                ? runtimeOutcome.reason.message
                : 'Unknown datasource runtime detail error',
          },
        ]),
    ...(configOutcome.status === 'fulfilled'
      ? []
      : [
          {
            serverName: `edit/JDBCSystemResources/${dataSourceName}`,
            message:
              configOutcome.reason instanceof Error
                ? configOutcome.reason.message
                : 'Unknown datasource configuration error',
          },
        ]),
  ]

  return {
    status: partialFailures.length ? 'partial' : row ? 'available' : 'empty',
    row,
    partialFailures,
  }
}

export async function fetchDataSourcesSnapshot(
  creds: WlsCredentials,
  configs: ReadonlyMap<string, DataSourceConfig> = EMPTY_DATA_SOURCE_CONFIGS,
): Promise<DataSourcesSnapshot> {
  const servers = await fetchServerRuntimeRows(creds)
  const runningServers = servers.filter(isRuntimeServer)
  const outcomes = await Promise.allSettled(
    runningServers.map((server) => fetchServerDataSources(creds, server, configs)),
  )

  const runtimeRows = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []))
  const rows = reconcileDataSourceRows(runtimeRows, servers, configs)
  const partialFailures = outcomes.flatMap((outcome, index) => {
    if (outcome.status === 'fulfilled') return []
    const serverName = runningServers[index]?.name ?? 'unknown'
    const message = outcome.reason instanceof Error ? outcome.reason.message : 'Unknown error'
    return [{ serverName, message }]
  })

  return {
    status: partialFailures.length ? 'partial' : rows.length ? 'available' : 'empty',
    rows,
    runtimeRows,
    servers,
    partialFailures,
  }
}

export function useDataSources() {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval()
  const configQuery = useQuery({
    queryKey: dataSourceConfigsQueryKey(creds),
    enabled: !!creds,
    staleTime: 60_000,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchDataSourceConfigs(creds)
    },
  })

  const snapshotQuery = useQuery({
    queryKey: dataSourcesQueryKey(creds),
    enabled: !!creds,
    staleTime: 0,
    refetchInterval: livePollingInterval,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchDataSourcesSnapshot(creds, configQuery.data?.configs ?? EMPTY_DATA_SOURCE_CONFIGS)
    },
  })
  const configFailures =
    configQuery.isError
      ? [
          {
            serverName: 'edit/JDBCSystemResources',
            message: configQuery.error instanceof Error ? configQuery.error.message : 'Unknown error',
          },
        ]
      : (configQuery.data?.failures ?? [])
  const data = snapshotQuery.data
    ? (() => {
        const partialFailures = [...configFailures, ...snapshotQuery.data.partialFailures]
        const rows = reconcileDataSourceRows(
          snapshotQuery.data.runtimeRows,
          snapshotQuery.data.servers,
          configQuery.data?.configs ?? EMPTY_DATA_SOURCE_CONFIGS,
        )
        return {
          ...snapshotQuery.data,
          rows,
          partialFailures,
          status: partialFailures.length ? 'partial' : rows.length ? 'available' : 'empty',
        } satisfies DataSourcesSnapshot
      })()
    : undefined

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds,
    isFetching: snapshotQuery.isFetching || configQuery.isFetching,
    isStale: snapshotQuery.isStale || configQuery.isStale,
    refetch: async () => {
      const [snapshotResult] = await Promise.all([snapshotQuery.refetch(), configQuery.refetch()])
      return snapshotResult
    },
  })

  return {
    ...snapshotQuery,
    data,
    dataUpdatedAt: Math.max(snapshotQuery.dataUpdatedAt, configQuery.dataUpdatedAt),
    isFetching: snapshotQuery.isFetching || configQuery.isFetching,
    refetch: async () => {
      const [snapshotResult] = await Promise.all([snapshotQuery.refetch(), configQuery.refetch()])
      return snapshotResult
    },
  }
}

export function useSelectedDataSourceDetail(serverName: string, dataSourceName: string) {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval()

  const query = useQuery({
    queryKey: dataSourceSelectedDetailQueryKey(creds, serverName, dataSourceName),
    enabled: !!creds && !!serverName && !!dataSourceName,
    staleTime: 0,
    refetchInterval: livePollingInterval,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchSelectedDataSourceDetail(creds, serverName, dataSourceName)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds && !!serverName && !!dataSourceName,
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}

export function useDataSourceRuntimeDetail(
  serverName: string,
  dataSourceName: string,
  options: { enabled?: boolean } = {},
) {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval()

  const query = useQuery({
    queryKey: dataSourceRuntimeDetailQueryKey(creds, serverName, dataSourceName),
    enabled: !!creds && !!serverName && !!dataSourceName && (options.enabled ?? true),
    staleTime: 0,
    refetchInterval: livePollingInterval,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchDataSourceRuntimeDetail(creds, serverName, dataSourceName)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds && !!serverName && !!dataSourceName && (options.enabled ?? true),
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}
