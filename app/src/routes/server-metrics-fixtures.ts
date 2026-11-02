import type { ServerMetricCaptureSession } from '@/api/queries/server-metric-capture-store'
import { jdbcMetricResourceId, jmsMetricResourceId, serverMetricResourceId } from '@/api/queries/metric-history'

export type ServerMetricCaptureFixtureName = 'active' | 'stopped' | 'unavailable' | 'gap'

const BASE_TIME = Date.parse('2026-05-04T10:00:00.000Z')

function point(
  timestamp: number,
  family: ServerMetricCaptureSession['samples'][number]['family'],
  resourceId: string,
  resourceLabel: string,
  metric: string,
  value: number,
  gapBefore = false,
): ServerMetricCaptureSession['samples'][number] {
  return { timestamp, family, resourceId, resourceLabel, metric, value, gapBefore }
}

function metricSet(serverName: string, timestamp: number, index: number, gapBefore = false) {
  const serverId = serverMetricResourceId(serverName)
  const jdbcId = jdbcMetricResourceId(serverName, 'OrdersDS')
  const jmsId = jmsMetricResourceId(serverName, 'DemoJMSServer', 'OrdersQueue')

  return [
    point(timestamp, 'jvm', serverId, serverName, 'heap.percent', 42 + index * 4, gapBefore),
    point(timestamp, 'jvm', serverId, serverName, 'heap.used', (520 + index * 40) * 1024 * 1024, gapBefore),
    point(timestamp, 'jvm', serverId, serverName, 'heap.max', 1536 * 1024 * 1024, gapBefore),
    point(timestamp, 'jvm', serverId, serverName, 'cpu.process', 18 + index * 7, gapBefore),
    point(timestamp, 'jvm', serverId, serverName, 'uptime.ms', 3_600_000 + index * 30_000, gapBefore),
    point(timestamp, 'threads', serverId, serverName, 'threads.total', 24, gapBefore),
    point(timestamp, 'threads', serverId, serverName, 'threads.idle', 14 - index, gapBefore),
    point(timestamp, 'threads', serverId, serverName, 'threads.standby', 2, gapBefore),
    point(timestamp, 'threads', serverId, serverName, 'threads.pending', index * 2, gapBefore),
    point(timestamp, 'threads', serverId, serverName, 'threads.queue', index * 3, gapBefore),
    point(timestamp, 'threads', serverId, serverName, 'threads.hogging', index, gapBefore),
    point(timestamp, 'threads', serverId, serverName, 'threads.stuck', index === 3 ? 1 : 0, gapBefore),
    point(timestamp, 'jdbc', jdbcId, 'OrdersDS', 'connections.active', 18 + index * 3, gapBefore),
    point(timestamp, 'jdbc', jdbcId, 'OrdersDS', 'connections.waiting', index === 3 ? 4 : index, gapBefore),
    point(timestamp, 'jdbc', jdbcId, 'OrdersDS', 'connections.capacity', 50, gapBefore),
    point(timestamp, 'jdbc', jdbcId, 'OrdersDS', 'connections.leaked', 0, gapBefore),
    point(timestamp, 'jms', jmsId, 'OrdersQueue', 'messages.current', 22 + index * 5, gapBefore),
    point(timestamp, 'jms', jmsId, 'OrdersQueue', 'messages.pending', 2 + index * 2, gapBefore),
    point(timestamp, 'jms', jmsId, 'OrdersQueue', 'consumers.current', 1, gapBefore),
    point(timestamp, 'jms', jmsId, 'OrdersQueue', 'paused.any', 0, gapBefore),
  ]
}

export function serverMetricCaptureVisualFixture(
  name: ServerMetricCaptureFixtureName,
  scopeKey: string,
  serverName: string,
): ServerMetricCaptureSession {
  const tickTimes = name === 'gap'
    ? [BASE_TIME, BASE_TIME + 5_000, BASE_TIME + 95_000, BASE_TIME + 100_000]
    : [BASE_TIME, BASE_TIME + 5_000, BASE_TIME + 10_000, BASE_TIME + 15_000]
  const ticks = name === 'unavailable'
    ? tickTimes.slice(0, 2).map((timestamp) => ({ timestamp, gapBefore: false }))
    : tickTimes.map((timestamp, index) => ({ timestamp, gapBefore: name === 'gap' && index === 2 }))
  const samples = name === 'unavailable'
    ? []
    : tickTimes.flatMap((timestamp, index) => metricSet(serverName, timestamp, index, name === 'gap' && index === 2))
  const status = name === 'active' || name === 'gap' || name === 'unavailable' ? 'active' : 'stopped'
  const jdbcId = jdbcMetricResourceId(serverName, 'OrdersDS')
  const jmsId = jmsMetricResourceId(serverName, 'DemoJMSServer', 'OrdersQueue')

  return {
    id: `${scopeKey}-${serverName}-${name}`,
    scopeKey,
    serverName,
    status,
    pollingIntervalMs: 5_000,
    pollWhileHidden: name === 'active',
    startedAt: BASE_TIME,
    stoppedAt: status === 'stopped' ? tickTimes.at(-1) ?? BASE_TIME : null,
    ticks,
    samples,
    resources: name === 'unavailable'
      ? {}
      : {
          [jdbcId]: {
            family: 'jdbc',
            resourceId: jdbcId,
            resourceLabel: 'OrdersDS',
            state: 'Running',
            severity: name === 'stopped' ? 'healthy' : 'warning',
            detail: { serverName, activeConnectionsCurrentCount: 27, waitingForConnectionCurrentCount: 4 },
          },
          [jmsId]: {
            family: 'jms',
            resourceId: jmsId,
            resourceLabel: 'OrdersQueue',
            state: 'running',
            severity: 'warning',
            detail: { serverName, jmsServerName: 'DemoJMSServer', destinationName: 'OrdersQueue' },
          },
        },
    sampleCount: ticks.length,
    pointCount: samples.length,
    gapCount: ticks.filter((tick) => tick.gapBefore).length,
    omitted: { jdbc: name === 'gap' ? 2 : 0, jms: name === 'gap' ? 1 : 0 },
  }
}
