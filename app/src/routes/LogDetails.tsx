import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ChevronDown, ChevronRight, Clipboard, Loader2, Maximize2, Minimize2, Pause, Play, RefreshCw, Search, SkipForward } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  useLogDetailMetadata,
  useLogRecordTail,
  useLogRuntimeDetail,
  isHttpAccessLogArchiveName,
  logTailArchiveUrlValue,
  LOG_TAIL_ARCHIVE_SEARCH_PARAM,
  parseHttpAccessLogRecord,
  resolveLogTailArchiveSelection,
  selectDefaultLogTailArchive,
  type LogArchiveRuntime,
  type LogArchiveRuntimeCounters,
  type LogDataAccessRuntimeDetail,
  type LogRecordPreviewRow,
  type LogRuntimeRow,
  type LogSignalSeverity,
} from '@/api/queries/logs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MonoText, PageHeader, StatusBadge, type StatusTone } from '@/components'
import { cn } from '@/lib/utils'
import { detailReturnPath } from './detail-return-state'
import { buildTopLevelLogDetailFailures } from './log-detail-failures'
import { logRecordSeverityGroup, logRecordSeverityTone } from './log-record-severity'
import { routeParam } from './route-params'

function severityTone(severity: LogSignalSeverity): StatusTone {
  if (severity === 'critical') return 'negative'
  if (severity === 'warning') return 'warning'
  if (severity === 'healthy') return 'positive'
  return 'unknown'
}

function availabilityTone(available: boolean): StatusTone {
  return available ? 'positive' : 'warning'
}

function archiveKindTone(kind: LogArchiveRuntime['kind']): StatusTone {
  if (kind === 'server' || kind === 'domain') return 'positive'
  if (kind === 'diagnosticEvent') return 'warning'
  if (kind === 'custom' || kind === 'archive') return 'unknown'
  return 'neutral'
}

function formatNumber(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}

function streamModel(value: boolean | null): { tone: StatusTone; label: string } {
  if (value === true) return { tone: 'positive', label: 'OPEN' }
  if (value === false) return { tone: 'warning', label: 'CLOSED' }
  return { tone: 'unknown', label: 'UNKNOWN' }
}

function formatTimestamp(value: number | null) {
  if (value === null) return '-'
  return new Date(value).toLocaleString()
}

function formatDuration(value: number | null) {
  return value === null ? '-' : `${value.toLocaleString()} ms`
}

function formatAccessDuration(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}

function formatBytes(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}


function httpStatusTone(value: number | null): StatusTone {
  if (value === null) return 'unknown'
  if (value >= 500) return 'negative'
  if (value >= 400) return 'warning'
  if (value >= 300) return 'neutral'
  return 'positive'
}

type RecordSeverityFilter = 'all' | 'error' | 'warning' | 'info' | 'other'


function formatRecordTimestamp(record: LogRecordPreviewRow) {
  if (record.timestamp !== null) return formatTimestamp(record.timestamp)
  return record.date ?? '-'
}

function recordMatchesText(record: LogRecordPreviewRow, term: string) {
  const normalizedTerm = term.trim().toLowerCase()
  if (!normalizedTerm) return true
  const access = parseHttpAccessLogRecord(record)
  return [
    record.recordId?.toString() ?? '',
    record.date ?? '',
    record.severity ?? '',
    record.subsystem ?? '',
    record.machine ?? '',
    record.server ?? '',
    record.thread ?? '',
    record.userId ?? '',
    record.txId ?? '',
    record.contextId ?? '',
    record.messageId ?? '',
    record.message ?? '',
    record.supplementalAttributes ?? '',
    record.rid ?? '',
    access?.client ?? '',
    access?.user ?? '',
    access?.timestamp ?? '',
    access?.request ?? '',
    access?.method ?? '',
    access?.path ?? '',
    access?.protocol ?? '',
    access?.status?.toString() ?? '',
    access?.bytes?.toString() ?? '',
    access?.referer ?? '',
    access?.userAgent ?? '',
    access?.durationMs?.toString() ?? '',
  ].some((value) => value.toLowerCase().includes(normalizedTerm))
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

function CollapsibleSection({
  title,
  description,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string
  description?: string
  summary?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const Icon = open ? ChevronDown : ChevronRight
  return (
    <section className="border-border bg-surface-1 border">
      <button
        type="button"
        className="hover:bg-background/40 flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
          <span className="min-w-0">
            <span className="block text-[14px] font-medium leading-5">{title}</span>
            {description ? <span className="text-muted-foreground block truncate text-[12px] leading-4">{description}</span> : null}
          </span>
        </span>
        {summary ? <span className="shrink-0 text-right text-[13px] text-muted-foreground">{summary}</span> : null}
      </button>
      {open ? <div className="border-t border-border px-3 py-3">{children}</div> : null}
    </section>
  )
}

function LogRecordTailPanel({
  archives,
  selectedArchive,
  selectedArchiveName,
  records,
  nextRecordId,
  windowLabel,
  loading,
  fetching,
  paused,
  error,
  onRetry,
  onRefresh,
  onArchiveChange,
  onPauseChange,
}: {
  archives: LogArchiveRuntime[]
  selectedArchive: LogArchiveRuntime | null
  selectedArchiveName: string
  records: LogRecordPreviewRow[]
  nextRecordId: number | null
  windowLabel: string
  loading: boolean
  fetching: boolean
  paused: boolean
  error: string | null
  onRetry: () => void
  onRefresh: () => void
  onArchiveChange: (archiveName: string) => void
  onPauseChange: (paused: boolean) => void
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [atEnd, setAtEnd] = useState(true)
  const [textFilter, setTextFilter] = useState('')
  const [severityFilter, setSeverityFilter] = useState<RecordSeverityFilter>('all')
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const [maximized, setMaximized] = useState(false)
  const isHttpAccessArchive = selectedArchive?.kind === 'httpAccess' || isHttpAccessLogArchiveName(selectedArchiveName)
  const filteredRecords = useMemo(
    () =>
      records.filter((record) => {
        if (severityFilter !== 'all' && logRecordSeverityGroup(record.severity) !== severityFilter) return false
        return recordMatchesText(record, textFilter)
      }),
    [records, severityFilter, textFilter],
  )
  const jumpToEnd = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setAtEnd(true)
  }, [])
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight <= 24)
  }, [])
  const copyRecordMessage = useCallback((record: LogRecordPreviewRow) => {
    if (!record.message) return
    if (!navigator.clipboard?.writeText) {
      setCopyFeedback('Clipboard API unavailable.')
      return
    }
    navigator.clipboard.writeText(record.message).then(
      () => setCopyFeedback(`Copied log message ${record.recordId?.toLocaleString() ?? ''}`.trim()),
      (error: unknown) => setCopyFeedback(error instanceof Error ? `Copy failed: ${error.message}` : 'Copy failed.'),
    )
  }, [])

  useEffect(() => {
    if (!atEnd) return
    jumpToEnd()
  }, [atEnd, filteredRecords.length, jumpToEnd])

  useEffect(() => {
    if (!maximized) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMaximized(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [maximized])

  return (
    <section
      className={cn(
        'border-border px-3 py-3',
        maximized
          ? 'fixed inset-3 z-50 flex min-h-0 flex-col border bg-background shadow-2xl'
          : 'bg-surface-1 border',
      )}
    >
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-medium leading-5">Live Tail</h2>
          <p className="text-muted-foreground text-[13px] leading-[18px]">Read-only tail of the selected WLDF archive, starting at its newest records.</p>
        </div>
        <div className="flex items-center gap-2">
          {nextRecordId !== null ? (
            <MonoText className="text-muted-foreground text-[13px]">next {nextRecordId.toLocaleString()}</MonoText>
          ) : null}
          <MonoText className="text-muted-foreground text-[13px]">{records.length.toLocaleString()}</MonoText>
          <Button type="button" variant="ghost" size="sm" onClick={() => onPauseChange(!paused)}>
            {paused ? <Play className="size-3.5" strokeWidth={1.5} /> : <Pause className="size-3.5" strokeWidth={1.5} />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshCw className="size-3.5" strokeWidth={1.5} />
            Refresh
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={jumpToEnd}>
            <SkipForward className="size-3.5" strokeWidth={1.5} />
            End
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setMaximized((value) => !value)}>
            {maximized ? <Minimize2 className="size-3.5" strokeWidth={1.5} /> : <Maximize2 className="size-3.5" strokeWidth={1.5} />}
            {maximized ? 'Restore' : 'Maximize'}
          </Button>
        </div>
      </div>
      {selectedArchive ? (
        <div className="border-border bg-background mb-3 flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1 border px-2 py-1.5 text-[12px]">
          <span className="text-muted-foreground">Archive</span>
          <MonoText className="max-w-[360px] truncate text-[12px]" title={selectedArchive.name}>
            {selectedArchive.name}
          </MonoText>
          <StatusBadge
            kind="custom"
            tone={archiveKindTone(selectedArchive.kind)}
            label={selectedArchive.label}
          />
          <span className="text-muted-foreground min-w-[180px] flex-1 truncate" title={selectedArchive.description}>
            {selectedArchive.description}
          </span>
          <span className="text-muted-foreground">latest id</span>
          <MonoText className="text-[12px]">{formatNumber(selectedArchive.latestRecordId)}</MonoText>
          <span className="text-muted-foreground">earliest</span>
          <MonoText className="text-[12px]">{formatTimestamp(selectedArchive.earliestAvailableTimestamp)}</MonoText>
          <span className="text-muted-foreground">latest</span>
          <MonoText className="text-[12px]">{formatTimestamp(selectedArchive.latestAvailableTimestamp)}</MonoText>
          <StatusBadge
            kind="custom"
            tone={selectedArchive.timestampAvailable ? 'positive' : 'unknown'}
            label={selectedArchive.timestampAvailable ? 'TIME' : 'NO TIME'}
          />
        </div>
      ) : null}
      <div className="mb-3 grid shrink-0 gap-2 md:grid-cols-[minmax(180px,260px)_minmax(220px,1fr)_160px_220px]">
        <select
          value={selectedArchiveName}
          onChange={(event) => onArchiveChange(event.target.value)}
          aria-label="Live Tail archive"
          title={selectedArchiveName}
          className="border-input bg-background h-8 w-full px-2 font-mono text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {archives.map((archive) => (
            <option key={archive.name} value={archive.name}>
              [{archive.label}] {archive.name}
            </option>
          ))}
        </select>
        <label className="relative block">
          <Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" strokeWidth={1.5} />
          <Input
            value={textFilter}
            onChange={(event) => setTextFilter(event.target.value)}
            placeholder="Filter retained records"
            className="h-8 rounded-none pl-8 text-[13px]"
          />
        </label>
        <select
          value={severityFilter}
          onChange={(event) => setSeverityFilter(event.target.value as RecordSeverityFilter)}
          className="border-input bg-background h-8 w-full px-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <option value="all">All severities</option>
          <option value="error">Error</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
          <option value="other">Other</option>
        </select>
        <div className="border-border bg-background flex h-8 items-center justify-between gap-2 border px-2 text-[12px]">
          <span className="text-muted-foreground">{paused ? 'Paused' : fetching ? 'Polling' : 'Idle'}</span>
          <MonoText className="text-muted-foreground truncate" title={windowLabel}>
            {windowLabel}
          </MonoText>
        </div>
      </div>
      {error ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate font-mono">{error}</span>
          <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
      {copyFeedback ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate">{copyFeedback}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setCopyFeedback(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {loading ? <MetadataLoading /> : null}
      {!loading && !error && records.length === 0 ? (
        <div className="text-muted-foreground border-t border-border py-4 text-center text-[13px]">
          No records returned for the bounded tail window on {selectedArchiveName}.
        </div>
      ) : null}
      {!loading && !error && records.length > 0 && filteredRecords.length === 0 ? (
        <div className="text-muted-foreground border-t border-border py-4 text-center text-[13px]">
          No retained records match the current filters.
        </div>
      ) : null}
      {filteredRecords.length > 0 ? (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={cn('overflow-auto border-t border-border', maximized ? 'min-h-0 flex-1' : 'max-h-[520px]')}
        >
          {isHttpAccessArchive ? (
            <table className={cn('w-full border-collapse tabular-nums', maximized ? 'min-w-[1420px]' : 'min-w-[1220px]')}>
              <thead>
                <tr className="h-8 border-b border-border">
                  <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">ID</th>
                  <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Time</th>
                  <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Method</th>
                  <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Status</th>
                  <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Path</th>
                  <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Client</th>
                  <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Bytes</th>
                  <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Duration</th>
                  <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Agent / Raw</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecords.map((record, index) => {
                  const access = parseHttpAccessLogRecord(record)
                  return (
                    <tr key={`${record.recordId ?? 'record'}-${record.timestamp ?? index}`} className="h-9 border-b border-border align-top">
                      <td className="px-2 pt-2 text-right font-mono text-[13px]">{formatNumber(record.recordId)}</td>
                      <td className="max-w-[190px] px-2 pt-2 text-[13px]">
                        <MonoText title={formatRecordTimestamp(record)}>{formatRecordTimestamp(record)}</MonoText>
                      </td>
                      <td className="max-w-[90px] px-2 pt-2 text-[13px]">
                        <MonoText title={access?.method ?? '-'}>{access?.method ?? '-'}</MonoText>
                      </td>
                      <td className="px-2 pt-2 text-[13px]">
                        <StatusBadge kind="custom" tone={httpStatusTone(access?.status ?? null)} label={access?.status?.toString() ?? 'RAW'} />
                      </td>
                      <td className={cn('px-2 py-2 text-[13px] leading-[18px]', maximized ? 'min-w-[460px]' : 'min-w-[320px]')}>
                        <MonoText className="whitespace-pre-wrap break-words" title={access?.path ?? record.message ?? '-'}>
                          {access?.path ?? record.message ?? '-'}
                        </MonoText>
                        {access?.protocol || access?.referer ? (
                          <span className="text-muted-foreground mt-1 block truncate text-[12px]" title={[access.protocol, access.referer].filter(Boolean).join(' · ')}>
                            {[access.protocol, access.referer].filter(Boolean).join(' · ')}
                          </span>
                        ) : null}
                      </td>
                      <td className="max-w-[180px] truncate px-2 pt-2 text-[13px]">
                        <MonoText title={access?.client ?? '-'}>{access?.client ?? '-'}</MonoText>
                      </td>
                      <td className="px-2 pt-2 text-right font-mono text-[13px]">{formatBytes(access?.bytes ?? null)}</td>
                      <td className="px-2 pt-2 text-right font-mono text-[13px]">{formatAccessDuration(access?.durationMs ?? null)}</td>
                      <td className={cn('px-2 py-2 text-[13px] leading-[18px]', maximized ? 'min-w-[420px]' : 'min-w-[300px]')}>
                        <div className="flex items-start justify-between gap-2">
                          <MonoText className="whitespace-pre-wrap break-words" title={access?.userAgent ?? record.message ?? '-'}>
                            {access?.userAgent ?? access?.raw ?? record.message ?? '-'}
                          </MonoText>
                          {record.message ? (
                            <Button type="button" variant="ghost" size="sm" onClick={() => copyRecordMessage(record)}>
                              <Clipboard className="size-3.5" strokeWidth={1.5} />
                              Copy
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <table className={cn('w-full border-collapse tabular-nums', maximized ? 'min-w-[1360px]' : 'min-w-[1180px]')}>
              <thead>
                <tr className="h-8 border-b border-border">
                  <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">ID</th>
                  <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Time</th>
                  <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Severity</th>
                  <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Subsystem</th>
                  <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Message ID</th>
                  <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Thread</th>
                  <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">User</th>
                  <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Message</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecords.map((record, index) => (
                  <tr key={`${record.recordId ?? 'record'}-${record.timestamp ?? index}`} className="h-9 border-b border-border align-top">
                    <td className="px-2 pt-2 text-right font-mono text-[13px]">{formatNumber(record.recordId)}</td>
                    <td className="max-w-[190px] px-2 pt-2 text-[13px]">
                      <MonoText title={formatRecordTimestamp(record)}>{formatRecordTimestamp(record)}</MonoText>
                    </td>
                    <td className="px-2 pt-2 text-[13px]">
                      <StatusBadge kind="custom" tone={logRecordSeverityTone(record.severity)} label={record.severity ?? 'UNKNOWN'} />
                    </td>
                    <td className="max-w-[150px] truncate px-2 pt-2 text-[13px]">
                      <MonoText title={record.subsystem ?? '-'}>{record.subsystem ?? '-'}</MonoText>
                    </td>
                    <td className="max-w-[130px] truncate px-2 pt-2 text-[13px]">
                      <MonoText title={record.messageId ?? '-'}>{record.messageId ?? '-'}</MonoText>
                    </td>
                    <td className="max-w-[260px] truncate px-2 pt-2 text-[13px]">
                      <MonoText title={record.thread ?? '-'}>{record.thread ?? '-'}</MonoText>
                    </td>
                    <td className="max-w-[140px] truncate px-2 pt-2 text-[13px]">
                      <MonoText title={record.userId ?? '-'}>{record.userId ?? '-'}</MonoText>
                    </td>
                    <td className={cn('px-2 py-2 text-[13px] leading-[18px]', maximized ? 'min-w-[560px]' : 'min-w-[320px]')}>
                      <div className="flex items-start justify-between gap-2">
                        <MonoText className="whitespace-pre-wrap break-words" title={record.message ?? '-'}>
                          {record.message ?? '-'}
                        </MonoText>
                        {record.message ? (
                          <Button type="button" variant="ghost" size="sm" onClick={() => copyRecordMessage(record)}>
                            <Clipboard className="size-3.5" strokeWidth={1.5} />
                            Copy
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </section>
  )
}

function PartialBanner({
  failures,
  onRetry,
}: {
  failures: Array<{ serverName: string; signal: string; message: string }>
  onRetry: () => void
}) {
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

function ArchiveList({ row }: { row: LogRuntimeRow }) {
  return (
    <CollapsibleSection
      title="Archives"
      description="WLDF data access runtimes reported by this server."
      summary={<MonoText className="text-muted-foreground text-[13px]">{row.archives.length.toLocaleString()}</MonoText>}
    >
      {row.archives.length === 0 ? (
        <div className="text-muted-foreground py-3 text-center text-[13px]">
          No archive runtimes reported.
        </div>
      ) : (
        <div className="overflow-auto">
          <table className="w-full min-w-[860px] border-collapse tabular-nums">
            <thead>
              <tr className="h-8 border-b border-border">
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Name</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Kind</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Latest ID</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Earliest</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Latest</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {row.archives.map((archive) => (
                <tr key={archive.name} className="h-9 border-b border-border">
                  <td className="max-w-[260px] truncate px-2 text-[13px]">
                    <MonoText title={archive.name}>{archive.name}</MonoText>
                  </td>
                  <td className="max-w-[220px] px-2 text-[13px]">
                    <div className="flex min-w-0 items-center gap-2">
                      <StatusBadge kind="custom" tone={archiveKindTone(archive.kind)} label={archive.label} />
                      <span className="text-muted-foreground min-w-0 truncate text-[12px]" title={archive.description}>
                        {archive.description}
                      </span>
                    </div>
                  </td>
                  <td className="px-2 text-right font-mono text-[13px]">{formatNumber(archive.latestRecordId)}</td>
                  <td className="px-2 text-[13px]">
                    <MonoText>{formatTimestamp(archive.earliestAvailableTimestamp)}</MonoText>
                  </td>
                  <td className="px-2 text-[13px]">
                    <MonoText>{formatTimestamp(archive.latestAvailableTimestamp)}</MonoText>
                  </td>
                  <td className="px-2 text-[13px]">
                    <StatusBadge
                      kind="custom"
                      tone={archive.timestampAvailable ? 'positive' : 'unknown'}
                      label={archive.timestampAvailable ? 'AVAILABLE' : 'UNKNOWN'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CollapsibleSection>
  )
}

function LogSignalLoadingSummary() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Status" value="-" />
        <Metric label="State" value="-" />
        <Metric label="Messages" value="-" />
        <Metric label="Server Log Updated" value="-" />
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Stream" value="-" />
        <Metric label="Broadcaster" value="-" />
        <Metric label="Server Log" value="-" />
        <Metric label="Archives" value="-" />
      </div>
    </div>
  )
}

function MetadataLoading() {
  return (
    <div className="text-muted-foreground flex h-14 items-center justify-center gap-2 border-t border-border text-[13px]">
      <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
      Loading metadata...
    </div>
  )
}

function DataAccessDetailList({
  data,
  loading,
}: {
  data: LogDataAccessRuntimeDetail[]
  loading: boolean
}) {
  return (
    <CollapsibleSection
      title="Data Access Metadata"
      description="Detail-only WLDF data-access runtime metadata."
      summary={<MonoText className="text-muted-foreground text-[13px]">{loading ? 'loading' : data.length.toLocaleString()}</MonoText>}
    >
      {loading ? <MetadataLoading /> : null}
      {!loading && data.length === 0 ? (
        <div className="text-muted-foreground py-3 text-center text-[13px]">
          No data-access metadata reported.
        </div>
      ) : null}
      {data.length > 0 ? (
        <div className="overflow-auto">
          <table className="w-full min-w-[1060px] border-collapse tabular-nums">
            <thead>
              <tr className="h-8 border-b border-border">
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Name</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Kind</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Type</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Latest ID</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Earliest</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Latest</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Timestamp</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Columns</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Types</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Params</th>
              </tr>
            </thead>
            <tbody>
              {data.map((runtime) => (
                <tr key={runtime.name} className="h-9 border-b border-border">
                  <td className="max-w-[220px] truncate px-2 text-[13px]">
                    <MonoText title={runtime.name}>{runtime.name}</MonoText>
                  </td>
                  <td className="max-w-[160px] px-2 text-[13px]">
                    <StatusBadge kind="custom" tone={archiveKindTone(runtime.kind)} label={runtime.label} />
                  </td>
                  <td className="max-w-[220px] truncate px-2 text-[13px]">
                    <MonoText title={runtime.type ?? '-'}>{runtime.type ?? '-'}</MonoText>
                  </td>
                  <td className="px-2 text-right font-mono text-[13px]">{formatNumber(runtime.latestRecordId)}</td>
                  <td className="px-2 text-[13px]">
                    <MonoText>{formatTimestamp(runtime.earliestAvailableTimestamp)}</MonoText>
                  </td>
                  <td className="px-2 text-[13px]">
                    <MonoText>{formatTimestamp(runtime.latestAvailableTimestamp)}</MonoText>
                  </td>
                  <td className="px-2 text-[13px]">
                    <StatusBadge
                      kind="custom"
                      tone={runtime.timestampAvailable ? 'positive' : 'unknown'}
                      label={runtime.timestampAvailable ? 'AVAILABLE' : 'UNKNOWN'}
                    />
                  </td>
                  <td className="px-2 text-right font-mono text-[13px]">{formatNumber(runtime.columnCount)}</td>
                  <td className="px-2 text-right font-mono text-[13px]">{formatNumber(runtime.columnTypeCount)}</td>
                  <td className="px-2 text-right font-mono text-[13px]">{formatNumber(runtime.dataArchiveParameterCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </CollapsibleSection>
  )
}

function ArchiveRuntimeList({
  data,
  loading,
}: {
  data: LogArchiveRuntimeCounters[]
  loading: boolean
}) {
  return (
    <CollapsibleSection
      title="Archive Runtime Counters"
      description="WLDF archive runtime counters for the selected server."
      summary={<MonoText className="text-muted-foreground text-[13px]">{loading ? 'loading' : data.length.toLocaleString()}</MonoText>}
    >
      {loading ? <MetadataLoading /> : null}
      {!loading && data.length === 0 ? (
        <div className="text-muted-foreground py-3 text-center text-[13px]">
          No archive runtime counters reported.
        </div>
      ) : null}
      {data.length > 0 ? (
        <div className="overflow-auto">
          <table className="w-full min-w-[1080px] border-collapse tabular-nums">
            <thead>
              <tr className="h-8 border-b border-border">
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Name</th>
                <th className="text-muted-foreground px-2 text-left text-[11px] font-medium uppercase tracking-[0.04em]">Type</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Records</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Retrieved</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Seeks</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Seek Time</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Retrieval</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Inserted</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Deleted</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Index</th>
                <th className="text-muted-foreground px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Retired</th>
              </tr>
            </thead>
            <tbody>
              {data.map((runtime) => (
                <tr key={runtime.name} className="h-9 border-b border-border">
                  <td className="max-w-[240px] truncate px-2 text-[13px]">
                    <MonoText title={runtime.name}>{runtime.name}</MonoText>
                  </td>
                  <td className="max-w-[210px] truncate px-2 text-[13px]">
                    <MonoText title={runtime.type ?? '-'}>{runtime.type ?? '-'}</MonoText>
                  </td>
                  <td className="px-2 text-right font-mono text-[13px]">{formatNumber(runtime.recordCount)}</td>
                  <td className="px-2 text-right font-mono text-[13px]">{formatNumber(runtime.retrievedRecordCount)}</td>
                  <td className="px-2 text-right font-mono text-[13px]">{formatNumber(runtime.recordSeekCount)}</td>
                  <td className="px-2 text-right font-mono text-[13px]">{formatDuration(runtime.recordSeekTime)}</td>
                  <td className="px-2 text-right font-mono text-[13px]">{formatDuration(runtime.recordRetrievalTime)}</td>
                  <td className="px-2 text-right font-mono text-[13px]">{formatNumber(runtime.insertionCount)}</td>
                  <td className="px-2 text-right font-mono text-[13px]">{formatNumber(runtime.deletionCount)}</td>
                  <td className="px-2 text-right font-mono text-[13px]">
                    {runtime.indexPageCount !== null
                      ? formatNumber(runtime.indexPageCount)
                      : runtime.indexCycleCount !== null
                        ? formatNumber(runtime.indexCycleCount)
                        : formatNumber(runtime.rotatedFilesCount)}
                  </td>
                  <td className="px-2 text-right font-mono text-[13px]">{formatNumber(runtime.retiredRecordCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </CollapsibleSection>
  )
}

export function LogDetails() {
  const location = useLocation()
  const params = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const serverName = routeParam(params.serverName)
  const [tailPaused, setTailPaused] = useState(false)
  const selectedTailArchiveName = searchParams.get(LOG_TAIL_ARCHIVE_SEARCH_PARAM)
  const query = useLogRuntimeDetail(serverName)
  const returnPath = useMemo(() => detailReturnPath(location.state, '/logs'), [location.state])
  const row = query.data?.row ?? null
  const detailQuery = useLogDetailMetadata(serverName, { enabled: serverName.length > 0 && (query.isFetching || !!row) })
  const defaultTailArchive = useMemo(
    () => selectDefaultLogTailArchive(row?.archives ?? []),
    [row?.archives],
  )
  const selectedTailArchive = useMemo(
    () => resolveLogTailArchiveSelection(row?.archives ?? [], selectedTailArchiveName),
    [row?.archives, selectedTailArchiveName],
  )
  const handleTailArchiveChange = useCallback((archiveName: string) => {
    const selectedArchive = row?.archives.find((archive) => archive.name === archiveName) ?? null
    const urlValue = logTailArchiveUrlValue(selectedArchive, defaultTailArchive)
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      if (urlValue) {
        next.set(LOG_TAIL_ARCHIVE_SEARCH_PARAM, urlValue)
      } else {
        next.delete(LOG_TAIL_ARCHIVE_SEARCH_PARAM)
      }
      return next
    }, { replace: true })
    setTailPaused(false)
  }, [defaultTailArchive, row?.archives, setSearchParams])
  const recordQuery = useLogRecordTail(serverName, selectedTailArchive, {
    enabled: serverName.length > 0 && !!row && !!selectedTailArchive,
    paused: tailPaused,
  })
  const failures = useMemo(() => {
    const runtimeFailures = query.data?.partialFailures ?? []
    const detailFailures = detailQuery.data?.partialFailures ?? []
    return buildTopLevelLogDetailFailures({
      runtimeFailures,
      metadataFailures: detailFailures,
      metadataError: detailQuery.isError ? detailQuery.error : null,
      serverName,
    })
  }, [
    detailQuery.data?.partialFailures,
    detailQuery.error,
    detailQuery.isError,
    query.data?.partialFailures,
    serverName,
  ])
  const stream = row ? streamModel(row.logFileStreamOpened) : null
  const refetchAll = useCallback(() => {
    void query.refetch()
    void detailQuery.refetch()
    if (selectedTailArchive) void recordQuery.retry()
  }, [detailQuery, query, recordQuery, selectedTailArchive])
  const updatedAt = Math.max(query.dataUpdatedAt, detailQuery.dataUpdatedAt, recordQuery.dataUpdatedAt)
  const metadata = detailQuery.data
  const recordError =
    recordQuery.isError && recordQuery.error instanceof Error
      ? recordQuery.error.message
      : recordQuery.isError
        ? 'Unable to load log records.'
        : null
  const recordWindow = recordQuery.data?.window
  const recordWindowLabel =
    recordWindow?.since && recordWindow.until
      ? `${new Date(recordWindow.since).toLocaleTimeString()} - ${new Date(recordWindow.until).toLocaleTimeString()}`
      : 'following newest records'

  return (
    <>
      <PageHeader
        title={serverName || 'Log Runtime'}
        subtitle="Single server log runtime snapshot."
        meta={
          <>
            <Button type="button" variant="ghost" size="sm" className="-ml-2" asChild>
              <Link to={returnPath}>
                <ArrowLeft className="size-3.5" strokeWidth={1.5} />
                Logs
              </Link>
            </Button>
          </>
        }
        updatedAt={updatedAt}
        refreshing={query.isFetching || detailQuery.isFetching}
        onRefresh={refetchAll}
      />

      <PartialBanner failures={failures} onRetry={refetchAll} />

      {query.isFetching && !query.data ? <LogSignalLoadingSummary /> : null}

      {query.isError ? (
        <div className="border-status-negative/60 bg-status-negative/8 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate font-mono">
            {query.error instanceof Error ? query.error.message : 'Unable to load log runtime signals.'}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={refetchAll}>
            Retry
          </Button>
        </div>
      ) : null}

      {!query.isFetching && !query.isError && !row ? (
        <div className="border-border bg-surface-1 flex min-h-28 items-center justify-between gap-3 border px-3 py-3 text-[13px]">
          <div className="min-w-0">
            <div className="font-medium">Log runtime not found</div>
            <MonoText className="text-muted-foreground mt-1 block truncate">{serverName || '-'}</MonoText>
          </div>
          <Button type="button" variant="outline" size="sm" asChild>
            <Link to={returnPath}>Back to logs</Link>
          </Button>
        </div>
      ) : null}

      {serverName && (row || query.isFetching) ? (
        <div className="mt-4 space-y-4">
          {selectedTailArchive || recordQuery.isFetching || recordQuery.data || recordError ? (
            <LogRecordTailPanel
              archives={row?.archives ?? []}
              selectedArchive={selectedTailArchive}
              selectedArchiveName={selectedTailArchive?.name ?? ''}
              records={recordQuery.records}
              nextRecordId={recordQuery.data?.nextRecordId ?? null}
              windowLabel={recordWindowLabel}
              loading={recordQuery.isFetching && recordQuery.records.length === 0}
              fetching={recordQuery.isFetching}
              paused={tailPaused}
              error={recordError}
              onRetry={() => void recordQuery.retry()}
              onRefresh={() => void recordQuery.retry()}
              onArchiveChange={handleTailArchiveChange}
              onPauseChange={setTailPaused}
            />
          ) : null}
          {row && stream ? (
            <>
              <CollapsibleSection
                title="Runtime Signals"
                description="Server log runtime signal summary."
                summary={
                  <span className="flex items-center gap-2">
                    <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.severity} />
                    <MonoText className="text-muted-foreground text-[13px]">{formatNumber(row.messagesLogged)}</MonoText>
                  </span>
                }
              >
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
                    <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Status</div>
                    <div className="mt-2">
                      <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.severity} />
                    </div>
                  </div>
                  <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
                    <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">State</div>
                    <div className="mt-2">
                      <StatusBadge kind="wls-state" value={row.state} />
                    </div>
                  </div>
                  <Metric label="Messages" value={formatNumber(row.messagesLogged)} />
                  <Metric label="Server Log Updated" value={formatTimestamp(row.serverLogLatestTimestamp)} />
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-4">
                  <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
                    <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Stream</div>
                    <div className="mt-2">
                      <StatusBadge kind="custom" tone={stream.tone} label={stream.label} />
                    </div>
                  </div>
                  <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
                    <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Broadcaster</div>
                    <div className="mt-2">
                      <StatusBadge
                        kind="custom"
                        tone={availabilityTone(row.broadcasterAvailable)}
                        label={row.broadcasterAvailable ? 'AVAILABLE' : 'MISSING'}
                      />
                    </div>
                  </div>
                  <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
                    <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Server Log</div>
                    <div className="mt-2">
                      <StatusBadge
                        kind="custom"
                        tone={availabilityTone(row.serverLogAvailable)}
                        label={row.serverLogAvailable ? 'AVAILABLE' : 'MISSING'}
                      />
                    </div>
                  </div>
                  <Metric label="Archives" value={row.archives.length.toLocaleString()} />
                </div>
              </CollapsibleSection>
              <ArchiveList row={row} />
            </>
          ) : null}
          <DataAccessDetailList
            data={metadata?.dataAccessRuntimes ?? []}
            loading={detailQuery.isFetching && !metadata}
          />
          <ArchiveRuntimeList
            data={metadata?.archiveRuntimes ?? []}
            loading={detailQuery.isFetching && !metadata}
          />
        </div>
      ) : null}
    </>
  )
}
