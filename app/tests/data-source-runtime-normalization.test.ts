import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dataSourceRuntimeDetailQueryParams,
  dataSourceRuntimeQueryParams,
  normalizeDataSourceRuntimeCounters,
  normalizeDataSourceRuntimeDatabaseMetadata,
  normalizeDataSourceRuntimeStatementCacheCounters,
} from '../src/api/queries/data-source-runtime-normalization.ts'

test('normalizes datasource runtime availability counters independently', () => {
  assert.deepEqual(
    normalizeDataSourceRuntimeCounters({
      numAvailable: 4,
      numUnavailable: 1,
      connectionsTotalCount: 12,
      reserveRequestCount: 30,
      failedReserveRequestCount: 2,
      waitingForConnectionHighCount: 3,
      waitingForConnectionTotal: 8,
      waitingForConnectionSuccessTotal: 6,
      waitingForConnectionFailureTotal: 2,
      connectionDelayTime: 42,
      ignored: 99,
    }),
    {
      numAvailable: 4,
      numUnavailable: 1,
      connectionsTotalCount: 12,
      reserveRequestCount: 30,
      failedReserveRequestCount: 2,
      waitingForConnectionHighCount: 3,
      waitingForConnectionTotal: 8,
      waitingForConnectionSuccessTotal: 6,
      waitingForConnectionFailureTotal: 2,
      connectionDelayTime: 42,
    },
  )
})

test('normalizes missing datasource runtime counters as neutral values', () => {
  assert.deepEqual(normalizeDataSourceRuntimeCounters(null), {
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
  })
})

test('normalizes datasource runtime database metadata independently', () => {
  assert.deepEqual(
    normalizeDataSourceRuntimeDatabaseMetadata({
      enabled: true,
      databaseProductName: ' Oracle ',
      databaseProductVersion: '19c',
      driverName: 'Oracle JDBC Driver',
      driverVersion: '23.4',
      versionJDBCDriver: 'ojdbc11-23.4',
    }),
    {
      runtimeEnabled: true,
      databaseProductName: 'Oracle',
      databaseProductVersion: '19c',
      runtimeDriverName: 'Oracle JDBC Driver',
      runtimeDriverVersion: '23.4',
      jdbcDriverVersion: 'ojdbc11-23.4',
    },
  )
})

test('normalizes missing datasource runtime database metadata as neutral values', () => {
  assert.deepEqual(normalizeDataSourceRuntimeDatabaseMetadata(null), {
    runtimeEnabled: null,
    databaseProductName: null,
    databaseProductVersion: null,
    runtimeDriverName: null,
    runtimeDriverVersion: null,
    jdbcDriverVersion: null,
  })
})

test('normalizes datasource runtime statement cache counters independently', () => {
  assert.deepEqual(
    normalizeDataSourceRuntimeStatementCacheCounters({
      prepStmtCacheCurrentSize: 3,
      prepStmtCacheAccessCount: 100,
      prepStmtCacheHitCount: 80,
      prepStmtCacheMissCount: 20,
      prepStmtCacheAddCount: 25,
      prepStmtCacheDeleteCount: 22,
    }),
    {
      prepStmtCacheCurrentSize: 3,
      prepStmtCacheAccessCount: 100,
      prepStmtCacheHitCount: 80,
      prepStmtCacheMissCount: 20,
      prepStmtCacheAddCount: 25,
      prepStmtCacheDeleteCount: 22,
    },
  )
})

test('normalizes missing datasource runtime statement cache counters as neutral values', () => {
  assert.deepEqual(normalizeDataSourceRuntimeStatementCacheCounters(null), {
    prepStmtCacheCurrentSize: null,
    prepStmtCacheAccessCount: null,
    prepStmtCacheHitCount: null,
    prepStmtCacheMissCount: null,
    prepStmtCacheAddCount: null,
    prepStmtCacheDeleteCount: null,
  })
})

test('requests datasource list runtimes with an explicit pressure allow-list', () => {
  assert.deepEqual(dataSourceRuntimeQueryParams(), {
    fields: 'name,state,deploymentState,activeConnectionsCurrentCount,currCapacity,waitingForConnectionCurrentCount,leakedConnectionCount',
    links: 'none',
  })
})

test('requests datasource detail runtimes with an explicit advanced allow-list', () => {
  assert.deepEqual(dataSourceRuntimeDetailQueryParams(), {
    fields: 'name,state,deploymentState,activeConnectionsCurrentCount,currCapacity,waitingForConnectionCurrentCount,leakedConnectionCount,numAvailable,numUnavailable,connectionsTotalCount,reserveRequestCount,failedReserveRequestCount,waitingForConnectionHighCount,waitingForConnectionTotal,waitingForConnectionSuccessTotal,waitingForConnectionFailureTotal,connectionDelayTime,enabled,databaseProductName,databaseProductVersion,driverName,driverVersion,versionJDBCDriver,prepStmtCacheCurrentSize,prepStmtCacheAccessCount,prepStmtCacheHitCount,prepStmtCacheMissCount,prepStmtCacheAddCount,prepStmtCacheDeleteCount',
    links: 'none',
  })
})
