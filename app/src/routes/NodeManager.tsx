import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, RadioTower, Settings2, Shuffle } from 'lucide-react'
import {
  assignNodeManagerServers,
  createNodeManagerMachine,
  diffNodeManagerListenerConfig,
  formatNodeManagerEndpoint,
  invalidateNodeManagerConfigurationQueries,
  isNodeManagerServerAssignable,
  listenerDraftFromRow,
  machineCreationChanges,
  nodeManagerAssignmentBlockedReason,
  nodeManagerAssignmentServerChoices,
  nodeManagerTone,
  nodeManagerUnreachableHint,
  updateNodeManagerListener,
  useNodeManagerSnapshot,
  validateMachineName,
  validateNodeManagerListenerDraft,
  type AssignNodeManagerServersInput,
  type CreateNodeManagerMachineInput,
  type NodeManagerConfigChange,
  type NodeManagerConfigResult,
  type NodeManagerListenerDraft,
  type NodeManagerPartialFailure,
  type NodeManagerRow,
  type NodeManagerServerRow,
  type UpdateNodeManagerListenerInput,
} from '@/api/queries/node-manager'
import { useEditSessionStatus } from '@/api/queries/edit-sessions'
import { readOnlyDemoModeEnabled } from '@/api/runtime-config'
import { useAuth } from '@/auth/useAuth'
import {
  ConfirmDialog,
  DataTable,
  MonoText,
  PageHeader,
  StatusBadge,
  type DataTableColumn,
} from '@/components'
import { Button } from '@/components/ui/button'

type ListenerEditor =
  | { mode: 'create'; machineName: string; draft: NodeManagerListenerDraft }
  | { mode: 'edit'; row: NodeManagerRow; draft: NodeManagerListenerDraft }

type PendingConfigIntent =
  | { kind: 'listener'; input: UpdateNodeManagerListenerInput; title: string; description: string; subject: string }
  | { kind: 'create-machine'; input: CreateNodeManagerMachineInput; title: string; description: string; subject: string }
  | { kind: 'assign-servers'; input: AssignNodeManagerServersInput; title: string; description: string; subject: string }

function emptyListenerDraft(): NodeManagerListenerDraft {
  return {
    listenAddress: '',
    listenPort: '5556',
    nmType: 'SSL',
    socketCreateTimeoutMillis: '180000',
  }
}

function formatNumber(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}

function changesSubject(changes: NodeManagerConfigChange[]) {
  return changes.map((change) => `${change.label}: ${change.before} -> ${change.after}`).join('; ')
}

function assignmentSubject(input: AssignNodeManagerServersInput) {
  return input.assignments
    .map((assignment) => `${assignment.serverName}: ${assignment.fromMachineName ?? '-'} -> ${assignment.toMachineName}`)
    .join('; ')
}

function FeedbackBanner({ tone, message, onClear }: { tone: 'positive' | 'negative'; message: string; onClear: () => void }) {
  const toneClass = tone === 'positive'
    ? 'border-status-positive/60 bg-status-positive/8'
    : 'border-status-negative/60 bg-status-negative/8'
  return (
    <div className={`${toneClass} mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]`}>
      <span className="min-w-0 truncate font-mono">{message}</span>
      <Button type="button" variant="ghost" size="sm" onClick={onClear}>
        Clear
      </Button>
    </div>
  )
}

function PartialBanner({ failures, onRetry }: { failures: NodeManagerPartialFailure[]; onRetry: () => void }) {
  if (failures.length === 0) return null
  return (
    <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
      <span className="min-w-0 truncate">
        Partial data: {failures.map((failure) => `${failure.machineName ?? 'domain'}/${failure.family}: ${failure.message}`).join(' · ')}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function ListenerFields({
  draft,
  disabled,
  onChange,
}: {
  draft: NodeManagerListenerDraft
  disabled: boolean
  onChange: (draft: NodeManagerListenerDraft) => void
}) {
  const setField = (field: keyof NodeManagerListenerDraft, value: string) => onChange({ ...draft, [field]: value })

  return (
    <div className="grid gap-3 md:grid-cols-4">
      <label className="grid gap-1 text-[13px]">
        <span className="text-muted-foreground text-[11px] uppercase tracking-[0.04em]">Listen address</span>
        <input
          className="border-border bg-background h-8 border px-2 font-mono text-[13px] outline-none focus:border-accent"
          value={draft.listenAddress}
          disabled={disabled}
          onChange={(event) => setField('listenAddress', event.target.value)}
          placeholder="host or address"
        />
      </label>
      <label className="grid gap-1 text-[13px]">
        <span className="text-muted-foreground text-[11px] uppercase tracking-[0.04em]">Listen port</span>
        <input
          className="border-border bg-background h-8 border px-2 font-mono text-[13px] outline-none focus:border-accent"
          value={draft.listenPort}
          disabled={disabled}
          inputMode="numeric"
          onChange={(event) => setField('listenPort', event.target.value)}
        />
      </label>
      <label className="grid gap-1 text-[13px]">
        <span className="text-muted-foreground text-[11px] uppercase tracking-[0.04em]">Type</span>
        <select
          className="border-border bg-background h-8 border px-2 font-mono text-[13px] outline-none focus:border-accent"
          value={draft.nmType}
          disabled={disabled}
          onChange={(event) => setField('nmType', event.target.value)}
        >
          <option value="SSL">SSL</option>
          <option value="Plain">Plain</option>
          <option value="SSH">SSH</option>
          <option value="RSH">RSH</option>
        </select>
      </label>
      <label className="grid gap-1 text-[13px]">
        <span className="text-muted-foreground text-[11px] uppercase tracking-[0.04em]">Socket timeout</span>
        <input
          className="border-border bg-background h-8 border px-2 font-mono text-[13px] outline-none focus:border-accent"
          value={draft.socketCreateTimeoutMillis}
          disabled={disabled}
          inputMode="numeric"
          onChange={(event) => setField('socketCreateTimeoutMillis', event.target.value)}
        />
      </label>
    </div>
  )
}

function ListenerEditorPanel({
  editor,
  disabled,
  onChange,
  onCancel,
  onSubmit,
  blockedReason,
}: {
  editor: ListenerEditor
  disabled: boolean
  onChange: (editor: ListenerEditor) => void
  onCancel: () => void
  onSubmit: () => void
  blockedReason: string | null
}) {
  const title = editor.mode === 'create' ? 'Create Machine' : 'Edit Node Manager'

  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmit()
  }

  return (
    <form className="border-border bg-surface-1/40 mb-3 space-y-3 border p-3" onSubmit={submit}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-muted-foreground text-[11px] uppercase tracking-[0.04em]">{title}</div>
          {editor.mode === 'create' ? (
            <label className="mt-2 grid max-w-[320px] gap-1 text-[13px]">
              <span className="text-muted-foreground text-[11px] uppercase tracking-[0.04em]">Machine</span>
              <input
                className="border-border bg-background h-8 border px-2 font-mono text-[13px] outline-none focus:border-accent"
                value={editor.machineName}
                disabled={disabled}
                onChange={(event) => onChange({ ...editor, machineName: event.target.value })}
              />
            </label>
          ) : (
            <MonoText>{editor.row.machineName}</MonoText>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={disabled || !!blockedReason}>
            Save
          </Button>
        </div>
      </div>
      {blockedReason ? <p className="text-status-warning text-[13px] leading-[18px]">{blockedReason}</p> : null}
      <ListenerFields
        draft={editor.draft}
        disabled={disabled}
        onChange={(draft) => onChange({ ...editor, draft })}
      />
    </form>
  )
}

function AssignmentEditorPanel({
  servers,
  machines,
  selectedMachines,
  disabled,
  onChange,
  onCancel,
  onSubmit,
  blockedReason,
}: {
  servers: NodeManagerServerRow[]
  machines: string[]
  selectedMachines: Record<string, string>
  disabled: boolean
  onChange: (selectedMachines: Record<string, string>) => void
  onCancel: () => void
  onSubmit: () => void
  blockedReason: string | null
}) {
  return (
    <div className="border-border bg-surface-1/40 mb-3 space-y-3 border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-muted-foreground text-[11px] uppercase tracking-[0.04em]">Server machine assignment</div>
          <p className="text-muted-foreground text-[13px] leading-[18px]">
            Only stopped eligible managed servers can be reassigned.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={disabled || !!blockedReason} onClick={onSubmit}>
            Save assignments
          </Button>
        </div>
      </div>
      {blockedReason ? <p className="text-status-warning text-[13px] leading-[18px]">{blockedReason}</p> : null}
      <div className="overflow-auto border border-border bg-background">
        <table className="w-full min-w-[640px] border-collapse text-left text-[13px] leading-[18px]">
          <thead className="text-muted-foreground border-b border-border text-[11px] uppercase tracking-[0.04em]">
            <tr>
              <th className="px-3 py-2 font-medium">Server</th>
              <th className="px-3 py-2 font-medium">Lifecycle</th>
              <th className="px-3 py-2 font-medium">Machine</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((server) => {
              const blockedReason = nodeManagerAssignmentBlockedReason(server)
              const selectable = isNodeManagerServerAssignable(server)
              return (
                <tr key={server.serverName} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2">
                    <MonoText>{server.serverName}</MonoText>
                  </td>
                  <td className="px-3 py-2">
                    <MonoText className="text-muted-foreground">{server.lifecycleState ?? '-'}</MonoText>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      className="border-border bg-background h-8 min-w-[180px] border px-2 font-mono text-[13px] outline-none focus:border-accent disabled:opacity-50"
                      value={selectedMachines[server.serverName] ?? server.machineName ?? ''}
                      disabled={disabled || !selectable}
                      onChange={(event) => onChange({ ...selectedMachines, [server.serverName]: event.target.value })}
                    >
                      <option value="">-</option>
                      {machines.map((machineName) => (
                        <option key={machineName} value={machineName}>{machineName}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <span className={blockedReason ? 'text-muted-foreground' : 'text-status-positive'}>
                      {blockedReason ?? 'Eligible'}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function UnsupportedPanel({ reason }: { reason: string | null }) {
  return (
    <section className="border-border bg-surface-1 flex min-h-28 items-start justify-between gap-3 border px-3 py-3">
      <div className="min-w-0">
        <h2 className="text-[14px] font-medium leading-5">Node Manager status unavailable</h2>
        <p className="text-muted-foreground mt-1 text-[13px] leading-[18px]">
          This target did not expose the standard Node Manager runtime collection.
        </p>
        {reason ? <MonoText className="text-muted-foreground mt-2 block truncate">{reason}</MonoText> : null}
      </div>
      <StatusBadge kind="custom" tone="unknown" label="UNSUPPORTED" />
    </section>
  )
}

export function NodeManager() {
  const { creds } = useAuth()
  const queryClient = useQueryClient()
  const query = useNodeManagerSnapshot()
  const editSessionQuery = useEditSessionStatus()
  const snapshot = query.data
  const rows = useMemo(() => snapshot?.rows ?? [], [snapshot?.rows])
  const servers = useMemo(() => snapshot?.servers ?? [], [snapshot?.servers])
  const assignmentServers = useMemo(() => nodeManagerAssignmentServerChoices(servers), [servers])
  const configuredMachineNames = useMemo(() => snapshot?.machines ?? [], [snapshot?.machines])
  const machineNames = useMemo(() => rows.map((row) => row.machineName), [rows])
  const failures = snapshot?.partialFailures ?? []
  const unassignedServers = snapshot?.unassignedServers ?? []
  const readOnlyDemoMode = readOnlyDemoModeEnabled()
  const editSessionStatus = editSessionQuery.data
  const editSessionBlockReason = useMemo(() => {
    if (readOnlyDemoMode || !editSessionStatus) return null
    if (editSessionStatus.ownership === 'other-user') {
      return `Edit lock held by ${editSessionStatus.ownerEvidence ?? 'another user'}.`
    }
    if (editSessionStatus.state === 'conflict') {
      return 'Edit session merge conflict must be resolved before saving.'
    }
    return null
  }, [editSessionStatus, readOnlyDemoMode])
  const [listenerEditor, setListenerEditor] = useState<ListenerEditor | null>(null)
  const [assignmentEditorOpen, setAssignmentEditorOpen] = useState(false)
  const [assignmentSelections, setAssignmentSelections] = useState<Record<string, string>>({})
  const [pendingIntent, setPendingIntent] = useState<PendingConfigIntent | null>(null)
  const [feedback, setFeedback] = useState<{ tone: 'positive' | 'negative'; message: string } | null>(null)

  const configMutation = useMutation({
    mutationFn: async (intent: PendingConfigIntent) => {
      if (!creds) throw new Error('not authenticated')
      if (intent.kind === 'listener') return updateNodeManagerListener(creds, intent.input)
      if (intent.kind === 'create-machine') return createNodeManagerMachine(creds, intent.input)
      return assignNodeManagerServers(creds, intent.input)
    },
    onSuccess: async (result: NodeManagerConfigResult) => {
      setFeedback({ tone: 'positive', message: result.detail })
      setListenerEditor(null)
      setAssignmentEditorOpen(false)
      setPendingIntent(null)
      await invalidateNodeManagerConfigurationQueries(queryClient, creds, result.affectedServers)
      await query.refetch()
    },
    onError: (error) => {
      setFeedback({
        tone: 'negative',
        message: error instanceof Error ? error.message : 'Node Manager configuration failed.',
      })
      setPendingIntent(null)
    },
  })

  const mutationPending = configMutation.isPending

  const openAssignmentEditor = useCallback(() => {
    if (readOnlyDemoMode) return
    setAssignmentSelections(Object.fromEntries(assignmentServers.map((server) => [server.serverName, server.machineName ?? ''])))
    setAssignmentEditorOpen(true)
    setListenerEditor(null)
  }, [assignmentServers, readOnlyDemoMode])

  const prepareListenerSave = useCallback(() => {
    if (!listenerEditor || readOnlyDemoMode) return
    setFeedback(null)
    if (editSessionBlockReason) {
      setFeedback({ tone: 'negative', message: editSessionBlockReason })
      return
    }
    const validation = validateNodeManagerListenerDraft(listenerEditor.draft)
    if (!validation.ok || !validation.config) {
      setFeedback({ tone: 'negative', message: validation.errors.join(' ') || 'Invalid Node Manager listener values.' })
      return
    }

    if (listenerEditor.mode === 'create') {
      const machine = validateMachineName(listenerEditor.machineName)
      if (!machine.ok) {
        setFeedback({ tone: 'negative', message: machine.error ?? 'Invalid machine name.' })
        return
      }
      if (machineNames.includes(machine.value)) {
        setFeedback({ tone: 'negative', message: `Machine ${machine.value} already exists.` })
        return
      }
      const changes = machineCreationChanges(validation.config)
      setPendingIntent({
        kind: 'create-machine',
        input: { machineName: machine.value, listener: validation.config, changes },
        title: 'Create machine?',
        description: 'This will create a WebLogic machine and configure its Node Manager listener in an edit session.',
        subject: `${machine.value}; ${changesSubject(changes)}`,
      })
      return
    }

    const { patch, changes } = diffNodeManagerListenerConfig(listenerEditor.row, validation.config)
    if (changes.length === 0) {
      setFeedback({ tone: 'negative', message: 'No Node Manager listener changes to save.' })
      return
    }
    setPendingIntent({
      kind: 'listener',
      input: { machineName: listenerEditor.row.machineName, patch, changes },
      title: 'Update Node Manager?',
      description: 'This will update the machine Node Manager listener in a WebLogic edit session.',
      subject: `${listenerEditor.row.machineName}; ${changesSubject(changes)}`,
    })
  }, [editSessionBlockReason, listenerEditor, machineNames, readOnlyDemoMode])

  const prepareAssignmentSave = useCallback(() => {
    if (readOnlyDemoMode) return
    setFeedback(null)
    if (editSessionBlockReason) {
      setFeedback({ tone: 'negative', message: editSessionBlockReason })
      return
    }
    const assignments = servers.flatMap((server) => {
      if (!isNodeManagerServerAssignable(server)) return []
      const nextMachine = assignmentSelections[server.serverName] ?? server.machineName ?? ''
      if (!nextMachine || nextMachine === server.machineName) return []
      return [{ serverName: server.serverName, fromMachineName: server.machineName, toMachineName: nextMachine }]
    })
    if (assignments.length === 0) {
      setFeedback({ tone: 'negative', message: 'No eligible server machine assignment changes to save.' })
      return
    }
    setPendingIntent({
      kind: 'assign-servers',
      input: { assignments },
      title: 'Update server assignments?',
      description: 'This will update managed-server machine assignments in a WebLogic edit session.',
      subject: assignmentSubject({ assignments }),
    })
  }, [assignmentSelections, editSessionBlockReason, readOnlyDemoMode, servers])

  const columns = useMemo<DataTableColumn<NodeManagerRow>[]>(
    () => [
      {
        id: 'machine',
        header: 'MACHINE',
        className: 'min-w-[180px]',
        cell: (row) => <MonoText className="font-medium">{row.machineName}</MonoText>,
      },
      {
        id: 'reachable',
        header: 'STATUS',
        className: 'whitespace-normal',
        cell: (row) => {
          const hint = nodeManagerUnreachableHint(row)
          return (
            <span className="flex max-w-[360px] flex-col gap-1">
              <StatusBadge kind="custom" tone={nodeManagerTone(row)} label={row.reachable} />
              {hint ? <span className="text-muted-foreground text-[12px] leading-4">{hint}</span> : null}
            </span>
          )
        },
      },
      {
        id: 'endpoint',
        header: 'LISTEN',
        cell: (row) => {
          const endpoint = formatNodeManagerEndpoint(row)
          return <MonoText className={endpoint === '-' ? 'text-status-neutral' : undefined}>{endpoint}</MonoText>
        },
      },
      {
        id: 'type',
        header: 'TYPE',
        cell: (row) => <MonoText className={row.nmType ? undefined : 'text-status-neutral'}>{row.nmType ?? '-'}</MonoText>,
      },
      {
        id: 'servers',
        header: 'SERVERS',
        cell: (row) => (
          <div className="flex max-w-[360px] flex-wrap gap-1">
            {row.serverNames.length === 0 ? <span className="text-status-neutral">–</span> : null}
            {row.serverNames.map((serverName) => (
              <Button key={serverName} asChild variant="ghost" size="xs">
                <Link to={`/servers/${encodeURIComponent(serverName)}`}>{serverName}</Link>
              </Button>
            ))}
          </div>
        ),
      },
      {
        id: 'timeout',
        header: 'SOCKET TIMEOUT',
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.socketCreateTimeoutMillis)}</MonoText>,
      },
      ...(!readOnlyDemoMode ? [{
        id: 'actions',
        header: '',
        align: 'right' as const,
        cell: (row: NodeManagerRow) => (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={mutationPending}
            onClick={() => {
              setListenerEditor({ mode: 'edit', row, draft: listenerDraftFromRow(row) })
              setAssignmentEditorOpen(false)
            }}
          >
            <Settings2 className="size-3" strokeWidth={1.5} />
            Edit
          </Button>
        ),
      }] : []),
    ],
    [mutationPending, readOnlyDemoMode],
  )

  return (
    <div>
      <PageHeader
        title="Node Manager"
        subtitle="Machine reachability, listener metadata, and managed-server mapping."
        action={
          !readOnlyDemoMode && snapshot?.status === 'supported' ? (
            <>
              <Button type="button" variant="ghost" size="sm" disabled={mutationPending} onClick={openAssignmentEditor}>
                <Shuffle className="size-3.5" strokeWidth={1.5} />
                Assign servers
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={mutationPending}
                onClick={() => {
                  setListenerEditor({ mode: 'create', machineName: '', draft: emptyListenerDraft() })
                  setAssignmentEditorOpen(false)
                }}
              >
                <Plus className="size-3.5" strokeWidth={1.5} />
                Create machine
              </Button>
            </>
          ) : null
        }
        meta={
          snapshot?.status === 'supported' ? (
            <span className="text-muted-foreground text-[13px] leading-[18px]">
              {rows.length.toLocaleString()} {rows.length === 1 ? 'machine' : 'machines'}
            </span>
          ) : null
        }
        updatedAt={query.dataUpdatedAt}
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
      />

      {snapshot?.status === 'unsupported' ? <UnsupportedPanel reason={snapshot.unsupportedReason} /> : null}

      {snapshot?.status !== 'unsupported' ? (
        <>
          {feedback ? <FeedbackBanner tone={feedback.tone} message={feedback.message} onClear={() => setFeedback(null)} /> : null}

          <ConfirmDialog
            open={!!pendingIntent}
            title={pendingIntent?.title ?? 'Confirm Node Manager change?'}
            description={pendingIntent?.description ?? 'This will update WebLogic configuration in an edit session.'}
            subject={pendingIntent?.subject}
            confirmLabel="Apply"
            pending={mutationPending}
            onCancel={() => {
              if (!mutationPending) setPendingIntent(null)
            }}
            onConfirm={() => {
              if (pendingIntent) configMutation.mutate(pendingIntent)
            }}
          />

          {listenerEditor && !readOnlyDemoMode ? (
            <ListenerEditorPanel
              editor={listenerEditor}
              disabled={mutationPending}
              onChange={setListenerEditor}
              onCancel={() => setListenerEditor(null)}
              onSubmit={prepareListenerSave}
              blockedReason={editSessionBlockReason}
            />
          ) : null}

          {assignmentEditorOpen && !readOnlyDemoMode ? (
            <AssignmentEditorPanel
              servers={assignmentServers}
              machines={configuredMachineNames}
              selectedMachines={assignmentSelections}
              disabled={mutationPending}
              onChange={setAssignmentSelections}
              onCancel={() => setAssignmentEditorOpen(false)}
              onSubmit={prepareAssignmentSave}
              blockedReason={editSessionBlockReason}
            />
          ) : null}

          <PartialBanner failures={failures} onRetry={() => query.refetch()} />

          {unassignedServers.length > 0 ? (
            <div className="border-border bg-surface-1 mb-3 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]">
              <RadioTower className="text-status-neutral size-4" strokeWidth={1.5} />
              <span className="text-muted-foreground min-w-0 truncate">
                Servers without machine mapping: <MonoText>{unassignedServers.join(', ')}</MonoText>
              </span>
            </div>
          ) : null}

          <DataTable
            columns={columns}
            rows={rows}
            getRowId={(row) => row.id}
            loading={query.isLoading || query.isFetching}
            error={query.error ? { message: query.error.message, retry: () => query.refetch() } : null}
            empty={{
              message: 'No Node Manager machines reported.',
              hint: 'This domain may not configure machines or Node Manager runtime metadata.',
            }}
          />
          {mutationPending ? (
            <div className="text-muted-foreground mt-3 flex items-center gap-2 text-[13px]">
              <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
              Applying Node Manager configuration...
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
