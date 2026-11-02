import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dataSourceConfigCollectionQueryParams,
  dataSourceParamsQueryParams,
  normalizeDataSourceParamsMetadata,
  readDataSourceTargetRefs,
} from '../src/api/queries/data-source-config-normalization.ts'

test('reads datasource target tuples and ignores malformed targets', () => {
  assert.deepEqual(
    readDataSourceTargetRefs([
      ['servers', 'AdminServer'],
      { identity: ['servers', 'server1'] },
      ['clusters', 'cluster1'],
      { identity: ['clusters', 'cluster2'] },
      ['machines', 'm1'],
      { identity: ['machines', 'm2'] },
      'bad',
    ]),
    [
      { kind: 'servers', name: 'AdminServer' },
      { kind: 'servers', name: 'server1' },
      { kind: 'clusters', name: 'cluster1' },
      { kind: 'clusters', name: 'cluster2' },
    ],
  )
})

test('normalizes datasource params transaction metadata independently', () => {
  assert.deepEqual(
    normalizeDataSourceParamsMetadata({
      JNDINames: [' jdbc/demo ', '', 42, 'jdbc/orders'],
      globalTransactionsProtocol: ' TwoPhaseCommit ',
      algorithmType: 'Load-Balancing',
      scope: 'Global',
      dataSourceList: 'OrdersDS1,OrdersDS2',
      keepConnAfterGlobalTx: true,
    }),
    {
      jndiNames: ['jdbc/demo', 'jdbc/orders'],
      globalTransactionsProtocol: 'TwoPhaseCommit',
      algorithmType: 'Load-Balancing',
      scope: 'Global',
      dataSourceList: 'OrdersDS1,OrdersDS2',
      keepConnAfterGlobalTx: true,
    },
  )
})

test('normalizes missing datasource params metadata as neutral values', () => {
  assert.deepEqual(normalizeDataSourceParamsMetadata(null), {
    jndiNames: [],
    globalTransactionsProtocol: null,
    algorithmType: null,
    scope: null,
    dataSourceList: null,
    keepConnAfterGlobalTx: null,
  })
})

test('requests datasource params with an explicit metadata allow-list', () => {
  assert.deepEqual(dataSourceConfigCollectionQueryParams(), {
    fields: 'name,targets',
    links: 'none',
  })
  assert.deepEqual(dataSourceParamsQueryParams(), {
    fields: 'JNDINames,globalTransactionsProtocol,algorithmType,scope,dataSourceList,keepConnAfterGlobalTx',
    links: 'none',
  })
})
