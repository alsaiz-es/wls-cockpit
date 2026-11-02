import assert from 'node:assert/strict'
import test from 'node:test'
import { targetChange, targetChangeSummary } from '../src/components/target-change-model.ts'

test('the target editor summarizes exactly what a save changes', () => {
  const change = targetChange(['cluster:cluster1', 'server:AdminServer'], ['cluster:cluster1', 'server:osb_server2'])
  assert.deepEqual(change, { added: ['server:osb_server2'], removed: ['server:AdminServer'] })
  assert.equal(targetChangeSummary(change), 'Adds server:osb_server2 · Removes server:AdminServer')
  assert.equal(targetChangeSummary(targetChange(['cluster:cluster1'], ['cluster:cluster1'])), 'No changes yet.')
})
