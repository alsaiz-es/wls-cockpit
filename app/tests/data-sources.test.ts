import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { WlsCredentials } from '../src/api/client.ts'
import {
  fetchSelectedDataSourceDetail,
  reconcileDataSourceRows,
  type DataSourceConfig,
  type DataSourceRuntimeRow,
} from '../src/api/queries/data-sources.ts'
import type { ServerRuntimeRow } from '../src/api/queries/server-runtimes.ts'

const creds: WlsCredentials = {
  profileId: 'local',
  name: 'Local',
  targetUrl: 'http://wls-admin.example.com:7001',
  username: 'admin',
  password: 'secret',
  version: '14.1.2.0.0',
}

function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function server(name: string): ServerRuntimeRow {
  return {
    name,
    state: 'RUNNING',
    healthState: 'ok',
    listenAddress: null,
    listenPort: null,
    heap: null,
    jvm: null,
    threads: null,
  }
}

function config(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    systemResourceName: 'StoppedDS',
    configuredTargets: [{ kind: 'servers', name: 'AdminServer' }],
    jndiNames: ['jdbc/stopped'],
    driverName: 'oracle.jdbc.OracleDriver',
    url: 'jdbc:oracle:thin:@example',
    databaseUser: 'app',
    configuredInitialCapacity: 1,
    configuredMinCapacity: 1,
    configuredMaxCapacity: 15,
    testTableName: 'SQL ISVALID',
    globalTransactionsProtocol: 'OnePhaseCommit',
    useXaDataSourceInterface: false,
    algorithmType: null,
    scope: null,
    dataSourceList: null,
    keepConnAfterGlobalTx: null,
    testConnectionsOnReserve: true,
    testFrequencySeconds: 120,
    secondsToTrustAnIdlePoolConnection: 10,
    countOfTestFailuresTillFlush: 2,
    countOfRefreshFailuresTillDisable: 3,
    statementCacheSize: 20,
    statementCacheType: 'LRU',
    statementTimeout: 30,
    shrinkFrequencySeconds: 900,
    inactiveConnectionTimeoutSeconds: 60,
    connectionReserveTimeoutSeconds: 15,
    connectionCreationRetryFrequencySeconds: 20,
    loginDelaySeconds: 1,
    highestNumWaiters: 100,
    removeInfectedConnections: true,
    pinnedToThread: false,
    wrapJdbc: true,
    wrapTypes: true,
    invokeBeginEndRequest: null,
    ...overrides,
  }
}

function runtimeRow(overrides: Partial<DataSourceRuntimeRow> = {}): DataSourceRuntimeRow {
  return {
    id: 'AdminServer:StoppedDS',
    name: 'StoppedDS',
    serverName: 'AdminServer',
    runtimeAvailable: true,
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
    state: 'Running',
    deploymentState: 2,
    activeConnectionsCurrentCount: 2,
    currCapacity: 5,
    waitingForConnectionCurrentCount: 0,
    leakedConnectionCount: 0,
    utilization: null,
    utilizationCapacity: null,
    utilizationCapacitySource: null,
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
    ...overrides,
  }
}

function installSelectedDetailFetch(t: TestContext, targetServer = 'AdminServer') {
  const originalFetch = globalThis.fetch
  const originalRequest = globalThis.Request
  globalThis.Request = class RelativeUrlRequest extends originalRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init)
    }
  } as typeof Request
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/JDBCDataSourceRuntimeMBeans/StoppedDS?')) {
      return json({ error: 'missing' }, { status: 404, statusText: 'Not Found' })
    }
    if (url.includes('/edit/JDBCSystemResources/StoppedDS?')) {
      return json({ name: 'StoppedDS', targets: [['servers', targetServer]] })
    }
    if (url.includes('/JDBCResource/JDBCDataSourceParams?')) {
      return json({ JNDINames: ['jdbc/stopped'], globalTransactionsProtocol: 'OnePhaseCommit' })
    }
    if (url.includes('/JDBCResource/JDBCDriverParams/properties/properties?')) {
      return json({ items: [{ name: 'user', value: 'app' }] })
    }
    if (url.includes('/JDBCResource/JDBCDriverParams?')) {
      return json({
        driverName: 'oracle.jdbc.OracleDriver',
        url: 'jdbc:oracle:thin:@example',
        useXaDataSourceInterface: false,
      })
    }
    if (url.includes('/JDBCResource/JDBCConnectionPoolParams?')) {
      return json({ initialCapacity: 1, minCapacity: 1, maxCapacity: 15, testTableName: 'SQL ISVALID' })
    }
    throw new Error(`unexpected URL ${url}`)
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = originalFetch
    globalThis.Request = originalRequest
  })
}

test('datasource reconciliation adds configuration-only rows and deduplicates runtime rows', () => {
  const configs = new Map([['StoppedDS', config()]])
  const configuredOnly = reconcileDataSourceRows([], [server('AdminServer')], configs)

  assert.equal(configuredOnly.length, 1)
  assert.equal(configuredOnly[0]?.runtimeAvailable, false)
  assert.equal(configuredOnly[0]?.state, 'Runtime not reported')
  assert.equal(configuredOnly[0]?.severity, 'unknown')
  assert.equal(configuredOnly[0]?.configuredMaxCapacity, 15)
  assert.equal(configuredOnly[0]?.activeConnectionsCurrentCount, null)

  const runtime = reconcileDataSourceRows([runtimeRow()], [server('AdminServer')], configs)
  assert.equal(runtime.length, 1)
  assert.equal(runtime[0]?.runtimeAvailable, true)
  assert.equal(runtime[0]?.state, 'Running')
  assert.equal(runtime[0]?.configurationSupported, true)
  assert.equal(runtime[0]?.configuredMaxCapacity, 15)
  assert.equal(runtime[0]?.utilizationCapacity, 15)

  assert.deepEqual(reconcileDataSourceRows([], [server('AdminServer')], new Map()), [])
})

test('selected datasource detail falls back to matching configuration when runtime is missing', async (t) => {
  installSelectedDetailFetch(t)

  const snapshot = await fetchSelectedDataSourceDetail(creds, 'AdminServer', 'StoppedDS')

  assert.equal(snapshot.status, 'partial')
  assert.equal(snapshot.row?.runtimeAvailable, false)
  assert.equal(snapshot.row?.name, 'StoppedDS')
  assert.equal(snapshot.row?.serverName, 'AdminServer')
  assert.equal(snapshot.row?.state, 'Runtime not reported')
  assert.equal(snapshot.row?.jndiNames[0], 'jdbc/stopped')
  assert.equal(snapshot.row?.configuredMaxCapacity, 15)
  assert.equal(snapshot.partialFailures.some((failure) => failure.serverName === 'AdminServer'), true)
})

test('selected datasource detail remains not found when configuration targets another server', async (t) => {
  installSelectedDetailFetch(t, 'ManagedServer1')

  const snapshot = await fetchSelectedDataSourceDetail(creds, 'AdminServer', 'StoppedDS')

  assert.equal(snapshot.status, 'partial')
  assert.equal(snapshot.row, null)
  assert.equal(snapshot.partialFailures.some((failure) => failure.serverName === 'AdminServer'), true)
})
