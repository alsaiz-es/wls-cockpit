import { useCallback, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { Loader2, Plus, Search } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type WlsCredentials } from '@/api/client'
import { readOnlyDemoModeEnabled } from '@/api/runtime-config'
import {
  runServerLifecycleAction,
  type ServerLifecycleAction,
  type ServerLifecycleTask,
} from '@/api/queries/server-lifecycle'
import { heapUtilization } from '@/api/queries/heap-utilization'
import {
  getMetricHistorySeries,
  serverMetricResourceId,
  useMetricHistoryRecorder,
  type MetricHistorySampleInput,
} from '@/api/queries/metric-history'
import { useServerRuntimes, type ServerRuntimeRow } from '@/api/queries/server-runtimes'
import { useNodeManagerSnapshot } from '@/api/queries/node-manager'
import {
  invalidateTopologyConfigurationQueries,
  runTopologyEditTransaction,
  useTopologyConfigurationSnapshot,
} from '@/api/queries/topology-configuration'
import { useAuth } from '@/auth/useAuth'
import {
  ConfirmDialog,
  DataTable,
  HeapBar,
  MetricTrend,
  MonoText,
  PageHeader,
  RestartRequiredBadge,
  StatusBadge,
  type DataTableColumn,
  type DataTableSort,
  type WlsHealthState,
  type WlsLifecycleState,
} from '@/components'
import { RowActions, type RowAction } from '@/components/row-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  parseRuntimeTableUrlState,
  serializeRuntimeTableUrlState,
  type RuntimeTableUrlState,
} from './runtime-table-url-state'
import { detailReturnState } from './detail-return-state'
import {
  actionLabel,
  batchLifecycleAction,
  pendingLabel,
  rowLifecycleActions,
  runServerLifecycleItems,
  commonBatchActions,
  serverLifecycleConfirmCopy,
  type ServerLifecycleBatchAction,
} from './server-lifecycle-actions'
import {
  createServerIntent,
  initialCreateServerForm,
  validateCreateServerForm,
  type CreateServerClusterMode,
  type CreateServerForm,
  type CreateServerIntent,
  type CreateServerValidation,
} from './topology-configuration-route-model'

const DEFAULT_SORT: DataTableSort = { columnId: 'name', direction: 'asc' }

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

const healthOrder: WlsHealthState[] = ['ok', 'warn', 'overloaded', 'critical', 'failed', 'unknown']
const SERVER_TABLE_URL_CONFIG = {
  defaultSort: DEFAULT_SORT,
  sortableColumns: ['name', 'state', 'health', 'heap', 'threads'],
  filters: {
    state: { param: 'state', defaultValue: 'all', allowedValues: ['all', ...lifecycleOrder] },
    health: { param: 'health', defaultValue: 'all', allowedValues: ['all', ...healthOrder] },
  },
}

interface LifecycleMutationVariables {
  items: Array<{
    serverName: string
    action: ServerLifecycleAction
  }>
  mode: 'single' | 'batch'
}

type DestructiveServerIntent =
  | { kind: 'single'; serverName: string; action: ServerLifecycleAction }
  | { kind: 'batch'; items: Array<{ serverName: string; action: ServerLifecycleAction }> }

interface ServerConfigResult {
  detail: string
}

function readTargetUrl(creds: WlsCredentials | null) {
  const targetUrl = creds?.targetUrl
  return typeof targetUrl === 'string' && targetUrl.trim().length > 0 ? targetUrl : null
}

function parseDefaultHost(creds: WlsCredentials | null) {
  const raw = readTargetUrl(creds)
  if (!raw) return 'localhost'

  try {
    return new URL(raw).hostname
  } catch {
    return 'localhost'
  }
}

function heapPercent(row: ServerRuntimeRow) {
  return heapUtilization(row.heap)
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

function compareRows(a: ServerRuntimeRow, b: ServerRuntimeRow, sort: DataTableSort) {
  const direction = sort.direction === 'asc' ? 1 : -1
  switch (sort.columnId) {
    case 'name':
      return compareText(a.name, b.name) * direction
    case 'state':
      return (lifecycleOrder.indexOf(a.state) - lifecycleOrder.indexOf(b.state)) * direction
    case 'health':
      return (healthOrder.indexOf(a.healthState) - healthOrder.indexOf(b.healthState)) * direction
    case 'heap':
      return compareNumberWithNulls(heapPercent(a), heapPercent(b), sort.direction)
    case 'threads':
      return compareNumberWithNulls(a.threads?.total ?? null, b.threads?.total ?? null, sort.direction)
    default:
      return compareText(a.name, b.name)
  }
}

function formatListen(row: ServerRuntimeRow, defaultHost: string) {
  if (row.listenPort === null) return '–'
  if (
    !row.listenAddress ||
    row.listenAddress === defaultHost ||
    row.listenAddress === 'localhost' ||
    row.listenAddress === '127.0.0.1'
  ) {
    return `:${row.listenPort}`
  }
  return `${row.listenAddress}:${row.listenPort}`
}

function formatCount(value: number | null) {
  return value === null ? '–' : value.toLocaleString()
}

function searchText(row: ServerRuntimeRow) {
  return [
    row.name,
    row.state,
    row.healthState,
    row.listenAddress ?? '',
    row.listenPort === null ? '' : String(row.listenPort),
  ]
    .join(' ')
    .toLowerCase()
}

function serverMetricSamples(rows: ServerRuntimeRow[]): MetricHistorySampleInput[] {
  return rows.flatMap((row): MetricHistorySampleInput[] => {
    const resourceId = serverMetricResourceId(row.name)
    const heapPercent = heapUtilization(row.heap)
    return [
      {
        family: 'servers',
        resourceId,
        metric: 'heap.percent',
        value: heapPercent === null ? null : heapPercent * 100,
      },
      {
        family: 'servers',
        resourceId,
        metric: 'threads.total',
        value: row.threads?.total,
      },
      {
        family: 'servers',
        resourceId,
        metric: 'threads.pending',
        value: row.threads?.pending,
      },
      {
        family: 'servers',
        resourceId,
        metric: 'threads.hogging',
        value: row.threads?.hogging,
      },
      {
        family: 'servers',
        resourceId,
        metric: 'threads.stuck',
        value: row.threads?.stuck,
      },
    ]
  })
}

function taskSummary(task: ServerLifecycleTask) {
  const status = task.status ? ` · ${task.status}` : ''
  const taskName = task.name ? ` · ${task.name}` : ''
  const running = task.running === true ? ' · running' : ''
  return `${actionLabel(task.action)} ${task.serverName}${status}${running}${taskName}`
}

function taskListSummary(tasks: ServerLifecycleTask[]) {
  if (tasks.length === 0) return ''
  if (tasks.length === 1) return taskSummary(tasks[0])

  const action = tasks[0].action
  const names = tasks.map((task) => task.serverName).join(', ')
  return `${actionLabel(action)} ${tasks.length} servers · ${names}`
}


function FieldError({ value }: { value?: string }) {
  return value ? <div className="text-status-negative mt-1 text-[12px] leading-4">{value}</div> : null
}

function FieldLabel({ children }: { children: string }) {
  return <span className="text-muted-foreground mb-1 block text-[11px] uppercase leading-[14px] tracking-[0.04em]">{children}</span>
}

function textInputClass(error?: string) {
  return `h-8 rounded-[4px] font-mono text-[13px] ${error ? 'border-status-negative focus-visible:ring-status-negative/40' : ''}`
}

const selectClass =
  'border-input bg-background h-8 rounded-[4px] border px-2 text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

function TextField({
  label,
  value,
  error,
  disabled,
  onChange,
}: {
  label: string
  value: string
  error?: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <label>
      <FieldLabel>{label}</FieldLabel>
      <Input
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={textInputClass(error)}
      />
      <FieldError value={error} />
    </label>
  )
}

function CreateServerPanel({
  form,
  errors,
  clusterNames,
  machineNames,
  machinesLoading,
  machinesAvailable,
  disabled,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: CreateServerForm
  errors: CreateServerValidation['errors']
  clusterNames: string[]
  machineNames: string[]
  machinesLoading: boolean
  machinesAvailable: boolean
  disabled: boolean
  onChange: (form: CreateServerForm) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const setField = (field: keyof CreateServerForm, value: string) => onChange({ ...form, [field]: value })
  const setClusterMode = (clusterMode: CreateServerClusterMode) => onChange({ ...form, clusterMode })

  return (
    <section className="border-border bg-surface-1 mb-3 border px-3 py-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-medium leading-5">Create Managed Server</h2>
          <p className="text-muted-foreground text-[13px] leading-[18px]">
            Initial edit-tree configuration; lifecycle start remains separate.
          </p>
        </div>
      </div>

      {errors.configuration ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 border px-3 py-2 text-[13px]">
          {errors.configuration}
        </div>
      ) : null}

      <div className="space-y-3">
        <div>
          <h3 className="text-[13px] font-medium leading-[18px]">Identity and Listen</h3>
          <div className="mt-2 grid gap-2 md:grid-cols-4">
            <TextField label="Server name" value={form.name} error={errors.name} disabled={disabled} onChange={(value) => setField('name', value)} />
            <TextField label="Listen address" value={form.listenAddress} error={errors.listenAddress} disabled={disabled} onChange={(value) => setField('listenAddress', value)} />
            <TextField label="Listen port" value={form.listenPort} error={errors.listenPort} disabled={disabled} onChange={(value) => setField('listenPort', value)} />
            <TextField label="Notes" value={form.notes} error={errors.notes} disabled={disabled} onChange={(value) => setField('notes', value)} />
          </div>
        </div>

        <div>
          <h3 className="text-[13px] font-medium leading-[18px]">Cluster and Machine</h3>
          <div className="mt-2 grid gap-2 md:grid-cols-4">
            <label>
              <FieldLabel>Cluster mode</FieldLabel>
              <select
                value={form.clusterMode}
                disabled={disabled}
                onChange={(event) => setClusterMode(event.target.value as CreateServerClusterMode)}
                className={`${selectClass} w-full`}
              >
                <option value="none">No cluster</option>
                <option value="existing">Existing cluster</option>
                <option value="new">New cluster</option>
              </select>
            </label>
            {form.clusterMode === 'existing' ? (
              <label>
                <FieldLabel>Cluster</FieldLabel>
                <select
                  value={form.clusterName}
                  disabled={disabled || clusterNames.length === 0}
                  onChange={(event) => setField('clusterName', event.target.value)}
                  className={`${selectClass} w-full font-mono`}
                >
                  <option value="">Select cluster</option>
                  {clusterNames.map((clusterName) => (
                    <option key={clusterName} value={clusterName}>{clusterName}</option>
                  ))}
                </select>
                <FieldError value={errors.clusterName} />
              </label>
            ) : null}
            {form.clusterMode === 'new' ? (
              <TextField label="New cluster name" value={form.newClusterName} error={errors.newClusterName} disabled={disabled} onChange={(value) => setField('newClusterName', value)} />
            ) : null}
            <label>
              <FieldLabel>Machine</FieldLabel>
              <select
                value={form.machineName}
                disabled={disabled || machinesLoading || !machinesAvailable || machineNames.length === 0}
                onChange={(event) => setField('machineName', event.target.value)}
                className={`${selectClass} w-full font-mono`}
              >
                <option value="">No machine</option>
                {machineNames.map((machineName) => (
                  <option key={machineName} value={machineName}>{machineName}</option>
                ))}
              </select>
              <FieldError value={errors.machineName} />
            </label>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-muted-foreground text-[12px] leading-4">
          {machinesLoading ? 'Loading machine choices...' : machinesAvailable ? `${machineNames.length.toLocaleString()} machines available` : 'Machine choices unavailable'}
        </span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={disabled} onClick={onSubmit}>
            {disabled ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : <Plus className="size-3.5" strokeWidth={1.5} />}
            Create
          </Button>
        </div>
      </div>
    </section>
  )
}

function CreateServerConfirmDialog({
  intent,
  pending,
  onConfirm,
  onCancel,
}: {
  intent: CreateServerIntent | null
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!intent) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6">
      <div role="dialog" aria-modal="true" aria-labelledby="create-server-dialog-title" className="border-border bg-surface-2 w-full max-w-[420px] border shadow-xl">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Plus className="text-accent size-4" strokeWidth={1.5} aria-hidden />
            <h2 id="create-server-dialog-title" className="text-[16px] font-medium leading-[22px]">Create managed server?</h2>
          </div>
        </div>
        <div className="space-y-3 px-4 py-3 text-[13px] leading-[18px]">
          <p className="text-muted-foreground">
            This will stage and activate WebLogic edit-tree changes. The new server will not be started automatically.
          </p>
          <div className="border-border bg-background border px-2 py-2">
            <MonoText className="block truncate text-[13px]" title={intent.subject}>
              {intent.subject}
            </MonoText>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={pending} onClick={onConfirm}>
            {pending ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : null}
            Create server
          </Button>
        </div>
      </div>
    </div>
  )
}

export function Servers() {
  const { creds } = useAuth()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedServerNames, setSelectedServerNames] = useState<Set<string>>(() => new Set())
  const [selectionSnapshotAt, setSelectionSnapshotAt] = useState(0)
  const [lifecycleTasks, setLifecycleTasks] = useState<ServerLifecycleTask[] | null>(null)
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  const [destructiveIntent, setDestructiveIntent] = useState<DestructiveServerIntent | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [createForm, setCreateForm] = useState<CreateServerForm>(() => initialCreateServerForm())
  const [createFormErrors, setCreateFormErrors] = useState<CreateServerValidation['errors']>({})
  const [createIntent, setCreateIntent] = useState<CreateServerIntent | null>(null)
  const [configResult, setConfigResult] = useState<ServerConfigResult | null>(null)
  const query = useServerRuntimes()
  const queryClient = useQueryClient()
  const readOnlyDemoMode = readOnlyDemoModeEnabled()
  const topologyQuery = useTopologyConfigurationSnapshot({ enabled: showCreateForm && !readOnlyDemoMode })
  const nodeManagerQuery = useNodeManagerSnapshot({ enabled: showCreateForm && !readOnlyDemoMode })
  const defaultHost = useMemo(() => parseDefaultHost(creds), [creds])
  const returnState = useMemo(() => detailReturnState(location), [location])
  const tableState = useMemo(
    () => parseRuntimeTableUrlState(searchParams, SERVER_TABLE_URL_CONFIG),
    [searchParams],
  )
  const sort = tableState.sort
  const search = tableState.search
  const stateFilter = tableState.filters.state as WlsLifecycleState | 'all'
  const healthFilter = tableState.filters.health as WlsHealthState | 'all'
  const effectiveSort = sort ?? DEFAULT_SORT
  const allRows = useMemo(() => query.data ?? [], [query.data])
  const configuredServerNames = useMemo(
    () => topologyQuery.data?.servers.map((server) => server.name).sort(compareText) ?? [],
    [topologyQuery.data?.servers],
  )
  const serverNames = useMemo(
    () => [...new Set([...allRows.map((row) => row.name), ...configuredServerNames])].sort(compareText),
    [allRows, configuredServerNames],
  )
  const clusterNames = useMemo(
    () => topologyQuery.data?.clusters.map((cluster) => cluster.name).sort(compareText) ?? [],
    [topologyQuery.data?.clusters],
  )
  const machineNames = useMemo(
    () => nodeManagerQuery.data?.status === 'supported' ? [...nodeManagerQuery.data.machines].sort(compareText) : [],
    [nodeManagerQuery.data],
  )
  const machinesAvailable = nodeManagerQuery.data?.status === 'supported'
  const hasActiveFilters = search.trim().length > 0 || stateFilter !== 'all' || healthFilter !== 'all'
  const updateTableState = useCallback(
    (patch: Partial<RuntimeTableUrlState>) => {
      const next = {
        search: patch.search ?? tableState.search,
        filters: { ...tableState.filters, ...patch.filters },
        sort: patch.sort === undefined ? tableState.sort : patch.sort,
      }
      setSearchParams(serializeRuntimeTableUrlState(next, SERVER_TABLE_URL_CONFIG, searchParams), { replace: true })
    },
    [searchParams, setSearchParams, tableState],
  )
  const lifecycleMutation = useMutation<
    { tasks: ServerLifecycleTask[]; failures: string[] },
    Error,
    LifecycleMutationVariables
  >({
    mutationFn: async ({ items }) => {
      if (!creds) throw new Error('not authenticated')
      return runServerLifecycleItems(items, (item) => runServerLifecycleAction(creds, item.serverName, item.action))
    },
    onMutate: () => {
      setLifecycleTasks(null)
      setLifecycleError(null)
    },
    onSuccess: ({ tasks, failures }, variables) => {
      setLifecycleTasks(tasks.length ? tasks : null)
      if (failures.length) setLifecycleError(failures.join(' · '))
      if (variables.mode === 'batch') {
        setSelectedServerNames(new Set())
      }
    },
    onError: (error) => {
      setLifecycleError(error.message || 'Lifecycle action failed.')
    },
    onSettled: async () => {
      await query.refetch()
    },
  })

  const configMutation = useMutation<ServerConfigResult, Error, CreateServerIntent>({
    mutationFn: async (intent) => {
      if (!creds) throw new Error('not authenticated')
      await runTopologyEditTransaction(creds, intent.detail, intent.steps)
      return { detail: `${intent.detail} accepted. Server was not started.` }
    },
    onMutate: () => {
      setLifecycleTasks(null)
      setLifecycleError(null)
      setConfigResult(null)
    },
    onSuccess: (result) => {
      setConfigResult(result)
      setCreateForm(initialCreateServerForm())
      setCreateFormErrors({})
      setShowCreateForm(false)
      setCreateIntent(null)
    },
    onError: (error) => {
      // Close the confirmation so the error banner is not hidden behind it.
      setCreateIntent(null)
      setLifecycleError(error.message || 'Server configuration failed.')
    },
    onSettled: async () => {
      await Promise.all([
        query.refetch(),
        topologyQuery.refetch(),
        invalidateTopologyConfigurationQueries(queryClient, creds),
      ])
    },
  })

  const pendingLifecycle = lifecycleMutation.isPending ? lifecycleMutation.variables : null
  const mutationPending = lifecycleMutation.isPending || configMutation.isPending
  const historySamples = useMemo(() => serverMetricSamples(allRows), [allRows])
  const history = useMetricHistoryRecorder({
    creds,
    samples: historySamples,
    timestamp: query.dataUpdatedAt,
  })

  const executeLifecycle = useCallback(
    (serverName: string, action: ServerLifecycleAction) => {
      if (readOnlyDemoMode) return
      lifecycleMutation.mutate({ items: [{ serverName, action }], mode: 'single' })
    },
    [lifecycleMutation, readOnlyDemoMode],
  )

  const runLifecycle = useCallback(
    (serverName: string, action: ServerLifecycleAction) => {
      if (readOnlyDemoMode) return
      // Every lifecycle action changes a running domain, so each one is confirmed (docs/ui §7.1).
      setDestructiveIntent({ kind: 'single', serverName, action })
    },
    [readOnlyDemoMode],
  )

  const executeBulkLifecycle = useCallback(
    (items: LifecycleMutationVariables['items']) => {
      if (readOnlyDemoMode) return
      lifecycleMutation.mutate({ items, mode: 'batch' })
    },
    [lifecycleMutation, readOnlyDemoMode],
  )

  const runBulkLifecycle = useCallback(
    (items: LifecycleMutationVariables['items']) => {
      if (readOnlyDemoMode) return
      const [first] = items
      if (first && items.every((item) => item.action === first.action)) {
        setDestructiveIntent({ kind: 'batch', items })
        return
      }
      executeBulkLifecycle(items)
    },
    [executeBulkLifecycle, readOnlyDemoMode],
  )

  const confirmDestructiveIntent = useCallback(() => {
    if (!destructiveIntent) return
    const intent = destructiveIntent
    setDestructiveIntent(null)
    if (intent.kind === 'single') {
      executeLifecycle(intent.serverName, intent.action)
      return
    }
    executeBulkLifecycle(intent.items)
  }, [destructiveIntent, executeBulkLifecycle, executeLifecycle])

  const openCreateForm = useCallback(() => {
    if (readOnlyDemoMode) return
    setCreateFormErrors({})
    setConfigResult(null)
    setShowCreateForm(true)
  }, [readOnlyDemoMode])

  const cancelCreateForm = useCallback(() => {
    if (configMutation.isPending) return
    setShowCreateForm(false)
    setCreateFormErrors({})
    setCreateIntent(null)
  }, [configMutation.isPending])

  const submitCreateForm = useCallback(() => {
    if (!creds || readOnlyDemoMode) return
    const validation = validateCreateServerForm(createForm, {
      configurationLoaded: !!topologyQuery.data && !topologyQuery.isFetching,
      serverNames,
      clusterNames,
      machineNames,
      machinesAvailable,
    })
    setCreateFormErrors(validation.errors)
    if (!validation.valid) return
    setCreateIntent(createServerIntent(creds, createForm))
  }, [
    clusterNames,
    createForm,
    creds,
    machineNames,
    machinesAvailable,
    readOnlyDemoMode,
    serverNames,
    topologyQuery.data,
    topologyQuery.isFetching,
  ])

  const confirmCreateIntent = useCallback(() => {
    if (!createIntent || configMutation.isPending) return
    configMutation.mutate(createIntent)
  }, [configMutation, createIntent])

  const stateOptions = useMemo(() => {
    const states = [...new Set(allRows.map((row) => row.state))]
    return states.sort((a, b) => lifecycleOrder.indexOf(a) - lifecycleOrder.indexOf(b))
  }, [allRows])

  const healthOptions = useMemo(() => {
    const states = [...new Set(allRows.map((row) => row.healthState))]
    return states.sort((a, b) => healthOrder.indexOf(a) - healthOrder.indexOf(b))
  }, [allRows])
  const visibleStateOptions = useMemo(
    () => stateFilter !== 'all' && !stateOptions.includes(stateFilter) ? [stateFilter, ...stateOptions] : stateOptions,
    [stateFilter, stateOptions],
  )
  const visibleHealthOptions = useMemo(
    () => healthFilter !== 'all' && !healthOptions.includes(healthFilter) ? [healthFilter, ...healthOptions] : healthOptions,
    [healthFilter, healthOptions],
  )

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return allRows
      .filter((row) => stateFilter === 'all' || row.state === stateFilter)
      .filter((row) => healthFilter === 'all' || row.healthState === healthFilter)
      .filter((row) => needle.length === 0 || searchText(row).includes(needle))
      .sort((a, b) => compareRows(a, b, effectiveSort))
  }, [allRows, effectiveSort, healthFilter, search, stateFilter])

  const lifecycleModeOptions = useMemo(() => ({ readOnlyDemoMode }), [readOnlyDemoMode])
  const selectableRows = useMemo(
    () => rows.filter((row) => batchLifecycleAction(row, lifecycleModeOptions)),
    [lifecycleModeOptions, rows],
  )
  const currentSelectedServerNames = useMemo(
    () => (selectionSnapshotAt === query.dataUpdatedAt ? selectedServerNames : new Set<string>()),
    [query.dataUpdatedAt, selectedServerNames, selectionSnapshotAt],
  )
  const selectedRows = useMemo(
    () => rows.filter((row) => currentSelectedServerNames.has(row.name)),
    [currentSelectedServerNames, rows],
  )
  const bulkActions = useMemo(
    () => commonBatchActions(selectedRows, lifecycleModeOptions),
    [lifecycleModeOptions, selectedRows],
  )
  const allSelectableVisibleSelected =
    selectableRows.length > 0 && selectableRows.every((row) => currentSelectedServerNames.has(row.name))
  const pendingItems = useMemo(
    () => new Map(pendingLifecycle?.items.map((item) => [item.serverName, item.action]) ?? []),
    [pendingLifecycle],
  )
  const destructiveCopy = destructiveIntent
    ? serverLifecycleConfirmCopy(
        destructiveIntent.kind === 'single' ? destructiveIntent.action : destructiveIntent.items[0].action,
        destructiveIntent.kind === 'single' ? 1 : destructiveIntent.items.length,
      )
    : null
  const destructiveSubject =
    destructiveIntent?.kind === 'single'
      ? destructiveIntent.serverName
      : destructiveIntent?.items.map((item) => item.serverName).join(', ')

  const toggleSelected = useCallback((serverName: string, checked: boolean) => {
    setSelectionSnapshotAt(query.dataUpdatedAt)
    setSelectedServerNames((current) => {
      const next = new Set(current)
      if (checked) {
        next.add(serverName)
      } else {
        next.delete(serverName)
      }
      return next
    })
  }, [query.dataUpdatedAt])

  const toggleVisibleSelection = useCallback(
    (checked: boolean) => {
      setSelectionSnapshotAt(query.dataUpdatedAt)
      setSelectedServerNames((current) => {
        const next = new Set(current)
        selectableRows.forEach((row) => {
          if (checked) {
            next.add(row.name)
          } else {
            next.delete(row.name)
          }
        })
        return next
      })
    },
    [query.dataUpdatedAt, selectableRows],
  )

  const clearSelection = useCallback(() => {
    setSelectionSnapshotAt(query.dataUpdatedAt)
    setSelectedServerNames(new Set())
  }, [query.dataUpdatedAt])

  const invokeBulkAction = useCallback((action: ServerLifecycleBatchAction) => {
    if (!bulkActions.includes(action) || selectedRows.length === 0) return
    runBulkLifecycle(selectedRows.map((row) => ({ serverName: row.name, action })))
  }, [bulkActions, runBulkLifecycle, selectedRows])

  const columns = useMemo<DataTableColumn<ServerRuntimeRow>[]>(
    () => [
      {
        id: 'select',
        header: (
          <input
            type="checkbox"
            aria-label="Select eligible visible servers"
            checked={allSelectableVisibleSelected}
            disabled={selectableRows.length === 0 || lifecycleMutation.isPending}
            onChange={(event) => toggleVisibleSelection(event.target.checked)}
            className="border-input bg-background size-3.5 rounded-[3px] align-middle accent-[var(--accent)]"
          />
        ),
        align: 'center',
        headerClassName: 'w-[44px]',
        className: 'w-[44px]',
        cell: (row) => {
          const action = batchLifecycleAction(row, lifecycleModeOptions)
          if (!action) return <span className="text-status-neutral">–</span>

          return (
            <input
              type="checkbox"
              aria-label={`Select ${row.name}`}
              checked={currentSelectedServerNames.has(row.name)}
              disabled={lifecycleMutation.isPending}
              onChange={(event) => toggleSelected(row.name, event.target.checked)}
              className="border-input bg-background size-3.5 rounded-[3px] align-middle accent-[var(--accent)]"
            />
          )
        },
      },
      {
        id: 'name',
        header: 'NAME',
        sortable: true,
        className: 'min-w-[200px]',
        cell: (row) => (
          <Link
            to={`/servers/${encodeURIComponent(row.name)}`}
            state={returnState}
            className="hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MonoText className="block truncate font-medium" title={row.name}>
              {row.name}
            </MonoText>
          </Link>
        ),
      },
      {
        id: 'state',
        header: 'STATE',
        sortable: true,
        cell: (row) => (
          <div className="flex min-w-0 items-center gap-2">
            <StatusBadge kind="wls-state" value={row.state} />
            {row.restartRequired ? <RestartRequiredBadge /> : null}
          </div>
        ),
      },
      {
        id: 'health',
        header: 'HEALTH',
        sortable: true,
        cell: (row) => <StatusBadge kind="wls-health" value={row.healthState} />,
      },
      {
        id: 'heap',
        header: 'HEAP',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              history.scopeKey,
              'servers',
              serverMetricResourceId(row.name),
              'heap.percent',
            )}
            value={<HeapBar heap={row.heap} />}
            title={`${row.name} heap`}
          />
        ),
      },
      {
        id: 'threads',
        header: 'THREADS',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              history.scopeKey,
              'servers',
              serverMetricResourceId(row.name),
              'threads.total',
            )}
            value={
              <MonoText className={row.threads ? undefined : 'text-status-neutral'}>
                {formatCount(row.threads?.total ?? null)}
              </MonoText>
            }
            title={`Pending: ${row.threads?.pending ?? '-'} · Hogging: ${row.threads?.hogging ?? '-'} · Stuck: ${row.threads?.stuck ?? '-'}`}
          />
        ),
      },
      {
        id: 'listen',
        header: 'LISTEN',
        className: 'font-mono',
        cell: (row) => {
          const listen = formatListen(row, defaultHost)
          return (
            <MonoText className={listen === '–' ? 'text-status-neutral' : undefined} title={listen}>
              {listen}
            </MonoText>
          )
        },
      },
      {
        id: 'actions',
        header: 'ACTIONS',
        align: 'right',
        className: 'min-w-[184px]',
        cell: (row) => {
          const actions = rowLifecycleActions(row, lifecycleModeOptions)
          if (actions.length === 0) return <span className="text-status-neutral">–</span>
          const toRowAction = (action: ServerLifecycleAction): RowAction => ({
            key: action,
            label: actionLabel(action),
            pendingLabel: pendingLabel(action),
            ariaLabel: `${actionLabel(action)} ${row.name}`,
            destructive: action === 'shutdown' || action === 'forceShutdown',
            separatorBefore: action === 'forceShutdown',
            pending: pendingItems.get(row.name) === action,
            onSelect: () => runLifecycle(row.name, action),
          })
          const primary = (['start', 'resume', 'shutdown', 'forceShutdown'] as const).find((action) => actions.includes(action))
          return (
            <RowActions
              primary={primary ? toRowAction(primary) : null}
              more={actions.filter((action) => action !== primary).map(toRowAction)}
              moreLabel={`More lifecycle actions for ${row.name}`}
              disabled={lifecycleMutation.isPending}
            />
          )
        },
      },
    ],
    [
      allSelectableVisibleSelected,
      defaultHost,
      lifecycleMutation.isPending,
      lifecycleModeOptions,
      pendingItems,
      runLifecycle,
      selectableRows.length,
      currentSelectedServerNames,
      history.scopeKey,
      returnState,
      toggleSelected,
      toggleVisibleSelection,
    ],
  )

  return (
    <>
      <PageHeader
        title="Servers"
        subtitle="Domain server runtimes."
        action={
          !readOnlyDemoMode ? (
            <Button type="button" size="sm" disabled={mutationPending} onClick={openCreateForm}>
              <Plus className="size-3.5" strokeWidth={1.5} />
              Create server
            </Button>
          ) : null
        }
        updatedAt={query.dataUpdatedAt}
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
      />

      <ConfirmDialog
        open={!!destructiveIntent}
        title={destructiveCopy?.title ?? ''}
        description={destructiveCopy?.description ?? ''}
        subject={destructiveSubject}
        confirmLabel={destructiveCopy?.confirmLabel}
        pending={lifecycleMutation.isPending}
        onConfirm={confirmDestructiveIntent}
        onCancel={() => setDestructiveIntent(null)}
      />

      <CreateServerConfirmDialog
        intent={createIntent}
        pending={configMutation.isPending}
        onConfirm={confirmCreateIntent}
        onCancel={() => setCreateIntent(null)}
      />

      {showCreateForm && !readOnlyDemoMode ? (
        <CreateServerPanel
          form={createForm}
          errors={createFormErrors}
          clusterNames={clusterNames}
          machineNames={machineNames}
          machinesLoading={nodeManagerQuery.isLoading || nodeManagerQuery.isFetching}
          machinesAvailable={machinesAvailable}
          disabled={configMutation.isPending}
          onChange={setCreateForm}
          onCancel={cancelCreateForm}
          onSubmit={submitCreateForm}
        />
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search
            className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2"
            strokeWidth={1.5}
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Filter servers"
            placeholder="Filter servers"
            value={search}
            onChange={(event) => {
              updateTableState({ search: event.target.value })
              clearSelection()
            }}
            className="h-8 rounded-[4px] pl-7 text-[13px]"
          />
        </div>
        <select
          aria-label="Filter server state"
          value={stateFilter}
          onChange={(event) => {
            updateTableState({ filters: { state: event.target.value } })
            clearSelection()
          }}
          className="border-input bg-background h-8 min-w-[156px] rounded-[4px] border px-2 text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">All states</option>
          {visibleStateOptions.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter server health"
          value={healthFilter}
          onChange={(event) => {
            updateTableState({ filters: { health: event.target.value } })
            clearSelection()
          }}
          className="border-input bg-background h-8 min-w-[140px] rounded-[4px] border px-2 text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">All health</option>
          {visibleHealthOptions.map((health) => (
            <option key={health} value={health}>
              {health.toUpperCase()}
            </option>
          ))}
        </select>
        {hasActiveFilters ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              updateTableState({ search: '', filters: { state: 'all', health: 'all' }, sort })
              clearSelection()
            }}
          >
            Reset
          </Button>
        ) : null}
      </div>

      {selectedRows.length > 0 ? (
        <div className="border-border bg-surface-1 mb-3 flex min-h-10 flex-wrap items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="font-medium">{selectedRows.length} selected</span>
            <span className="text-muted-foreground truncate">
              {bulkActions.length
                ? 'Actions available for every selected server'
                : 'The selected servers have no lifecycle action in common'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={lifecycleMutation.isPending} onClick={clearSelection}>
              Clear
            </Button>
            {bulkActions.map((action) => (
              <Button
                key={action}
                type="button"
                variant={action === 'start' || action === 'resume' ? 'secondary' : 'outline'}
                size="sm"
                disabled={lifecycleMutation.isPending}
                onClick={() => invokeBulkAction(action)}
                className={
                  action === 'shutdown' || action === 'forceShutdown'
                    ? 'text-status-negative hover:text-status-negative'
                    : action === 'suspend'
                      ? 'text-status-warning hover:text-status-warning'
                      : undefined
                }
              >
                {lifecycleMutation.isPending && pendingLifecycle?.mode === 'batch' && pendingLifecycle.items[0]?.action === action ? (
                  <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
                ) : null}
                {actionLabel(action)} selected
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {lifecycleTasks ? (
        <div
          role="status"
          aria-live="polite"
          className="border-status-positive/60 bg-status-positive/8 mb-3 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]"
        >
          <span className="text-status-positive font-medium">Lifecycle task accepted</span>
          <span className="text-muted-foreground min-w-0 truncate font-mono">{taskListSummary(lifecycleTasks)}</span>
        </div>
      ) : null}

      {configResult ? (
        <div
          role="status"
          aria-live="polite"
          className="border-status-positive/60 bg-status-positive/8 mb-3 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]"
        >
          <span className="text-status-positive font-medium">Server configuration accepted</span>
          <span className="text-muted-foreground min-w-0 truncate font-mono">{configResult.detail}</span>
        </div>
      ) : null}

      {lifecycleError ? (
        <div
          role="alert"
          className="border-status-negative/60 bg-status-negative/8 mb-3 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]"
        >
          <span className="text-status-negative font-medium">Lifecycle action failed</span>
          <span className="min-w-0 truncate font-mono">{lifecycleError}</span>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.name}
        sort={effectiveSort}
        onSortChange={(nextSort) => updateTableState({ sort: nextSort })}
        loading={query.isFetching}
        error={
          query.isError
            ? {
                message: query.error instanceof Error ? query.error.message : 'Unable to load server runtimes.',
                retry: () => void query.refetch(),
              }
            : null
        }
        empty={{
          message:
            hasActiveFilters && allRows.length > 0
              ? 'No server rows match the current filters.'
              : 'No servers reported by this domain.',
        }}
      />
    </>
  )
}
