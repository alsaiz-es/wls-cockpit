import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acknowledgeActiveLocalAlerts,
  activeLocalAlertCount,
  canSendDesktopNotifications,
  emptyLocalAlertState,
  evaluateLocalAlertConditions,
  getLocalAlertSnapshot,
  markLocalAlertsRead,
  projectDashboardAlertConditions,
  recordLocalAlertSnapshot,
  resetLocalAlerts,
  sendDesktopNotifications,
  unacknowledgedLocalAlertCount,
  unreadLocalAlertCount,
  type LocalAlertCondition,
} from '../src/api/queries/local-alerts.ts'
import type { DashboardSnapshot } from '../src/api/queries/domain-dashboard.ts'

function snapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    severity: 'healthy',
    servers: [],
    serverRollup: { total: 0, running: 0, warning: 0, stopped: 0, failed: 0, unknown: 0 },
    runtimePressure: {
      highestHeap: null,
      heapUnavailable: 0,
      heapUnavailableServers: [],
      totalThreads: null,
      idleThreads: null,
      pendingUserRequests: 0,
      hoggingThreads: 0,
      queueLength: 0,
      stuckThreads: 0,
      threadsUnavailable: 0,
      threadsUnavailableServers: [],
    },
    jdbc: { status: 'empty', items: [], failures: [] },
    jms: { status: 'empty', items: [], failures: [] },
    jmsRollup: { jmsServers: 0, destinations: 0, messagesCurrent: 0, messagesPending: 0, zeroConsumerBacklog: 0, paused: 0 },
    applications: { status: 'empty', items: [], failures: [] },
    applicationRollup: { total: 0, internal: 0, external: 0, healthy: 0, unhealthy: 0 },
    logs: { status: 'empty', items: [], failures: [] },
    issues: [],
    partialFailures: [],
    ...overrides,
  }
}

function condition(
  id: string,
  family: LocalAlertCondition['family'] = 'servers',
  severity: LocalAlertCondition['severity'] = 'critical',
): LocalAlertCondition {
  return {
    id,
    family,
    resourceId: id,
    resourceLabel: id,
    condition: 'failure',
    severity,
    title: `${id} failed`,
    detail: `${id} detail`,
  }
}

test('projects alert conditions from dashboard runtime signals', () => {
  const conditions = projectDashboardAlertConditions(snapshot({
    servers: [{
      name: 'osb_server1',
      state: 'FAILED_NOT_RESTARTABLE',
      healthState: 'failed',
      listenAddress: null,
      listenPort: null,
      heap: null,
      jvm: null,
      threads: null,
    }],
    jdbc: {
      status: 'available',
      failures: [],
      items: [{
        serverName: 'osb_server1',
        name: 'jdbc/AppDS',
        state: 'Overloaded',
        deploymentState: 'ACTIVE',
        activeConnectionsCurrentCount: 10,
        currCapacity: 10,
        configuredMaxCapacity: 10,
        waitingForConnectionCurrentCount: 2,
        leakedConnectionCount: 0,
        utilization: 1,
        utilizationCapacity: 10,
        utilizationCapacitySource: 'configuredMaxCapacity',
        severity: 'critical',
      }],
    },
    jms: {
      status: 'available',
      failures: [],
      items: [{
        serverName: 'osb_server1',
        jmsServerName: 'JMSServer1',
        destinationName: 'QueueA',
        destinationType: 'Queue',
        state: 'running',
        destinationsCurrentCount: null,
        messagesCurrentCount: 4,
        messagesPendingCount: 0,
        consumersCurrentCount: 0,
        consumptionPaused: false,
        productionPaused: false,
        insertionPaused: false,
        consumptionPausedState: null,
        productionPausedState: null,
        insertionPausedState: null,
        severity: 'warning',
      }],
    },
    applications: {
      status: 'available',
      failures: [],
      items: [{
        serverName: 'osb_server1',
        name: 'OrderApp',
        deploymentName: 'OrderApp',
        internal: false,
        healthState: 'failed',
        overallHealthState: 'failed',
        activeVersionState: null,
        deploymentState: 'FAILED',
        severity: 'critical',
      }],
    },
  }))

  assert.deepEqual(conditions.map((item) => item.family).sort(), ['applications', 'jdbc', 'jms', 'servers'])
})

test('first snapshot creates active baseline without emitting toasts', () => {
  const result = evaluateLocalAlertConditions(
    emptyLocalAlertState('scope-a'),
    'scope-a',
    [condition('server-a')],
    1000,
  )

  assert.equal(activeLocalAlertCount(result.state), 1)
  assert.equal(unacknowledgedLocalAlertCount(result.state), 1)
  assert.equal(result.emittedEvents.length, 0)
  assert.equal(result.state.toasts.length, 0)
  assert.equal(result.state.log.length, 1)
  assert.equal(result.state.log[0].silent, true)
})

test('marking read and acknowledging active alerts are separate actions', () => {
  resetLocalAlerts('scope-a')
  recordLocalAlertSnapshot('scope-a', snapshot({
    servers: [{
      name: 'osb_server1',
      state: 'FAILED_NOT_RESTARTABLE',
      healthState: 'failed',
      listenAddress: null,
      listenPort: null,
      heap: null,
      jvm: null,
      threads: null,
    }],
  }), 1000)

  assert.equal(activeLocalAlertCount(getLocalAlertSnapshot()), 1)
  assert.equal(unacknowledgedLocalAlertCount(getLocalAlertSnapshot()), 1)
  assert.equal(unreadLocalAlertCount(getLocalAlertSnapshot()), 1)

  markLocalAlertsRead()
  assert.equal(activeLocalAlertCount(getLocalAlertSnapshot()), 1)
  assert.equal(unacknowledgedLocalAlertCount(getLocalAlertSnapshot()), 1)
  assert.equal(unreadLocalAlertCount(getLocalAlertSnapshot()), 0)

  acknowledgeActiveLocalAlerts(1500)
  assert.equal(activeLocalAlertCount(getLocalAlertSnapshot()), 1)
  assert.equal(unacknowledgedLocalAlertCount(getLocalAlertSnapshot()), 0)
  assert.equal(Object.values(getLocalAlertSnapshot().activeConditions)[0]?.acknowledgedAt, 1500)
})

test('worsening condition emits once while sustained condition is deduped', () => {
  const baseline = evaluateLocalAlertConditions(emptyLocalAlertState('scope-a'), 'scope-a', [], 1000).state
  const first = evaluateLocalAlertConditions(baseline, 'scope-a', [condition('server-a')], 2000)
  const second = evaluateLocalAlertConditions(first.state, 'scope-a', [condition('server-a')], 3000)

  assert.equal(first.emittedEvents.length, 1)
  assert.equal(first.state.toasts.length, 1)
  assert.equal(second.emittedEvents.length, 0)
  assert.equal(second.state.toasts.length, 1)
})

test('sustained acknowledged conditions stay acknowledged until recovery or reappearance', () => {
  resetLocalAlerts('scope-a')
  const failedSnapshot = snapshot({
    servers: [{
      name: 'osb_server1',
      state: 'FAILED_NOT_RESTARTABLE',
      healthState: 'failed',
      listenAddress: null,
      listenPort: null,
      heap: null,
      jvm: null,
      threads: null,
    }],
  })

  recordLocalAlertSnapshot('scope-a', snapshot(), 1000)
  recordLocalAlertSnapshot('scope-a', failedSnapshot, 2000)
  acknowledgeActiveLocalAlerts(2500)
  recordLocalAlertSnapshot('scope-a', failedSnapshot, 3000)
  assert.equal(unacknowledgedLocalAlertCount(getLocalAlertSnapshot()), 0)

  recordLocalAlertSnapshot('scope-a', snapshot(), 4000)
  assert.equal(activeLocalAlertCount(getLocalAlertSnapshot()), 0)

  recordLocalAlertSnapshot('scope-a', failedSnapshot, 5000)
  assert.equal(activeLocalAlertCount(getLocalAlertSnapshot()), 1)
  assert.equal(unacknowledgedLocalAlertCount(getLocalAlertSnapshot()), 1)
})

test('worsening active condition clears acknowledgement and emits a new alert', () => {
  const baseline = evaluateLocalAlertConditions(emptyLocalAlertState('scope-a'), 'scope-a', [], 1000).state
  const active = evaluateLocalAlertConditions(baseline, 'scope-a', [condition('jms-a', 'jms', 'warning')], 2000).state
  active.activeConditions['jms-a'].acknowledgedAt = 2500

  const worsened = evaluateLocalAlertConditions(active, 'scope-a', [condition('jms-a', 'jms', 'critical')], 3000)

  assert.equal(worsened.emittedEvents.length, 1)
  assert.equal(worsened.emittedEvents[0].severity, 'critical')
  assert.equal(unacknowledgedLocalAlertCount(worsened.state), 1)
  assert.equal(worsened.state.activeConditions['jms-a'].acknowledgedAt, undefined)
})

test('recovery emits low-priority event and reappearance alerts again', () => {
  const baseline = evaluateLocalAlertConditions(emptyLocalAlertState('scope-a'), 'scope-a', [], 1000).state
  const active = evaluateLocalAlertConditions(baseline, 'scope-a', [condition('server-a')], 2000).state
  const recovered = evaluateLocalAlertConditions(active, 'scope-a', [], 3000)
  const reappeared = evaluateLocalAlertConditions(recovered.state, 'scope-a', [condition('server-a')], 4000)

  assert.equal(recovered.emittedEvents.length, 1)
  assert.equal(recovered.emittedEvents[0].kind, 'recovery')
  assert.equal(recovered.emittedEvents[0].severity, 'info')
  assert.equal(reappeared.emittedEvents.length, 1)
  assert.equal(reappeared.emittedEvents[0].kind, 'alert')
})

test('scope changes clear active alerts and reset baseline', () => {
  const active = evaluateLocalAlertConditions(
    emptyLocalAlertState('scope-a'),
    'scope-a',
    [condition('server-a')],
    1000,
  ).state
  const nextScope = evaluateLocalAlertConditions(active, 'scope-b', [condition('server-b')], 2000)

  assert.equal(nextScope.state.scopeKey, 'scope-b')
  assert.equal(activeLocalAlertCount(nextScope.state), 1)
  assert.deepEqual(Object.keys(nextScope.state.activeConditions), ['server-b'])
  assert.equal(nextScope.emittedEvents.length, 0)
  assert.equal(nextScope.state.log.length, 1)
  assert.equal(nextScope.state.log[0].silent, true)
  assert.equal(unacknowledgedLocalAlertCount(nextScope.state), 1)
})

test('condition bursts are aggregated by family above the cap', () => {
  const baseline = evaluateLocalAlertConditions(emptyLocalAlertState('scope-a'), 'scope-a', [], 1000).state
  const conditions = Array.from({ length: 8 }, (_, index) => condition(`app-${index}`, 'applications'))
  const result = evaluateLocalAlertConditions(baseline, 'scope-a', conditions, 2000, { aggregationCap: 5 })

  assert.equal(result.emittedEvents.length, 1)
  assert.equal(result.emittedEvents[0].aggregate, true)
  assert.equal(result.emittedEvents[0].count, 8)
  assert.equal(result.state.log.length, 1)
  assert.equal(result.state.toasts.length, 1)
})

test('desktop notifications only send when explicitly enabled and granted', () => {
  const event = {
    id: 'event-1',
    kind: 'alert',
    family: 'servers',
    severity: 'critical',
    title: 'server failed',
    detail: 'server detail',
    timestamp: 1000,
    conditionIds: ['server-a'],
    resourceLabels: ['server-a'],
    count: 1,
    aggregate: false,
    silent: false,
    read: false,
  } as const
  const sent: string[] = []
  const notificationApi = class {
    static permission: NotificationPermission = 'default'
    constructor(title: string) {
      sent.push(title)
    }
  }

  assert.equal(canSendDesktopNotifications(true, notificationApi), false)
  assert.equal(sendDesktopNotifications([event], true, notificationApi), 0)
  notificationApi.permission = 'granted'
  assert.equal(sendDesktopNotifications([event], true, notificationApi), 1)
  assert.deepEqual(sent, ['server failed'])
  assert.equal(sendDesktopNotifications([event], false, notificationApi), 0)
})

test('application issues quote the WebLogic health symptom instead of a generic state line', async () => {
  const { applicationHealthDetail, firstHealthReason } = await import('../src/api/queries/deployment-health-symptoms.ts')
  const reason = firstHealthReason(
    { state: 'ok', symptoms: [] },
    {
      state: 'warn',
      symptoms: [{ type: 'MDB', severity: 'MEDIUM', instanceId: 'Email Provider', info: 'MDB application Email Provider is NOT connected to messaging system.' }],
    },
  )
  assert.equal(reason, 'MDB application Email Provider is NOT connected to messaging system.')
  assert.equal(applicationHealthDetail({ healthState: 'ok', overallHealthState: 'warn', healthReason: reason }), reason)
  assert.equal(
    applicationHealthDetail({ healthState: 'ok', overallHealthState: 'warn', healthReason: null }),
    'Health ok, overall warn (WebLogic gave no symptom).',
  )
})
