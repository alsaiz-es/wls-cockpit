import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SERVER_METRIC_CAPTURE_JDBC_RUNTIME_FIELDS,
  SERVER_METRIC_CAPTURE_JMS_DESTINATION_FIELDS,
  SERVER_METRIC_CAPTURE_JMS_SERVER_FIELDS,
  SERVER_METRIC_CAPTURE_SELECTED_ENDPOINTS,
  serverMetricCapturePollInterval,
  serverMetricCapturePollQueryKey,
  serverMetricCaptureSnapshotFromSettled,
} from '../src/api/queries/server-metric-capture-query.ts'
import type { JdbcPoolRuntime } from '../src/api/queries/domain-dashboard.ts'
import type { ServerMetricCaptureSession } from '../src/api/queries/server-metric-capture-store.ts'
import type { ServerRuntimeRow } from '../src/api/queries/server-runtimes.ts'

function session(overrides: Partial<ServerMetricCaptureSession> = {}): ServerMetricCaptureSession {
  return {
    id: 'session-1',
    scopeKey: 'scope-a',
    serverName: 'osb_server1',
    status: 'active',
    pollingIntervalMs: 5_000,
    pollWhileHidden: false,
    startedAt: 1000,
    stoppedAt: null,
    ticks: [],
    samples: [],
    resources: {},
    sampleCount: 0,
    pointCount: 0,
    gapCount: 0,
    omitted: { jdbc: 0, jms: 0 },
    ...overrides,
  }
}

function server(): ServerRuntimeRow {
  return {
    name: 'osb_server1',
    state: 'RUNNING',
    healthState: 'ok',
    listenAddress: null,
    listenPort: null,
    heap: null,
    jvm: null,
    threads: null,
  }
}

test('server metric capture poll key and endpoint manifest stay selected-server scoped', () => {
  assert.deepEqual(serverMetricCapturePollQueryKey('scope-a', 'osb_server1', 'session-1'), [
    'serverMetricCapturePoll',
    'scope-a',
    'osb_server1',
    'session-1',
  ])
  assert.deepEqual(SERVER_METRIC_CAPTURE_SELECTED_ENDPOINTS, [
    'serverRuntime',
    'jvmRuntime',
    'threadPoolRuntime',
    'jdbcDataSourceRuntimeMBeans',
    'jmsServers',
    'jmsDestinations',
  ])
})

test('server metric capture field allow-lists stay bounded', () => {
  assert.match(SERVER_METRIC_CAPTURE_JDBC_RUNTIME_FIELDS, /waitingForConnectionCurrentCount/)
  assert.match(SERVER_METRIC_CAPTURE_JMS_SERVER_FIELDS, /messagesPendingCount/)
  assert.match(SERVER_METRIC_CAPTURE_JMS_DESTINATION_FIELDS, /consumersCurrentCount/)
  assert.doesNotMatch(SERVER_METRIC_CAPTURE_JDBC_RUNTIME_FIELDS, /dashboard/i)
  assert.doesNotMatch(SERVER_METRIC_CAPTURE_JMS_SERVER_FIELDS, /threadStackDump/)
  assert.doesNotMatch(SERVER_METRIC_CAPTURE_JMS_DESTINATION_FIELDS, /threadStackDump/)
})

test('server metric capture poll interval honors cadence and visibility', () => {
  assert.equal(serverMetricCapturePollInterval(true, session({ pollingIntervalMs: 10_000 })), 10_000)
  assert.equal(serverMetricCapturePollInterval(false, session({ pollingIntervalMs: 10_000 })), false)
  assert.equal(serverMetricCapturePollInterval(false, session({ pollingIntervalMs: 10_000, pollWhileHidden: true })), 10_000)
  assert.equal(serverMetricCapturePollInterval(true, session({ status: 'stopped' })), false)
  assert.equal(serverMetricCapturePollInterval(true, null), false)
})

test('server metric capture snapshot keeps partial-family data when one family fails', () => {
  const jdbc: JdbcPoolRuntime[] = [{
    serverName: 'osb_server1',
    name: 'ProbeDS',
    state: 'Running',
    deploymentState: 'ACTIVE',
    activeConnectionsCurrentCount: 2,
    currCapacity: 4,
    configuredMaxCapacity: 10,
    waitingForConnectionCurrentCount: 0,
    leakedConnectionCount: 0,
    utilization: 0.2,
    utilizationCapacity: 10,
    utilizationCapacitySource: 'configuredMax',
    severity: 'healthy',
  }]
  const snapshot = serverMetricCaptureSnapshotFromSettled(
    server(),
    { status: 'fulfilled', value: jdbc },
    { status: 'rejected', reason: new Error('JMS unavailable') },
  )

  assert.equal(snapshot.jdbc.length, 1)
  assert.deepEqual(snapshot.jms, [])
  assert.deepEqual(snapshot.failures, ['jms: JMS unavailable'])
})
