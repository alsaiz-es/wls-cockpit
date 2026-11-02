import { Link, useLocation, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { readOnlyDemoModeEnabled } from '@/api/runtime-config'
import {
  useSelectedDataSourceDetail,
  type DataSourceRuntimeRow,
  type DataSourceSeverity,
} from '@/api/queries/data-sources'
import { deploymentTargetLabel } from '@/api/queries/deployment-targets'
import { Button } from '@/components/ui/button'
import { MonoText, PageHeader, RelativeTime, StatusBadge, type StatusTone } from '@/components'
import { detailReturnPath } from './detail-return-state'
import { demoSensitiveValue } from './demo-readonly-values'
import { routeParam } from './route-params'

function severityTone(severity: DataSourceSeverity): StatusTone {
  if (severity === 'critical') return 'negative'
  if (severity === 'warning') return 'warning'
  if (severity === 'healthy') return 'positive'
  return 'unknown'
}

function formatNumber(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}

function formatDeploymentState(value: string | number | null) {
  if (value === null) return '-'
  if (value === 2) return 'ACTIVE'
  if (value === 0) return 'UNPREPARED'
  return String(value)
}

function formatPercent(value: number | null) {
  return value === null ? '-' : `${Math.round(value * 100)}%`
}

function formatBoolean(value: boolean | null) {
  if (value === null) return '-'
  return value ? 'true' : 'false'
}

function targetSummary(row: DataSourceRuntimeRow) {
  return row.configuredTargets.length ? row.configuredTargets.map(deploymentTargetLabel).join(', ') : '-'
}

function listSummary(values: string[]) {
  return values.length ? values.join(', ') : '-'
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
      <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">{label}</div>
      <MonoText className="mt-2 block truncate text-[18px] leading-6" title={value}>
        {value}
      </MonoText>
      {detail ? <div className="text-muted-foreground mt-1 truncate text-xs">{detail}</div> : null}
    </div>
  )
}

function UtilizationPanel({ row }: { row: DataSourceRuntimeRow }) {
  const percent = row.utilization === null ? null : Math.round(row.utilization * 100)
  const denominatorLabel =
    row.utilizationCapacitySource === 'configuredMax'
      ? 'configured max'
      : row.utilizationCapacitySource === 'runtimeCurrent'
        ? 'created capacity fallback'
        : 'capacity unavailable'
  const tone =
    row.severity === 'critical'
      ? 'bg-status-negative'
      : row.severity === 'warning'
        ? 'bg-status-warning'
        : row.severity === 'healthy'
          ? 'bg-status-positive'
          : 'bg-status-unknown'

  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-medium leading-5">Pool Utilization</h2>
          <p className="text-muted-foreground text-[13px] leading-[18px]">
            Active connections over {denominatorLabel}.
          </p>
        </div>
        <MonoText className="text-muted-foreground text-[13px]">{formatPercent(row.utilization)}</MonoText>
      </div>
      <div className="h-2 overflow-hidden rounded-[3px] bg-surface-2">
        {percent === null ? null : (
          <div className={`h-full rounded-[3px] ${tone}`} style={{ width: `${Math.min(100, percent)}%` }} />
        )}
      </div>
      <div className="text-muted-foreground mt-3 grid gap-2 text-[13px] md:grid-cols-4">
        <div>
          <span className="text-foreground">Active </span>
          <MonoText>{formatNumber(row.activeConnectionsCurrentCount)}</MonoText>
        </div>
        <div>
          <span className="text-foreground">Capacity </span>
          <MonoText>{formatNumber(row.utilizationCapacity)}</MonoText>
        </div>
        <div>
          <span className="text-foreground">Created </span>
          <MonoText>{formatNumber(row.currCapacity)}</MonoText>
        </div>
        <div>
          <span className="text-foreground">Free max </span>
          <MonoText>
            {row.activeConnectionsCurrentCount === null || row.utilizationCapacity === null
              ? '-'
              : Math.max(0, row.utilizationCapacity - row.activeConnectionsCurrentCount).toLocaleString()}
          </MonoText>
        </div>
      </div>
    </section>
  )
}

function PartialBanner({
  failures,
  onRetry,
}: {
  failures: Array<{ serverName: string; message: string }>
  onRetry: () => void
}) {
  if (failures.length === 0) return null
  return (
    <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
      <span className="min-w-0 truncate">
        Partial data: {failures.map((failure) => `${failure.serverName}: ${failure.message}`).join(' · ')}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

export function DataSourceDetails() {
  const location = useLocation()
  const params = useParams()
  const serverName = routeParam(params.serverName)
  const dataSourceName = routeParam(params.dataSourceName)
  const readOnlyDemoMode = readOnlyDemoModeEnabled()
  const query = useSelectedDataSourceDetail(serverName, dataSourceName)
  const failures = query.data?.partialFailures ?? []
  const returnPath = useMemo(() => detailReturnPath(location.state, '/data-sources'), [location.state])
  const row = query.data?.row ?? null
  const refetchAll = useCallback(() => void query.refetch(), [query])

  return (
    <>
      <PageHeader
        title={dataSourceName || 'Data Source'}
        subtitle="Single JDBC datasource runtime snapshot."
        meta={
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-muted-foreground flex items-center gap-1 text-[13px] leading-[18px]">
              Updated <RelativeTime value={query.dataUpdatedAt} />
            </span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" asChild>
                <Link to={returnPath}>
                  <ArrowLeft className="size-3.5" strokeWidth={1.5} />
                  Data Sources
                </Link>
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={refetchAll}>
                <RefreshCw className="size-3.5" strokeWidth={1.5} />
                Refresh
              </Button>
            </div>
          </div>
        }
      />

      <PartialBanner failures={failures} onRetry={refetchAll} />

      {query.isFetching && !query.data ? (
        <div className="text-muted-foreground flex h-24 items-center justify-center gap-2 border-b border-border text-[13px]">
          <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          Loading...
        </div>
      ) : null}

      {query.isError ? (
        <div className="border-status-negative/60 bg-status-negative/8 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate font-mono">
            {query.error instanceof Error ? query.error.message : 'Unable to load datasource runtime.'}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={refetchAll}>
            Retry
          </Button>
        </div>
      ) : null}

      {!query.isFetching && !query.isError && !row ? (
        <div className="border-border bg-surface-1 flex min-h-28 items-center justify-between gap-3 border px-3 py-3 text-[13px]">
          <div className="min-w-0">
            <div className="font-medium">Datasource not found</div>
            <MonoText className="text-muted-foreground mt-1 block truncate">
              {serverName || '-'} / {dataSourceName || '-'}
            </MonoText>
          </div>
          <Button type="button" variant="outline" size="sm" asChild>
            <Link to={returnPath}>Back to data sources</Link>
          </Button>
        </div>
      ) : null}

      {row ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
              <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Status</div>
              <div className="mt-2">
                <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.severity} />
              </div>
            </div>
            <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
              <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Runtime</div>
              <div className="mt-2">
                <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.state} />
              </div>
            </div>
            <Metric label="Server" value={row.serverName} />
            <Metric label="Deploy" value={formatDeploymentState(row.deploymentState)} />
          </div>

          <UtilizationPanel row={row} />

          <div className="grid gap-3 md:grid-cols-4">
            <Metric label="Active" value={formatNumber(row.activeConnectionsCurrentCount)} />
            <Metric label="Max capacity" value={formatNumber(row.utilizationCapacity)} />
            <Metric label="Created" value={formatNumber(row.currCapacity)} />
            <Metric label="Waiting" value={formatNumber(row.waitingForConnectionCurrentCount)} />
            <Metric label="Leaks" value={formatNumber(row.leakedConnectionCount)} />
          </div>

          <section className="border-border bg-surface-1 border px-3 py-3">
            <div className="mb-3">
              <h2 className="text-[14px] font-medium leading-5">Availability Counters</h2>
              <p className="text-muted-foreground text-[13px] leading-[18px]">
                Runtime availability, reserve, and wait counters from WebLogic.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-5">
              <Metric label="Available" value={formatNumber(row.numAvailable)} />
              <Metric label="Unavailable" value={formatNumber(row.numUnavailable)} />
              <Metric label="Connections total" value={formatNumber(row.connectionsTotalCount)} />
              <Metric label="Reserve requests" value={formatNumber(row.reserveRequestCount)} />
              <Metric label="Failed reserves" value={formatNumber(row.failedReserveRequestCount)} />
              <Metric label="Wait high" value={formatNumber(row.waitingForConnectionHighCount)} />
              <Metric label="Wait total" value={formatNumber(row.waitingForConnectionTotal)} />
              <Metric label="Wait success" value={formatNumber(row.waitingForConnectionSuccessTotal)} />
              <Metric label="Wait failure" value={formatNumber(row.waitingForConnectionFailureTotal)} />
              <Metric label="Delay ms" value={formatNumber(row.connectionDelayTime)} />
            </div>
          </section>

          <section className="border-border bg-surface-1 border px-3 py-3">
            <div className="mb-3">
              <h2 className="text-[14px] font-medium leading-5">Database Runtime</h2>
              <p className="text-muted-foreground text-[13px] leading-[18px]">
                Database product and JDBC driver metadata reported by the datasource runtime.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <Metric label="Enabled" value={formatBoolean(row.runtimeEnabled)} />
              <Metric label="DB product" value={row.databaseProductName ?? '-'} />
              <Metric label="DB version" value={row.databaseProductVersion ?? '-'} />
              <Metric label="Runtime driver" value={row.runtimeDriverName ?? '-'} />
              <Metric label="Driver version" value={row.runtimeDriverVersion ?? '-'} />
              <Metric label="JDBC driver version" value={row.jdbcDriverVersion ?? '-'} />
            </div>
          </section>

          <section className="border-border bg-surface-1 border px-3 py-3">
            <div className="mb-3">
              <h2 className="text-[14px] font-medium leading-5">Statement Cache</h2>
              <p className="text-muted-foreground text-[13px] leading-[18px]">
                Prepared statement cache counters reported by the datasource runtime.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <Metric label="Current size" value={formatNumber(row.prepStmtCacheCurrentSize)} />
              <Metric label="Access" value={formatNumber(row.prepStmtCacheAccessCount)} />
              <Metric label="Hits" value={formatNumber(row.prepStmtCacheHitCount)} />
              <Metric label="Misses" value={formatNumber(row.prepStmtCacheMissCount)} />
              <Metric label="Adds" value={formatNumber(row.prepStmtCacheAddCount)} />
              <Metric label="Deletes" value={formatNumber(row.prepStmtCacheDeleteCount)} />
            </div>
          </section>

          <section className="border-border bg-surface-1 border px-3 py-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[14px] font-medium leading-5">Configuration</h2>
                <p className="text-muted-foreground text-[13px] leading-[18px]">JDBC system resource metadata from the edit tree.</p>
              </div>
              <MonoText className="text-muted-foreground text-[13px]">{row.systemResourceName ?? '-'}</MonoText>
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <Metric label="Configured targets" value={targetSummary(row)} />
              <Metric label="JNDI" value={listSummary(row.jndiNames)} />
              <Metric label="Driver" value={row.driverName ?? '-'} />
              <Metric label="DB user" value={demoSensitiveValue(row.databaseUser, readOnlyDemoMode) ?? '-'} />
              <Metric label="JDBC URL" value={demoSensitiveValue(row.url, readOnlyDemoMode) ?? '-'} />
              <Metric label="Initial" value={formatNumber(row.configuredInitialCapacity)} />
              <Metric label="Min" value={formatNumber(row.configuredMinCapacity)} />
              <Metric label="Max" value={formatNumber(row.configuredMaxCapacity)} />
              <Metric label="Test table" value={row.testTableName ?? '-'} />
              <Metric label="Global TX" value={row.globalTransactionsProtocol ?? '-'} />
              <Metric label="Algorithm" value={row.algorithmType ?? '-'} />
              <Metric label="Scope" value={row.scope ?? '-'} />
              <Metric label="Datasource list" value={demoSensitiveValue(row.dataSourceList, readOnlyDemoMode) ?? '-'} />
              <Metric label="Keep after global TX" value={formatBoolean(row.keepConnAfterGlobalTx)} />
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}
