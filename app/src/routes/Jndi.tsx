import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Folder, Network, Search } from 'lucide-react'
import {
  displayJndiPath,
  useJndiSnapshot,
  visibleJndiTreeNodes,
  type JndiTreeNode,
} from '@/api/queries/jndi'
import { useServerRuntimes } from '@/api/queries/server-runtimes'
import { readOnlyDemoModeEnabled } from '@/api/runtime-config'
import { useAuth } from '@/auth/useAuth'
import {
  MonoText,
  PageHeader,
  StatusBadge,
  lifecycleTone,
} from '@/components'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FILTER_SELECT_CLASS } from '@/components/filter-option-label'
import { cn } from '@/lib/utils'
import { demoSensitiveValue } from './demo-readonly-values'

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function safeClassLabel(value: string | null) {
  return value ?? '-'
}

function nodeDisplayPath(node: JndiTreeNode) {
  return displayJndiPath(node.path)
}

function EmptyValue() {
  return <MonoText className="text-status-neutral">–</MonoText>
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

function MetadataRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 border-t border-border py-2 first:border-t-0">
      <span className="text-muted-foreground text-[12px] uppercase leading-[16px] tracking-[0.04em]">{label}</span>
      <div className="min-w-0 text-[13px] leading-[18px]">{children}</div>
    </div>
  )
}

function DetailPanel({ node }: { node: JndiTreeNode | null }) {
  return (
    <aside className="border-border bg-surface-1 min-h-[320px] border">
      <div className="border-b border-border px-3 py-2">
        <div className="text-[14px] font-medium leading-[20px]">Binding Metadata</div>
        <div className="text-muted-foreground text-[12px] leading-[16px]">Safe JNDI fields only.</div>
      </div>
      <div className="px-3 py-2">
        {!node ? (
          <div className="text-muted-foreground py-8 text-center text-[13px]">Select a binding or context.</div>
        ) : (
          <>
            <MetadataRow label="Server"><MonoText>{node.serverName}</MonoText></MetadataRow>
            <MetadataRow label="Path"><MonoText className="break-all">{nodeDisplayPath(node)}</MonoText></MetadataRow>
            <MetadataRow label="Kind"><StatusBadge kind="custom" tone={node.kind === 'context' ? 'neutral' : 'positive'} label={node.kind} /></MetadataRow>
            <MetadataRow label="Context">{node.binding?.context ? <MonoText className="break-all">{node.binding.context}</MonoText> : <EmptyValue />}</MetadataRow>
            <MetadataRow label="Name"><MonoText className="break-all">{node.name}</MonoText></MetadataRow>
            <MetadataRow label="Class">{node.className ? <MonoText className="break-all">{safeClassLabel(node.className)}</MonoText> : <EmptyValue />}</MetadataRow>
            <MetadataRow label="Children"><MonoText>{node.childCount.toLocaleString()}</MonoText></MetadataRow>
            <MetadataRow label="Error">
              {node.error ? (
                <MonoText className="break-all text-status-warning">{demoSensitiveValue(node.error, readOnlyDemoModeEnabled())}</MonoText>
              ) : (
                <EmptyValue />
              )}
            </MetadataRow>
          </>
        )}
      </div>
    </aside>
  )
}

function TreeNodeRow({
  node,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  node: JndiTreeNode
  expanded: boolean
  selected: boolean
  onToggle: (node: JndiTreeNode) => void
  onSelect: (node: JndiTreeNode) => void
}) {
  const canExpand = node.kind === 'context' && node.childCount > 0
  const ToggleIcon = expanded ? ChevronDown : ChevronRight
  return (
    <div
      role="treeitem"
      aria-expanded={canExpand ? expanded : undefined}
      aria-selected={selected}
      className={cn(
        'grid min-h-9 grid-cols-[minmax(260px,1.6fr)_minmax(220px,1fr)_110px] items-center border-t border-border text-[13px] leading-[18px] hover:bg-surface-1',
        selected && 'bg-accent/8',
      )}
    >
      <div
        className="flex min-w-0 items-center gap-2 px-3 py-2"
        style={{ paddingLeft: `${12 + node.depth * 18}px` }}
      >
        {canExpand ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${node.path}` : `Expand ${node.path}`}
            className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onToggle(node)}
          >
            <ToggleIcon className="size-3.5" strokeWidth={1.5} />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        {node.kind === 'context' ? (
          <Folder className="text-muted-foreground size-3.5 shrink-0" strokeWidth={1.5} />
        ) : (
          <Network className="text-muted-foreground size-3.5 shrink-0" strokeWidth={1.5} />
        )}
        <button
          type="button"
          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onSelect(node)}
        >
          <MonoText className="block min-w-0 truncate" title={nodeDisplayPath(node)}>{node.name}</MonoText>
        </button>
      </div>
      <MonoText className="min-w-0 truncate px-3 text-muted-foreground" title={node.className ?? undefined}>
        {node.className ?? '-'}
      </MonoText>
      <div className="px-3">
        <StatusBadge
          kind="custom"
          tone={node.error ? 'warning' : node.kind === 'context' ? 'neutral' : 'positive'}
          label={node.error ? 'warning' : node.kind}
        />
      </div>
    </div>
  )
}

export function Jndi() {
  const { creds } = useAuth()
  const serversQuery = useServerRuntimes()
  const serverOptions = useMemo(
    () => (serversQuery.data ?? []).slice().sort((a, b) => compareText(a.name, b.name)),
    [serversQuery.data],
  )
  const runningServerOptions = useMemo(
    () => serverOptions.filter((server) => server.state === 'RUNNING'),
    [serverOptions],
  )
  const [requestedServer, setRequestedServer] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const selectableServerOptions = runningServerOptions
  const selectedServer = useMemo(() => {
    if (requestedServer && selectableServerOptions.some((server) => server.name === requestedServer)) return requestedServer
    return selectableServerOptions[0]?.name ?? null
  }, [requestedServer, selectableServerOptions])
  const jndiQuery = useJndiSnapshot(selectedServer)
  const snapshot = jndiQuery.data
  const failures = snapshot?.partialFailures ?? []

  const selectServer = useCallback((serverName: string | null) => {
    setRequestedServer(serverName)
    setExpandedPaths(new Set())
    setSelectedNodeId(null)
    setSearch('')
  }, [])

  const visibleNodes = useMemo(() => {
    const nodes = snapshot?.tree ?? []
    return visibleJndiTreeNodes(nodes, expandedPaths, search)
  }, [expandedPaths, search, snapshot?.tree])

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null
    return snapshot?.tree.find((node) => node.id === selectedNodeId) ?? null
  }, [selectedNodeId, snapshot?.tree])

  const toggleNode = useCallback((node: JndiTreeNode) => {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(node.path)) next.delete(node.path)
      else next.add(node.path)
      return next
    })
  }, [])

  const expandAllLoaded = useCallback(() => {
    setExpandedPaths(new Set((snapshot?.tree ?? []).filter((node) => node.kind === 'context').map((node) => node.path)))
  }, [snapshot?.tree])

  const collapseAll = useCallback(() => {
    setExpandedPaths(new Set())
  }, [])

  return (
    <>
      <PageHeader
        title="JNDI"
        subtitle="Read-only server-scoped JNDI bindings and class metadata."
        updatedAt={Math.max(serversQuery.dataUpdatedAt, jndiQuery.dataUpdatedAt)}
        refreshing={serversQuery.isFetching || jndiQuery.isFetching}
        onRefresh={() => void Promise.all([serversQuery.refetch(), jndiQuery.refetch()])}
      />

      <PartialBanner failures={failures} onRetry={() => void jndiQuery.refetch()} />

      {jndiQuery.isError && visibleNodes.length > 0 ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate">
            Refresh failed: {jndiQuery.error instanceof Error ? jndiQuery.error.message : 'Unable to refresh JNDI bindings.'}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void jndiQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          aria-label="Select WebLogic server"
          className={`${FILTER_SELECT_CLASS} min-w-[180px]`}
          value={selectedServer ?? ''}
          onChange={(event) => selectServer(event.target.value || null)}
        >
          {selectableServerOptions.length === 0 ? <option value="">No running servers</option> : null}
          {selectableServerOptions.map((server) => (
            <option key={server.name} value={server.name}>
              {server.name}
            </option>
          ))}
        </select>
        {selectedServer ? (
          <StatusBadge
            kind="custom"
            tone={lifecycleTone(selectableServerOptions.find((server) => server.name === selectedServer)?.state ?? 'UNKNOWN')}
            label={selectableServerOptions.find((server) => server.name === selectedServer)?.state ?? 'UNKNOWN'}
          />
        ) : null}
        <div className="relative min-w-[240px] flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2" strokeWidth={1.5} aria-hidden />
          <Input
            aria-label="Search loaded JNDI nodes"
            placeholder="Search loaded names, contexts, classes"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-8 rounded-[4px] pl-7 text-[13px]"
          />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={expandAllLoaded} disabled={!snapshot?.tree.length}>
          Expand
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={collapseAll} disabled={!expandedPaths.size}>
          Collapse
        </Button>
        {search ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setSearch('')}>
            Clear
          </Button>
        ) : null}
      </div>

      {snapshot?.status === 'unsupported' ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0">{snapshot.unsupportedReason ?? 'JNDI tree browsing is unavailable for this target.'}</span>
          {creds?.version === '12.2.1.4.0' ? null : (
            <Button type="button" variant="ghost" size="sm" onClick={() => void jndiQuery.refetch()}>
              Retry
            </Button>
          )}
        </div>
      ) : null}

      <div className="grid min-h-[420px] grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="border-border bg-background border">
          <div className="grid h-9 grid-cols-[minmax(260px,1.6fr)_minmax(220px,1fr)_110px] items-center border-b border-border text-muted-foreground text-[12px] font-medium uppercase leading-[16px] tracking-[0.04em]">
            <div className="px-3">Name</div>
            <div className="px-3">Class</div>
            <div className="px-3">Kind</div>
          </div>
          <div role="tree" aria-label="JNDI tree" className={cn(jndiQuery.isFetching && visibleNodes.length > 0 && 'opacity-70')}>
            {jndiQuery.isFetching && visibleNodes.length === 0 ? (
              <div className="text-muted-foreground flex h-32 items-center justify-center text-[13px]">Loading JNDI bindings...</div>
            ) : jndiQuery.isError && visibleNodes.length === 0 ? (
              <div className="border-status-negative/60 bg-status-negative/8 m-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
                <span className="min-w-0 truncate">{jndiQuery.error instanceof Error ? jndiQuery.error.message : 'Unable to load JNDI bindings.'}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => void jndiQuery.refetch()}>
                  Retry
                </Button>
              </div>
            ) : visibleNodes.length === 0 ? (
              <div className="text-muted-foreground flex h-32 items-center justify-center text-[13px]">
                {search
                  ? 'No loaded JNDI nodes match the filter.'
                  : snapshot?.status === 'unsupported'
                    ? 'JNDI bindings cannot be read on this WebLogic version.'
                    : 'No JNDI bindings reported for the selected server.'}
              </div>
            ) : (
              visibleNodes.map((node) => (
                <TreeNodeRow
                  key={node.id}
                  node={node}
                  expanded={expandedPaths.has(node.path)}
                  selected={selectedNodeId === node.id}
                  onToggle={toggleNode}
                  onSelect={(nextNode) => setSelectedNodeId(nextNode.id)}
                />
              ))
            )}
          </div>
        </section>
        <DetailPanel node={selectedNode} />
      </div>
    </>
  )
}
