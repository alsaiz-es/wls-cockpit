import assert from 'node:assert/strict'
import test from 'node:test'
import {
  projectServerMetricSamples,
  sortJdbcForServerMetrics,
  sortJmsForServerMetrics,
} from '../src/api/queries/server-metrics.ts'
import type { JdbcPoolRuntime, JmsRuntimeSummary } from '../src/api/queries/domain-dashboard.ts'
import type { ServerRuntimeRow } from '../src/api/queries/server-runtimes.ts'

function server(overrides: Partial<ServerRuntimeRow> = {}): ServerRuntimeRow {
  return {
    name: 'osb_server1',
    state: 'RUNNING',
    healthState: 'ok',
    listenAddress: null,
    listenPort: null,
    heap: { current: 512, max: 1024 },
    jvm: {
      uptime: 60_000,
      javaVersion: '1.8.0_401',
      javaVendor: 'Oracle Corporation',
      javaVmVendor: 'Oracle Corporation',
      osName: 'Linux',
      osVersion: '4.1',
      processCpuLoad: 0.125,
    },
    threads: {
      total: 20,
      idle: 12,
      standby: 1,
      pending: 2,
      queueLength: 3,
      hogging: 4,
      stuck: 0,
    },
    ...overrides,
  }
}

function jdbc(name: string, waiting: number, active = 0, serverName = 'osb_server1'): JdbcPoolRuntime {
  return {
    serverName,
    name,
    state: 'Running',
    deploymentState: 'ACTIVE',
    activeConnectionsCurrentCount: active,
    currCapacity: 10,
    configuredMaxCapacity: 20,
    waitingForConnectionCurrentCount: waiting,
    leakedConnectionCount: 0,
    utilization: 0.5,
    utilizationCapacity: 20,
    utilizationCapacitySource: 'configuredMax',
    severity: waiting > 0 ? 'critical' : 'healthy',
  }
}

function jms(destinationName: string, pending: number, messages = 0, serverName = 'osb_server1'): JmsRuntimeSummary {
  return {
    serverName,
    jmsServerName: 'JMSServer',
    destinationName,
    destinationType: 'Queue',
    state: 'running',
    destinationsCurrentCount: null,
    messagesCurrentCount: messages,
    messagesPendingCount: pending,
    consumersCurrentCount: 1,
    consumptionPaused: false,
    productionPaused: false,
    insertionPaused: false,
    consumptionPausedState: null,
    productionPausedState: null,
    insertionPausedState: null,
    severity: pending > 0 ? 'warning' : 'healthy',
  }
}

test('projects selected server JVM CPU, heap, and thread samples', () => {
  const projection = projectServerMetricSamples({ server: server(), jdbc: [], jms: [] })

  const byMetric = new Map(projection.samples.map((sample) => [sample.metric, sample]))
  assert.equal(byMetric.get('cpu.process')?.value, 12.5)
  assert.equal(byMetric.get('heap.percent')?.value, 50)
  assert.equal(byMetric.get('threads.pending')?.value, 2)
  assert.equal(byMetric.get('threads.hogging')?.value, 4)
  assert.deepEqual(projection.omitted, { jdbc: 0, jms: 0 })
})

test('projects CPU sample as unavailable when JVM CPU is missing', () => {
  const row = server({
    jvm: {
      uptime: 60_000,
      javaVersion: null,
      javaVendor: null,
      javaVmVendor: null,
      osName: null,
      osVersion: null,
      processCpuLoad: null,
    },
  })
  const projection = projectServerMetricSamples({ server: row, jdbc: [], jms: [] })

  assert.equal(projection.samples.find((sample) => sample.metric === 'cpu.process')?.value, null)
})

test('server metrics filters hosted resources to the selected server and records omitted counts', () => {
  const projection = projectServerMetricSamples({
    server: server(),
    jdbc: [jdbc('low', 0), jdbc('high', 5), jdbc('other', 10, 0, 'AdminServer')],
    jms: [jms('lowQueue', 0), jms('highQueue', 7), jms('otherQueue', 9, 0, 'AdminServer')],
    limit: 1,
  })

  assert.equal(projection.omitted.jdbc, 1)
  assert.equal(projection.omitted.jms, 1)
  assert.equal(projection.samples.some((sample) => sample.resourceLabel === 'high'), true)
  assert.equal(projection.samples.some((sample) => sample.resourceLabel === 'low'), false)
  assert.equal(projection.samples.some((sample) => sample.resourceLabel === 'other'), false)
  assert.equal(projection.samples.some((sample) => sample.resourceLabel === 'highQueue'), true)
  assert.equal(projection.samples.some((sample) => sample.resourceLabel === 'lowQueue'), false)
  assert.equal(projection.samples.some((sample) => sample.resourceLabel === 'otherQueue'), false)
  assert.deepEqual(projection.resources.map((resource) => resource.resourceLabel), ['high', 'highQueue'])
})

test('hosted JDBC and JMS sort by pressure before name', () => {
  assert.deepEqual(sortJdbcForServerMetrics([jdbc('b', 0, 9), jdbc('a', 3), jdbc('c', 0, 1)]).map((row) => row.name), [
    'a',
    'b',
    'c',
  ])
  assert.deepEqual(sortJmsForServerMetrics([jms('b', 0, 9), jms('a', 3), jms('c', 0, 1)]).map((row) => row.destinationName), [
    'a',
    'b',
    'c',
  ])
})
