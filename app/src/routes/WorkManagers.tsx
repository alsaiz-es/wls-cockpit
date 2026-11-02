import { useCallback, useMemo } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { RefreshCw, Search } from 'lucide-react'
import {
  compareWorkManagerPressure,
  useWorkManagerRuntimeSnapshot,
  type WorkManagerFamily,
  type WorkManagerPartialFailure,
  type WorkManagerRuntimeRow,
  type WorkManagerSeverity,
} from '@/api/queries/work-managers'
import {
  DataTable,
  MonoText,
  PageHeader,
  RelativeTime,
  StatusBadge,
  type DataTableColumn,
  type DataTableSort,
  type StatusTone,
} from '@/components'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { detailReturnState } from './detail-return-state'
import {
  parseRuntimeTableUrlState,
  serializeRuntimeTableUrlState,
  type RuntimeTableUrlConfig,
  type RuntimeTableUrlState,
} from './runtime-table-url-state'

const DEFAULT_SORT: DataTableSort = { columnId: 'pressure', direction: 'asc' }
const severities = ['critical', 'warning', 'neutral'] as const
const severityFilters = ['all', ...severities] as const
const families = ['threadPool', 'workManager', 'executeQueue'] as const
const familyFilters = ['all', ...families] as const
type SeverityFilter = (typeof severityFilters)[number]
type FamilyFilter = (typeof familyFilters)[number]

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function compareNumberWithNulls(a: number | null, b: number | null, direction: 'asc' | 'desc') {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return direction === 'asc' ? a - b : b - a
}

function formatNumber(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}

function severityTone(severity: WorkManagerSeverity): StatusTone {
  if (severity === 'critical') return 'negative'
  if (severity === 'warning') return 'warning'
  return 'neutral'
}

function familyLabel(family: WorkManagerFamily) {
  if (family === 'threadPool') return 'thread pool'
  if (family === 'executeQueue') return 'execute queue'
  return 'work manager'
}

function searchText(row: WorkManagerRuntimeRow) {
  return [
    row.serverName,
    row.family,
    row.name,
    row.severity,
    row.healthState,
    row.applicationName ?? '',
    row.moduleName ?? '',
    row.partitionName ?? '',
    row.config?.capacityName ?? '',
    row.config?.maxThreadsConstraintName ?? '',
    row.config?.minThreadsConstraintName ?? '',
    row.config?.requestClassName ?? '',
    ...row.unavailable,
  ].join(' ').toLowerCase()
}

function compareRows(a: WorkManagerRuntimeRow, b: WorkManagerRuntimeRow, sort: DataTableSort) {
  const direction = sort.direction === 'asc' ? 1 : -1
  switch (sort.columnId) {
    case 'pressure':
      return compareWorkManagerPressure(a, b) * direction
    case 'server':
      return compareText(a.serverName, b.serverName) * direction || compareText(a.name, b.name)
    case 'family':
      return compareText(a.family, b.family) * direction || compareText(a.serverName, b.serverName) || compareText(a.name, b.name)
    case 'name':
      return compareText(a.name, b.name) * direction || compareText(a.serverName, b.serverName)
    case 'severity':
      return compareWorkManagerPressure(a, b) * direction
    case 'pending':
      return compareNumberWithNulls(a.pendingRequests, b.pendingRequests, sort.direction) || compareText(a.name, b.name)
    case 'rejected':
      return compareNumberWithNulls(a.rejectedRequests, b.rejectedRequests, sort.direction) || compareText(a.name, b.name)
    case 'completed':
      return compareNumberWithNulls(a.completedRequests, b.completedRequests, sort.direction) || compareText(a.name, b.name)
    case 'stuck':
      return compareNumberWithNulls(a.stuckThreadCount, b.stuckThreadCount, sort.direction) || compareText(a.name, b.name)
    case 'hogging':
      return compareNumberWithNulls(a.hoggingThreadCount, b.hoggingThreadCount, sort.direction) || compareText(a.name, b.name)
    case 'constraint':
      return compareNumberWithNulls(a.constraintValue, b.constraintValue, sort.direction) || compareText(a.name, b.name)
    default:
      return compareRows(a, b, DEFAULT_SORT)
  }
}

function configSummary(row: WorkManagerRuntimeRow) {
  const config = row.config
  if (!config) {
    if (row.nestedDetailSkipped) return 'nested detail skipped'
    const unavailableNestedCount = Object.values(row.nested).filter((value) => value?.unavailable).length
    if (unavailableNestedCount > 0) return `${unavailableNestedCount} nested detail unavailable`
    if (row.unavailable.length) return row.unavailable[0]
    return '-'
  }
  const parts = [
    config.capacityName ? `capacity ${config.capacityName}` : null,
    config.maxThreadsConstraintName ? `max ${config.maxThreadsConstraintName}` : null,
    config.minThreadsConstraintName ? `min ${config.minThreadsConstraintName}` : null,
    config.requestClassName ? `class ${config.requestClassName}` : null,
    config.fairShare !== null ? `fair ${config.fairShare}` : null,
    config.responseTimeGoalMs !== null ? `goal ${config.responseTimeGoalMs}ms` : null,
    config.count !== null ? `count ${config.count}` : null,
  ].filter(Boolean)
  return parts.join(' · ') || '-'
}

function PartialBanner({
  failures,
  overflowCount,
  onRetry,
}: {
  failures: WorkManagerPartialFailure[]
  overflowCount: number
  onRetry: () => void
}) {
  if (failures.length === 0 && overflowCount === 0) return null
  const visibleFailures = failures.slice(0, 5)
  const hiddenFailureCount = Math.max(0, failures.length - visibleFailures.length)
  const failureText = visibleFailures
    .map((failure) => `${failure.serverName ?? 'domain'}/${failure.runtimeName ? `${failure.runtimeName}/` : ''}${failure.family}: ${failure.message}`)
    .join(' · ')
  const cappedFailureText = hiddenFailureCount > 0
    ? `${failureText} · +${hiddenFailureCount.toLocaleString()} more partial failures`
    : failureText
  return (
    <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
      <span className="min-w-0 truncate">
        {overflowCount > 0 ? `+${overflowCount.toLocaleString()} Work Managers shown without nested detail.` : null}
        {overflowCount > 0 && cappedFailureText ? ' · ' : null}
        {cappedFailureText ? `Partial data: ${cappedFailureText}` : null}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

export function WorkManagers() {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedServer = searchParams.get('server')?.trim() || 'all'
  const query = useWorkManagerRuntimeSnapshot(selectedServer)
  const allRows = useMemo(() => query.data?.rows ?? [], [query.data?.rows])
  const returnState = useMemo(() => detailReturnState(location), [location])
  const serverOptions = useMemo(() => [...new Set(allRows.map((row) => row.serverName))].sort(compareText), [allRows])
  const tableUrlConfig = useMemo<RuntimeTableUrlConfig>(
    () => ({
      defaultSort: DEFAULT_SORT,
      sortableColumns: ['pressure', 'server', 'family', 'name', 'severity', 'pending', 'rejected', 'completed', 'stuck', 'hogging', 'constraint'],
      filters: {
        server: { param: 'server', defaultValue: 'all', allowedValues: ['all', selectedServer, ...serverOptions] },
        severity: { param: 'severity', defaultValue: 'all', allowedValues: severityFilters },
        family: { param: 'family', defaultValue: 'all', allowedValues: familyFilters },
      },
    }),
    [selectedServer, serverOptions],
  )
  const tableState = useMemo(() => parseRuntimeTableUrlState(searchParams, tableUrlConfig), [searchParams, tableUrlConfig])
  const sort = tableState.sort
  const effectiveSort = sort ?? DEFAULT_SORT
  const search = tableState.search
  const server = tableState.filters.server as string
  const severity = tableState.filters.severity as SeverityFilter
  const family = tableState.filters.family as FamilyFilter
  const hasActiveFilters = search.trim().length > 0 || server !== 'all' || severity !== 'all' || family !== 'all'
  const failures = query.data?.partialFailures ?? []
  const overflowCount = query.data?.nestedOverflowCount ?? 0

  const updateTableState = useCallback(
    (patch: Partial<RuntimeTableUrlState>) => {
      const next = {
        search: patch.search ?? tableState.search,
        filters: { ...tableState.filters, ...patch.filters },
        sort: patch.sort === undefined ? tableState.sort : patch.sort,
      }
      setSearchParams(serializeRuntimeTableUrlState(next, tableUrlConfig, searchParams), { replace: true })
    },
    [searchParams, setSearchParams, tableState, tableUrlConfig],
  )

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return allRows
      .filter((row) => server === 'all' || row.serverName === server)
      .filter((row) => severity === 'all' || row.severity === severity)
      .filter((row) => family === 'all' || row.family === family)
      .filter((row) => needle.length === 0 || searchText(row).includes(needle))
      .sort((a, b) => compareRows(a, b, effectiveSort))
  }, [allRows, effectiveSort, family, search, server, severity])

  const columns = useMemo<DataTableColumn<WorkManagerRuntimeRow>[]>(
    () => [
      {
        id: 'severity',
        header: 'STATUS',
        sortable: true,
        cell: (row) =>
          row.severityReasons.length ? (
            <span className="flex min-w-0 flex-col gap-0.5" title={row.severityReasons.join('\n')}>
              <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.severity} />
              <span className="text-muted-foreground truncate text-[11px]">{row.severityReasons[0]}</span>
            </span>
          ) : (
            <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.severity} />
          ),
      },
      {
        id: 'server',
        header: 'SERVER',
        sortable: true,
        cell: (row) => (
          <Link
            to={`/servers/${encodeURIComponent(row.serverName)}`}
            state={returnState}
            className="hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MonoText className="font-medium">{row.serverName}</MonoText>
          </Link>
        ),
      },
      {
        id: 'family',
        header: 'FAMILY',
        sortable: true,
        cell: (row) => <MonoText>{familyLabel(row.family)}</MonoText>,
      },
      {
        id: 'name',
        header: 'NAME',
        sortable: true,
        className: 'min-w-[220px]',
        cell: (row) => (
          <div className="min-w-0">
            <MonoText className="block truncate font-medium" title={row.name}>{row.name}</MonoText>
            {row.applicationName || row.moduleName || row.partitionName ? (
              <MonoText className="text-muted-foreground block truncate text-[11px]" title={[row.applicationName, row.moduleName, row.partitionName].filter(Boolean).join(' / ')}>
                {[row.applicationName, row.moduleName, row.partitionName].filter(Boolean).join(' / ')}
              </MonoText>
            ) : null}
          </div>
        ),
      },
      {
        id: 'pending',
        header: 'PENDING',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => <MonoText>{formatNumber(row.pendingRequests)}</MonoText>,
      },
      {
        id: 'rejected',
        header: 'REJECTED',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => <MonoText>{formatNumber(row.rejectedRequests)}</MonoText>,
      },
      {
        id: 'completed',
        header: 'COMPLETED',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => <MonoText>{formatNumber(row.completedRequests)}</MonoText>,
      },
      {
        id: 'stuck',
        header: 'STUCK',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => <MonoText>{formatNumber(row.stuckThreadCount)}</MonoText>,
      },
      {
        id: 'hogging',
        header: 'HOGGING',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => <MonoText>{formatNumber(row.hoggingThreadCount)}</MonoText>,
      },
      {
        id: 'constraint',
        header: 'CONSTRAINT',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MonoText title={row.constraintLimit === null ? undefined : `${formatNumber(row.constraintValue)} / ${formatNumber(row.constraintLimit)}`}>
            {row.constraintLimit === null ? formatNumber(row.constraintValue) : `${formatNumber(row.constraintValue)} / ${formatNumber(row.constraintLimit)}`}
          </MonoText>
        ),
      },
      {
        id: 'config',
        header: 'CONFIG CONTEXT',
        className: 'min-w-[260px]',
        cell: (row) => (
          <span className="text-muted-foreground block truncate" title={configSummary(row)}>
            {configSummary(row)}
          </span>
        ),
      },
    ],
    [returnState],
  )

  return (
    <>
      <PageHeader
        title="Work Managers"
        subtitle="Runtime pressure by server thread pool, Work Manager, constraints, request classes, and legacy execute queues."
        meta={
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-muted-foreground flex items-center gap-1 text-[13px] leading-[18px]">
              Updated <RelativeTime value={query.dataUpdatedAt} />
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()}>
              <RefreshCw className="size-3.5" strokeWidth={1.5} />
              Refresh
            </Button>
          </div>
        }
      />

      <PartialBanner failures={failures} overflowCount={overflowCount} onRetry={() => void query.refetch()} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2" strokeWidth={1.5} aria-hidden />
          <Input
            aria-label="Search Work Managers"
            placeholder="Search servers, Work Managers, constraints"
            value={search}
            onChange={(event) => updateTableState({ search: event.target.value })}
            className="h-8 rounded-[4px] pl-7 text-[13px]"
          />
        </div>
        <select aria-label="Filter WebLogic server" className="h-8 border border-border bg-background px-2 text-[13px]" value={server} onChange={(event) => updateTableState({ filters: { server: event.target.value } })}>
          {['all', ...serverOptions].map((value) => <option key={value} value={value}>{value === 'all' ? 'all servers' : value}</option>)}
        </select>
        <select aria-label="Filter severity" className="h-8 border border-border bg-background px-2 text-[13px]" value={severity} onChange={(event) => updateTableState({ filters: { severity: event.target.value } })}>
          {severityFilters.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select aria-label="Filter family" className="h-8 border border-border bg-background px-2 text-[13px]" value={family} onChange={(event) => updateTableState({ filters: { family: event.target.value } })}>
          {familyFilters.map((value) => <option key={value} value={value}>{value === 'all' ? 'all families' : familyLabel(value as WorkManagerFamily)}</option>)}
        </select>
        {hasActiveFilters ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
            Clear
          </Button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        sort={effectiveSort}
        onSortChange={(nextSort) => updateTableState({ sort: nextSort })}
        loading={query.isFetching}
        error={query.isError ? { message: query.error instanceof Error ? query.error.message : 'Unable to load Work Manager runtimes.', retry: () => void query.refetch() } : null}
        empty={{
          message: hasActiveFilters ? 'No Work Manager rows match the active filters.' : 'No Work Manager runtimes reported by available servers.',
          hint: hasActiveFilters ? 'Clear filters to restore the full runtime set.' : undefined,
        }}
      />
    </>
  )
}
