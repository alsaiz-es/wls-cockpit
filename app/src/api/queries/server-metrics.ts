import type { JdbcPoolRuntime, JmsRuntimeSummary } from './domain-dashboard.ts'
import { heapUtilization } from './heap-utilization.ts'
import {
  jdbcMetricResourceId,
  jmsMetricResourceId,
  serverMetricResourceId,
} from './metric-history.ts'
import type { ServerRuntimeRow } from './server-runtimes.ts'

export const SERVER_METRICS_RESOURCE_LIMIT = 10

export type ServerMetricFamily = 'jvm' | 'threads' | 'jdbc' | 'jms'

export interface ServerMetricSampleInput {
  family: ServerMetricFamily
  resourceId: string
  resourceLabel: string
  metric: string
  value: number | null
}

export interface ServerMetricResourceSnapshot {
  family: Extract<ServerMetricFamily, 'jdbc' | 'jms'>
  resourceId: string
  resourceLabel: string
  state: string | null
  severity: string | null
  detail: Record<string, string | number | boolean | null>
}

export interface ServerMetricProjection {
  samples: ServerMetricSampleInput[]
  resources: ServerMetricResourceSnapshot[]
  omitted: {
    jdbc: number
    jms: number
  }
}

function sample(
  family: ServerMetricFamily,
  resourceId: string,
  resourceLabel: string,
  metric: string,
  value: number | null | undefined,
): ServerMetricSampleInput {
  return {
    family,
    resourceId,
    resourceLabel,
    metric,
    value: typeof value === 'number' && Number.isFinite(value) ? value : null,
  }
}

function booleanSample(value: boolean | null | undefined) {
  if (typeof value !== 'boolean') return null
  return value ? 1 : 0
}

function anyPaused(row: JmsRuntimeSummary) {
  const values = [row.consumptionPaused, row.productionPaused, row.insertionPaused]
  if (values.every((value) => value === null)) return null
  return values.some(Boolean)
}

export function serverJvmMetricSamples(server: ServerRuntimeRow): ServerMetricSampleInput[] {
  const resourceId = serverMetricResourceId(server.name)
  const heapPercent = heapUtilization(server.heap)
  const processCpuPercent = server.jvm?.processCpuLoad === null || server.jvm?.processCpuLoad === undefined
    ? null
    : server.jvm.processCpuLoad * 100

  return [
    sample('jvm', resourceId, server.name, 'heap.used', server.heap?.current),
    sample('jvm', resourceId, server.name, 'heap.max', server.heap?.max),
    sample('jvm', resourceId, server.name, 'heap.percent', heapPercent === null ? null : heapPercent * 100),
    sample('jvm', resourceId, server.name, 'cpu.process', processCpuPercent),
    sample('jvm', resourceId, server.name, 'uptime.ms', server.jvm?.uptime),
  ]
}

export function serverThreadMetricSamples(server: ServerRuntimeRow): ServerMetricSampleInput[] {
  const resourceId = serverMetricResourceId(server.name)
  return [
    sample('threads', resourceId, server.name, 'threads.total', server.threads?.total),
    sample('threads', resourceId, server.name, 'threads.idle', server.threads?.idle),
    sample('threads', resourceId, server.name, 'threads.standby', server.threads?.standby),
    sample('threads', resourceId, server.name, 'threads.pending', server.threads?.pending),
    sample('threads', resourceId, server.name, 'threads.queue', server.threads?.queueLength),
    sample('threads', resourceId, server.name, 'threads.hogging', server.threads?.hogging),
    sample('threads', resourceId, server.name, 'threads.stuck', server.threads?.stuck),
  ]
}

export function sortJdbcForServerMetrics(rows: JdbcPoolRuntime[]) {
  return [...rows].sort((a, b) => {
    const waitingDelta = (b.waitingForConnectionCurrentCount ?? 0) - (a.waitingForConnectionCurrentCount ?? 0)
    if (waitingDelta !== 0) return waitingDelta
    const activeDelta = (b.activeConnectionsCurrentCount ?? 0) - (a.activeConnectionsCurrentCount ?? 0)
    if (activeDelta !== 0) return activeDelta
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

export function sortJmsForServerMetrics(rows: JmsRuntimeSummary[]) {
  return [...rows].sort((a, b) => {
    const pendingDelta = (b.messagesPendingCount ?? 0) - (a.messagesPendingCount ?? 0)
    if (pendingDelta !== 0) return pendingDelta
    const messagesDelta = (b.messagesCurrentCount ?? 0) - (a.messagesCurrentCount ?? 0)
    if (messagesDelta !== 0) return messagesDelta
    return (a.destinationName ?? a.jmsServerName).localeCompare(b.destinationName ?? b.jmsServerName, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  })
}

export function jdbcMetricSamples(rows: JdbcPoolRuntime[], limit = SERVER_METRICS_RESOURCE_LIMIT) {
  return sortJdbcForServerMetrics(rows).slice(0, limit).flatMap((row) => {
    const resourceId = jdbcMetricResourceId(row.serverName, row.name)
    return [
      sample('jdbc', resourceId, row.name, 'connections.active', row.activeConnectionsCurrentCount),
      sample('jdbc', resourceId, row.name, 'connections.waiting', row.waitingForConnectionCurrentCount),
      sample('jdbc', resourceId, row.name, 'connections.capacity', row.utilizationCapacity),
      sample('jdbc', resourceId, row.name, 'connections.leaked', row.leakedConnectionCount),
      sample('jdbc', resourceId, row.name, 'connections.utilization', row.utilization === null ? null : row.utilization * 100),
    ]
  })
}

export function jmsMetricSamples(rows: JmsRuntimeSummary[], limit = SERVER_METRICS_RESOURCE_LIMIT) {
  return sortJmsForServerMetrics(rows).slice(0, limit).flatMap((row) => {
    const resourceId = jmsMetricResourceId(row.serverName, row.jmsServerName, row.destinationName)
    const resourceLabel = row.destinationName ?? row.jmsServerName
    return [
      sample('jms', resourceId, resourceLabel, 'messages.current', row.messagesCurrentCount),
      sample('jms', resourceId, resourceLabel, 'messages.pending', row.messagesPendingCount),
      sample('jms', resourceId, resourceLabel, 'consumers.current', row.consumersCurrentCount),
      sample(
        'jms',
        resourceId,
        resourceLabel,
        'paused.any',
        booleanSample(anyPaused(row)),
      ),
    ]
  })
}

export function jdbcMetricResources(rows: JdbcPoolRuntime[], limit = SERVER_METRICS_RESOURCE_LIMIT) {
  return sortJdbcForServerMetrics(rows).slice(0, limit).map<ServerMetricResourceSnapshot>((row) => ({
    family: 'jdbc',
    resourceId: jdbcMetricResourceId(row.serverName, row.name),
    resourceLabel: row.name,
    state: row.state,
    severity: row.severity,
    detail: {
      serverName: row.serverName,
      activeConnectionsCurrentCount: row.activeConnectionsCurrentCount,
      waitingForConnectionCurrentCount: row.waitingForConnectionCurrentCount,
      configuredMaxCapacity: row.configuredMaxCapacity,
      currCapacity: row.currCapacity,
      leakedConnectionCount: row.leakedConnectionCount,
    },
  }))
}

export function jmsMetricResources(rows: JmsRuntimeSummary[], limit = SERVER_METRICS_RESOURCE_LIMIT) {
  return sortJmsForServerMetrics(rows).slice(0, limit).map<ServerMetricResourceSnapshot>((row) => {
    const resourceLabel = row.destinationName ?? row.jmsServerName
    return {
      family: 'jms',
      resourceId: jmsMetricResourceId(row.serverName, row.jmsServerName, row.destinationName),
      resourceLabel,
      state: row.state,
      severity: row.severity,
      detail: {
        serverName: row.serverName,
        jmsServerName: row.jmsServerName,
        destinationName: row.destinationName,
        messagesCurrentCount: row.messagesCurrentCount,
        messagesPendingCount: row.messagesPendingCount,
        consumersCurrentCount: row.consumersCurrentCount,
        consumptionPaused: row.consumptionPaused,
        productionPaused: row.productionPaused,
        insertionPaused: row.insertionPaused,
      },
    }
  })
}

export function projectServerMetricSamples({
  server,
  jdbc,
  jms,
  limit = SERVER_METRICS_RESOURCE_LIMIT,
}: {
  server: ServerRuntimeRow
  jdbc: JdbcPoolRuntime[]
  jms: JmsRuntimeSummary[]
  limit?: number
}): ServerMetricProjection {
  const jdbcForServer = jdbc.filter((row) => row.serverName === server.name)
  const jmsForServer = jms.filter((row) => row.serverName === server.name)

  return {
    samples: [
      ...serverJvmMetricSamples(server),
      ...serverThreadMetricSamples(server),
      ...jdbcMetricSamples(jdbcForServer, limit),
      ...jmsMetricSamples(jmsForServer, limit),
    ],
    resources: [
      ...jdbcMetricResources(jdbcForServer, limit),
      ...jmsMetricResources(jmsForServer, limit),
    ],
    omitted: {
      jdbc: Math.max(0, jdbcForServer.length - limit),
      jms: Math.max(0, jmsForServer.length - limit),
    },
  }
}
