import type {
  DataSourceRuntimeCounters,
  DataSourceRuntimeDatabaseMetadata,
  DataSourceRuntimeStatementCacheCounters,
} from './data-source-runtime-normalization.ts'

export interface DataSourceRuntimeDetailFields
  extends DataSourceRuntimeCounters,
    DataSourceRuntimeDatabaseMetadata,
    DataSourceRuntimeStatementCacheCounters {
  name: string
  serverName: string
  state: string
  deploymentState: string | number | null
  activeConnectionsCurrentCount: number | null
  currCapacity: number | null
  waitingForConnectionCurrentCount: number | null
  leakedConnectionCount: number | null
}

export function mergeDataSourceRuntimeDetailFields<Row extends DataSourceRuntimeDetailFields>(
  row: Row,
  detail: DataSourceRuntimeDetailFields,
): Row {
  if (detail.serverName !== row.serverName || detail.name !== row.name) return row

  return {
    ...row,
    numAvailable: detail.numAvailable,
    numUnavailable: detail.numUnavailable,
    connectionsTotalCount: detail.connectionsTotalCount,
    reserveRequestCount: detail.reserveRequestCount,
    failedReserveRequestCount: detail.failedReserveRequestCount,
    waitingForConnectionHighCount: detail.waitingForConnectionHighCount,
    waitingForConnectionTotal: detail.waitingForConnectionTotal,
    waitingForConnectionSuccessTotal: detail.waitingForConnectionSuccessTotal,
    waitingForConnectionFailureTotal: detail.waitingForConnectionFailureTotal,
    connectionDelayTime: detail.connectionDelayTime,
    runtimeEnabled: detail.runtimeEnabled,
    databaseProductName: detail.databaseProductName,
    databaseProductVersion: detail.databaseProductVersion,
    runtimeDriverName: detail.runtimeDriverName,
    runtimeDriverVersion: detail.runtimeDriverVersion,
    jdbcDriverVersion: detail.jdbcDriverVersion,
    prepStmtCacheCurrentSize: detail.prepStmtCacheCurrentSize,
    prepStmtCacheAccessCount: detail.prepStmtCacheAccessCount,
    prepStmtCacheHitCount: detail.prepStmtCacheHitCount,
    prepStmtCacheMissCount: detail.prepStmtCacheMissCount,
    prepStmtCacheAddCount: detail.prepStmtCacheAddCount,
    prepStmtCacheDeleteCount: detail.prepStmtCacheDeleteCount,
  }
}
