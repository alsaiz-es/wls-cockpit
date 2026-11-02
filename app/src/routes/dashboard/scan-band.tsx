import type { DashboardSnapshot } from '@/api/queries/domain-dashboard'
import { MonoText, StatusBadge } from '@/components'
import { cn } from '@/lib/utils'
import { formatNumber, formatPercent, heapTone, severityTone } from './format'
import { CompactMetric } from './primitives'
import type { DashboardVisualModel } from './visual-model'

function logAvailability(snapshot: DashboardSnapshot) {
  if (snapshot.logs.status === 'failed') return { value: 'failed', tone: 'warning' as const }
  if (snapshot.logs.items.length === 0) return { value: 'none', tone: 'unknown' as const }
  const unavailable = snapshot.logs.items.filter((item) => item.status === 'unavailable').length
  if (unavailable > 0) return { value: `${unavailable} unavailable`, tone: 'warning' as const }
  return { value: `${snapshot.logs.items.length} available`, tone: 'positive' as const }
}

function jdbcPressure(snapshot: DashboardSnapshot) {
  if (snapshot.jdbc.status === 'failed') return { value: 'failed', tone: 'warning' as const }
  const critical = snapshot.jdbc.items.filter((item) => item.severity === 'critical').length
  const warning = snapshot.jdbc.items.filter((item) => item.severity === 'warning').length
  if (critical > 0) return { value: `${critical} critical`, tone: 'negative' as const }
  if (warning > 0) return { value: `${warning} warning`, tone: 'warning' as const }
  return { value: snapshot.jdbc.items.length.toLocaleString(), tone: 'positive' as const }
}

function jmsPressure(snapshot: DashboardSnapshot) {
  if (snapshot.jms.status === 'failed') return { value: 'failed', detail: 'runtime', tone: 'warning' as const }
  if (snapshot.jms.items.length === 0) return { value: 'none', detail: 'configured', tone: 'unknown' as const }
  // The tone follows the destinations' alert levels (rule thresholds, durations and ignores), so a
  // queue with messages only turns amber once it is an issue.
  const critical = snapshot.jms.items.some((item) => item.severity === 'critical')
  const warning = snapshot.jms.items.some((item) => item.severity === 'warning')
  if (snapshot.jmsRollup.messagesCurrent > 0 || snapshot.jmsRollup.messagesPending > 0 || critical || warning) {
    return {
      value: formatNumber(snapshot.jmsRollup.messagesCurrent),
      detail: `${formatNumber(snapshot.jmsRollup.messagesPending)} pending`,
      tone: critical ? ('negative' as const) : warning ? ('warning' as const) : ('positive' as const),
    }
  }
  return {
    value: formatNumber(snapshot.jmsRollup.messagesCurrent),
    detail: `${snapshot.jmsRollup.destinations.toLocaleString()} destinations`,
    tone: 'positive' as const,
  }
}

function appHealth(snapshot: DashboardSnapshot) {
  if (snapshot.applications.status === 'failed') return { value: 'failed', tone: 'warning' as const }
  if (snapshot.applicationRollup.unhealthy > 0) {
    return { value: `${snapshot.applicationRollup.unhealthy} anomalies`, tone: 'warning' as const }
  }
  return { value: '0 anomalies', tone: 'positive' as const }
}

function boundedNames(names: string[]) {
  if (names.length === 0) return 'complete'
  if (names.length <= 2) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`
}

function coverage(snapshot: DashboardSnapshot) {
  const missing = new Set([
    ...snapshot.runtimePressure.heapUnavailableServers,
    ...snapshot.runtimePressure.threadsUnavailableServers,
  ])
  if (missing.size === 0) return { value: 'complete', detail: 'runtime fields', tone: 'positive' as const }
  const names = Array.from(missing)
  return {
    value: `${names.length} missing`,
    detail: boundedNames(names),
    tone: 'warning' as const,
  }
}

function pressureTone(value: number) {
  return value > 0 ? ('negative' as const) : ('positive' as const)
}

function hoggingTone(value: number) {
  return value > 0 ? ('warning' as const) : ('positive' as const)
}

export function ScanBand({
  snapshot,
  visual,
}: {
  snapshot: DashboardSnapshot
  visual: DashboardVisualModel
}) {
  const logs = logAvailability(snapshot)
  const jdbc = jdbcPressure(snapshot)
  const jms = jmsPressure(snapshot)
  const apps = appHealth(snapshot)
  const coverageMetric = coverage(snapshot)
  const heapPercent = snapshot.runtimePressure.highestHeap?.percent
  const issueCount = snapshot.issues.length

  return (
    // The band stays neutral; a strip in the color of the worst state marks a degraded or critical
    // domain without tinting every number in it.
    <section
      className={cn(
        'rounded-lg border border-border bg-surface-1 p-4',
        visual.layoutMode === 'critical' && 'border-l-[3px] border-l-status-negative',
        visual.layoutMode === 'degraded' && 'border-l-[3px] border-l-status-warning',
      )}
    >
      <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(220px,0.45fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <StatusBadge kind="custom" tone={severityTone(snapshot.severity)} label={snapshot.severity} />
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
            <span>
              <MonoText>{issueCount.toLocaleString()}</MonoText> {issueCount === 1 ? 'issue' : 'issues'}
            </span>
          </div>
        </div>
        <div className="min-w-0 border-l border-border pl-3">
          <div className="text-muted-foreground truncate text-[11px] uppercase leading-[14px] tracking-[0.04em]">
            Affected Resource
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <MonoText className="truncate font-semibold" title={visual.affected.label}>
              {visual.affected.label}
            </MonoText>
            {visual.affected.targetLabel ? (
              <span className="text-muted-foreground shrink-0 text-xs">-&gt; {visual.affected.targetLabel}</span>
            ) : null}
          </div>
          <div className="text-muted-foreground mt-0.5 truncate text-xs" title={visual.affected.detail}>
            {visual.affected.detail}
          </div>
        </div>
      </div>

      <div className="grid gap-y-3 sm:grid-cols-2 lg:grid-cols-6 2xl:grid-cols-[repeat(11,minmax(0,1fr))]">
        <CompactMetric label="Servers" value={snapshot.serverRollup.total} />
        <CompactMetric label="Running" value={snapshot.serverRollup.running} tone="positive" />
        <CompactMetric
          label="Heap"
          value={formatPercent(heapPercent)}
          detail={snapshot.runtimePressure.highestHeap?.serverName ?? 'unavailable'}
          tone={heapTone(heapPercent)}
        />
        <CompactMetric
          label="Pending"
          value={formatNumber(snapshot.runtimePressure.pendingUserRequests)}
          detail="user requests"
          tone={pressureTone(snapshot.runtimePressure.pendingUserRequests)}
        />
        <CompactMetric
          label="Hogging"
          value={formatNumber(snapshot.runtimePressure.hoggingThreads)}
          detail={`${formatNumber(snapshot.runtimePressure.queueLength)} queued`}
          tone={hoggingTone(snapshot.runtimePressure.hoggingThreads)}
        />
        <CompactMetric
          label="Stuck"
          value={formatNumber(snapshot.runtimePressure.stuckThreads)}
          detail={`${formatNumber(snapshot.runtimePressure.idleThreads)}/${formatNumber(snapshot.runtimePressure.totalThreads)} idle`}
          tone={pressureTone(snapshot.runtimePressure.stuckThreads)}
        />
        <CompactMetric label="JDBC" value={jdbc.value} detail={`${snapshot.jdbc.items.length} pools`} tone={jdbc.tone} />
        <CompactMetric label="JMS" value={jms.value} detail={jms.detail} tone={jms.tone} />
        <CompactMetric
          label="Deploy"
          value={apps.value}
          detail={`${snapshot.applicationRollup.external.toLocaleString()} user`}
          tone={apps.tone}
        />
        <CompactMetric label="Coverage" value={coverageMetric.value} detail={coverageMetric.detail} tone={coverageMetric.tone} />
        <CompactMetric label="Logs" value={logs.value} detail="activity" tone={logs.tone} />
      </div>
    </section>
  )
}
