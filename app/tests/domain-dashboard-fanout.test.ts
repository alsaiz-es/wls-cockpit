import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectDashboardFamilyFanout,
  dashboardPartialFailures,
  toDashboardFamilyResult,
  type OptionalFamilyPayload,
} from '../src/api/queries/dashboard-family-fanout.ts'
import { shouldFetchJmsDestinations } from '../src/api/queries/dashboard-jms-gating.ts'

const idleJmsSummary = {
  destinationsCurrentCount: 2,
  messagesCurrentCount: 0,
  messagesPendingCount: 0,
  consumptionPaused: false,
  productionPaused: false,
  insertionPaused: false,
  consumptionPausedState: null,
  productionPausedState: null,
  insertionPausedState: null,
}

test('dashboard JMS scan gate fetches non-empty JMS server destination collections', () => {
  assert.equal(shouldFetchJmsDestinations(idleJmsSummary), true)
  assert.equal(shouldFetchJmsDestinations({ ...idleJmsSummary, destinationsCurrentCount: 0 }), false)
})

test('dashboard JMS scan gate fetches destinations for pressure or incomplete summaries', () => {
  assert.equal(shouldFetchJmsDestinations({ ...idleJmsSummary, messagesCurrentCount: 7 }), true)
  assert.equal(shouldFetchJmsDestinations({ ...idleJmsSummary, messagesPendingCount: 1 }), true)
  assert.equal(shouldFetchJmsDestinations({ ...idleJmsSummary, consumptionPausedState: 'Production-Paused' }), true)
  assert.equal(shouldFetchJmsDestinations({ ...idleJmsSummary, messagesCurrentCount: null }), true)
  assert.equal(
    shouldFetchJmsDestinations({
      ...idleJmsSummary,
      destinationsCurrentCount: 0,
      messagesCurrentCount: null,
      messagesPendingCount: null,
    }),
    false,
  )
})

test('dashboard optional family fanout preserves successful rows when one resource fails', async () => {
  const payload = await collectDashboardFamilyFanout(
    ['server-a', 'server-b'],
    async (server) => {
      if (server === 'server-b') throw new Error('request timed out')
      return [{ server, name: 'OrdersDS' }]
    },
    (server) => server,
  )
  const result = toDashboardFamilyResult('jdbc', payload)

  assert.equal(result.status, 'available')
  assert.deepEqual(result.items, [{ server: 'server-a', name: 'OrdersDS' }])
  assert.deepEqual(result.failures, [{ resource: 'server-b', message: 'request timed out' }])
  assert.deepEqual(dashboardPartialFailures([{ family: 'jdbc', result }]), [
    { family: 'jdbc', resource: 'server-b', message: 'jdbc server-b: request timed out' },
  ])
})

test('dashboard optional family fanout marks the family failed when every resource fails', async () => {
  const payload = await collectDashboardFamilyFanout(
    ['server-a', 'server-b'],
    async (server) => {
      throw new Error(`${server} unavailable`)
    },
    (server) => server,
  )
  const result = toDashboardFamilyResult('applications', payload)

  assert.equal(result.status, 'failed')
  assert.deepEqual(result.items, [])
  assert.deepEqual(result.failures, [
    { resource: 'server-a', message: 'server-a unavailable' },
    { resource: 'server-b', message: 'server-b unavailable' },
  ])
})

test('dashboard optional family fanout carries nested JMS destination failures with fallback rows', async () => {
  const payload = await collectDashboardFamilyFanout(
    ['server-a', 'server-b'],
    async (server): Promise<Array<{ server: string; destination: string | null }> | OptionalFamilyPayload<{ server: string; destination: string | null }>> => {
      if (server === 'server-b') throw new Error('JMS runtime unavailable')

      return {
        attempted: 2,
        successful: 2,
        items: [
          { server, destination: 'OrdersQueue' },
          { server, destination: null },
        ],
        failures: [{ resource: `${server}/DemoJmsServer`, message: 'destinations unavailable' }],
      }
    },
    (server) => server,
  )
  const result = toDashboardFamilyResult('jms', payload)

  assert.equal(result.status, 'available')
  assert.deepEqual(result.items, [
    { server: 'server-a', destination: 'OrdersQueue' },
    { server: 'server-a', destination: null },
  ])
  assert.deepEqual(result.failures, [
    { resource: 'server-a/DemoJmsServer', message: 'destinations unavailable' },
    { resource: 'server-b', message: 'JMS runtime unavailable' },
  ])
})
