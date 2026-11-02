import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deploymentConfigMapEntries,
  normalizeDeploymentConfigSummary,
  readDeploymentTargetRefs,
} from '../src/api/queries/deployment-config-normalization.ts'
import {
  deploymentConfigQueryParams,
  deploymentRuntimeDetailCandidates,
  deploymentRuntimeQueryParams,
} from '../src/api/queries/deployment-runtime-detail-selection.ts'
import {
  deploymentHealthSymptoms,
} from '../src/api/queries/deployment-health-symptoms.ts'

test('reads deployment target tuples and ignores malformed targets', () => {
  assert.deepEqual(readDeploymentTargetRefs([['servers', 'AdminServer'], ['clusters', 'cluster1'], ['machines', 'm1'], 'bad']), [
    { kind: 'servers', name: 'AdminServer' },
    { kind: 'clusters', name: 'cluster1' },
  ])
})

test('reads deployment targets in the identity shape WebLogic REST returns', () => {
  // Shape captured from /edit/appDeployments?fields=name,targets on 12.2.1.4.
  assert.deepEqual(
    readDeploymentTargetRefs([{ identity: ['clusters', 'cluster1'] }, { identity: ['servers', 'AdminServer'] }, { identity: [] }]),
    [
      { kind: 'clusters', name: 'cluster1' },
      { kind: 'servers', name: 'AdminServer' },
    ],
  )
})

test('normalizes deployment configuration metadata independently', () => {
  const summary = normalizeDeploymentConfigSummary({
    targets: [['servers', 'AdminServer']],
    moduleType: 'war',
    deploymentOrder: 100,
    sourcePath: ' /u01/apps/demo.war ',
    planPath: '',
    securityDDModel: 'DDOnly',
    stagingMode: 'stage',
  })

  assert.deepEqual(summary?.targets, [{ kind: 'servers', name: 'AdminServer' }])
  assert.deepEqual(summary?.metadata, {
    moduleType: 'war',
    deploymentOrder: 100,
    sourcePath: '/u01/apps/demo.war',
    planPath: null,
    securityDDModel: 'DDOnly',
    stagingMode: 'stage',
  })
})

test('maps deployment config by deployment name and application name', () => {
  const entries = deploymentConfigMapEntries({
    name: 'DemoDeployment',
    applicationName: 'DemoApp',
    targets: [['servers', 'AdminServer']],
    sourcePath: '/u01/apps/demo.war',
  })

  assert.equal(entries.length, 2)
  assert.equal(entries[0][0], 'DemoDeployment')
  assert.equal(entries[1][0], 'DemoApp')
  assert.equal(entries[0][1], entries[1][1])
})

test('rejects deployment config entries without a deployment name', () => {
  assert.deepEqual(deploymentConfigMapEntries({ applicationName: 'DemoApp' }), [])
  assert.equal(normalizeDeploymentConfigSummary(null), null)
})

test('uses bounded deployment configuration and runtime query params', () => {
  assert.deepEqual(deploymentConfigQueryParams(), {
    fields: 'name,applicationName,targets,moduleType,deploymentOrder,sourcePath,planPath,securityDDModel,stagingMode',
    links: 'none',
  })
  assert.deepEqual(deploymentRuntimeQueryParams(), {
    fields:
      'name,applicationName,applicationVersion,internal,healthState,overallHealthState,activeVersionState,deploymentState',
    links: 'none',
  })
})

test('builds selected deployment runtime candidates from route and config identity', () => {
  assert.deepEqual(deploymentRuntimeDetailCandidates('OrdersDeployment', 'OrdersApp'), [
    'OrdersDeployment',
    'OrdersApp',
  ])
  assert.deepEqual(deploymentRuntimeDetailCandidates('DemoApp', 'DemoApp'), ['DemoApp'])
  assert.deepEqual(deploymentRuntimeDetailCandidates('DemoApp', null), ['DemoApp'])
})

test('normalizes deployment health symptoms from health and overall states', () => {
  assert.deepEqual(
    deploymentHealthSymptoms(
      {
        state: 'ok',
        symptoms: [
          {
            type: 'JDBC',
            severity: 'LOW',
            instanceId: 'OrdersApp',
            info: ' Connection pool retrying. ',
          },
        ],
      },
      {
        state: 'warn',
        symptoms: [
          {
            type: 'MDB',
            severity: 'MEDIUM',
            instanceId: 'OrdersMdb',
            info: 'MDB application OrdersMdb is NOT connected to messaging system.',
          },
          { ignored: true },
        ],
      },
    ),
    [
      {
        source: 'health',
        category: 'resource',
        summary: 'Deployment health references a runtime resource dependency.',
        actionHint: 'Inspect the related datasource or runtime resource on the selected server.',
        type: 'JDBC',
        severity: 'LOW',
        instanceId: 'OrdersApp',
        info: 'Connection pool retrying.',
      },
      {
        source: 'overall',
        category: 'jms',
        summary: 'MDB is not connected to its messaging system.',
        actionHint: 'Check the selected server JMS resources, MDB target, and destination availability.',
        type: 'MDB',
        severity: 'MEDIUM',
        instanceId: 'OrdersMdb',
        info: 'MDB application OrdersMdb is NOT connected to messaging system.',
      },
    ],
  )
})

test('JMS system modules get their targets from JMSSystemResources', async () => {
  const { applyJmsModuleTargets, jmsModuleTargetEntries, JMS_MODULE_TYPE } = await import('../src/api/queries/deployment-config-normalization.ts')
  const modules = new Map(jmsModuleTargetEntries({ name: 'OrdersJMSModule', targets: [{ identity: ['servers', 'AdminServer'] }] }))
  const row = { name: 'OrdersJMSModule', deploymentName: 'OrdersJMSModule', configurationSupported: false, configuredTargets: [], moduleType: null }
  const [applied] = applyJmsModuleTargets([row], modules)
  assert.deepEqual(applied.configuredTargets, [{ kind: 'servers', name: 'AdminServer' }])
  assert.equal(applied.moduleType, JMS_MODULE_TYPE)
  const app = { ...row, name: 'orders-app', deploymentName: 'orders-app', configurationSupported: true }
  assert.equal(applyJmsModuleTargets([app], modules)[0], app)
})
