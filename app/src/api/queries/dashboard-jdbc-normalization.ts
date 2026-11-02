import {
  resolveDataSourceUtilization,
  type DataSourceUtilizationCapacitySource,
} from './data-source-utilization.ts'

export type JdbcPoolSeverity = 'healthy' | 'warning' | 'critical' | 'unknown'

export interface JdbcPoolRuntime {
  serverName: string
  name: string
  state: string
  deploymentState: string | number | null
  activeConnectionsCurrentCount: number | null
  currCapacity: number | null
  configuredMaxCapacity: number | null
  waitingForConnectionCurrentCount: number | null
  leakedConnectionCount: number | null
  utilization: number | null
  utilizationCapacity: number | null
  utilizationCapacitySource: DataSourceUtilizationCapacitySource | null
  severity: JdbcPoolSeverity
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function classifyJdbcPool(pool: Omit<JdbcPoolRuntime, 'severity'>): JdbcPoolSeverity {
  const state = pool.state.toLowerCase()
  if (
    state === 'overloaded' ||
    (pool.leakedConnectionCount ?? 0) > 0 ||
    (pool.waitingForConnectionCurrentCount ?? 0) > 0
  ) {
    return 'critical'
  }
  if (state !== 'running' || pool.deploymentState === 'UNPREPARED' || pool.deploymentState === 0) {
    return 'warning'
  }
  if (pool.utilization !== null && pool.utilization >= 0.9) return 'warning'
  return 'healthy'
}

export function normalizeJdbcPool(
  serverName: string,
  item: unknown,
  configuredMaxCapacity: number | null = null,
): JdbcPoolRuntime | null {
  if (!isObject(item)) return null

  const name = readString(item.name)
  if (!name) return null

  const activeConnectionsCurrentCount = readNumber(item.activeConnectionsCurrentCount)
  const currCapacity = readNumber(item.currCapacity)
  const utilization = resolveDataSourceUtilization({
    activeConnectionsCurrentCount,
    configuredMaxCapacity,
    currCapacity,
  })
  const pool = {
    serverName,
    name,
    state: readString(item.state) ?? 'Unknown',
    deploymentState: readString(item.deploymentState) ?? readNumber(item.deploymentState),
    activeConnectionsCurrentCount,
    currCapacity,
    configuredMaxCapacity,
    waitingForConnectionCurrentCount: readNumber(item.waitingForConnectionCurrentCount),
    leakedConnectionCount: readNumber(item.leakedConnectionCount),
    ...utilization,
  }

  return { ...pool, severity: classifyJdbcPool(pool) }
}
