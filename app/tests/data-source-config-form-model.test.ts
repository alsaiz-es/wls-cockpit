import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyDriverPreset,
  formForRow,
  initialConfigForm,
  updateUrlMode,
  updateUrlTemplateField,
  validateDataSourceConfigForm,
} from '../src/routes/data-source-config-form-model.ts'
import type { DataSourceRuntimeRow } from '../src/api/queries/data-sources.ts'

function minimalRow(overrides: Partial<DataSourceRuntimeRow> = {}): DataSourceRuntimeRow {
  return {
    id: 'AdminServer:OrdersDS',
    name: 'OrdersDS',
    serverName: 'AdminServer',
    runtimeAvailable: true,
    systemResourceName: 'OrdersDS',
    configurationSupported: true,
    configuredTargets: [{ kind: 'servers', name: 'AdminServer' }],
    jndiNames: ['jdbc/orders'],
    driverName: 'oracle.jdbc.OracleDriver',
    url: 'jdbc:oracle:thin:@//scan.example.com:1521/PDB1',
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
    state: 'Running',
    deploymentState: 2,
    activeConnectionsCurrentCount: 0,
    currCapacity: 1,
    waitingForConnectionCurrentCount: 0,
    leakedConnectionCount: 0,
    utilization: 0,
    utilizationCapacity: 15,
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
    ...overrides,
  }
}

test('initial datasource config form uses oracle preset defaults', () => {
  const form = initialConfigForm(['servers:AdminServer'])

  assert.equal(form.driverPresetId, 'oracle-thin-service')
  assert.equal(form.urlMode, 'template')
  assert.equal(form.driverName, 'oracle.jdbc.OracleDriver')
  assert.equal(form.testTableName, 'SQL ISVALID')
  assert.deepEqual(form.targetKeys, ['servers:AdminServer'])
})

test('template URL mode derives URL while manual URL is preserved', () => {
  let form = initialConfigForm()
  form = updateUrlTemplateField(form, 'host', 'scan.example.com')
  form = updateUrlTemplateField(form, 'service', 'PDB1')
  assert.equal(form.url, 'jdbc:oracle:thin:@//scan.example.com:1521/PDB1')

  form = updateUrlMode(form, 'manual')
  form = { ...form, url: 'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=scan)(PORT=1521)))' }
  const afterTuning = { ...form, maxCapacity: '30' }

  assert.equal(afterTuning.url, 'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=scan)(PORT=1521)))')
})

test('form hydrates known simple URLs as template mode and complex URLs as manual mode', () => {
  const simple = formForRow(minimalRow())
  assert.equal(simple.driverPresetId, 'oracle-thin-service')
  assert.equal(simple.urlMode, 'template')
  assert.equal(simple.urlTemplateFields.service, 'PDB1')

  const complex = formForRow(minimalRow({ url: 'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=scan)(PORT=1521)))' }))
  assert.equal(complex.driverPresetId, 'oracle-thin-service')
  assert.equal(complex.urlMode, 'manual')
  assert.equal(complex.url, 'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=scan)(PORT=1521)))')
})

test('applying custom preset keeps manual URL and exposes driver class', () => {
  const form = applyDriverPreset({ ...initialConfigForm(), url: 'jdbc:custom://host/db' }, 'custom')

  assert.equal(form.driverPresetId, 'custom')
  assert.equal(form.urlMode, 'manual')
  assert.equal(form.url, 'jdbc:custom://host/db')
})

test('preflight validation blocks missing, invalid numeric, and capacity relationship values', () => {
  const form = {
    ...initialConfigForm(),
    name: 'OrdersDS',
    jndiName: 'jdbc/orders',
    databaseUser: 'app',
    url: 'not-jdbc',
    initialCapacity: '20',
    maxCapacity: '10',
    targetKeys: [],
  }
  const result = validateDataSourceConfigForm(form, 'create')

  assert.equal(result.valid, false)
  assert.equal(result.errors.url, 'JDBC URL must start with jdbc:.')
  assert.equal(result.errors.initialCapacity, 'Initial capacity cannot exceed max capacity.')
  assert.equal(result.errors.targets, 'At least one target is required.')
})
