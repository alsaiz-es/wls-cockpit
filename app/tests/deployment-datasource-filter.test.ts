import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deploymentDataSourceKey,
  filterDeploymentDataSourceRows,
} from '../src/api/queries/deployment-datasource-filter.ts'

const rows = [
  { serverName: 'AdminServer', name: 'WLSCockpitDemoApp', deploymentName: 'WLSCockpitDemoApp' },
  { serverName: 'AdminServer', name: 'WLSCockpitDemoDS', deploymentName: 'WLSCockpitDemoDS' },
  { serverName: 'server1', name: 'RemoteDS', deploymentName: 'RemoteDS' },
]

test('deployment datasource filter removes applicationRuntimes backed by datasource runtime names', () => {
  const filtered = filterDeploymentDataSourceRows(
    rows,
    new Map([['AdminServer', new Set([deploymentDataSourceKey('AdminServer', 'WLSCockpitDemoDS')])]]),
  )

  assert.deepEqual(
    filtered.map((row) => row.name),
    ['WLSCockpitDemoApp', 'RemoteDS'],
  )
})

test('deployment datasource filter matches datasource deployment identity as well as display name', () => {
  const filtered = filterDeploymentDataSourceRows(
    [
      { serverName: 'AdminServer', name: 'jdbc/WLSCockpitDemoDS', deploymentName: 'WLSCockpitDemoDS' },
      { serverName: 'AdminServer', name: 'WLSCockpitDemoApp', deploymentName: 'WLSCockpitDemoApp' },
    ],
    new Map([['AdminServer', new Set([deploymentDataSourceKey('AdminServer', 'WLSCockpitDemoDS')])]]),
  )

  assert.deepEqual(filtered, [
    { serverName: 'AdminServer', name: 'WLSCockpitDemoApp', deploymentName: 'WLSCockpitDemoApp' },
  ])
})

test('deployment datasource filter preserves rows when discovery is unavailable for a server', () => {
  const filtered = filterDeploymentDataSourceRows(rows, new Map())

  assert.deepEqual(filtered, rows)
})
