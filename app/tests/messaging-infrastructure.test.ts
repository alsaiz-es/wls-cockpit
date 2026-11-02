import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyBridgeState,
  normalizeMessagingBridges,
  normalizePersistentStores,
  normalizeSafAgent,
  normalizeSafRemoteEndpoints,
  safEndpointFailing,
} from '../src/api/queries/messaging-infrastructure.ts'

test('persistent stores carry health state, first reason and counters', () => {
  const [store] = normalizePersistentStores('server1', {
    items: [{ name: 'FileStore-0', healthState: { state: 'warning', reasons: ['Disk almost full'] }, objectCount: 12, readCount: 'x' }],
  })
  assert.equal(store?.id, 'server1/FileStore-0')
  assert.equal(store?.healthState, 'warn')
  assert.equal(store?.healthReason, 'Disk almost full')
  assert.equal(store?.objectCount, 12)
  assert.equal(store?.readCount, null)
  assert.equal(store?.severity, 'warning')
  assert.deepEqual(normalizePersistentStores('server1', null), [])
  const [fromSymptoms] = normalizePersistentStores('server1', {
    items: [{ name: 'JDBCStore', healthState: { state: 'critical', symptoms: [{ type: 'STORE', severity: 'HIGH', info: 'Store failed to open' }] } }],
  })
  assert.equal(fromSymptoms?.healthReason, 'Store failed to open')
  assert.equal(fromSymptoms?.severity, 'critical')
})

test('a SAF endpoint fails when its last failure is newer than its last connection', () => {
  const [endpoint] = normalizeSafRemoteEndpoints({ items: [{ name: 'e1', URL: 't3://remote:8001', lastTimeConnected: 100, lastTimeFailedToConnect: 200 }] })
  assert.ok(endpoint)
  assert.equal(safEndpointFailing(endpoint), true)
  assert.equal(safEndpointFailing({ ...endpoint, lastTimeConnected: 300 }), false)
  assert.equal(safEndpointFailing({ ...endpoint, lastTimeFailedToConnect: 0 }), false)
})

test('SAF agents are critical when messages wait behind a failing endpoint', () => {
  const failing = normalizeSafRemoteEndpoints({ items: [{ name: 'e1', lastTimeConnected: 1, lastTimeFailedToConnect: 2 }] })
  const healthy = { name: 'agent', healthState: { state: 'ok' } }
  assert.equal(normalizeSafAgent('ms1', { ...healthy, messagesCurrentCount: 4 }, failing).severity, 'critical')
  assert.equal(normalizeSafAgent('ms1', { ...healthy, messagesCurrentCount: 0 }, failing).severity, 'warning')
  assert.equal(normalizeSafAgent('ms1', { ...healthy, pausedForForwarding: true }, []).severity, 'warning')
  assert.equal(normalizeSafAgent('ms1', healthy, []).severity, 'healthy')
})

test('bridges that are not active need attention', () => {
  assert.equal(classifyBridgeState('Active'), 'healthy')
  assert.equal(classifyBridgeState('Inactive'), 'warning')
  assert.equal(classifyBridgeState('Stopped'), 'critical')
  assert.equal(classifyBridgeState(null), 'unknown')
  assert.deepEqual(
    normalizeMessagingBridges('ms1', { items: [{ name: 'OrdersBridge', state: 'Active', description: 'Forwarding messages.' }] }).map((row) => [row.id, row.severity]),
    [['ms1/OrdersBridge', 'healthy']],
  )
})
