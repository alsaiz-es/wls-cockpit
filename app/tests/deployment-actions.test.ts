import assert from 'node:assert/strict'
import test from 'node:test'
import { deploymentConfirmCopy, rowStateLabel } from '../src/routes/deployment-actions.ts'

const row = {
  name: 'orders-app',
  targetName: 'server1',
  configuredTargets: [{ name: 'cluster1' }, { name: 'AdminServer' }],
}

test('start, stop and redeploy each ask for confirmation with their own wording', () => {
  assert.equal(deploymentConfirmCopy('start', row).confirmLabel, 'Confirm start')
  assert.equal(deploymentConfirmCopy('start', row).subject, 'orders-app on server1')
  assert.equal(deploymentConfirmCopy('stop', row).confirmLabel, 'Confirm stop')
  assert.equal(deploymentConfirmCopy('undeploy', row).confirmLabel, 'Confirm undeploy')
})

test('redeploy confirmation names every target, because WebLogic redeploys on all of them', () => {
  const copy = deploymentConfirmCopy('redeploy', row)
  assert.equal(copy.subject, 'orders-app on cluster1, AdminServer')
  assert.match(copy.description, /all of its targets, not only this server/)
  assert.equal(deploymentConfirmCopy('redeploy', { ...row, configuredTargets: [] }).subject, 'orders-app on server1')
})

test('the state filter falls back to activeVersionState, which is all applicationRuntimes report', () => {
  assert.equal(rowStateLabel({ deploymentState: null, activeVersionState: 2 }), 'ACTIVE')
  assert.equal(rowStateLabel({ deploymentState: null, activeVersionState: 0 }), 'INACTIVE')
  assert.equal(rowStateLabel({ deploymentState: 1, activeVersionState: 2 }), 'PREPARED')
  assert.equal(rowStateLabel({ deploymentState: null, activeVersionState: null }), '–')
})
