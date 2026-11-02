import assert from 'node:assert/strict'
import test from 'node:test'
import { DATA_SOURCE_TEST_PASSED, normalizeLifecycleResult } from '../src/api/queries/data-source-lifecycle.ts'

test('a data source test reports whether the connection worked', () => {
  assert.equal(normalizeLifecycleResult({ return: null }, 'OrdersDS', 'server1', 'testPool').message, DATA_SOURCE_TEST_PASSED)
  assert.throws(
    () => normalizeLifecycleResult({ return: 'IO Error: The Network Adapter could not establish the connection' }, 'OrdersDS', 'server1', 'testPool'),
    /Test OrdersDS on server1 failed: IO Error: The Network Adapter could not establish the connection/,
  )
  assert.equal(normalizeLifecycleResult({ return: null }, 'OrdersDS', 'server1', 'shrink').message, null)
})
