import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDeploymentRuntimeGroups } from '../src/api/queries/deployment-runtime-groups.ts'
import type { DeploymentRuntimeRow } from '../src/api/queries/deployments.ts'

function row(overrides: Partial<DeploymentRuntimeRow>): DeploymentRuntimeRow {
  return {
    id: 'AdminServer:DemoApp',
    name: 'DemoApp',
    deploymentName: 'DemoApp',
    serverName: 'AdminServer',
    targetName: 'AdminServer',
    lifecycleSupported: true,
    configurationSupported: true,
    configuredTargets: [{ kind: 'servers', name: 'AdminServer' }],
    moduleType: 'war',
    deploymentOrder: 100,
    sourcePath: '/u01/apps/demo.war',
    planPath: null,
    securityDDModel: null,
    stagingMode: 'nostage',
    healthState: 'ok',
    overallHealthState: 'ok',
    healthSymptoms: [],
    activeVersionState: 2,
    deploymentState: 'ACTIVE',
    applicationVersion: null,
    scope: 'external',
    severity: 'healthy',
    ...overrides,
  }
}

test('groups deployment instances by configured deployment name', () => {
  const groups = buildDeploymentRuntimeGroups([
    row({ id: 'server2:OrdersDeployment', name: 'OrdersApp', deploymentName: 'OrdersDeployment', serverName: 'server2' }),
    row({ id: 'server1:OrdersDeployment', name: 'OrdersApp', deploymentName: 'OrdersDeployment', serverName: 'server1' }),
  ])

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.deploymentName, 'OrdersDeployment')
  assert.equal(groups[0]?.name, 'OrdersApp')
  assert.deepEqual(groups[0]?.instances.map((instance) => instance.serverName), ['server1', 'server2'])
})

test('rolls up worst severity and health across deployment instances', () => {
  const groups = buildDeploymentRuntimeGroups([
    row({ id: 'server1:DemoApp', serverName: 'server1', severity: 'healthy', healthState: 'ok', overallHealthState: 'ok' }),
    row({ id: 'server2:DemoApp', serverName: 'server2', severity: 'warning', healthState: 'warn', overallHealthState: 'ok' }),
    row({ id: 'server3:DemoApp', serverName: 'server3', severity: 'critical', healthState: 'critical', overallHealthState: 'failed' }),
  ])

  assert.equal(groups[0]?.severity, 'critical')
  assert.equal(groups[0]?.healthState, 'critical')
  assert.equal(groups[0]?.overallHealthState, 'failed')
})

test('reports mixed scope and unique sorted configured targets', () => {
  const groups = buildDeploymentRuntimeGroups([
    row({
      scope: 'external',
      configuredTargets: [
        { kind: 'clusters', name: 'cluster1' },
        { kind: 'servers', name: 'AdminServer' },
      ],
    }),
    row({
      serverName: 'server1',
      scope: 'internal',
      configuredTargets: [
        { kind: 'servers', name: 'AdminServer' },
        { kind: 'servers', name: 'server1' },
      ],
    }),
  ])

  assert.equal(groups[0]?.scope, 'mixed')
  assert.deepEqual(groups[0]?.configuredTargets, [
    { kind: 'clusters', name: 'cluster1' },
    { kind: 'servers', name: 'AdminServer' },
    { kind: 'servers', name: 'server1' },
  ])
})

test('deduplicates versions and runtime states', () => {
  const groups = buildDeploymentRuntimeGroups([
    row({ applicationVersion: 'v2', activeVersionState: 2, deploymentState: 'ACTIVE' }),
    row({ serverName: 'server1', applicationVersion: 'v1', activeVersionState: 0, deploymentState: 'PREPARED' }),
    row({ serverName: 'server2', applicationVersion: 'v2', activeVersionState: 2, deploymentState: 'ACTIVE' }),
  ])

  assert.deepEqual(groups[0]?.applicationVersions, ['v1', 'v2'])
  assert.deepEqual(groups[0]?.activeVersionStates, [2, 0])
  assert.deepEqual(groups[0]?.deploymentStates, ['ACTIVE', 'PREPARED'])
})
