import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { Clipboard, Pause, Play, RefreshCw, Search, Trash2 } from 'lucide-react'
import {
  buildMultiLogTailSources,
  isHttpAccessLogArchiveName,
  multiLogTailSourceId,
  parseHttpAccessLogRecord,
  useLogs,
  useMultiLogRecordTail,
  type LogRuntimeRow,
  type LogSignalSeverity,
  type MultiLogTailRecord,
  type MultiLogTailSource,
  type MultiLogTailSourceFailure,
} from '@/api/queries/logs'
import { LOG_SEVERITY_FLOORS, type LogSeverityFloor } from '@/api/queries/log-tail'
import { useAuth } from '@/auth/useAuth'
import {
  DataTable,
  MonoText,
  PageHeader,
  RelativeTime,
  StatusBadge,
  type DataTableColumn,
  type DataTableSort,
  type StatusTone,
  type WlsLifecycleState,
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
import { readLogsTailSelection, writeLogsTailSelection } from './logs-tail-selection'
import { logRecordSeverityTone } from './log-record-severity'

const DEFAULT_SORT: DataTableSort = { columnId: 'severity', direction: 'asc' }
const severityOrder: LogSignalSeverity[] = ['critical', 'warning', 'unknown', 'healthy']
const severityFilters = ['all', ...severityOrder] as const
type SeverityFilter = (typeof severityFilters)[number]
const MULTI_TAIL_MAX_SOURCES = 6
const sourceAccentClasses = [
  'border-l-accent',
  'border-l-status-warning',
  'border-l-status-positive',
  'border-l-status-negative',
  'border-l-ring',
  'border-l-muted-foreground',
]

const lifecycleOrder: WlsLifecycleState[] = [
  'RUNNING',
  'STARTING',
  'ADMIN',
  'STANDBY',
  'SUSPENDED',
  'SUSPENDING',
  'FORCE_SUSPENDING',
  'RESUMING',
  'SHUTTING_DOWN',
  'SHUTDOWN',
  'FAILED_NOT_RESTARTABLE',
  'UNKNOWN',
]

function severityTone(severity: LogSignalSeverity): StatusTone {
  if (severity === 'critical') return 'negative'
  if (severity === 'warning') return 'warning'
  if (severity === 'healthy') return 'positive'
  return 'unknown'
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function compareNumberWithNulls(a: number | null, b: number | null, direction: 'asc' | 'desc') {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return direction === 'asc' ? a - b : b - a
}

function compareBoolWithNulls(a: boolean | null, b: boolean | null, direction: 'asc' | 'desc') {
  const numericA = a === null ? null : Number(a)
  const numericB = b === null ? null : Number(b)
  return compareNumberWithNulls(numericA, numericB, direction)
}

function compareRows(a: LogRuntimeRow, b: LogRuntimeRow, sort: DataTableSort) {
  const direction = sort.direction === 'asc' ? 1 : -1
  switch (sort.columnId) {
    case 'severity':
      return (severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)) * direction || compareText(a.serverName, b.serverName)
    case 'server':
      return compareText(a.serverName, b.serverName) * direction
    case 'state':
      return (lifecycleOrder.indexOf(a.state) - lifecycleOrder.indexOf(b.state)) * direction
    case 'messages':
      return compareNumberWithNulls(a.messagesLogged, b.messagesLogged, sort.direction)
    case 'stream':
      return compareBoolWithNulls(a.logFileStreamOpened, b.logFileStreamOpened, sort.direction)
    case 'broadcaster':
      return (Number(a.broadcasterAvailable) - Number(b.broadcasterAvailable)) * direction
    case 'serverLog':
      return (Number(a.serverLogAvailable) - Number(b.serverLogAvailable)) * direction
    case 'archives':
      return compareNumberWithNulls(a.archives.length, b.archives.length, sort.direction)
    case 'serverLogLatest':
      return compareNumberWithNulls(a.serverLogLatestTimestamp, b.serverLogLatestTimestamp, sort.direction)
    default:
      return compareRows(a, b, DEFAULT_SORT)
  }
}

function formatNumber(value: number | null) {
  return value === null ? '–' : value.toLocaleString()
}

function formatBytes(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}

function formatRecordTimestamp(record: MultiLogTailRecord) {
  if (record.timestamp !== null) return new Date(record.timestamp).toLocaleString()
  return record.date ?? '-'
}

function availabilityTone(available: boolean): StatusTone {
  return available ? 'positive' : 'warning'
}

function archiveKindTone(kind: LogRuntimeRow['archives'][number]['kind']): StatusTone {
  if (kind === 'server' || kind === 'domain') return 'positive'
  if (kind === 'diagnosticEvent') return 'warning'
  if (kind === 'custom' || kind === 'archive') return 'unknown'
  return 'neutral'
}

function archiveSummary(row: LogRuntimeRow) {
  if (row.archives.length === 0) return '–'
  return row.archives.map((archive) => `${archive.name} [${archive.label}]`).join(', ')
}

function archiveKindSummary(row: LogRuntimeRow) {
  const labels = [...new Set(row.archives.map((archive) => archive.label))]
  return labels.slice(0, 3).join(' · ') + (labels.length > 3 ? ` +${labels.length - 3}` : '')
}

function streamModel(value: boolean | null): { tone: StatusTone; label: string } {
  if (value === true) return { tone: 'positive', label: 'OPEN' }
  if (value === false) return { tone: 'warning', label: 'CLOSED' }
  return { tone: 'unknown', label: 'UNKNOWN' }
}


function httpStatusTone(value: number | null): StatusTone {
  if (value === null) return 'unknown'
  if (value >= 500) return 'negative'
  if (value >= 400) return 'warning'
  if (value >= 300) return 'neutral'
  return 'positive'
}

function searchText(row: LogRuntimeRow) {
  return [
    row.serverName,
    row.state,
    row.severity,
    row.logFileStreamOpened === true ? 'open' : row.logFileStreamOpened === false ? 'closed' : 'unknown',
    row.broadcasterAvailable ? 'broadcaster available' : 'broadcaster missing',
    row.serverLogAvailable ? 'server log available' : 'server log missing',
    ...row.archives.map((archive) => archive.name),
    ...row.archives.map((archive) => archive.label),
    ...row.archives.map((archive) => archive.description),
  ]
    .join(' ')
    .toLowerCase()
}

function logDetailPath(row: LogRuntimeRow) {
  return `/logs/${encodeURIComponent(row.serverName)}`
}

function sourceLabel(source: MultiLogTailSource) {
  return `${source.serverName} / ${source.archive.name}`
}

function recordText(record: MultiLogTailRecord) {
  const access = parseHttpAccessLogRecord(record)
  return [
    record.sourceServerName,
    record.sourceArchiveName,
    record.recordId?.toString() ?? '',
    record.date ?? '',
    record.severity ?? '',
    record.subsystem ?? '',
    record.thread ?? '',
    record.userId ?? '',
    record.messageId ?? '',
    access?.method ?? '',
    access?.status?.toString() ?? '',
    access?.path ?? '',
    access?.client ?? '',
    access?.bytes?.toString() ?? '',
    access?.userAgent ?? '',
    record.message ?? '',
  ].join('\t')
}

function PartialBanner({ failures, onRetry }: { failures: Array<{ serverName: string; signal: string; message: string }>; onRetry: () => void }) {
  if (failures.length === 0) return null
  return (
    <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
      <span className="min-w-0 truncate">
        Partial data:{' '}
        {failures
          .map((failure) => `${failure.serverName}/${failure.signal}: ${failure.message}`)
          .join(' · ')}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function MultiTailFailureBanner({ failures, onRetry }: { failures: MultiLogTailSourceFailure[]; onRetry: () => void }) {
  if (failures.length === 0) return null
  return (
    <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
      <span className="min-w-0 truncate" title={failures.map((failure) => `${failure.serverName}/${failure.archiveName}: ${failure.message}`).join('\n')}>
        Stopped polling {failures.length === 1 ? 'a source that failed' : `${failures.length} sources that failed`}:{' '}
        {failures
          .map((failure) => `${failure.serverName}/${failure.archiveName}: ${failure.message}`)
          .join(' · ')}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function MultiServerLogTail({
  rows,
  loading,
}: {
  rows: LogRuntimeRow[]
  loading: boolean
}) {
  const { creds } = useAuth()
  const profileId = creds?.profileId
  const [initialSelection] = useState(() => readLogsTailSelection(profileId))
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(() => new Set(initialSelection.sourceIds))
  const [severityFloor, setSeverityFloor] = useState<LogSeverityFloor>(initialSelection.severityFloor)
  const [textFilter, setTextFilter] = useState('')
  const [paused, setPaused] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const sourceOptions = useMemo(
    () =>
      rows.flatMap((row) =>
        row.archives.map((archive) => ({
          id: multiLogTailSourceId(row.serverName, archive.name),
          serverName: row.serverName,
          archive,
        })),
      ),
    [rows],
  )
  const selectedSources = useMemo(
    () => buildMultiLogTailSources(rows, selectedSourceIds, MULTI_TAIL_MAX_SOURCES),
    [rows, selectedSourceIds],
  )
  const selectedSourceIdList = useMemo(
    () => selectedSources.map((source) => source.id),
    [selectedSources],
  )
  const selectedSourceIdSet = useMemo(() => new Set(selectedSourceIdList), [selectedSourceIdList])
  const sourceIndex = useMemo(
    () => Object.fromEntries(selectedSources.map((source, index) => [source.id, index])),
    [selectedSources],
  )
  const query = useMultiLogRecordTail(selectedSources, {
    enabled: selectedSources.length > 0,
    paused,
    severityFloor,
  })
  // Newest first, so the latest record is visible without scrolling the bounded panel.
  const visibleRecords = useMemo(() => {
    const needle = textFilter.trim().toLowerCase()
    const matching = needle ? query.records.filter((record) => recordText(record).toLowerCase().includes(needle)) : query.records
    return [...matching].reverse()
  }, [query.records, textFilter])

  useEffect(() => {
    writeLogsTailSelection(profileId, { sourceIds: [...selectedSourceIds], severityFloor })
  }, [profileId, selectedSourceIds, severityFloor])

  const toggleSource = useCallback((sourceId: string) => {
    setSelectedSourceIds((current) => {
      const next = new Set(current)
      if (next.has(sourceId)) {
        next.delete(sourceId)
      } else if (next.size < MULTI_TAIL_MAX_SOURCES) {
        next.add(sourceId)
      }
      return next
    })
    setPaused(false)
  }, [])

  const selectServerLogs = useCallback(() => {
    setSelectedSourceIds(new Set(
      sourceOptions
        .filter((source) => source.archive.name === 'ServerLog')
        .slice(0, MULTI_TAIL_MAX_SOURCES)
        .map((source) => source.id),
    ))
    setPaused(false)
  }, [sourceOptions])

  const clear = useCallback(() => {
    query.reset()
    setCopyFeedback(null)
  }, [query])

  const copyRecordMessage = useCallback((record: MultiLogTailRecord) => {
    if (!navigator.clipboard?.writeText) {
      setCopyFeedback('Clipboard API unavailable.')
      return
    }
    navigator.clipboard.writeText(record.message ?? recordText(record)).then(
      () => setCopyFeedback('Copied log record.'),
      (error: unknown) => setCopyFeedback(error instanceof Error ? `Copy failed: ${error.message}` : 'Copy failed.'),
    )
  }, [])

  const copyAll = useCallback(() => {
    if (!navigator.clipboard?.writeText) {
      setCopyFeedback('Clipboard API unavailable.')
      return
    }
    navigator.clipboard.writeText(query.records.map(recordText).join('\n')).then(
      () => setCopyFeedback(`Copied ${query.records.length.toLocaleString()} retained records.`),
      (error: unknown) => setCopyFeedback(error instanceof Error ? `Copy failed: ${error.message}` : 'Copy failed.'),
    )
  }, [query.records])

  return (
    <section className="border-border bg-surface-1 mb-4 border px-3 py-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-medium leading-5">Global Tail</h2>
          <p className="text-muted-foreground text-[13px] leading-[18px]">
            Follows the newest WLDF records, newest first. Select up to {MULTI_TAIL_MAX_SOURCES} sources.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MonoText className="text-muted-foreground text-[12px]">
            {visibleRecords.length === query.records.length
              ? `${query.records.length.toLocaleString()} records`
              : `${visibleRecords.length.toLocaleString()} of ${query.records.length.toLocaleString()} records`}
          </MonoText>
          <Button type="button" size="sm" variant="ghost" disabled={sourceOptions.length === 0} onClick={selectServerLogs}>
            All server logs
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={selectedSources.length === 0} onClick={() => setPaused((value) => !value)}>
            {paused ? <Play className="size-3.5" strokeWidth={1.5} /> : <Pause className="size-3.5" strokeWidth={1.5} />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={selectedSources.length === 0} onClick={() => void query.refetch()}>
            <RefreshCw className="size-3.5" strokeWidth={1.5} />
            Refresh
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={query.records.length === 0} onClick={clear}>
            <Trash2 className="size-3.5" strokeWidth={1.5} />
            Clear
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={query.records.length === 0} onClick={copyAll}>
            <Clipboard className="size-3.5" strokeWidth={1.5} />
            Copy
          </Button>
        </div>
      </div>

      <div className="mb-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {sourceOptions.length === 0 ? (
          <div className="border-border bg-background px-3 py-3 text-[13px] text-muted-foreground">
            {loading ? 'Discovering log archives...' : 'No WLDF log archive sources reported.'}
          </div>
        ) : sourceOptions.map((source) => {
          const checked = selectedSourceIdSet.has(source.id)
          const disabled = !checked && selectedSources.length >= MULTI_TAIL_MAX_SOURCES
          const sourceNumber = sourceIndex[source.id] ?? 0
          return (
            <label
              key={source.id}
              className={[
                'border-border bg-background flex min-h-11 items-center gap-2 border border-l-4 px-2 py-2 text-[13px]',
                checked ? sourceAccentClasses[sourceNumber % sourceAccentClasses.length] : 'border-l-transparent',
                disabled ? 'opacity-55' : '',
              ].join(' ')}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => toggleSource(source.id)}
              />
              <span className="min-w-0 flex-1">
                <MonoText className="block truncate" title={sourceLabel(source)}>
                  {source.serverName}
                </MonoText>
                <span className="text-muted-foreground block truncate" title={source.archive.name}>
                  [{source.archive.label}] {source.archive.name}
                </span>
              </span>
            </label>
          )
        })}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search
            className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2"
            strokeWidth={1.5}
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Filter tail records"
            placeholder="Filter tail records"
            value={textFilter}
            onChange={(event) => setTextFilter(event.target.value)}
            className="h-8 rounded-[4px] pl-7 text-[13px]"
          />
        </div>
        <select
          aria-label="Tail severity"
          title="Filtered by WebLogic on server and domain logs; other archives are not filtered."
          value={severityFloor}
          onChange={(event) => setSeverityFloor(event.target.value as LogSeverityFloor)}
          className="border-input bg-background h-8 min-w-[160px] rounded-[4px] border px-2 text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {LOG_SEVERITY_FLOORS.map((floor) => (
            <option key={floor.value} value={floor.value}>
              {floor.label}
            </option>
          ))}
        </select>
      </div>

      <div className="border-border bg-background mb-3 flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1 border px-2 py-1.5 text-[12px]">
        <span className="text-muted-foreground">Status</span>
        <MonoText>{selectedSources.length === 0 ? 'idle' : paused ? 'paused' : query.isFetching ? 'polling' : 'watching'}</MonoText>
        <span className="text-muted-foreground">Sources</span>
        <MonoText>{selectedSources.length.toLocaleString()} / {MULTI_TAIL_MAX_SOURCES}</MonoText>
        <span className="text-muted-foreground">Updated</span>
        <RelativeTime value={query.dataUpdatedAt} />
      </div>

      <MultiTailFailureBanner failures={query.partialFailures} onRetry={query.retryFailed} />
      {copyFeedback ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate">{copyFeedback}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setCopyFeedback(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {query.isError ? (
        <div className="border-status-negative/60 bg-status-negative/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate font-mono">{query.error instanceof Error ? query.error.message : 'Unable to run global tail.'}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      {selectedSources.length === 0 ? (
        <div className="text-muted-foreground border-t border-border py-4 text-center text-[13px]">
          Select one or more sources to start multi-server polling.
        </div>
      ) : query.records.length === 0 ? (
        <div className="text-muted-foreground border-t border-border py-4 text-center text-[13px]">
          {query.isFetching ? 'Polling selected sources...' : 'No retained records from selected sources.'}
        </div>
      ) : visibleRecords.length === 0 ? (
        <div className="text-muted-foreground border-t border-border py-4 text-center text-[13px]">
          No retained records match "{textFilter.trim()}".
        </div>
      ) : (
        <div className="max-h-[440px] overflow-auto border-t border-border">
          <table className="w-full min-w-[1160px] border-collapse tabular-nums">
            <thead>
              <tr className="h-8 border-b border-border">
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Source</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">ID</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Time</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Signal</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Context</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Message</th>
              </tr>
            </thead>
            <tbody>
              {visibleRecords.map((record, index) => {
                const sourceNumber = sourceIndex[record.sourceId] ?? 0
                const isHttpAccessRecord = record.sourceArchiveKind === 'httpAccess' || isHttpAccessLogArchiveName(record.sourceArchiveName)
                const access = isHttpAccessRecord
                  ? parseHttpAccessLogRecord(record)
                  : null
                return (
                  <tr
                    key={`${record.sourceId}-${record.recordId ?? record.timestamp ?? index}`}
                    className={`h-9 border-b border-l-4 border-border align-top ${sourceAccentClasses[sourceNumber % sourceAccentClasses.length]}`}
                  >
                    <td className="max-w-[240px] px-2 py-2 text-[13px]">
                      <MonoText className="block truncate" title={`${record.sourceServerName} / ${record.sourceArchiveName}`}>
                        {record.sourceServerName}
                      </MonoText>
                      <span className="text-muted-foreground block truncate text-[12px]" title={record.sourceArchiveName}>
                        [{record.sourceArchiveLabel}] {record.sourceArchiveName}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-[13px]">{formatNumber(record.recordId)}</td>
                    <td className="max-w-[180px] px-2 py-2 text-[13px]">
                      <MonoText title={formatRecordTimestamp(record)}>{formatRecordTimestamp(record)}</MonoText>
                    </td>
                    <td className="px-2 py-2 text-[13px]">
                      {isHttpAccessRecord ? (
                        <StatusBadge kind="custom" tone={httpStatusTone(access?.status ?? null)} label={access?.status?.toString() ?? 'HTTP'} />
                      ) : (
                        <StatusBadge kind="custom" tone={logRecordSeverityTone(record.severity)} label={record.severity ?? 'UNKNOWN'} />
                      )}
                    </td>
                    <td className="max-w-[180px] px-2 py-2 text-[13px]">
                      {isHttpAccessRecord ? (
                        <>
                          <MonoText className="block truncate" title={access?.method ?? '-'}>
                            {access?.method ?? '-'}
                          </MonoText>
                          <span className="text-muted-foreground block truncate text-[12px]" title={access?.client ?? '-'}>
                            {access?.client ?? '-'}
                          </span>
                        </>
                      ) : (
                        <MonoText className="block truncate" title={record.subsystem ?? '-'}>
                          {record.subsystem ?? '-'}
                        </MonoText>
                      )}
                    </td>
                    <td className="min-w-[360px] px-2 py-2 text-[13px] leading-[18px]">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <MonoText className="whitespace-pre-wrap break-words" title={access?.path ?? record.message ?? '-'}>
                            {access?.path ?? record.message ?? '-'}
                          </MonoText>
                          {access ? (
                            <span
                              className="text-muted-foreground mt-1 block truncate text-[12px]"
                              title={[access.protocol, `bytes ${formatBytes(access.bytes)}`, access.userAgent].filter(Boolean).join(' · ')}
                            >
                              {[access.protocol, `bytes ${formatBytes(access.bytes)}`, access.userAgent].filter(Boolean).join(' · ')}
                            </span>
                          ) : null}
                        </div>
                        <Button type="button" variant="ghost" size="sm" onClick={() => copyRecordMessage(record)}>
                          <Clipboard className="size-3.5" strokeWidth={1.5} />
                          Copy
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function Logs() {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const query = useLogs()
  const returnState = useMemo(() => detailReturnState(location), [location])
  const failures = query.data?.partialFailures ?? []
  const allRows = useMemo(() => query.data?.rows ?? [], [query.data?.rows])
  const serverOptions = useMemo(() => {
    return [...new Set(allRows.map((row) => row.serverName))].sort(compareText)
  }, [allRows])
  const tableUrlConfig = useMemo<RuntimeTableUrlConfig>(
    () => ({
      defaultSort: DEFAULT_SORT,
      sortableColumns: ['severity', 'server', 'state', 'messages', 'stream', 'broadcaster', 'serverLog', 'archives', 'serverLogLatest'],
      filters: {
        severity: { param: 'severity', defaultValue: 'all', allowedValues: severityFilters },
        server: { param: 'server', defaultValue: 'all', allowedValues: ['all', ...serverOptions] },
      },
    }),
    [serverOptions],
  )
  const tableState = useMemo(
    () => parseRuntimeTableUrlState(searchParams, tableUrlConfig),
    [searchParams, tableUrlConfig],
  )
  const sort = tableState.sort
  const search = tableState.search
  const severity = tableState.filters.severity as SeverityFilter
  const server = tableState.filters.server as string
  const effectiveSort = sort ?? DEFAULT_SORT
  const hasActiveFilters = search.trim().length > 0 || severity !== 'all' || server !== 'all'
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
      .filter((row) => needle.length === 0 || searchText(row).includes(needle))
      .sort((a, b) => compareRows(a, b, effectiveSort))
  }, [allRows, effectiveSort, search, server, severity])

  const columns = useMemo<DataTableColumn<LogRuntimeRow>[]>(
    () => [
      {
        id: 'severity',
        header: 'STATUS',
        sortable: true,
        cell: (row) => <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.severity} />,
      },
      {
        id: 'server',
        header: 'SERVER',
        sortable: true,
        className: 'min-w-[200px]',
        cell: (row) => (
          <Link
            to={logDetailPath(row)}
            state={returnState}
            className="hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MonoText className="block truncate font-medium" title={row.serverName}>
              {row.serverName}
            </MonoText>
          </Link>
        ),
      },
      {
        id: 'state',
        header: 'STATE',
        sortable: true,
        cell: (row) => <StatusBadge kind="wls-state" value={row.state} />,
      },
      {
        id: 'messages',
        header: 'MESSAGES',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => formatNumber(row.messagesLogged),
      },
      {
        id: 'stream',
        header: 'STREAM',
        sortable: true,
        cell: (row) => {
          const model = streamModel(row.logFileStreamOpened)
          return <StatusBadge kind="custom" tone={model.tone} label={model.label} />
        },
      },
      {
        id: 'broadcaster',
        header: 'BROADCASTER',
        sortable: true,
        cell: (row) => (
          <StatusBadge
            kind="custom"
            tone={availabilityTone(row.broadcasterAvailable)}
            label={row.broadcasterAvailable ? 'AVAILABLE' : 'MISSING'}
          />
        ),
      },
      {
        id: 'serverLog',
        header: 'SERVER LOG',
        sortable: true,
        cell: (row) => (
          <StatusBadge
            kind="custom"
            tone={availabilityTone(row.serverLogAvailable)}
            label={row.serverLogAvailable ? 'AVAILABLE' : 'MISSING'}
          />
        ),
      },
      {
        id: 'archives',
        header: 'ARCHIVES',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <div className="text-right" title={archiveSummary(row)}>
            <MonoText className={row.archives.length === 0 ? 'text-status-neutral' : undefined}>
              {formatNumber(row.archives.length)}
            </MonoText>
            {row.archives.length > 0 ? (
              <div className="text-muted-foreground mt-1 flex justify-end gap-1 text-[11px]">
                {row.archives.slice(0, 2).map((archive) => (
                  <StatusBadge
                    key={archive.name}
                    kind="custom"
                    tone={archiveKindTone(archive.kind)}
                    label={archive.label}
                    className="max-w-[86px]"
                  />
                ))}
                {row.archives.length > 2 ? (
                  <MonoText className="text-muted-foreground">{`+${row.archives.length - 2}`}</MonoText>
                ) : null}
              </div>
            ) : null}
            {row.archives.length > 0 ? <span className="sr-only">{archiveKindSummary(row)}</span> : null}
          </div>
        ),
      },
      {
        id: 'serverLogLatest',
        header: 'SERVER LOG UPDATED',
        sortable: true,
        className: 'min-w-[132px]',
        cell: (row) => <RelativeTime value={row.serverLogLatestTimestamp} />,
      },
    ],
    [returnState],
  )

  return (
    <>
      <PageHeader
        title="Logs"
        subtitle="Server log runtime signals."
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

      <PartialBanner failures={failures} onRetry={() => void query.refetch()} />

      <MultiServerLogTail rows={allRows} loading={query.isFetching && !query.data} />

      <h2 className="mb-2 text-[14px] font-medium leading-5">Log runtimes</h2>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search
            className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2"
            strokeWidth={1.5}
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Filter log runtimes"
            placeholder="Filter log runtimes"
            value={search}
            onChange={(event) => updateTableState({ search: event.target.value })}
            className="h-8 rounded-[4px] pl-7 text-[13px]"
          />
        </div>
        <select
          aria-label="Filter log runtime health"
          value={severity}
          onChange={(event) => updateTableState({ filters: { severity: event.target.value } })}
          className="border-input bg-background h-8 min-w-[132px] rounded-[4px] border px-2 text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {severityFilters.map((option) => (
            <option key={option} value={option}>
              {option === 'all' ? 'All health states' : option}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter log server"
          value={server}
          onChange={(event) => updateTableState({ filters: { server: event.target.value } })}
          className="border-input bg-background h-8 min-w-[148px] rounded-[4px] border px-2 font-mono text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">All servers</option>
          {serverOptions.map((serverName) => (
            <option key={serverName} value={serverName}>
              {serverName}
            </option>
          ))}
        </select>
        {hasActiveFilters ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              updateTableState({
                search: '',
                filters: { severity: 'all', server: 'all' },
                sort,
              })
            }}
          >
            Reset
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
        error={
          query.isError
            ? {
                message: query.error instanceof Error ? query.error.message : 'Unable to load log runtime signals.',
                retry: () => void query.refetch(),
              }
            : null
        }
        empty={{
          message:
            hasActiveFilters && allRows.length > 0
              ? 'No log runtime rows match the current filters.'
              : 'No log runtime signals reported by running servers.',
        }}
      />
    </>
  )
}
