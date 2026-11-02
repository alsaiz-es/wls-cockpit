import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deploymentTargetKey,
  deploymentTargetLabel,
  deploymentTargetTuple,
} from '../src/api/queries/deployment-targets.ts'

test('deployment target helpers preserve WLS edit target tuple identity', () => {
  const target = { kind: 'servers' as const, name: 'AdminServer' }

  assert.equal(deploymentTargetKey(target), 'servers:AdminServer')
  assert.equal(deploymentTargetLabel(target), 'server:AdminServer')
  assert.deepEqual(deploymentTargetTuple(target), ['servers', 'AdminServer'])
})
