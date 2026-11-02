import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeDataSourceRuntimeDetailFields } from '../src/api/queries/data-source-detail-merge.ts'
import type { DataSourceRuntimeDetailFields } from '../src/api/queries/data-source-detail-merge.ts'

interface TestDataSourceRuntimeRow extends DataSourceRuntimeDetailFields {
  id: string
  configuredMaxCapacity: number | null
  utilization: number | null
  utilizationCapacity: number | null
  utilizationCapacitySource: 'configuredMax' | 'runtimeCurrent' | null
  severity: 'healthy' | 'warning' | 'critical' | 'unknown'
}

function baseRow(): TestDataSourceRuntimeRow {
  return {
    id: 'AdminServer:OrdersDS',
    name: 'OrdersDS',
    serverName: 'AdminServer',
    systemResourceName: 'OrdersDS',
    configurationSupported: true,
    configuredTargets: [],
    jndiNames: ['jdbc/OrdersDS'],
    driverName: 'org.example.Driver',
    url: 'jdbc:example',
    databaseUser: 'orders',
    configuredInitialCapacity: 1,
    configuredMinCapacity: 1,
    configuredMaxCapacity: 10,
    testTableName: 'SQL SELECT 1',
    globalTransactionsProtocol: null,
    algorithmType: null,
    scope: null,
    dataSourceList: null,
    keepConnAfterGlobalTx: null,
    state: 'Running',
    deploymentState: 2,
    activeConnectionsCurrentCount: 2,
    currCapacity: 5,
    waitingForConnectionCurrentCount: 0,
    leakedConnectionCount: 0,
    utilization: 0.2,
    utilizationCapacity: 10,
    utilizationCapacitySource: 'configuredMax',
    severity: 'healthy',
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

test('datasource detail merge keeps fresh list-level pressure fields', () => {
  const row = baseRow()
  const merged = mergeDataSourceRuntimeDetailFields(row, {
    name: 'OrdersDS',
    serverName: 'AdminServer',
    state: 'Suspended',
    deploymentState: 0,
    activeConnectionsCurrentCount: 9,
    currCapacity: 9,
    waitingForConnectionCurrentCount: 4,
    leakedConnectionCount: 1,
    numAvailable: 3,
    numUnavailable: 1,
    connectionsTotalCount: 100,
    reserveRequestCount: 20,
    failedReserveRequestCount: 2,
    waitingForConnectionHighCount: 5,
    waitingForConnectionTotal: 6,
    waitingForConnectionSuccessTotal: 4,
    waitingForConnectionFailureTotal: 2,
    connectionDelayTime: 12,
    runtimeEnabled: true,
    databaseProductName: 'Oracle',
    databaseProductVersion: '19c',
    runtimeDriverName: 'Oracle JDBC Driver',
    runtimeDriverVersion: '23.4',
    jdbcDriverVersion: 'ojdbc11-23.4',
    prepStmtCacheCurrentSize: 7,
    prepStmtCacheAccessCount: 80,
    prepStmtCacheHitCount: 60,
    prepStmtCacheMissCount: 20,
    prepStmtCacheAddCount: 10,
    prepStmtCacheDeleteCount: 3,
  })

  assert.equal(merged.state, 'Running')
  assert.equal(merged.deploymentState, 2)
  assert.equal(merged.activeConnectionsCurrentCount, 2)
  assert.equal(merged.waitingForConnectionCurrentCount, 0)
  assert.equal(merged.leakedConnectionCount, 0)
  assert.equal(merged.severity, 'healthy')
  assert.equal(merged.databaseProductName, 'Oracle')
  assert.equal(merged.prepStmtCacheCurrentSize, 7)
})

test('datasource detail merge ignores detail from a different datasource identity', () => {
  const row = baseRow()
  const merged = mergeDataSourceRuntimeDetailFields(row, {
    ...row,
    name: 'OtherDS',
    serverName: 'AdminServer',
    databaseProductName: 'Other database',
  })

  assert.strictEqual(merged, row)
  assert.equal(merged.databaseProductName, null)
})
