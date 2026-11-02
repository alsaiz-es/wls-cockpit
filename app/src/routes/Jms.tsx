import { useCallback, useMemo } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { Search } from 'lucide-react'
import {
  getMetricHistorySeries,
  jmsMetricResourceId,
  useMetricHistoryRecorder,
  type MetricHistorySampleInput,
} from '@/api/queries/metric-history'
import { useJmsDestinations, type JmsDestinationRow, type JmsSeverity } from '@/api/queries/jms'
import { useAuth } from '@/auth/useAuth'
import {
  DataTable,
  MetricTrend,
  MonoText,
  PageHeader,
  StatusBadge,
  type DataTableColumn,
  type DataTableSort,
  type StatusTone,
} from '@/components'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  parseRuntimeTableUrlState,
  serializeRuntimeTableUrlState,
  type RuntimeTableUrlConfig,
  type RuntimeTableUrlState,
} from './runtime-table-url-state'
import { detailReturnState } from './detail-return-state'
import { jmsDestinationDisplayName } from './jms-destination-name'
import { jmsServerInventory } from './jms-server-inventory'
import { cn } from '@/lib/utils'

const DEFAULT_SORT: DataTableSort = { columnId: 'severity', direction: 'asc' }
const severityOrder: JmsSeverity[] = ['critical', 'warning', 'unknown', 'healthy']
const severityFilters = ['all', ...severityOrder] as const
const backlogFilters = ['all', 'backlog', 'pending', 'zeroConsumers', 'stalled'] as const
const pausedFilters = ['all', 'paused', 'enabled'] as const
type SeverityFilter = (typeof severityFilters)[number]
type BacklogFilter = (typeof backlogFilters)[number]
type PausedFilter = (typeof pausedFilters)[number]

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function compareNumberWithNulls(a: number | null, b: number | null, direction: 'asc' | 'desc') {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return direction === 'asc' ? a - b : b - a
}

function severityTone(severity: JmsSeverity): StatusTone {
  if (severity === 'critical') return 'negative'
  if (severity === 'warning') return 'warning'
  if (severity === 'healthy') return 'positive'
  return 'unknown'
}

function formatNumber(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}

function pauseState(row: JmsDestinationRow) {
  return row.consumptionPaused === true || row.productionPaused === true || row.insertionPaused === true
}

function pauseLabel(row: JmsDestinationRow) {
  if (pauseState(row)) return 'PAUSED'
  const states = [row.consumptionPausedState, row.productionPausedState, row.insertionPausedState].filter(Boolean)
  return states.length ? 'ENABLED' : 'UNKNOWN'
}

function searchText(row: JmsDestinationRow) {
  return [
    row.serverName,
    row.jmsServerName,
    row.destinationName ?? '',
    row.destinationType ?? '',
    row.state ?? '',
    row.severity,
    row.consumptionPausedState ?? '',
    row.productionPausedState ?? '',
    row.insertionPausedState ?? '',
  ].join(' ').toLowerCase()
}

function detailPath(row: JmsDestinationRow) {
  if (!row.destinationName) return null
  return `/jms/${encodeURIComponent(row.serverName)}/${encodeURIComponent(row.jmsServerName)}/${encodeURIComponent(row.destinationName)}`
}

function jmsMetricSamples(rows: JmsDestinationRow[]): MetricHistorySampleInput[] {
  return rows.flatMap((row): MetricHistorySampleInput[] => {
    const resourceId = jmsMetricResourceId(row.serverName, row.jmsServerName, row.destinationName)
    return [
      {
        family: 'jms',
        resourceId,
        metric: 'messages.current',
        value: row.messagesCurrentCount,
      },
      {
        family: 'jms',
        resourceId,
        metric: 'messages.pending',
        value: row.messagesPendingCount,
      },
      {
        family: 'jms',
        resourceId,
        metric: 'consumers.current',
        value: row.consumersCurrentCount,
      },
    ]
  })
}

function compareRows(a: JmsDestinationRow, b: JmsDestinationRow, sort: DataTableSort) {
  const direction = sort.direction === 'asc' ? 1 : -1
  switch (sort.columnId) {
    case 'severity':
      return (
        (severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)) * direction ||
        compareText(a.destinationName ?? a.jmsServerName, b.destinationName ?? b.jmsServerName)
      )
    case 'destination':
      return compareText(a.destinationName ?? '', b.destinationName ?? '') * direction
    case 'server':
      return compareText(a.serverName, b.serverName) * direction
    case 'jmsServer':
      return compareText(a.jmsServerName, b.jmsServerName) * direction
    case 'type':
      return compareText(a.destinationType ?? '', b.destinationType ?? '') * direction
    case 'messages':
      return compareNumberWithNulls(a.messagesCurrentCount, b.messagesCurrentCount, sort.direction)
    case 'pending':
      return compareNumberWithNulls(a.messagesPendingCount, b.messagesPendingCount, sort.direction)
    case 'consumers':
      return compareNumberWithNulls(a.consumersCurrentCount, b.consumersCurrentCount, sort.direction)
    case 'bytes':
      return compareNumberWithNulls(a.bytesCurrentCount, b.bytesCurrentCount, sort.direction)
    default:
      return compareRows(a, b, DEFAULT_SORT)
  }
}

function PartialBanner({
  failures,
  onRetry,
}: {
  failures: Array<{ serverName: string; jmsServerName?: string; family: string; message: string }>
  onRetry: () => void
}) {
  if (failures.length === 0) return null
  return (
    <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
      <span className="min-w-0 truncate">
        Partial data:{' '}
        {failures
          .map((failure) => `${failure.serverName}${failure.jmsServerName ? `/${failure.jmsServerName}` : ''}/${failure.family}: ${failure.message}`)
          .join(' · ')}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

export function Jms() {
  const { creds } = useAuth()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const query = useJmsDestinations()
  const returnState = useMemo(() => detailReturnState(location), [location])
  const failures = query.data?.partialFailures ?? []
  const allRows = useMemo(() => query.data?.rows ?? [], [query.data?.rows])
  const inventory = useMemo(() => jmsServerInventory(allRows), [allRows])
  const historySamples = useMemo(() => jmsMetricSamples(allRows), [allRows])
  const history = useMetricHistoryRecorder({
    creds,
    samples: historySamples,
    timestamp: query.dataUpdatedAt,
  })
  const serverOptions = useMemo(() => [...new Set(allRows.map((row) => row.serverName))].sort(compareText), [allRows])
  const jmsServerOptions = useMemo(() => [...new Set(allRows.map((row) => row.jmsServerName))].sort(compareText), [allRows])
  const typeOptions = useMemo(() => [...new Set(allRows.flatMap((row) => (row.destinationType ? [row.destinationType] : [])))].sort(compareText), [allRows])
  const tableUrlConfig = useMemo<RuntimeTableUrlConfig>(
    () => ({
      defaultSort: DEFAULT_SORT,
      sortableColumns: ['severity', 'destination', 'server', 'jmsServer', 'type', 'messages', 'pending', 'consumers', 'bytes'],
      filters: {
        severity: { param: 'severity', defaultValue: 'all', allowedValues: severityFilters },
        server: { param: 'server', defaultValue: 'all', allowedValues: ['all', ...serverOptions] },
        jmsServer: { param: 'jmsServer', defaultValue: 'all', allowedValues: ['all', ...jmsServerOptions] },
        type: { param: 'type', defaultValue: 'all', allowedValues: ['all', ...typeOptions] },
        backlog: { param: 'backlog', defaultValue: 'all', allowedValues: backlogFilters },
        paused: { param: 'paused', defaultValue: 'all', allowedValues: pausedFilters },
      },
    }),
    [jmsServerOptions, serverOptions, typeOptions],
  )
  const tableState = useMemo(() => parseRuntimeTableUrlState(searchParams, tableUrlConfig), [searchParams, tableUrlConfig])
  const sort = tableState.sort
  const search = tableState.search
  const severity = tableState.filters.severity as SeverityFilter
  const server = tableState.filters.server as string
  const jmsServer = tableState.filters.jmsServer as string
  const type = tableState.filters.type as string
  const backlog = tableState.filters.backlog as BacklogFilter
  const paused = tableState.filters.paused as PausedFilter
  const effectiveSort = sort ?? DEFAULT_SORT
  const hasActiveFilters =
    search.trim().length > 0 ||
    severity !== 'all' ||
    server !== 'all' ||
    jmsServer !== 'all' ||
    type !== 'all' ||
    backlog !== 'all' ||
    paused !== 'all'

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
      .filter((row) => jmsServer === 'all' || row.jmsServerName === jmsServer)
      .filter((row) => type === 'all' || row.destinationType === type)
      .filter((row) => {
        if (backlog === 'all') return true
        if (backlog === 'backlog') return (row.messagesCurrentCount ?? 0) > 0
        if (backlog === 'pending') return (row.messagesPendingCount ?? 0) > 0
        if (backlog === 'zeroConsumers') return !!row.destinationName && row.consumersCurrentCount === 0
        return !!row.destinationName && (row.messagesCurrentCount ?? 0) > 0 && row.consumersCurrentCount === 0
      })
      .filter((row) => {
        if (paused === 'all') return true
        return paused === 'paused' ? pauseState(row) : !pauseState(row)
      })
      .filter((row) => needle.length === 0 || searchText(row).includes(needle))
      .sort((a, b) => compareRows(a, b, effectiveSort))
  }, [allRows, backlog, effectiveSort, jmsServer, paused, search, server, severity, type])

  const columns = useMemo<DataTableColumn<JmsDestinationRow>[]>(
    () => [
      {
        id: 'severity',
        header: 'STATUS',
        sortable: true,
        cell: (row) => <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.severity} />,
      },
      {
        id: 'destination',
        header: 'DESTINATION',
        sortable: true,
        className: 'min-w-[220px]',
        cell: (row) => {
          const label = row.destinationName ?? '(JMS server)'
          const path = detailPath(row)
          if (!path) {
            return <MonoText className="block truncate font-medium text-muted-foreground" title={label}>{label}</MonoText>
          }
          const display = jmsDestinationDisplayName(label)
          return (
            <Link to={path} state={returnState} className="hover:text-accent block min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={label}>
              <MonoText className="block truncate font-medium">{display.primary}</MonoText>
              {display.secondary ? (
                <MonoText className="text-muted-foreground block truncate text-[11px]">{display.secondary}</MonoText>
              ) : null}
            </Link>
          )
        },
      },
      {
        id: 'server',
        header: 'SERVER',
        sortable: true,
        cell: (row) => <MonoText title={row.serverName}>{row.serverName}</MonoText>,
      },
      {
        id: 'jmsServer',
        header: 'JMS SERVER',
        sortable: true,
        cell: (row) => <MonoText title={row.jmsServerName}>{row.jmsServerName}</MonoText>,
      },
      {
        id: 'type',
        header: 'TYPE',
        sortable: true,
        cell: (row) => <MonoText>{row.destinationType ?? '-'}</MonoText>,
      },
      {
        id: 'messages',
        header: 'MESSAGES',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              history.scopeKey,
              'jms',
              jmsMetricResourceId(row.serverName, row.jmsServerName, row.destinationName),
              'messages.current',
            )}
            value={formatNumber(row.messagesCurrentCount)}
            title={`${row.destinationName ?? row.jmsServerName} current messages`}
          />
        ),
      },
      {
        id: 'pending',
        header: 'PENDING',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              history.scopeKey,
              'jms',
              jmsMetricResourceId(row.serverName, row.jmsServerName, row.destinationName),
              'messages.pending',
            )}
            value={formatNumber(row.messagesPendingCount)}
            title={`${row.destinationName ?? row.jmsServerName} pending messages`}
          />
        ),
      },
      {
        id: 'consumers',
        header: 'CONSUMERS',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              history.scopeKey,
              'jms',
              jmsMetricResourceId(row.serverName, row.jmsServerName, row.destinationName),
              'consumers.current',
            )}
            value={formatNumber(row.consumersCurrentCount)}
            title={`${row.destinationName ?? row.jmsServerName} consumers`}
            higherIsWorse={false}
          />
        ),
      },
      {
        id: 'bytes',
        header: 'BYTES',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => formatNumber(row.bytesCurrentCount),
      },
      {
        id: 'pause',
        header: 'PAUSE',
        cell: (row) => <StatusBadge kind="custom" tone={pauseState(row) ? 'warning' : 'neutral'} label={pauseLabel(row)} />,
      },
    ],
    [history.scopeKey, returnState],
  )

  return (
    <>
      <PageHeader
        title="JMS"
        subtitle="Read-only JMS servers, destinations, counters, consumers, bytes, and pause state."
        updatedAt={query.dataUpdatedAt}
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
      />

      <PartialBanner failures={failures} onRetry={() => void query.refetch()} />
      {query.data?.notReporting.length ? (
        <div className="border-border bg-surface-1 mb-3 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]" role="status">
          <span className="text-muted-foreground shrink-0">Not reporting JMS</span>
          <MonoText className="min-w-0 truncate">
            {query.data.notReporting.map((server) => `${server.serverName} (${server.state})`).join(' · ')}
          </MonoText>
        </div>
      ) : null}

      {inventory.length > 1 ? (
        <section className="border-border mb-3 border" aria-label="JMS servers">
          <div className="text-muted-foreground border-b border-border px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.04em]">
            JMS servers · select one to filter the destinations
          </div>
          <div className="grid sm:grid-cols-2 xl:grid-cols-3">
            {inventory.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => updateTableState({ filters: { jmsServer: jmsServer === entry.jmsServerName ? 'all' : entry.jmsServerName } })}
                className={cn(
                  'bg-background hover:bg-surface-1 -mb-px flex min-w-0 flex-col items-start gap-0.5 border-b border-r border-border px-3 py-2 text-left text-[13px]',
                  jmsServer === entry.jmsServerName ? 'bg-accent/8' : null,
                )}
              >
                <MonoText className="block max-w-full truncate font-medium">{entry.jmsServerName}</MonoText>
                <span className="text-muted-foreground text-[12px]">
                  {entry.serverName} · {entry.destinations} destinations · {entry.messages.toLocaleString()} messages ·{' '}
                  {entry.consumers.toLocaleString()} consumers
                  {entry.stalled ? <span className="text-status-warning"> · {entry.stalled} stalled</span> : null}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2" strokeWidth={1.5} aria-hidden />
          <Input
            aria-label="Search JMS destinations"
            placeholder="Search destinations, servers, state"
            value={search}
            onChange={(event) => updateTableState({ search: event.target.value })}
            className="h-8 rounded-[4px] pl-7 text-[13px]"
          />
        </div>
        <select aria-label="Filter severity" className="h-8 border border-border bg-background px-2 text-[13px]" value={severity} onChange={(event) => updateTableState({ filters: { severity: event.target.value } })}>
          {severityFilters.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select aria-label="Filter WebLogic server" className="h-8 border border-border bg-background px-2 text-[13px]" value={server} onChange={(event) => updateTableState({ filters: { server: event.target.value } })}>
          {['all', ...serverOptions].map((value) => <option key={value} value={value}>{value === 'all' ? 'all servers' : value}</option>)}
        </select>
        <select aria-label="Filter JMS server" className="h-8 border border-border bg-background px-2 text-[13px]" value={jmsServer} onChange={(event) => updateTableState({ filters: { jmsServer: event.target.value } })}>
          {['all', ...jmsServerOptions].map((value) => <option key={value} value={value}>{value === 'all' ? 'all JMS servers' : value}</option>)}
        </select>
        <select aria-label="Filter destination type" className="h-8 border border-border bg-background px-2 text-[13px]" value={type} onChange={(event) => updateTableState({ filters: { type: event.target.value } })}>
          {['all', ...typeOptions].map((value) => <option key={value} value={value}>{value === 'all' ? 'all types' : value}</option>)}
        </select>
        <select aria-label="Filter backlog" className="h-8 border border-border bg-background px-2 text-[13px]" value={backlog} onChange={(event) => updateTableState({ filters: { backlog: event.target.value } })}>
          <option value="all">all backlog</option>
          <option value="backlog">messages</option>
          <option value="pending">pending</option>
          <option value="zeroConsumers">zero consumers</option>
          <option value="stalled">backlog, no consumers</option>
        </select>
        <select aria-label="Filter pause state" className="h-8 border border-border bg-background px-2 text-[13px]" value={paused} onChange={(event) => updateTableState({ filters: { paused: event.target.value } })}>
          <option value="all">all pause states</option>
          <option value="paused">paused</option>
          <option value="enabled">enabled</option>
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
        error={query.isError ? { message: query.error instanceof Error ? query.error.message : 'Unable to load JMS runtime.', retry: () => void query.refetch() } : null}
        empty={{
          message: hasActiveFilters ? 'No JMS rows match the active filters.' : 'No JMS runtimes reported by running servers.',
          hint: hasActiveFilters ? 'Clear filters to restore the full runtime set.' : undefined,
        }}
      />
    </>
  )
}
