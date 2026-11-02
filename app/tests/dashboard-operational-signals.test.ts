import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyDashboardJms } from '../src/api/queries/dashboard-jms-classification.ts'
import { buildObservedServerDownIssues } from '../src/api/queries/dashboard-observed-servers.ts'
import { dashboardServerJmsPressure } from '../src/api/queries/dashboard-server-pressure.ts'
import { issueHint, issueSecondaryTarget, issueSnapshotServers, issueTarget } from '../src/routes/dashboard/format.ts'

function jms(overrides: Partial<Parameters<typeof classifyDashboardJms>[0]> = {}) {
  const row = {
    destinationName: 'OrdersQueue',
    state: 'running',
    messagesCurrentCount: 7,
    messagesPendingCount: 0,
    consumersCurrentCount: 0,
    consumptionPaused: false,
    productionPaused: false,
    insertionPaused: false,
    consumptionPausedState: 'Consumption-Enabled',
    productionPausedState: 'Production-Enabled',
    insertionPausedState: 'Insertion-Enabled',
    ...overrides,
  }

  return {
    ...row,
    severity: classifyDashboardJms(row),
  }
}

test('JMS backlog with zero consumers is warning unless stronger signals exist', () => {
  assert.equal(jms().severity, 'warning')
  assert.equal(jms({ consumptionPaused: true }).severity, 'critical')
  assert.equal(jms({ state: 'FAILED' }).severity, 'critical')
  assert.equal(jms({ messagesCurrentCount: 0, consumersCurrentCount: 0 }).severity, 'healthy')
})

test('dashboard server pressure renders JMS unavailable for non-running servers', () => {
  assert.deepEqual(
    dashboardServerJmsPressure(
      { state: 'SHUTDOWN' },
      [{ messagesCurrentCount: 7, messagesPendingCount: 0, severity: 'warning' }],
    ),
    { messages: null, pending: null, issues: 1 },
  )
  assert.deepEqual(
    dashboardServerJmsPressure(
      { state: 'RUNNING' },
      [{ messagesCurrentCount: 7, messagesPendingCount: 2, severity: 'warning' }],
    ),
    { messages: 7, pending: 2, issues: 1 },
  )
})

test('JMS issue targets server detail instead of dashboard', () => {
  const issue = {
    id: 'jms:AdminServer:DemoJMSServer:OrdersQueue',
    severity: 'warning',
    family: 'jms',
    title: 'OrdersQueue has JMS pressure',
    detail: 'Messages 7, pending 0, consumers 0, paused no.',
    hint: 'Open JMS detail.',
    serverName: 'AdminServer',
    resourceName: 'OrdersQueue',
    jmsServerName: 'DemoJMSServer',
    destinationName: 'OrdersQueue',
    snapshotServers: ['AdminServer'],
  } as const
  const target = issueTarget(issue)

  assert.deepEqual(target, {
    label: 'JMS OrdersQueue',
    href: '/jms/AdminServer/DemoJMSServer/OrdersQueue',
  })
  assert.deepEqual(issueSecondaryTarget(issue), {
    label: 'Server',
    href: '/servers/AdminServer',
  })
  assert.deepEqual(issueSnapshotServers(issue), ['AdminServer'])
  assert.equal(issueHint({ ...issue, hint: undefined }), 'Open JMS detail to inspect backlog, consumers, pause state, and message tooling support.')
})

test('session-observed running server later stopped becomes critical', () => {
  const observedRunningServers = new Set<string>()
  const noIssue = buildObservedServerDownIssues([{ name: 'AdminServer', state: 'RUNNING' }], observedRunningServers)
  assert.equal(noIssue.some((issue) => issue.id === 'server-observed-down:AdminServer'), false)

  const issues = buildObservedServerDownIssues([{ name: 'AdminServer', state: 'SHUTDOWN' }], observedRunningServers)

  assert.deepEqual(
    issues.find((issue) => issue.id === 'server-observed-down:AdminServer'),
    {
      id: 'server-observed-down:AdminServer',
      severity: 'critical',
      family: 'servers',
      title: 'AdminServer stopped after running',
      detail: 'Observed RUNNING earlier in this browser session; now SHUTDOWN.',
      hint: 'Open server detail and collect evidence before deciding whether to restart the managed server.',
      serverName: 'AdminServer',
      snapshotServers: ['AdminServer'],
    },
  )
})
