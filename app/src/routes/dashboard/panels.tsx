import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type {
  ApplicationRuntimeSummary,
  DashboardSnapshot,
  JdbcPoolRuntime,
  JmsRuntimeSummary,
  LogActivityRuntime,
} from '@/api/queries/domain-dashboard'
import { dashboardServerJmsPressure } from '@/api/queries/dashboard-server-pressure'
import {
  getMetricHistorySeries,
  jdbcMetricResourceId,
  jmsMetricResourceId,
  serverMetricResourceId,
} from '@/api/queries/metric-history'
import type { ServerRuntimeRow } from '@/api/queries/server-runtimes'
import { alertTextClass, DataTable, HeapBar, MetricTrend, MonoText, StatusBadge, type DataTableColumn } from '@/components'
import { deploymentLabel, formatNumber, severityTone } from './format'
import { CompactStatusLine, Section, Unavailable } from './primitives'
import { ServerStateBand } from './server-state-band'

function segment(value: string) {
  return encodeURIComponent(value)
}

function DetailLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </Link>
  )
}

export function ServerStatesPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  return (
    <Section title="Server States" detail="Lifecycle roll-up from reconciled runtimes.">
      <ServerStateBand {...snapshot.serverRollup} />
    </Section>
  )
}

interface ServerPressureRow {
  server: ServerRuntimeRow
  jdbcWaiting: number
  jdbcLeaks: number
  jdbcIssues: number
  jmsMessages: number | null
  jmsPending: number | null
  jmsIssues: number
  severity: 'critical' | 'warning' | 'healthy' | 'unknown'
}

interface MetricHistoryViewProps {
  metricScopeKey: string | null
}

function pressureSeverity(
  server: ServerRuntimeRow,
  jdbcPools: JdbcPoolRuntime[],
  jmsItems: JmsRuntimeSummary[],
): ServerPressureRow['severity'] {
  if (!server.threads) return 'unknown'
  if (server.threads.stuck > 0 || (server.threads.pending ?? 0) > 0) return 'critical'
  if ((server.threads.hogging ?? 0) > 0) return 'warning'
  if (jdbcPools.some((pool) => pool.severity === 'critical')) return 'critical'
  if (jmsItems.some((item) => item.severity === 'critical')) return 'critical'
  if (jdbcPools.some((pool) => pool.severity === 'warning')) return 'warning'
  if (jmsItems.some((item) => item.severity === 'warning')) return 'warning'
  return 'healthy'
}

function buildServerPressureRows(snapshot: DashboardSnapshot): ServerPressureRow[] {
  return snapshot.servers
    .map((server) => {
      const pools = snapshot.jdbc.items.filter((pool) => pool.serverName === server.name)
      const jmsItems = snapshot.jms.items.filter((item) => item.serverName === server.name)
      const jmsPressure = dashboardServerJmsPressure(server, jmsItems)
      return {
        server,
        jdbcWaiting: pools.reduce((total, pool) => total + (pool.waitingForConnectionCurrentCount ?? 0), 0),
        jdbcLeaks: pools.reduce((total, pool) => total + (pool.leakedConnectionCount ?? 0), 0),
        jdbcIssues: pools.filter((pool) => pool.severity === 'critical' || pool.severity === 'warning').length,
        jmsMessages: jmsPressure.messages,
        jmsPending: jmsPressure.pending,
        jmsIssues: jmsPressure.issues,
        severity: pressureSeverity(server, pools, jmsItems),
      }
    })
    .sort((a, b) => {
      const severityRank = { critical: 0, warning: 1, healthy: 2, unknown: 3 }
      const severityDelta = severityRank[a.severity] - severityRank[b.severity]
      if (severityDelta !== 0) return severityDelta
      const pendingDelta = (b.server.threads?.pending ?? 0) - (a.server.threads?.pending ?? 0)
      if (pendingDelta !== 0) return pendingDelta
      const hoggingDelta = (b.server.threads?.hogging ?? 0) - (a.server.threads?.hogging ?? 0)
      if (hoggingDelta !== 0) return hoggingDelta
      return a.server.name.localeCompare(b.server.name, undefined, { numeric: true, sensitivity: 'base' })
    })
}

export function ServerPressurePanel({
  snapshot,
  metricScopeKey,
}: { snapshot: DashboardSnapshot } & MetricHistoryViewProps) {
  const rows = useMemo(() => buildServerPressureRows(snapshot), [snapshot])
  const columns = useMemo<DataTableColumn<ServerPressureRow>[]>(
    () => [
      {
        id: 'server',
        header: 'SERVER',
        className: 'min-w-[160px]',
        cell: (row) => (
          <DetailLink to={`/servers/${segment(row.server.name)}`}>
            <MonoText className="block truncate font-medium" title={row.server.name}>
              {row.server.name}
            </MonoText>
          </DetailLink>
        ),
      },
      {
        id: 'state',
        header: 'STATE',
        cell: (row) => <StatusBadge kind="wls-state" value={row.server.state} />,
      },
      {
        id: 'health',
        header: 'HEALTH',
        cell: (row) => <StatusBadge kind="wls-health" value={row.server.healthState} />,
      },
      {
        id: 'heap',
        header: 'HEAP',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              metricScopeKey,
              'servers',
              serverMetricResourceId(row.server.name),
              'heap.percent',
            )}
            value={<HeapBar heap={row.server.heap} alertLevel={snapshot.serverAlerts?.[row.server.name]?.heap} />}
            title={`${row.server.name} heap`}
          />
        ),
      },
      {
        id: 'pending',
        header: 'PENDING',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              metricScopeKey,
              'servers',
              serverMetricResourceId(row.server.name),
              'threads.pending',
            )}
            value={formatNumber(row.server.threads?.pending)}
            alertLevel={snapshot.serverAlerts?.[row.server.name]?.pending}
            title={`${row.server.name} pending threads`}
          />
        ),
      },
      {
        id: 'hogging',
        header: 'HOGGING',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              metricScopeKey,
              'servers',
              serverMetricResourceId(row.server.name),
              'threads.hogging',
            )}
            value={formatNumber(row.server.threads?.hogging)}
            alertLevel={snapshot.serverAlerts?.[row.server.name]?.hogging}
            title={`${row.server.name} hogging threads`}
          />
        ),
      },
      {
        id: 'stuck',
        header: 'STUCK',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              metricScopeKey,
              'servers',
              serverMetricResourceId(row.server.name),
              'threads.stuck',
            )}
            value={formatNumber(row.server.threads?.stuck)}
            alertLevel={snapshot.serverAlerts?.[row.server.name]?.stuck}
            title={`${row.server.name} stuck threads`}
          />
        ),
      },
      {
        id: 'idle',
        header: 'IDLE/TOTAL',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MonoText>
            {row.server.threads ? `${formatNumber(row.server.threads.idle)}/${formatNumber(row.server.threads.total)}` : '-'}
          </MonoText>
        ),
      },
      {
        id: 'jdbc',
        header: 'JDBC WAIT',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MonoText title={`${row.jdbcIssues} pool issues · ${row.jdbcLeaks} leaks`}>
            {formatNumber(row.jdbcWaiting)}
          </MonoText>
        ),
      },
      {
        id: 'jms',
        header: 'JMS MSG',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MonoText title={`${row.jmsPending} pending · ${row.jmsIssues} issues`}>
            {formatNumber(row.jmsMessages)}
          </MonoText>
        ),
      },
    ],
    [metricScopeKey, snapshot.serverAlerts],
  )

  return (
    <Section title="Server Pressure" detail="Execution, heap, JDBC, and JMS pressure by managed server.">
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.server.name}
        loading={false}
        empty={{ message: 'No server runtimes reported.' }}
      />
    </Section>
  )
}

export function JmsPressurePanel({
  snapshot,
  isFetching,
  compact = false,
  metricScopeKey,
}: {
  snapshot: DashboardSnapshot
  isFetching: boolean
  compact?: boolean
} & MetricHistoryViewProps) {
  const columns = useMemo<DataTableColumn<JmsRuntimeSummary>[]>(
    () => [
      {
        id: 'name',
        header: 'DESTINATION',
        className: 'min-w-[220px]',
        cell: (row) => (
          <MonoText className="block truncate font-medium" title={row.destinationName ?? row.jmsServerName}>
            {row.destinationName ?? row.jmsServerName}
          </MonoText>
        ),
      },
      {
        id: 'server',
        header: 'SERVER',
        cell: (row) => <MonoText title={row.serverName}>{row.serverName}</MonoText>,
      },
      {
        id: 'jmsServer',
        header: 'JMS SERVER',
        cell: (row) => <MonoText title={row.jmsServerName}>{row.jmsServerName}</MonoText>,
      },
      {
        id: 'type',
        header: 'TYPE',
        cell: (row) => <MonoText>{row.destinationType ?? '-'}</MonoText>,
      },
      {
        id: 'messages',
        header: 'MESSAGES',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              metricScopeKey,
              'jms',
              jmsMetricResourceId(row.serverName, row.jmsServerName, row.destinationName),
              'messages.current',
            )}
            value={formatNumber(row.messagesCurrentCount)}
            alertLevel={row.alertSignals?.messages}
            title={`${row.destinationName ?? row.jmsServerName} current messages`}
          />
        ),
      },
      {
        id: 'pending',
        header: 'PENDING',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              metricScopeKey,
              'jms',
              jmsMetricResourceId(row.serverName, row.jmsServerName, row.destinationName),
              'messages.pending',
            )}
            value={formatNumber(row.messagesPendingCount)}
            alertLevel={row.alertSignals?.pending}
            title={`${row.destinationName ?? row.jmsServerName} pending messages`}
          />
        ),
      },
      {
        id: 'consumers',
        header: 'CONSUMERS',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => <MonoText className={alertTextClass(row.alertSignals?.consumers)}>{formatNumber(row.consumersCurrentCount)}</MonoText>,
      },
      {
        id: 'state',
        header: 'STATUS',
        cell: (row) => <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.severity} />,
      },
    ],
    [metricScopeKey],
  )

  const rows = useMemo(() => {
    return [...snapshot.jms.items]
      .sort((a, b) => {
        if (a.severity !== b.severity) return severityTone(a.severity) === 'negative' ? -1 : 1
        const messageDelta = (b.messagesCurrentCount ?? 0) - (a.messagesCurrentCount ?? 0)
        if (messageDelta !== 0) return messageDelta
        return (a.destinationName ?? a.jmsServerName).localeCompare(b.destinationName ?? b.jmsServerName, undefined, {
          numeric: true,
          sensitivity: 'base',
        })
      })
      .slice(0, 8)
  }, [snapshot.jms.items])

  return (
    <Section title="JMS Pressure" detail="Backlog, pending messages, consumers, and paused state.">
      {snapshot.jms.status === 'failed' ? (
        <Unavailable message={snapshot.jms.error ?? 'JMS runtimes unavailable.'} />
      ) : compact && snapshot.jms.items.length === 0 ? (
        <CompactStatusLine label="No JMS runtimes reported by running servers." tone="unknown" value="NONE" />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          getRowId={(row) => `${row.serverName}:${row.jmsServerName}:${row.destinationName ?? 'server'}`}
          loading={isFetching}
          empty={{ message: 'No JMS runtimes reported by running servers.' }}
        />
      )}
    </Section>
  )
}

export function ApplicationsPanel({
  snapshot,
  isFetching,
}: {
  snapshot: DashboardSnapshot
  isFetching: boolean
}) {
  const columns = useMemo<DataTableColumn<ApplicationRuntimeSummary>[]>(
    () => [
      {
        id: 'name',
        header: 'APPLICATION',
        className: 'min-w-[220px]',
        cell: (row) => (
          <DetailLink to={`/deployments/${segment(row.serverName)}/${segment(row.deploymentName)}`}>
            <MonoText className="block truncate font-medium" title={row.name}>
              {row.name}
            </MonoText>
          </DetailLink>
        ),
      },
      {
        id: 'server',
        header: 'SERVER',
        cell: (row) => <MonoText title={row.serverName}>{row.serverName}</MonoText>,
      },
      {
        id: 'health',
        header: 'HEALTH',
        cell: (row) => <StatusBadge kind="wls-health" value={row.overallHealthState} />,
      },
      {
        id: 'deployment',
        header: 'DEPLOY',
        cell: (row) => <MonoText>{deploymentLabel(row.deploymentState)}</MonoText>,
      },
      {
        id: 'scope',
        header: 'SCOPE',
        cell: (row) => (
          <MonoText className={row.internal ? 'text-muted-foreground' : undefined}>
            {row.internal ? 'internal' : 'user'}
          </MonoText>
        ),
      },
    ],
    [],
  )

  // Only the anomalies: healthy runtimes are summarized by the rollup, not listed as anomalies.
  const rows = useMemo(() => {
    return snapshot.applications.items
      .filter((app) => app.severity !== 'healthy')
      .sort((a, b) => {
        if (a.severity !== b.severity) return severityTone(a.severity) === 'negative' ? -1 : 1
        if (a.internal !== b.internal) return a.internal ? 1 : -1
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      })
      .slice(0, 10)
  }, [snapshot.applications.items])
  const unhealthy = snapshot.applicationRollup.unhealthy

  return (
    <Section
      title="Deployment Anomalies"
      detail={`${snapshot.applicationRollup.external.toLocaleString()} user · ${snapshot.applicationRollup.internal.toLocaleString()} internal`}
    >
      {snapshot.applications.status === 'failed' ? (
        <Unavailable message={snapshot.applications.error ?? 'Application runtimes unavailable.'} />
      ) : unhealthy === 0 ? (
        <CompactStatusLine
          label={`${snapshot.applicationRollup.healthy.toLocaleString()} healthy deployment runtimes collapsed.`}
          value="0 anomalies"
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          getRowId={(row) => `${row.serverName}:${row.deploymentName}`}
          loading={isFetching}
          empty={{ message: 'No application runtimes reported by running servers.' }}
        />
      )}
    </Section>
  )
}

export function JdbcPoolsPanel({
  snapshot,
  isFetching,
  compact = false,
  metricScopeKey,
}: {
  snapshot: DashboardSnapshot
  isFetching: boolean
  compact?: boolean
} & MetricHistoryViewProps) {
  const columns = useMemo<DataTableColumn<JdbcPoolRuntime>[]>(
    () => [
      {
        id: 'name',
        header: 'POOL',
        className: 'min-w-[180px]',
        cell: (row) => (
          <DetailLink to={`/data-sources/${segment(row.serverName)}/${segment(row.name)}`}>
            <MonoText className="block truncate font-medium" title={row.name}>
              {row.name}
            </MonoText>
          </DetailLink>
        ),
      },
      {
        id: 'server',
        header: 'SERVER',
        cell: (row) => <MonoText title={row.serverName}>{row.serverName}</MonoText>,
      },
      {
        id: 'state',
        header: 'STATE',
        cell: (row) => <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.state} />,
      },
      {
        id: 'active',
        header: 'ACTIVE',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              metricScopeKey,
              'jdbc',
              jdbcMetricResourceId(row.serverName, row.name),
              'connections.active',
            )}
            value={formatNumber(row.activeConnectionsCurrentCount)}
            alertLevel={row.alertSignals?.utilization}
            title={`${row.name} active connections`}
          />
        ),
      },
      {
        id: 'capacity',
        header: 'MAX',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => <MonoText className={alertTextClass(row.alertSignals?.utilization)}>{formatNumber(row.utilizationCapacity)}</MonoText>,
      },
      {
        id: 'wait',
        header: 'WAIT',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              metricScopeKey,
              'jdbc',
              jdbcMetricResourceId(row.serverName, row.name),
              'connections.waiting',
            )}
            value={formatNumber(row.waitingForConnectionCurrentCount)}
            alertLevel={row.alertSignals?.waiting}
            title={`${row.name} waiting connections`}
          />
        ),
      },
      {
        id: 'leaks',
        header: 'LEAKS',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => <MonoText className={alertTextClass(row.alertSignals?.leaks)}>{formatNumber(row.leakedConnectionCount)}</MonoText>,
      },
    ],
    [metricScopeKey],
  )

  const rows = useMemo(() => {
    return [...snapshot.jdbc.items]
      .sort((a, b) => {
        if (a.severity !== b.severity) return severityTone(a.severity) === 'negative' ? -1 : 1
        return (b.waitingForConnectionCurrentCount ?? 0) - (a.waitingForConnectionCurrentCount ?? 0)
      })
      .slice(0, 8)
  }, [snapshot.jdbc.items])

  return (
    <Section title="JDBC Pools" detail="Pool pressure from running servers.">
      {snapshot.jdbc.status === 'failed' ? (
        <Unavailable message={snapshot.jdbc.error ?? 'JDBC runtimes unavailable.'} />
      ) : compact && snapshot.jdbc.items.length === 0 ? (
        <CompactStatusLine label="No datasource pressure reported by running servers." />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          getRowId={(row) => `${row.serverName}:${row.name}`}
          loading={isFetching}
          empty={{ message: 'No datasource runtimes reported by running servers.' }}
        />
      )}
    </Section>
  )
}

export function LogActivityPanel({
  snapshot,
  isFetching,
  compact = false,
}: {
  snapshot: DashboardSnapshot
  isFetching: boolean
  compact?: boolean
}) {
  const columns = useMemo<DataTableColumn<LogActivityRuntime>[]>(
    () => [
      {
        id: 'server',
        header: 'SERVER',
        className: 'min-w-[180px]',
        cell: (row) => (
          <DetailLink to={`/logs/${segment(row.serverName)}`}>
            <MonoText className="block truncate font-medium" title={row.serverName}>
              {row.serverName}
            </MonoText>
          </DetailLink>
        ),
      },
      {
        id: 'status',
        header: 'STATUS',
        cell: (row) => (
          <StatusBadge
            kind="custom"
            tone={row.status === 'available' ? 'positive' : 'warning'}
            label={row.status}
          />
        ),
      },
      {
        id: 'opened',
        header: 'STREAM',
        cell: (row) => (
          <MonoText>{row.logFileStreamOpened === null ? '-' : row.logFileStreamOpened ? 'open' : 'closed'}</MonoText>
        ),
      },
      {
        id: 'messages',
        header: 'MESSAGES',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => <MonoText>{formatNumber(row.messagesLogged)}</MonoText>,
      },
    ],
    [],
  )

  return (
    <Section title="Log Activity" detail="Best-effort message count and log stream availability.">
      {snapshot.logs.status === 'failed' ? (
        <Unavailable message={snapshot.logs.error ?? 'Log activity unavailable.'} />
      ) : compact && snapshot.logs.items.length === 0 ? (
        <CompactStatusLine label="No log activity runtimes reported by running servers." tone="unknown" value="NONE" />
      ) : (
        <DataTable
          columns={columns}
          rows={snapshot.logs.items}
          getRowId={(row) => row.serverName}
          loading={isFetching}
          empty={{ message: 'No log activity runtimes reported by running servers.' }}
        />
      )}
    </Section>
  )
}
