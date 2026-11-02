import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dataSourceParamsBody,
  driverBody,
  gateDataSourceConfigInputForVersion,
  poolBody,
  type DataSourceConfigInput,
} from '../src/api/queries/data-source-management-payload.ts'

function input(overrides: Partial<DataSourceConfigInput> = {}): DataSourceConfigInput {
  return {
    name: 'OrdersDS',
    jndiName: 'jdbc/orders',
    driverName: 'oracle.jdbc.OracleDriver',
    url: 'jdbc:oracle:thin:@//scan.example.com:1521/PDB1',
    databaseUser: 'app',
    password: '',
    globalTransactionsProtocol: 'OnePhaseCommit',
    useXaDataSourceInterface: false,
    keepConnAfterGlobalTx: null,
    initialCapacity: 1,
    minCapacity: 1,
    maxCapacity: 15,
    testTableName: 'SQL ISVALID',
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
    invokeBeginEndRequest: true,
    targets: [{ kind: 'servers', name: 'AdminServer' }],
    ...overrides,
  }
}

test('datasource mutation bodies include represented tuning fields and preserve false values', () => {
  const value = input()

  assert.deepEqual(dataSourceParamsBody(value), {
    JNDINames: ['jdbc/orders'],
    globalTransactionsProtocol: 'OnePhaseCommit',
  })
  assert.deepEqual(driverBody(value), {
    driverName: 'oracle.jdbc.OracleDriver',
    url: 'jdbc:oracle:thin:@//scan.example.com:1521/PDB1',
    useXaDataSourceInterface: false,
  })
  assert.deepEqual(poolBody(value), {
    initialCapacity: 1,
    minCapacity: 1,
    maxCapacity: 15,
    testTableName: 'SQL ISVALID',
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
    invokeBeginEndRequest: true,
  })
})

test('datasource mutation bodies omit null and empty optional fields', () => {
  const value = input({
    password: '',
    globalTransactionsProtocol: null,
    useXaDataSourceInterface: null,
    testTableName: '',
    statementCacheType: null,
    initialCapacity: null,
  })

  assert.deepEqual(dataSourceParamsBody(value), { JNDINames: ['jdbc/orders'] })
  assert.deepEqual(driverBody(value), {
    driverName: 'oracle.jdbc.OracleDriver',
    url: 'jdbc:oracle:thin:@//scan.example.com:1521/PDB1',
  })
  assert.equal('initialCapacity' in poolBody(value), false)
  assert.equal('testTableName' in poolBody(value), false)
  assert.equal('statementCacheType' in poolBody(value), false)
})

test('datasource version gating omits invokeBeginEndRequest for 12.2.1.4 only', () => {
  assert.equal(gateDataSourceConfigInputForVersion(input(), { version: '12.2.1.4.0' }).invokeBeginEndRequest, null)
  assert.equal(gateDataSourceConfigInputForVersion(input(), { version: '14.1.2.0.0' }).invokeBeginEndRequest, true)
})
