import { useMemo, useState } from 'react'
import { MonoText, PageHeader } from '@/components'
import type { DashboardIssue, DashboardSnapshot } from '@/api/queries/domain-dashboard'
import { useDomainDashboard } from '@/api/queries/domain-dashboard'
import { heapUtilization } from '@/api/queries/heap-utilization'
import {
  jdbcMetricResourceId,
  jmsMetricResourceId,
  serverMetricResourceId,
  useMetricHistoryRecorder,
  type MetricHistorySampleInput,
} from '@/api/queries/metric-history'
import { useAuth } from '@/auth/useAuth'
import { DiagnosticSnapshotExport, type DiagnosticSnapshotRequest } from '@/components/diagnostic-snapshot-export'
import { cn } from '@/lib/utils'
import { IssueQueue } from './dashboard/issue-queue'
import { issueSnapshotServers } from './dashboard/format'
import {
  ApplicationsPanel,
  JdbcPoolsPanel,
  JmsPressurePanel,
  LogActivityPanel,
  ServerPressurePanel,
  ServerStatesPanel,
} from './dashboard/panels'
import { Banner, LoadingBlock, Section } from './dashboard/primitives'
import { ScanBand } from './dashboard/scan-band'
import { dashboardVisualFixture } from './dashboard/visual-fixtures'
import { buildDashboardVisualModel } from './dashboard/visual-model'

function devFixtureSnapshot(): DashboardSnapshot | null {
  if (!import.meta.env.DEV) return null
  const fixture = new URLSearchParams(window.location.search).get('fixture')
  if (fixture !== 'healthy' && fixture !== 'warning' && fixture !== 'critical' && fixture !== 'partial') return null
  return dashboardVisualFixture(fixture)
}

function dashboardMetricSamples(snapshot: DashboardSnapshot | null): MetricHistorySampleInput[] {
  if (!snapshot) return []

  const serverSamples = snapshot.servers.flatMap((server): MetricHistorySampleInput[] => {
    const heapPercent = heapUtilization(server.heap)
    return [
      {
        family: 'servers',
        resourceId: serverMetricResourceId(server.name),
        metric: 'heap.percent',
        value: heapPercent === null ? null : heapPercent * 100,
      },
      {
        family: 'servers',
        resourceId: serverMetricResourceId(server.name),
        metric: 'threads.pending',
        value: server.threads?.pending,
      },
      {
        family: 'servers',
        resourceId: serverMetricResourceId(server.name),
        metric: 'threads.hogging',
        value: server.threads?.hogging,
      },
      {
        family: 'servers',
        resourceId: serverMetricResourceId(server.name),
        metric: 'threads.stuck',
        value: server.threads?.stuck,
      },
    ]
  })

  const jdbcSamples = snapshot.jdbc.items.flatMap((pool): MetricHistorySampleInput[] => [
    {
      family: 'jdbc',
      resourceId: jdbcMetricResourceId(pool.serverName, pool.name),
      metric: 'connections.active',
      value: pool.activeConnectionsCurrentCount,
    },
    {
      family: 'jdbc',
      resourceId: jdbcMetricResourceId(pool.serverName, pool.name),
      metric: 'connections.waiting',
      value: pool.waitingForConnectionCurrentCount,
    },
  ])

  const jmsSamples = snapshot.jms.items.flatMap((item): MetricHistorySampleInput[] => [
    {
      family: 'jms',
      resourceId: jmsMetricResourceId(item.serverName, item.jmsServerName, item.destinationName),
      metric: 'messages.current',
      value: item.messagesCurrentCount,
    },
    {
      family: 'jms',
      resourceId: jmsMetricResourceId(item.serverName, item.jmsServerName, item.destinationName),
      metric: 'messages.pending',
      value: item.messagesPendingCount,
    },
  ])

  return [...serverSamples, ...jdbcSamples, ...jmsSamples]
}

export function Dashboard() {
  const { creds } = useAuth()
  const [snapshotRequest, setSnapshotRequest] = useState<DiagnosticSnapshotRequest | null>(null)
  const fixture = devFixtureSnapshot()
  const query = useDomainDashboard({ enabled: !fixture })
  const snapshot = fixture ?? query.data
  const historySamples = useMemo(() => dashboardMetricSamples(snapshot ?? null), [snapshot])
  const history = useMetricHistoryRecorder({
    creds,
    samples: historySamples,
    timestamp: fixture ? 0 : query.dataUpdatedAt,
    enabled: !fixture,
  })
  const visual = snapshot ? buildDashboardVisualModel(snapshot) : null
  const firstLoad = !fixture && query.isLoading && !snapshot
  const isFetching = !fixture && query.isFetching

  function openIssueSnapshot(issue: DashboardIssue) {
    setSnapshotRequest({
      id: `${issue.id}:${Date.now()}`,
      serverNames: issueSnapshotServers(issue),
    })
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Domain health overview."
        updatedAt={snapshot ? (fixture ? 1700000000000 : query.dataUpdatedAt) : undefined}
        refreshing={isFetching}
        onRefresh={fixture ? undefined : () => void query.refetch()}
      />
      <DiagnosticSnapshotExport snapshot={snapshot} request={snapshotRequest} showTrigger={false} />

      {query.isError && !snapshot ? (
        <Banner tone="negative" onRetry={() => void query.refetch()}>
          <MonoText>{query.error instanceof Error ? query.error.message : 'Unable to build domain snapshot.'}</MonoText>
        </Banner>
      ) : null}

      {snapshot?.partialFailures.length ? (
        <Banner tone="warning" onRetry={() => void query.refetch()}>
          <span className="block truncate">
            Partial data: {snapshot.partialFailures.map((failure) => failure.message).join(' · ')}
          </span>
        </Banner>
      ) : null}

      {firstLoad ? (
        <LoadingBlock />
      ) : snapshot && visual ? (
        <div className={cn('space-y-4', isFetching && 'opacity-70')}>
          <ScanBand snapshot={snapshot} visual={visual} />

          {visual.emphasize.issueQueue ? (
            <Section title="Issue Queue" detail="Read-only diagnostic targets for the next operator action.">
              <IssueQueue issues={snapshot.issues} compact={visual.compact.issues} onSnapshotIssue={openIssueSnapshot} />
            </Section>
          ) : null}

          <ServerPressurePanel
            snapshot={snapshot}
            metricScopeKey={history.scopeKey}
          />

          <div className="grid gap-4">
            {!visual.emphasize.issueQueue ? (
              <Section title="Issue Queue" detail="Read-only diagnostic targets for the next operator action.">
                <IssueQueue issues={snapshot.issues} compact={visual.compact.issues} onSnapshotIssue={openIssueSnapshot} />
              </Section>
            ) : (
              <ServerStatesPanel snapshot={snapshot} />
            )}
            <ApplicationsPanel snapshot={snapshot} isFetching={isFetching} />
          </div>

          <div className="grid gap-4">
            <JdbcPoolsPanel
              snapshot={snapshot}
              isFetching={isFetching}
              compact={visual.compact.jdbc}
              metricScopeKey={history.scopeKey}
            />
            <JmsPressurePanel
              snapshot={snapshot}
              isFetching={isFetching}
              compact={snapshot.jms.status === 'empty'}
              metricScopeKey={history.scopeKey}
            />
          </div>

          <LogActivityPanel snapshot={snapshot} isFetching={isFetching} compact={visual.compact.logs} />
        </div>
      ) : null}
    </>
  )
}
