export interface DataSourceRuntimeCounters {
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
}

export interface DataSourceRuntimeDatabaseMetadata {
  runtimeEnabled: boolean | null
  databaseProductName: string | null
  databaseProductVersion: string | null
  runtimeDriverName: string | null
  runtimeDriverVersion: string | null
  jdbcDriverVersion: string | null
}

export interface DataSourceRuntimeStatementCacheCounters {
  prepStmtCacheCurrentSize: number | null
  prepStmtCacheAccessCount: number | null
  prepStmtCacheHitCount: number | null
  prepStmtCacheMissCount: number | null
  prepStmtCacheAddCount: number | null
  prepStmtCacheDeleteCount: number | null
}

export const dataSourceRuntimeListFields = [
  'name',
  'state',
  'deploymentState',
  'activeConnectionsCurrentCount',
  'currCapacity',
  'waitingForConnectionCurrentCount',
  'leakedConnectionCount',
] as const

export const dataSourceRuntimeDetailFields = [
  ...dataSourceRuntimeListFields,
  'numAvailable',
  'numUnavailable',
  'connectionsTotalCount',
  'reserveRequestCount',
  'failedReserveRequestCount',
  'waitingForConnectionHighCount',
  'waitingForConnectionTotal',
  'waitingForConnectionSuccessTotal',
  'waitingForConnectionFailureTotal',
  'connectionDelayTime',
  'enabled',
  'databaseProductName',
  'databaseProductVersion',
  'driverName',
  'driverVersion',
  'versionJDBCDriver',
  'prepStmtCacheCurrentSize',
  'prepStmtCacheAccessCount',
  'prepStmtCacheHitCount',
  'prepStmtCacheMissCount',
  'prepStmtCacheAddCount',
  'prepStmtCacheDeleteCount',
] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export function normalizeDataSourceRuntimeCounters(value: unknown): DataSourceRuntimeCounters {
  const data = isObject(value) ? value : {}
  return {
    numAvailable: readNumber(data.numAvailable),
    numUnavailable: readNumber(data.numUnavailable),
    connectionsTotalCount: readNumber(data.connectionsTotalCount),
    reserveRequestCount: readNumber(data.reserveRequestCount),
    failedReserveRequestCount: readNumber(data.failedReserveRequestCount),
    waitingForConnectionHighCount: readNumber(data.waitingForConnectionHighCount),
    waitingForConnectionTotal: readNumber(data.waitingForConnectionTotal),
    waitingForConnectionSuccessTotal: readNumber(data.waitingForConnectionSuccessTotal),
    waitingForConnectionFailureTotal: readNumber(data.waitingForConnectionFailureTotal),
    connectionDelayTime: readNumber(data.connectionDelayTime),
  }
}

export function normalizeDataSourceRuntimeDatabaseMetadata(value: unknown): DataSourceRuntimeDatabaseMetadata {
  const data = isObject(value) ? value : {}
  return {
    runtimeEnabled: readBoolean(data.enabled),
    databaseProductName: readString(data.databaseProductName),
    databaseProductVersion: readString(data.databaseProductVersion),
    runtimeDriverName: readString(data.driverName),
    runtimeDriverVersion: readString(data.driverVersion),
    jdbcDriverVersion: readString(data.versionJDBCDriver),
  }
}

export function normalizeDataSourceRuntimeStatementCacheCounters(
  value: unknown,
): DataSourceRuntimeStatementCacheCounters {
  const data = isObject(value) ? value : {}
  return {
    prepStmtCacheCurrentSize: readNumber(data.prepStmtCacheCurrentSize),
    prepStmtCacheAccessCount: readNumber(data.prepStmtCacheAccessCount),
    prepStmtCacheHitCount: readNumber(data.prepStmtCacheHitCount),
    prepStmtCacheMissCount: readNumber(data.prepStmtCacheMissCount),
    prepStmtCacheAddCount: readNumber(data.prepStmtCacheAddCount),
    prepStmtCacheDeleteCount: readNumber(data.prepStmtCacheDeleteCount),
  }
}

export function dataSourceRuntimeQueryParams() {
  return {
    fields: dataSourceRuntimeListFields.join(','),
    links: 'none',
  } as const
}

export function dataSourceRuntimeDetailQueryParams() {
  return {
    fields: dataSourceRuntimeDetailFields.join(','),
    links: 'none',
  } as const
}
