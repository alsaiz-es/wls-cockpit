import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, CheckCircle2, Loader2, ShieldCheck, XCircle } from 'lucide-react'
import { createDiagnosticSnapshotBundle, type DiagnosticSnapshotManifest } from '@/api/queries/diagnostic-snapshot'
import type { DashboardSnapshot } from '@/api/queries/domain-dashboard'
import { useAuth } from '@/auth/useAuth'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { selectableThreadDumpServers } from './diagnostic-snapshot-selection'
import { MonoText } from './mono-text'
import { StatusBadge } from './status-badge'

const INCLUDED_SECTIONS = [
  'Dashboard runtime summary',
  'Clusters and Node Manager',
  'JMS and JTA runtime summaries',
  'Data sources and deployments',
  'Bounded recent server logs',
] as const

function downloadBlob(filename: string, blob: Blob) {
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000)
}

function runningServerNames(snapshot: DashboardSnapshot | undefined) {
  return (snapshot?.servers ?? [])
    .filter((server) => server.state === 'RUNNING')
    .map((server) => server.name)
    .sort((a, b) => a.localeCompare(b))
}

function partialErrorCount(manifest: DiagnosticSnapshotManifest | null) {
  return manifest?.sections.filter((section) => section.status === 'failed').length ?? 0
}

export interface DiagnosticSnapshotRequest {
  id: string
  serverNames: string[]
}

export function DiagnosticSnapshotExport({
  snapshot,
  request,
  showTrigger = true,
}: {
  snapshot: DashboardSnapshot | undefined
  request?: DiagnosticSnapshotRequest | null
  showTrigger?: boolean
}) {
  const { creds } = useAuth()
  const [open, setOpen] = useState(false)
  const [includeThreadDumps, setIncludeThreadDumps] = useState(false)
  const [selectedServers, setSelectedServers] = useState<Set<string>>(() => new Set())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastManifest, setLastManifest] = useState<DiagnosticSnapshotManifest | null>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const servers = useMemo(() => runningServerNames(snapshot), [snapshot])
  const selectedThreadDumpServers = servers.filter((server) => selectedServers.has(server))
  const canIncludeThreadDumps = includeThreadDumps && selectedThreadDumpServers.length > 0

  useEffect(() => {
    if (!request) return
    const frame = window.requestAnimationFrame(() => {
      const selected = selectableThreadDumpServers(servers, request.serverNames)
      setSelectedServers(selected)
      setIncludeThreadDumps(selected.size > 0)
      setError(null)
      setLastManifest(null)
      setOpen(true)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [request, servers])

  useEffect(() => {
    if (!open) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) setOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    const frame = window.requestAnimationFrame(() => confirmRef.current?.focus())
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      window.cancelAnimationFrame(frame)
    }
  }, [open, pending])

  async function exportSnapshot() {
    if (!creds) return
    setPending(true)
    setError(null)
    setLastManifest(null)
    try {
      const bundle = await createDiagnosticSnapshotBundle(creds, {
        includeThreadDumps: canIncludeThreadDumps,
        threadDumpServers: selectedThreadDumpServers,
      })
      downloadBlob(bundle.filename, bundle.blob)
      setLastManifest(bundle.manifest)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to generate diagnostic snapshot.')
    } finally {
      setPending(false)
    }
  }

  function toggleServer(serverName: string, checked: boolean) {
    setSelectedServers((current) => {
      const next = new Set(current)
      if (checked) next.add(serverName)
      else next.delete(serverName)
      return next
    })
  }

  return (
    <>
      {showTrigger ? (
        <Button type="button" variant="ghost" size="sm" disabled={!creds} onClick={() => setOpen(true)}>
          <Archive className="size-4" strokeWidth={1.5} />
          Snapshot
        </Button>
      ) : null}

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="diagnostic-snapshot-title"
            className="border-border bg-surface-2 w-full max-w-[560px] border shadow-xl"
          >
            <div className="border-b border-border px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Archive className="text-accent size-4 shrink-0" strokeWidth={1.5} aria-hidden />
                  <h2 id="diagnostic-snapshot-title" className="truncate text-[16px] font-medium leading-[22px]">
                    Diagnostic snapshot
                  </h2>
                </div>
                {lastManifest ? (
                  <StatusBadge
                    kind="custom"
                    tone={partialErrorCount(lastManifest) > 0 ? 'warning' : 'positive'}
                    label={partialErrorCount(lastManifest) > 0 ? 'PARTIAL' : 'EXPORTED'}
                  />
                ) : null}
              </div>
            </div>

            <div className="max-h-[70vh] overflow-auto px-4 py-3 text-[13px] leading-[18px]">
              <p className="text-muted-foreground">
                Cockpit will collect runtime JSON and recent log windows into a local ZIP download. It redacts known
                secrets, path-like fields, payload-bearing fields, and does not upload the bundle.
              </p>

              <div className="mt-3 border border-border bg-background px-3 py-2">
                <div className="mb-2 flex items-center gap-2 text-[12px] font-medium uppercase leading-4 tracking-[0.04em]">
                  <ShieldCheck className="size-3.5 text-status-positive" strokeWidth={1.5} aria-hidden />
                  Included sections
                </div>
                <ul className="grid gap-1 text-muted-foreground sm:grid-cols-2">
                  {INCLUDED_SECTIONS.map((section) => (
                    <li key={section} className="flex min-w-0 items-center gap-2">
                      <CheckCircle2 className="size-3.5 shrink-0 text-status-positive" strokeWidth={1.5} aria-hidden />
                      <span className="truncate">{section}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-3 border border-border bg-background px-3 py-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={includeThreadDumps}
                    disabled={pending || servers.length === 0}
                    onChange={(event) => {
                      const checked = event.target.checked
                      setIncludeThreadDumps(checked)
                      if (checked) {
                        setSelectedServers((current) => (current.size > 0 ? current : new Set(servers)))
                      }
                    }}
                    className="border-input bg-background size-3.5 rounded-[3px] accent-[var(--accent)]"
                  />
                  <span className="font-medium">Include fresh thread dumps</span>
                  <span className="text-muted-foreground">optional</span>
                </label>
                <div className="mt-2 grid max-h-[120px] gap-1 overflow-auto">
                  {servers.length === 0 ? (
                    <span className="text-muted-foreground">No running servers are available for thread dump capture.</span>
                  ) : (
                    servers.map((server) => (
                      <label
                        key={server}
                        className={cn(
                          'flex min-w-0 items-center gap-2 text-muted-foreground',
                          !includeThreadDumps && 'opacity-60',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selectedServers.has(server)}
                          disabled={pending || !includeThreadDumps}
                          onChange={(event) => toggleServer(server, event.target.checked)}
                          className="border-input bg-background size-3.5 rounded-[3px] accent-[var(--accent)]"
                        />
                        <MonoText className="truncate text-[12px]" title={server}>
                          {server}
                        </MonoText>
                      </label>
                    ))
                  )}
                </div>
              </div>

              {error ? (
                <div className="border-status-negative/60 bg-status-negative/8 mt-3 flex gap-2 border px-3 py-2 text-status-negative">
                  <XCircle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
                  <span>{error}</span>
                </div>
              ) : null}

              {lastManifest ? (
                <div className="border-border bg-background mt-3 border px-3 py-2">
                  <div className="font-medium">Downloaded {lastManifest.sections.length} manifest sections.</div>
                  {partialErrorCount(lastManifest) > 0 ? (
                    <div className="mt-1 text-muted-foreground">
                      Partial errors:{' '}
                      {lastManifest.sections
                        .filter((section) => section.status === 'failed')
                        .map((section) => `${section.id}: ${section.error ?? 'failed'}`)
                        .join(' · ')}
                    </div>
                  ) : (
                    <div className="mt-1 text-muted-foreground">All selected sections were included.</div>
                  )}
                </div>
              ) : null}
            </div>

            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button ref={confirmRef} type="button" size="sm" disabled={!creds || pending} onClick={exportSnapshot}>
                {pending ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : <Archive className="size-3.5" strokeWidth={1.5} />}
                Export ZIP
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
