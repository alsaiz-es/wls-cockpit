import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDeploymentRuntimeGroups } from '../src/api/queries/deployment-runtime-groups.ts'
import {
  buildDeploymentTargetingMatrix,
  matrixRowMatchesCluster,
  matrixRowMatchesTarget,
} from '../src/api/queries/deployment-targeting-matrix.ts'
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

test('projects deployment configured targets and runtime state into matrix cells', () => {
  const groups = buildDeploymentRuntimeGroups([
    row({
      configuredTargets: [
        { kind: 'servers', name: 'AdminServer' },
        { kind: 'servers', name: 'server2' },
        { kind: 'clusters', name: 'cluster1' },
      ],
    }),
    row({
      id: 'server1:DemoApp',
      serverName: 'server1',
      configuredTargets: [
        { kind: 'servers', name: 'AdminServer' },
        { kind: 'servers', name: 'server2' },
        { kind: 'clusters', name: 'cluster1' },
      ],
      activeVersionState: 0,
      deploymentState: 'PREPARED',
    }),
  ])

  const matrix = buildDeploymentTargetingMatrix(groups, [{ kind: 'servers', name: 'server3' }])
  const matrixRow = matrix.rows[0]
  assert.ok(matrixRow)
  assert.deepEqual(matrix.targets.map((target) => target.key), [
    'clusters:cluster1',
    'servers:AdminServer',
    'servers:server1',
    'servers:server2',
    'servers:server3',
  ])
  assert.equal(matrixRow.cells.find((cell) => cell.target.key === 'servers:AdminServer')?.state, 'configured-active')
  assert.equal(matrixRow.cells.find((cell) => cell.target.key === 'servers:server1')?.state, 'runtime-inactive')
  assert.equal(matrixRow.cells.find((cell) => cell.target.key === 'servers:server2')?.state, 'configured-missing')
  assert.equal(matrixRow.cells.find((cell) => cell.target.key === 'clusters:cluster1')?.state, 'configured-unavailable')
  assert.equal(matrixRow.cells.find((cell) => cell.target.key === 'servers:server3')?.state, 'empty')
  assert.equal(matrixRow.drift, 'missing-runtime')
})

test('classifies runtime-only drift and target filters without mutation inputs', () => {
  const groups = buildDeploymentRuntimeGroups([
    row({
      configuredTargets: [{ kind: 'servers', name: 'AdminServer' }],
    }),
    row({
      id: 'server1:DemoApp',
      serverName: 'server1',
      configuredTargets: [{ kind: 'servers', name: 'AdminServer' }],
    }),
  ])

  const matrixRow = buildDeploymentTargetingMatrix(groups).rows[0]
  assert.ok(matrixRow)
  assert.equal(matrixRow.drift, 'runtime-only')
  assert.equal(matrixRowMatchesTarget(matrixRow, 'servers:server1'), true)
  assert.equal(matrixRowMatchesTarget(matrixRow, 'servers:server2'), false)
})

test('classifies configured cluster-only rows as unavailable drift', () => {
  const matrixRow = buildDeploymentTargetingMatrix(
    buildDeploymentRuntimeGroups([
      row({
        configuredTargets: [
          { kind: 'clusters', name: 'cluster1' },
          { kind: 'servers', name: 'AdminServer' },
        ],
      }),
    ]),
  ).rows[0]

  assert.ok(matrixRow)
  assert.equal(matrixRow.drift, 'unavailable')
  assert.equal(matrixRow.cellsByTargetKey.get('clusters:cluster1')?.state, 'configured-unavailable')
})

test('protects internal, mixed-scope, and runtime-only matrix rows from target edits', () => {
  const [internal, mixed, runtimeOnly] = buildDeploymentTargetingMatrix(
    buildDeploymentRuntimeGroups([
      row({ deploymentName: 'InternalApp', name: 'InternalApp', scope: 'internal' }),
      row({ deploymentName: 'MixedApp', name: 'MixedApp', scope: 'external' }),
      row({ deploymentName: 'MixedApp', name: 'MixedApp', serverName: 'server1', scope: 'internal' }),
      row({
        deploymentName: 'RuntimeOnlyApp',
        name: 'RuntimeOnlyApp',
        configurationSupported: false,
        configuredTargets: [],
      }),
    ]),
  ).rows

  assert.equal(internal?.editable, false)
  assert.match(internal?.protectedReason ?? '', /Internal/)
  assert.equal(mixed?.editable, false)
  assert.match(mixed?.protectedReason ?? '', /mixed-scope/)
  assert.equal(runtimeOnly?.editable, false)
  assert.match(runtimeOnly?.protectedReason ?? '', /Configuration row/)
})

test('matches matrix rows by configured cluster', () => {
  const matrixRow = buildDeploymentTargetingMatrix(
    buildDeploymentRuntimeGroups([
      row({ configuredTargets: [{ kind: 'clusters', name: 'cluster1' }] }),
    ]),
  ).rows[0]

  assert.ok(matrixRow)
  assert.equal(matrixRowMatchesCluster(matrixRow, 'cluster1'), true)
  assert.equal(matrixRowMatchesCluster(matrixRow, 'cluster2'), false)
})
