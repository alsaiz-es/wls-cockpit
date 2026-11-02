import { useMemo, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import {
  actionAuditFamilies,
  actionAuditJsonl,
  actionAuditStatuses,
  useActionAuditRecords,
  type ActionAuditFamily,
  type ActionAuditRecord,
  type ActionAuditStatus,
} from '@/api/queries/action-audit'
import { readRuntimeConfig } from '@/api/runtime-config'
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

type FamilyFilter = ActionAuditFamily | 'all'
type StatusFilter = ActionAuditStatus | 'all'
type TimeFilter = 'all' | '1h' | '24h' | '7d'

const DEFAULT_SORT: DataTableSort = { columnId: 'time', direction: 'desc' }
const timeFilters: TimeFilter[] = ['all', '1h', '24h', '7d']

function sinceFor(value: TimeFilter) {
  const now = Date.now()
  if (value === '1h') return now - 60 * 60 * 1000
  if (value === '24h') return now - 24 * 60 * 60 * 1000
  if (value === '7d') return now - 7 * 24 * 60 * 60 * 1000
  return undefined
}

function statusTone(status: ActionAuditStatus): StatusTone {
  return status === 'success' ? 'positive' : 'negative'
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function compareRows(a: ActionAuditRecord, b: ActionAuditRecord, sort: DataTableSort) {
  const direction = sort.direction === 'asc' ? 1 : -1
  switch (sort.columnId) {
    case 'time':
      return (Date.parse(a.startedAt) - Date.parse(b.startedAt)) * direction
    case 'family':
      return compareText(a.family, b.family) * direction || compareText(a.action, b.action)
    case 'resource':
      return compareText(a.resource.name, b.resource.name) * direction
    case 'target':
      return compareText(a.target, b.target) * direction
    case 'status':
      return compareText(a.status, b.status) * direction
    case 'duration':
      return (a.durationMs - b.durationMs) * direction
    default:
      return compareRows(a, b, DEFAULT_SORT)
  }
}

function downloadAudit(records: ActionAuditRecord[]) {
  const blob = new Blob([actionAuditJsonl(records)], { type: 'application/x-ndjson' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `wls-cockpit-action-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  anchor.click()
  URL.revokeObjectURL(url)
}

function FilterSelect<T extends string>({
  label,
  value,
  values,
  onChange,
}: {
  label: string
  value: T
  values: T[]
  onChange: (value: T) => void
}) {
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <select
        className="border-border bg-background h-8 border px-2 text-[13px]"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {values.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </label>
  )
}

export function ActionAudit() {
  const runtimeConfig = readRuntimeConfig()
  const [family, setFamily] = useState<FamilyFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [time, setTime] = useState<TimeFilter>('24h')
  const [target, setTarget] = useState('')
  const [sort, setSort] = useState<DataTableSort | null>(DEFAULT_SORT)
  const query = useActionAuditRecords({
    family,
    status,
    target,
    since: sinceFor(time),
    limit: 500,
  })
  const rows = useMemo(() => {
    const sorted = [...(query.data ?? [])]
    if (sort) sorted.sort((a, b) => compareRows(a, b, sort))
    return sorted
  }, [query.data, sort])

  const auditTimestamp = (value: string) => {
    const date = new Date(value)
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const columns: DataTableColumn<ActionAuditRecord>[] = [
    {
      id: 'time',
      header: 'Time',
      sortable: true,
      // Absolute time first: an audit is read to reconstruct what happened when.
      cell: (row) => (
        <span className="flex flex-col">
          <MonoText className="text-[12px]">{auditTimestamp(row.startedAt)}</MonoText>
          <span className="text-muted-foreground text-[11px]">
            <RelativeTime value={row.startedAt} />
          </span>
        </span>
      ),
    },
    {
      id: 'user',
      header: 'By',
      cell: (row) => (
        <span className="flex min-w-0 flex-col" title={[row.username, row.profileName].filter(Boolean).join(' @ ')}>
          <MonoText className="block truncate">{row.username ?? '-'}</MonoText>
          {row.profileName ? <span className="text-muted-foreground block truncate text-[11px]">{row.profileName}</span> : null}
        </span>
      ),
    },
    {
      id: 'family',
      header: 'Action',
      sortable: true,
      cell: (row) => (
        <span className="flex min-w-0 flex-col" title={`${row.method} ${row.path}`}>
          <span className="block truncate">
            {row.family} / {row.action}
          </span>
          <MonoText className="text-muted-foreground block truncate text-[11px]">
            {row.method} {row.path}
          </MonoText>
        </span>
      ),
    },
    {
      id: 'resource',
      header: 'Resource',
      sortable: true,
      cell: (row) => (
        <span className="block truncate" title={`${row.resource.parent ? `${row.resource.parent} / ` : ''}${row.resource.name}`}>
          {row.resource.parent ? <span className="text-muted-foreground">{row.resource.parent} / </span> : null}
          <MonoText>{row.resource.name}</MonoText>
        </span>
      ),
    },
    {
      id: 'target',
      header: 'Target',
      sortable: true,
      cell: (row) => <MonoText className="block truncate">{row.target}</MonoText>,
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      cell: (row) => <StatusBadge kind="custom" tone={statusTone(row.status)} label={row.httpStatus ? `${row.status} ${row.httpStatus}` : row.status} />,
    },
    {
      id: 'duration',
      header: 'Duration',
      sortable: true,
      align: 'right',
      cell: (row) => `${row.durationMs.toLocaleString()} ms`,
    },
    {
      id: 'error',
      header: 'Error',
      className: 'whitespace-normal',
      cell: (row) =>
        row.errorSummary ? (
          <details className="text-muted-foreground min-w-0">
            <summary className="cursor-pointer truncate">{row.errorSummary}</summary>
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px]">{row.errorSummary}</p>
          </details>
        ) : (
          <span className="text-muted-foreground">–</span>
        ),
    },
  ]

  if (!runtimeConfig.actionAuditAvailable) {
    return (
      <>
        <PageHeader title="Action Audit" subtitle="Local mutation traceability for self-hosted Cockpit runs." />
        <div className="border-border bg-surface-1 border px-4 py-8 text-center text-[13px] text-muted-foreground">
          Local action audit persistence is unavailable in this runtime mode.
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Action Audit"
        subtitle="Local sanitized records of explicit mutation actions."
        action={
          <>
            <Button type="button" variant="ghost" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}>
              <RefreshCw className="size-4" strokeWidth={1.5} />
              Refresh
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => downloadAudit(rows)} disabled={rows.length === 0}>
              <Download className="size-4" strokeWidth={1.5} />
              Export
            </Button>
          </>
        }
      />

      <section className="border-border bg-background mb-5 border px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect label="Family" value={family} values={actionAuditFamilies} onChange={setFamily} />
          <FilterSelect label="Status" value={status} values={actionAuditStatuses} onChange={setStatus} />
          <FilterSelect label="Time" value={time} values={timeFilters} onChange={setTime} />
          <Input
            className="h-8 w-[220px]"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="Target host:port"
          />
        </div>
      </section>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        sort={sort}
        onSortChange={setSort}
        loading={query.isFetching}
        error={query.error instanceof Error ? { message: query.error.message, retry: () => query.refetch() } : null}
        empty={{
          message: 'No local audit records found.',
          hint: 'Mutation actions appear here after they settle in self-host mode.',
        }}
      />
    </>
  )
}
