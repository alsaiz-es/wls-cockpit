import { useCallback, useMemo } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { AlertTriangle, Ban, Search } from 'lucide-react'
import {
  jtaRecoveryUnavailableReason,
  jtaSeverityTone,
  useJtaSnapshot,
  type JtaRecoveryRow,
  type JtaResourceRow,
  type JtaServerRow,
  type JtaSeverity,
  type JtaTransactionNameRow,
} from '@/api/queries/jta'
import {
  DataTable,
  MonoText,
  PageHeader,
  StatusBadge,
  type DataTableColumn,
  type DataTableSort,
} from '@/components'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FILTER_SELECT_CLASS, filterOptionLabel } from '@/components/filter-option-label'
import { detailReturnState } from './detail-return-state'
import {
  parseRuntimeTableUrlState,
  serializeRuntimeTableUrlState,
  type RuntimeTableUrlConfig,
  type RuntimeTableUrlState,
} from './runtime-table-url-state'
import { routeParam } from './route-params'

const DEFAULT_SORT: DataTableSort = { columnId: 'severity', direction: 'asc' }
const severityOrder: JtaSeverity[] = ['critical', 'warning', 'unknown', 'healthy']
const severityFilters = ['all', ...severityOrder] as const
const serviceFilters = ['all', 'RUNNING', 'other', 'unavailable'] as const
type SeverityFilter = (typeof severityFilters)[number]
type ServiceFilter = (typeof serviceFilters)[number]

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function compareNumberWithNulls(a: number | null, b: number | null, direction: 'asc' | 'desc') {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return direction === 'asc' ? a - b : b - a
}

function compareNumberRows(
  a: JtaServerRow,
  b: JtaServerRow,
  sort: DataTableSort,
  readValue: (row: JtaServerRow) => number | null,
) {
  return compareNumberWithNulls(readValue(a), readValue(b), sort.direction) || compareText(a.serverName, b.serverName)
}

function formatNumber(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}

function searchText(row: JtaServerRow) {
  return [
    row.serverName,
    row.lifecycleState,
    row.severity,
    row.healthState,
    row.transactionServiceState ?? '',
    ...row.resources.map((resource) => resource.resourceName),
    ...row.recoveryRows.map((recovery) => recovery.name),
  ].join(' ').toLowerCase()
}

function compareRows(a: JtaServerRow, b: JtaServerRow, sort: DataTableSort) {
  const direction = sort.direction === 'asc' ? 1 : -1
  switch (sort.columnId) {
    case 'severity':
      return (
        (severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)) * direction ||
        compareText(a.serverName, b.serverName)
      )
    case 'server':
      return compareText(a.serverName, b.serverName) * direction
    case 'active':
      return compareNumberRows(a, b, sort, (row) => row.activeTransactionsTotalCount)
    case 'total':
      return compareNumberRows(a, b, sort, (row) => row.transactionTotalCount)
    case 'committed':
      return compareNumberRows(a, b, sort, (row) => row.transactionCommittedTotalCount)
    case 'rolledBack':
      return compareNumberRows(a, b, sort, (row) => row.transactionRolledBackTotalCount)
    case 'heuristics':
      return compareNumberRows(a, b, sort, (row) => row.transactionHeuristicsTotalCount)
    default:
      return compareRows(a, b, DEFAULT_SORT)
  }
}

function serviceMatches(row: JtaServerRow, filter: ServiceFilter) {
  if (filter === 'all') return true
  if (filter === 'unavailable') return !row.available
  if (filter === 'other') return row.available && row.transactionServiceState !== 'RUNNING'
  return row.transactionServiceState === filter
}

function PartialBanner({
  failures,
  onRetry,
}: {
  failures: Array<{ serverName: string; family: string; message: string }>
  onRetry: () => void
}) {
  if (failures.length === 0) return null
  return (
    <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
      <span className="min-w-0 truncate">
        Partial data: {failures.map((failure) => `${failure.serverName}/${failure.family}: ${failure.message}`).join(' · ')}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function TransactionRowsUnsupportedPanel({ row }: { row: JtaServerRow }) {
  return (
    <section className="border-status-warning/60 bg-status-warning/8 flex min-h-10 items-start gap-2 border px-3 py-2 text-[13px]">
      <Ban className="text-status-warning mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} />
      <div className="min-w-0">
        <div className="font-medium">Transaction row drill-down unsupported</div>
        <div className="text-muted-foreground mt-1">{jtaRecoveryUnavailableReason(row)}</div>
      </div>
    </section>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'warning' | 'negative' }) {
  return (
    <div className="border-border bg-background min-h-16 border px-3 py-2">
      <div className="text-muted-foreground text-[12px] uppercase leading-[16px] tracking-[0.04em]">{label}</div>
      <MonoText className={tone === 'negative' ? 'text-status-negative' : tone === 'warning' ? 'text-status-warning' : ''}>
        {value}
      </MonoText>
    </div>
  )
}

function DetailSection<T extends { id: string }>({
  title,
  rows,
  columns,
  empty,
}: {
  title: string
  rows: T[]
  columns: DataTableColumn<T>[]
  empty: string
}) {
  return (
    <section className="space-y-2">
      <div className="text-[14px] font-medium leading-[20px]">{title}</div>
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        loading={false}
        empty={empty}
      />
    </section>
  )
}

export function Jta() {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const query = useJtaSnapshot()
  const returnState = useMemo(() => detailReturnState(location), [location])
  const allRows = useMemo(() => query.data?.servers ?? [], [query.data?.servers])
  const serverOptions = useMemo(() => [...new Set(allRows.map((row) => row.serverName))].sort(compareText), [allRows])
  const tableUrlConfig = useMemo<RuntimeTableUrlConfig>(
    () => ({
      defaultSort: DEFAULT_SORT,
      sortableColumns: ['severity', 'server', 'active', 'total', 'committed', 'rolledBack', 'heuristics'],
      filters: {
        severity: { param: 'severity', defaultValue: 'all', allowedValues: severityFilters },
        server: { param: 'server', defaultValue: 'all', allowedValues: ['all', ...serverOptions] },
        service: { param: 'service', defaultValue: 'all', allowedValues: serviceFilters },
      },
    }),
    [serverOptions],
  )
  const tableState = useMemo(() => parseRuntimeTableUrlState(searchParams, tableUrlConfig), [searchParams, tableUrlConfig])
  const sort = tableState.sort
  const effectiveSort = sort ?? DEFAULT_SORT
  const search = tableState.search
  const severity = tableState.filters.severity as SeverityFilter
  const server = tableState.filters.server as string
  const service = tableState.filters.service as ServiceFilter
  const failures = query.data?.partialFailures ?? []
  const hasActiveFilters = search.trim().length > 0 || severity !== 'all' || server !== 'all' || service !== 'all'

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
      .filter((row) => severity === 'all' || row.severity === severity)
      .filter((row) => server === 'all' || row.serverName === server)
      .filter((row) => serviceMatches(row, service))
      .filter((row) => needle.length === 0 || searchText(row).includes(needle))
      .sort((a, b) => compareRows(a, b, effectiveSort))
  }, [allRows, effectiveSort, search, server, service, severity])

  const columns = useMemo<DataTableColumn<JtaServerRow>[]>(
    () => [
      {
        id: 'severity',
        header: 'STATUS',
        sortable: true,
        cell: (row) => <StatusBadge kind="custom" tone={jtaSeverityTone(row.severity)} label={row.severity} />,
      },
      {
        id: 'server',
        header: 'SERVER',
        sortable: true,
        className: 'min-w-[160px]',
        cell: (row) => (
          <Link to={`/jta/${encodeURIComponent(row.serverName)}`} state={returnState} className="hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <MonoText className="font-medium">{row.serverName}</MonoText>
          </Link>
        ),
      },
      {
        id: 'service',
        header: 'SERVICE',
        cell: (row) => <MonoText>{row.transactionServiceState ?? row.lifecycleState}</MonoText>,
      },
      {
        id: 'active',
        header: 'ACTIVE',
        sortable: true,
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.activeTransactionsTotalCount)}</MonoText>,
      },
      {
        id: 'total',
        header: 'TOTAL',
        sortable: true,
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.transactionTotalCount)}</MonoText>,
      },
      {
        id: 'committed',
        header: 'COMMITTED',
        sortable: true,
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.transactionCommittedTotalCount)}</MonoText>,
      },
      {
        id: 'rolledBack',
        header: 'ROLLED BACK',
        sortable: true,
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.transactionRolledBackTotalCount)}</MonoText>,
      },
      {
        id: 'heuristics',
        header: 'HEURISTICS',
        sortable: true,
        align: 'right',
        cell: (row) => (
          <MonoText className={(row.transactionHeuristicsTotalCount ?? 0) > 0 ? 'text-status-negative' : ''}>
            {formatNumber(row.transactionHeuristicsTotalCount)}
          </MonoText>
        ),
      },
      {
        id: 'resources',
        header: 'RESOURCES',
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.registeredResourceCount)}</MonoText>,
      },
    ],
    [returnState],
  )

  return (
    <>
      <PageHeader
        title="JTA"
        subtitle="Per-server transaction counters, recovery state, and resource health."
        updatedAt={query.dataUpdatedAt}
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
      />

      <PartialBanner failures={failures} onRetry={() => void query.refetch()} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2" strokeWidth={1.5} aria-hidden />
          <Input
            aria-label="Search JTA rows"
            placeholder="Search servers, resources, recovery services"
            value={search}
            onChange={(event) => updateTableState({ search: event.target.value })}
            className="h-8 rounded-[4px] pl-7 text-[13px]"
          />
        </div>
        <select
          aria-label="Filter JTA severity"
          className={FILTER_SELECT_CLASS}
          value={severity}
          onChange={(event) => updateTableState({ filters: { severity: event.target.value } })}
        >
          {severityFilters.map((value) => <option key={value} value={value}>{filterOptionLabel(value, 'All statuses')}</option>)}
        </select>
        <select
          aria-label="Filter JTA server"
          className={FILTER_SELECT_CLASS}
          value={server}
          onChange={(event) => updateTableState({ filters: { server: event.target.value } })}
        >
          <option value="all">All servers</option>
          {serverOptions.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select
          aria-label="Filter JTA service"
          className={FILTER_SELECT_CLASS}
          value={service}
          onChange={(event) => updateTableState({ filters: { service: event.target.value } })}
        >
          <option value="all">All services</option>
          <option value="RUNNING">RUNNING</option>
          <option value="other">Other</option>
          <option value="unavailable">Unavailable</option>
        </select>
        {hasActiveFilters ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => updateTableState({ search: '', filters: { severity: 'all', server: 'all', service: 'all' }, sort: null })}>
            Clear
          </Button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        sort={sort}
        onSortChange={(nextSort) => updateTableState({ sort: nextSort })}
        loading={query.isFetching}
        error={query.isError ? { message: query.error instanceof Error ? query.error.message : 'Unable to load JTA runtime data.', retry: () => void query.refetch() } : null}
        empty={{
          message: hasActiveFilters ? 'No JTA rows match the current filters.' : 'No JTA runtime rows reported.',
          hint: hasActiveFilters ? 'Clear filters to restore the full server list.' : undefined,
        }}
      />
    </>
  )
}

export function JtaDetails() {
  const { serverName = '' } = useParams()
  const decodedServerName = routeParam(serverName)
  const query = useJtaSnapshot()
  const row = useMemo(
    () => query.data?.servers.find((candidate) => candidate.serverName === decodedServerName) ?? null,
    [decodedServerName, query.data?.servers],
  )

  const resourceColumns = useMemo<DataTableColumn<JtaResourceRow>[]>(
    () => [
      { id: 'name', header: 'RESOURCE', cell: (resource) => <MonoText title={resource.resourceName}>{resource.resourceName}</MonoText>, className: 'min-w-[260px]' },
      { id: 'health', header: 'HEALTH', cell: (resource) => <StatusBadge kind="wls-health" value={resource.healthState} /> },
      { id: 'total', header: 'TOTAL', align: 'right', cell: (resource) => <MonoText>{formatNumber(resource.transactionTotalCount)}</MonoText> },
      { id: 'committed', header: 'COMMITTED', align: 'right', cell: (resource) => <MonoText>{formatNumber(resource.transactionCommittedTotalCount)}</MonoText> },
      { id: 'rolledBack', header: 'ROLLED BACK', align: 'right', cell: (resource) => <MonoText>{formatNumber(resource.transactionRolledBackTotalCount)}</MonoText> },
      { id: 'heuristics', header: 'HEURISTICS', align: 'right', cell: (resource) => <MonoText className={(resource.transactionHeuristicsTotalCount ?? 0) > 0 ? 'text-status-negative' : ''}>{formatNumber(resource.transactionHeuristicsTotalCount)}</MonoText> },
    ],
    [],
  )
  const recoveryColumns = useMemo<DataTableColumn<JtaRecoveryRow>[]>(
    () => [
      { id: 'name', header: 'RECOVERY SERVICE', cell: (recovery) => <MonoText>{recovery.name}</MonoText>, className: 'min-w-[220px]' },
      { id: 'active', header: 'ACTIVE', cell: (recovery) => <StatusBadge kind="custom" tone={recovery.active ? 'positive' : recovery.active === false ? 'neutral' : 'unknown'} label={recovery.active === null ? 'unknown' : recovery.active ? 'active' : 'inactive'} /> },
      { id: 'logged', header: 'LOGGED', align: 'right', cell: (recovery) => <MonoText>{formatNumber(recovery.initialRecoveredTransactionTotalCount)}</MonoText> },
      { id: 'loggedPercent', header: 'LOGGED %', align: 'right', cell: (recovery) => <MonoText>{recovery.recoveredTransactionCompletionPercent === null ? '-' : `${recovery.recoveredTransactionCompletionPercent}%`}</MonoText> },
      { id: 'unlogged', header: 'UNLOGGED', align: 'right', cell: (recovery) => <MonoText>{formatNumber(recovery.initialRecoveredUnloggedTransactionTotalCount)}</MonoText> },
      { id: 'unloggedPercent', header: 'UNLOGGED %', align: 'right', cell: (recovery) => <MonoText>{recovery.recoveredUnloggedTransactionCompletionPercent === null ? '-' : `${recovery.recoveredUnloggedTransactionCompletionPercent}%`}</MonoText> },
    ],
    [],
  )
  const transactionNameColumns = useMemo<DataTableColumn<JtaTransactionNameRow>[]>(
    () => [
      { id: 'name', header: 'TRANSACTION NAME', cell: (transaction) => <MonoText title={transaction.transactionName}>{transaction.transactionName}</MonoText>, className: 'min-w-[260px]' },
      { id: 'total', header: 'TOTAL', align: 'right', cell: (transaction) => <MonoText>{formatNumber(transaction.transactionTotalCount)}</MonoText> },
      { id: 'committed', header: 'COMMITTED', align: 'right', cell: (transaction) => <MonoText>{formatNumber(transaction.transactionCommittedTotalCount)}</MonoText> },
      { id: 'rolledBack', header: 'ROLLED BACK', align: 'right', cell: (transaction) => <MonoText>{formatNumber(transaction.transactionRolledBackTotalCount)}</MonoText> },
      { id: 'heuristics', header: 'HEURISTICS', align: 'right', cell: (transaction) => <MonoText>{formatNumber(transaction.transactionHeuristicsTotalCount)}</MonoText> },
      { id: 'SECONDS', header: 'SECONDS ACTIVE', align: 'right', cell: (transaction) => <MonoText>{formatNumber(transaction.secondsActiveTotalCount)}</MonoText> },
    ],
    [],
  )

  return (
    <>
      <PageHeader
        title={decodedServerName || 'JTA'}
        subtitle="Single-server JTA runtime counters, resources, and recovery services."
        updatedAt={query.dataUpdatedAt}
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
      />

      {/* A failed resources or recovery request would otherwise read as 'nothing reported'. */}
      <PartialBanner
        failures={(query.data?.partialFailures ?? []).filter((failure) => failure.serverName === decodedServerName)}
        onRetry={() => void query.refetch()}
      />

      {query.isFetching && !row ? (
        <div className="text-muted-foreground flex h-32 items-center justify-center text-[13px]">Loading JTA runtime...</div>
      ) : query.isError ? (
        <div className="border-status-negative/60 bg-status-negative/8 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span>{query.error instanceof Error ? query.error.message : 'Unable to load JTA runtime data.'}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()}>Retry</Button>
        </div>
      ) : !row ? (
        <div className="text-muted-foreground flex h-32 items-center justify-center text-[13px]">JTA server runtime not found.</div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
            <Metric label="Status" value={row.severity} tone={row.severity === 'critical' ? 'negative' : row.severity === 'warning' ? 'warning' : undefined} />
            <Metric label="Service" value={row.transactionServiceState ?? row.lifecycleState} />
            <Metric label="Active" value={formatNumber(row.activeTransactionsTotalCount)} />
            <Metric label="Total" value={formatNumber(row.transactionTotalCount)} />
            <Metric label="Committed" value={formatNumber(row.transactionCommittedTotalCount)} />
            <Metric label="Rolled Back" value={formatNumber(row.transactionRolledBackTotalCount)} />
            <Metric label="Timeout" value={formatNumber(row.transactionRolledBackTimeoutTotalCount)} tone={(row.transactionRolledBackTimeoutTotalCount ?? 0) > 0 ? 'warning' : undefined} />
            <Metric label="Heuristics" value={formatNumber(row.transactionHeuristicsTotalCount)} tone={(row.transactionHeuristicsTotalCount ?? 0) > 0 ? 'negative' : undefined} />
          </div>

          {!row.transactionRowsSupported ? <TransactionRowsUnsupportedPanel row={row} /> : null}

          {row.transactionHeuristicsTotalCount || row.transactionAbandonedTotalCount ? (
            <section className="border-status-negative/60 bg-status-negative/8 flex min-h-10 items-start gap-2 border px-3 py-2 text-[13px]">
              <AlertTriangle className="text-status-negative mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} />
              <span>Heuristic or abandoned JTA transactions require manual recovery review before any force action.</span>
            </section>
          ) : null}

          <DetailSection title="Transaction Resources" rows={row.resources} columns={resourceColumns} empty="No JTA resource runtimes reported." />
          <DetailSection title="Recovery Services" rows={row.recoveryRows} columns={recoveryColumns} empty="No JTA recovery services reported." />
          <DetailSection title="Transaction Names" rows={row.transactionNames} columns={transactionNameColumns} empty="No transaction name runtime rows reported." />
        </div>
      )}
    </>
  )
}
