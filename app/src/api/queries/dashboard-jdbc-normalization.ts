import {
  alertRuleLevel,
  collectAlertSignals,
  getActiveAlertRules,
  worstAlertSignal,
  type AlertLevel,
  type AlertSignals,
  type ResolvedAlertRules,
} from '../alert-rules.ts'
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
  // Set by the dashboard: the figures that hold the pool at its level, judged over time.
  alertSignals?: AlertSignals<DashboardJdbcSignal>
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

// Overloaded, suspended or unprepared pools are immediate. Waiting requests and pool usage follow
// the jdbc.waiting and jdbc.utilization thresholds. The leaked counter only grows, so a single
// reading cannot tell a new leak from an old one: only the dashboard, which watches it over time,
// alerts on leaks (jdbc.leaked).
export function jdbcStateLevel(pool: Pick<JdbcPoolRuntime, 'state' | 'deploymentState'>): AlertLevel | null {
  const state = pool.state.toLowerCase()
  if (state === 'overloaded') return 'critical'
  if (state !== 'running' || pool.deploymentState === 'UNPREPARED' || pool.deploymentState === 0) return 'warning'
  return null
}

export function jdbcUtilizationPercent(pool: Pick<JdbcPoolRuntime, 'utilization'>) {
  return pool.utilization === null ? null : pool.utilization * 100
}

// Usage against the current capacity (the configured maximum was not readable) says nothing about
// headroom, since the pool can still grow: it can warn but never be critical.
export function capJdbcUtilizationLevel(
  level: AlertLevel | null,
  pool: Pick<JdbcPoolRuntime, 'utilizationCapacitySource'>,
): AlertLevel | null {
  return level === 'critical' && pool.utilizationCapacitySource !== 'configuredMax' ? 'warning' : level
}

export type JdbcAlertSignal = 'state' | 'waiting' | 'utilization'
export type DashboardJdbcSignal = JdbcAlertSignal | 'leaks'

type JdbcClassifiable = Pick<
  JdbcPoolRuntime,
  'state' | 'deploymentState' | 'waitingForConnectionCurrentCount' | 'utilization' | 'utilizationCapacitySource'
>

export function jdbcAlertSignals(
  pool: JdbcClassifiable,
  rules: ResolvedAlertRules = getActiveAlertRules(),
): AlertSignals<JdbcAlertSignal> {
  return collectAlertSignals<JdbcAlertSignal>([
    [['state'], jdbcStateLevel(pool)],
    [['waiting'], alertRuleLevel(rules.rules['jdbc.waiting'], pool.waitingForConnectionCurrentCount)],
    [['utilization'], capJdbcUtilizationLevel(alertRuleLevel(rules.rules['jdbc.utilization'], jdbcUtilizationPercent(pool)), pool)],
  ])
}

export function classifyJdbcPool(pool: JdbcClassifiable, rules: ResolvedAlertRules = getActiveAlertRules()): JdbcPoolSeverity {
  return worstAlertSignal(jdbcAlertSignals(pool, rules)) ?? 'healthy'
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
