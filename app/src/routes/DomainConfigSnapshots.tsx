import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, Download, GitCompare, Loader2, Plus } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import {
  captureDomainConfigSnapshot,
  diffDomainConfigSnapshots,
  domainConfigSnapshotFilename,
  readStoredDomainConfigSnapshotsForScope,
  writeStoredDomainConfigSnapshot,
  type DomainConfigDiffResource,
  type DomainConfigSnapshot,
} from '@/api/queries/domain-config-snapshots'
import { useAuth } from '@/auth/useAuth'
import { DataTable, PageHeader, RelativeTime, StatusBadge } from '@/components'
import type { DataTableColumn } from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { MonoText } from '@/components/mono-text'

function downloadSnapshot(snapshot: DomainConfigSnapshot) {
  const blob = new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], { type: 'application/json' })
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = domainConfigSnapshotFilename(snapshot)
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000)
}

function familyCounts(snapshot: DomainConfigSnapshot) {
  return snapshot.manifest.sections
    .filter((section) => section.status === 'included')
    .map((section) => `${section.family} ${section.recordCount}`)
    .join(' · ')
}

function statusTone(snapshot: DomainConfigSnapshot) {
  return snapshot.manifest.sections.some((section) => section.status === 'failed') ? 'warning' : 'positive'
}

export function DomainConfigSnapshots() {
  const { creds } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [storageRevision, setStorageRevision] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  const [beforeId, setBeforeId] = useState('')
  const [afterId, setAfterId] = useState('')
  const snapshots = useMemo(
    () => {
      void storageRevision
      return creds ? readStoredDomainConfigSnapshotsForScope(creds) : []
    },
    [creds, storageRevision],
  )

  const before = snapshots.find((snapshot) => snapshot.manifest.id === beforeId) ?? snapshots[1] ?? null
  const after = snapshots.find((snapshot) => snapshot.manifest.id === afterId) ?? snapshots[0] ?? null
  const diff = before && after && before.manifest.id !== after.manifest.id ? diffDomainConfigSnapshots(before, after) : null

  const capture = useCallback(async () => {
    if (!creds) return
    setPending(true)
    setError(null)
    setStorageWarning(null)
    try {
      const snapshot = await captureDomainConfigSnapshot(creds)
      const result = writeStoredDomainConfigSnapshot(snapshot)
      setStorageRevision((current) => current + 1)
      setAfterId(snapshot.manifest.id)
      setBeforeId(result.snapshots.find((entry) => entry.manifest.id !== snapshot.manifest.id)?.manifest.id ?? '')
      if (result.storageLimited) {
        setStorageWarning(`Snapshot captured. Local storage was near its quota; retained ${result.retainedScopeLimit} snapshots for this scope.`)
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to capture domain configuration snapshot.')
    } finally {
      setPending(false)
    }
  }, [creds])

  useEffect(() => {
    if (searchParams.get('capture') !== '1' || pending || !creds) return
    const timeout = window.setTimeout(() => {
      setSearchParams({}, { replace: true })
      void capture()
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [capture, creds, pending, searchParams, setSearchParams])

  const snapshotColumns = useMemo<DataTableColumn<DomainConfigSnapshot>[]>(
    () => [
      {
        id: 'captured',
        header: 'CAPTURED',
        cell: (snapshot) => (
          <div className="min-w-0">
            <MonoText className="block truncate text-[13px]">{snapshot.manifest.capturedAt}</MonoText>
            <span className="text-muted-foreground text-[12px]">
              <RelativeTime value={Date.parse(snapshot.manifest.capturedAt)} />
            </span>
          </div>
        ),
      },
      {
        id: 'target',
        header: 'TARGET',
        cell: (snapshot) => <MonoText className="block truncate">{snapshot.manifest.target}</MonoText>,
      },
      {
        id: 'status',
        header: 'STATUS',
        cell: (snapshot) => (
          <StatusBadge kind="custom" tone={statusTone(snapshot)} label={statusTone(snapshot) === 'warning' ? 'PARTIAL' : 'OK'} />
        ),
      },
      {
        id: 'families',
        header: 'FAMILIES',
        className: 'min-w-[320px]',
        cell: (snapshot) => <span className="block truncate text-muted-foreground">{familyCounts(snapshot)}</span>,
      },
      {
        id: 'actions',
        header: 'ACTIONS',
        align: 'right',
        cell: (snapshot) => (
          <Button type="button" variant="ghost" size="xs" onClick={() => downloadSnapshot(snapshot)}>
            <Download className="size-3" strokeWidth={1.5} />
            JSON
          </Button>
        ),
      },
    ],
    [],
  )

  const diffColumns = useMemo<DataTableColumn<DomainConfigDiffResource>[]>(
    () => [
      { id: 'family', header: 'FAMILY', cell: (row) => <MonoText>{row.family}</MonoText> },
      { id: 'identity', header: 'IDENTITY', className: 'min-w-[260px]', cell: (row) => <MonoText className="block truncate">{row.identity}</MonoText> },
      {
        id: 'kind',
        header: 'KIND',
        cell: (row) => (
          <StatusBadge
            kind="custom"
            tone={row.kind === 'removed' ? 'negative' : row.kind === 'added' ? 'positive' : 'warning'}
            label={row.kind}
          />
        ),
      },
      {
        id: 'changes',
        header: 'CHANGES',
        className: 'min-w-[360px]',
        cell: (row) => (
          <span className="block truncate text-muted-foreground">
            {row.kind === 'changed'
              ? `${row.changes.slice(0, 4).map((change) => change.path).join(', ')}${row.changes.length > 4 ? ` +${row.changes.length - 4} more` : ''}`
              : row.kind}
          </span>
        ),
      },
    ],
    [],
  )

  return (
    <div>
      <PageHeader
        title="Config Snapshots"
        subtitle="Sanitized local WebLogic domain configuration snapshots and diffs."
        action={
          <Button type="button" size="sm" disabled={!creds || pending} onClick={capture}>
            {pending ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : <Plus className="size-3.5" strokeWidth={1.5} />}
            Capture
          </Button>
        }
      />

      {error ? (
        <div className="border-status-negative/60 bg-status-negative/8 mb-4 border px-3 py-2 text-[13px]">{error}</div>
      ) : null}
      {storageWarning ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-4 border px-3 py-2 text-[13px]">{storageWarning}</div>
      ) : null}

      <section className="mb-5 border border-border bg-background px-4 py-3">
        <div className="mb-3 flex items-center gap-2">
          <Archive className="size-4 text-accent" strokeWidth={1.5} />
          <h2 className="text-[15px] font-medium leading-5">Stored snapshots</h2>
        </div>
        <DataTable
          columns={snapshotColumns}
          rows={snapshots}
          getRowId={(snapshot) => snapshot.manifest.id}
          loading={pending}
          empty={{
            message: 'No local config snapshots captured.',
            hint: 'Capture a snapshot before maintenance or after activating an edit session.',
          }}
        />
      </section>

      <section className="border border-border bg-background px-4 py-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <GitCompare className="size-4 text-accent" strokeWidth={1.5} />
            <h2 className="text-[15px] font-medium leading-5">Diff</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <select
              value={before?.manifest.id ?? ''}
              onChange={(event) => setBeforeId(event.target.value)}
              className="border-border bg-surface-1 h-8 max-w-[260px] border px-2"
            >
              <option value="">Before</option>
              {snapshots.map((snapshot) => (
                <option key={snapshot.manifest.id} value={snapshot.manifest.id}>
                  {snapshot.manifest.capturedAt}
                </option>
              ))}
            </select>
            <select
              value={after?.manifest.id ?? ''}
              onChange={(event) => setAfterId(event.target.value)}
              className="border-border bg-surface-1 h-8 max-w-[260px] border px-2"
            >
              <option value="">After</option>
              {snapshots.map((snapshot) => (
                <option key={snapshot.manifest.id} value={snapshot.manifest.id}>
                  {snapshot.manifest.capturedAt}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DataTable
          columns={diffColumns}
          rows={diff?.resources ?? []}
          getRowId={(row) => `${row.family}:${row.identity}:${row.kind}`}
          loading={false}
          empty={
            snapshots.length < 2
              ? 'Capture at least two snapshots to diff configuration.'
              : 'No resource-level differences between selected snapshots.'
          }
        />
      </section>
    </div>
  )
}
