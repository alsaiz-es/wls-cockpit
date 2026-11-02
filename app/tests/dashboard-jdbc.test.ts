import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeJdbcPool } from '../src/api/queries/dashboard-jdbc-normalization.ts'

test('dashboard JDBC pool pressure uses configured max capacity before current capacity', () => {
  assert.deepEqual(
    normalizeJdbcPool(
      'AdminServer',
      {
        name: 'OrdersDS',
        state: 'Running',
        deploymentState: 2,
        activeConnectionsCurrentCount: 5,
        currCapacity: 5,
        waitingForConnectionCurrentCount: 0,
        leakedConnectionCount: 0,
      },
      100,
    ),
    {
      serverName: 'AdminServer',
      name: 'OrdersDS',
      state: 'Running',
      deploymentState: 2,
      activeConnectionsCurrentCount: 5,
      currCapacity: 5,
      configuredMaxCapacity: 100,
      waitingForConnectionCurrentCount: 0,
      leakedConnectionCount: 0,
      utilization: 0.05,
      utilizationCapacity: 100,
      utilizationCapacitySource: 'configuredMax',
      severity: 'healthy',
    },
  )
})

test('dashboard JDBC pool pressure falls back to current capacity when config is unavailable', () => {
  assert.deepEqual(
    normalizeJdbcPool('AdminServer', {
      name: 'OrdersDS',
      state: 'Running',
      deploymentState: 2,
      activeConnectionsCurrentCount: 5,
      currCapacity: 5,
      waitingForConnectionCurrentCount: 0,
      leakedConnectionCount: 0,
    }),
    {
      serverName: 'AdminServer',
      name: 'OrdersDS',
      state: 'Running',
      deploymentState: 2,
      activeConnectionsCurrentCount: 5,
      currCapacity: 5,
      configuredMaxCapacity: null,
      waitingForConnectionCurrentCount: 0,
      leakedConnectionCount: 0,
      utilization: 1,
      utilizationCapacity: 5,
      utilizationCapacitySource: 'runtimeCurrent',
      severity: 'warning',
    },
  )
})
