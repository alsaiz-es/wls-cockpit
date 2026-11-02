import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyDeploymentLifecycleSupport,
  deploymentLifecycleSupported,
} from '../src/api/queries/deployment-lifecycle-support.ts'

test('deployment lifecycle support matches deployment or application names', () => {
  const lifecycleNames = new Set(['ConfiguredDeployment', 'DisplayApp'])

  assert.equal(
    deploymentLifecycleSupported({ deploymentName: 'ConfiguredDeployment', name: 'OtherApp' }, lifecycleNames),
    true,
  )
  assert.equal(
    deploymentLifecycleSupported({ deploymentName: 'OtherDeployment', name: 'DisplayApp' }, lifecycleNames),
    true,
  )
  assert.equal(
    deploymentLifecycleSupported({ deploymentName: 'OtherDeployment', name: 'OtherApp' }, lifecycleNames),
    false,
  )
})

test('deployment lifecycle decoration defaults to safe false without lifecycle names', () => {
  const rows = [
    { deploymentName: 'DemoDeployment', name: 'DemoApp', lifecycleSupported: true, serverName: 'AdminServer' },
  ]

  assert.deepEqual(applyDeploymentLifecycleSupport(rows, new Set()), [
    { deploymentName: 'DemoDeployment', name: 'DemoApp', lifecycleSupported: false, serverName: 'AdminServer' },
  ])
})

test('deployment lifecycle decoration preserves matching rows and object identity when unchanged', () => {
  const row = { deploymentName: 'DemoDeployment', name: 'DemoApp', lifecycleSupported: true, serverName: 'AdminServer' }
  const decorated = applyDeploymentLifecycleSupport([row], new Set(['DemoDeployment']))

  assert.strictEqual(decorated[0], row)
  assert.equal(decorated[0]?.lifecycleSupported, true)
})
