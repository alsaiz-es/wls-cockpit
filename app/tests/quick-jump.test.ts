import assert from 'node:assert/strict'
import test from 'node:test'
import type { DashboardSnapshot } from '../src/api/queries/domain-dashboard.ts'
import { buildQuickJumpEntries, filterQuickJumpEntries, hasLiveQuickJumpResources } from '../src/components/quick-jump-model.ts'

const snapshot = {
  severity: 'warning',
  servers: [
    { name: 'AdminServer', state: 'RUNNING', healthState: 'ok' },
    { name: 'osb_server1', state: 'RUNNING', healthState: 'warn' },
  ],
  applications: {
    status: 'available',
    items: [
      {
        serverName: 'osb_server1',
        name: 'orders-web',
        deploymentName: 'orders-web',
      },
    ],
    failures: [],
  },
  jdbc: {
    status: 'available',
    items: [
      {
        serverName: 'osb_server1',
        name: 'OrdersDS',
      },
    ],
    failures: [],
  },
  jms: {
    status: 'available',
    items: [
      {
        serverName: 'osb_server1',
        jmsServerName: 'JMSServer-1',
        destinationName: 'OrdersQueue',
      },
    ],
    failures: [],
  },
} as DashboardSnapshot

test('quick jump includes top-level routes and live dashboard resources', () => {
  const entries = buildQuickJumpEntries(snapshot)

  assert.ok(entries.some((entry) => entry.id === 'route:dashboard' && entry.href === '/dashboard'))
  assert.ok(entries.some((entry) => entry.id === 'server:osb_server1' && entry.href === '/servers/osb_server1'))
  assert.ok(entries.some((entry) => entry.id === 'deployment:osb_server1:orders-web' && entry.href === '/deployments/osb_server1/orders-web'))
  assert.ok(entries.some((entry) => entry.id === 'jdbc:osb_server1:OrdersDS' && entry.href === '/data-sources/osb_server1/OrdersDS'))
  assert.ok(entries.some((entry) => entry.id === 'jms:osb_server1:JMSServer-1:OrdersQueue' && entry.href === '/jms/osb_server1/JMSServer-1/OrdersQueue'))
  assert.equal(hasLiveQuickJumpResources(snapshot), true)
})

test('quick jump filtering searches labels details and keywords', () => {
  const entries = buildQuickJumpEntries(snapshot)
  const matches = filterQuickJumpEntries(entries, 'orders', 4)

  assert.deepEqual(matches.map((entry) => entry.label), ['orders-web', 'OrdersDS', 'OrdersQueue'])
})

test('quick jump falls back to routes without a dashboard snapshot', () => {
  const entries = buildQuickJumpEntries(null)

  assert.equal(hasLiveQuickJumpResources(null), false)
  assert.ok(entries.some((entry) => entry.id === 'route:servers'))
  assert.equal(entries.some((entry) => entry.id.startsWith('server:')), false)
})
