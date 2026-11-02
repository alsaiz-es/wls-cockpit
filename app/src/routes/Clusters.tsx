import { useCallback, useMemo, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Loader2, Network, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { readOnlyDemoModeEnabled } from '@/api/runtime-config'
import {
  useClusterSnapshot,
  type ClusterMemberRow,
  type ClusterPartialFailure,
  type ClusterReplicationRow,
  type ClusterRow,
  type ClusterRuntimeRow,
} from '@/api/queries/clusters'
import {
  createTopologyResourceStep,
  deleteTopologyResourceStep,
  invalidateTopologyConfigurationQueries,
  readTopologyReferenceName,
  readTopologyReferenceNames,
  runTopologyEditTransaction,
  updateTopologyChildStep,
  updateTopologyResourceStep,
  useTopologyConfigurationSnapshot,
  type TopologyConfiguredResource,
  type TopologyReferenceKind,
  type TopologySectionData,
} from '@/api/queries/topology-configuration'
import {
  fieldSupportsMutation,
  topologyEndpointsFor,
  type TopologyEndpointCatalog,
  type TopologyFieldMetadata,
} from '@/api/queries/topology-configuration-catalog'
import { useAuth } from '@/auth/useAuth'
import {
  ConfirmDialog,
  DataTable,
  MonoText,
  PageHeader,
  RelativeTime,
  StatusBadge,
  type DataTableColumn,
  type DataTableSort,
  type WlsLifecycleState,
} from '@/components'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { detailReturnPath, detailReturnState } from './detail-return-state'
import {
  parseRuntimeTableUrlState,
  serializeRuntimeTableUrlState,
  type RuntimeTableUrlConfig,
  type RuntimeTableUrlState,
} from './runtime-table-url-state'
import {
  buildClusterDeleteIntent,
  buildConfigEditDraft,
  buildTopologySectionEditIntent,
  clusterDeleteBlockedReason,
  createClusterIntent,
  initialCreateClusterForm,
  validateCreateClusterForm,
  type ConfigEditDraft,
  type ConfigEditErrors,
  type CreateClusterErrors,
  type CreateClusterForm,
  type CreateClusterIntent,
} from './topology-configuration-route-model'
import { routeParam } from './route-params'

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
const CLUSTERS_TABLE_URL_CONFIG: RuntimeTableUrlConfig = {
  defaultSort: DEFAULT_SORT,
  sortableColumns: ['name', 'health', 'members', 'alive', 'primaries', 'secondaries'],
  filters: {},
}

type ClusterDetailTab = 'overview' | 'configuration'

interface ConfigEditIntent {
  kind: 'delete-cluster' | 'update-section'
  endpointId: string
  endpointKind: TopologyEndpointCatalog['endpointKind']
  sectionLabel: string
  clusterName: string
  changedFields: string[]
  payload: Record<string, unknown>
  detail: string
}

interface ClusterConfigResult {
  detail: string
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function compareNumberWithNulls(a: number | null, b: number | null, direction: 'asc' | 'desc') {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return direction === 'asc' ? a - b : b - a
}

function formatNumber(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}

function formatText(value: string | null) {
  return value ?? '-'
}

function formatListen(row: ClusterMemberRow) {
  if (row.listenPort === null) return '-'
  if (!row.listenAddress || row.listenAddress === 'localhost' || row.listenAddress === '127.0.0.1') {
    return `:${row.listenPort}`
  }
  return `${row.listenAddress}:${row.listenPort}`
}

function stateSummary(row: ClusterRow) {
  return lifecycleOrder
    .flatMap((state) => {
      const count = row.stateCounts[state] ?? 0
      return count > 0 ? [`${state}:${count}`] : []
    })
    .join(' · ') || '-'
}

function searchText(row: ClusterRow) {
  return [
    row.name,
    row.clusterAddress ?? '',
    row.clusterMessagingMode ?? '',
    row.clusterType ?? '',
    row.healthState,
    ...row.configuredMemberNames,
    ...row.runtimeServerNames,
    ...row.activeSingletonServices,
  ].join(' ').toLowerCase()
}

function compareRows(a: ClusterRow, b: ClusterRow, sort: DataTableSort) {
  const direction = sort.direction === 'asc' ? 1 : -1
  switch (sort.columnId) {
    case 'name':
      return compareText(a.name, b.name) * direction
    case 'health':
      return compareText(a.healthState, b.healthState) * direction || compareText(a.name, b.name)
    case 'members':
      return compareNumberWithNulls(a.configuredMemberNames.length, b.configuredMemberNames.length, sort.direction) || compareText(a.name, b.name)
    case 'alive':
      return compareNumberWithNulls(a.aliveServerCount, b.aliveServerCount, sort.direction) || compareText(a.name, b.name)
    case 'primaries':
      return compareNumberWithNulls(a.primaryCount, b.primaryCount, sort.direction) || compareText(a.name, b.name)
    case 'secondaries':
      return compareNumberWithNulls(a.secondaryCount, b.secondaryCount, sort.direction) || compareText(a.name, b.name)
    default:
      return compareRows(a, b, DEFAULT_SORT)
  }
}

function referenceKindForField(field: TopologyFieldMetadata): TopologyReferenceKind | null {
  const property = field.jsonProperty.toLowerCase()
  if (property === 'cluster' || property.includes('cluster')) return 'clusters'
  if (property.includes('machine')) return 'machines'
  if (property.includes('dynamicserver')) return 'dynamicServers'
  if (property === 'servertemplate') return 'serverTemplates'
  if (property.includes('networkaccesspoint')) return 'networkAccessPoints'
  if (property === 'servers' || property.includes('server')) return 'servers'
  return null
}

function formatConfigValue(field: TopologyFieldMetadata, value: unknown) {
  if (field.sensitive || field.writeSupport === 'write-only') return '[protected]'
  if (value === null || value === undefined || value === '') return '-'
  const referenceKind = referenceKindForField(field)
  if (referenceKind && field.valueKind === 'reference') {
    return readTopologyReferenceName(value, referenceKind) ?? '-'
  }
  if (referenceKind && field.valueKind === 'reference-list') {
    const names = readTopologyReferenceNames(value, referenceKind)
    return names.length ? names.join(', ') : '-'
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '-'
    return value.map((item) => typeof item === 'string' || typeof item === 'number' ? String(item) : '[object]').join(', ')
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString() : '-'
  if (typeof value === 'string') return value
  return '[object]'
}

function supportLabel(field: TopologyFieldMetadata) {
  if (field.unavailableReason) return 'unavailable'
  if (field.writeSupport === 'write-only') return 'set only'
  if (field.writeSupport === 'create-only') return 'create only'
  if (field.writeSupport === 'read-only') return 'read only'
  if (field.writeSupport === 'unsupported') return 'unsupported'
  return 'editable'
}

function supportTitle(field: TopologyFieldMetadata) {
  return field.unavailableReason ?? field.readOnlyReason ?? field.restartNote ?? supportLabel(field)
}

function configFieldsForMutation(endpoint: TopologyEndpointCatalog, mode: 'create' | 'update') {
  if (!endpoint.capabilities.includes(mode)) return []
  return endpoint.fields.filter((field) => fieldSupportsMutation(field, mode) && !field.unavailableReason)
}

function editableConfigFields(endpoint: TopologyEndpointCatalog) {
  return configFieldsForMutation(endpoint, 'update')
}

function buildConfigEditIntent(
  clusterName: string,
  endpoint: TopologyEndpointCatalog,
  data: unknown,
  values: Record<string, string>,
): { intent: ConfigEditIntent | null; errors: ConfigEditErrors } {
  const result = buildTopologySectionEditIntent({ resourceName: clusterName, endpoint, data, values })
  if (!result.intent) return { intent: null, errors: result.errors }
  return {
    errors: {},
    intent: {
      ...result.intent,
      clusterName,
    },
  }
}

function PartialBanner({ failures, onRetry }: { failures: ClusterPartialFailure[]; onRetry: () => void }) {
  if (failures.length === 0) return null
  return (
    <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
      <span className="min-w-0 truncate">
        Partial data: {failures.map((failure) => `${failure.clusterName}/${failure.serverName ?? 'domain'}/${failure.family}: ${failure.message}`).join(' · ')}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
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

function CreateClusterPanel({
  form,
  errors,
  disabled,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: CreateClusterForm
  errors: CreateClusterErrors
  disabled: boolean
  onChange: (form: CreateClusterForm) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const setField = (field: keyof CreateClusterForm, value: string) => onChange({ ...form, [field]: value })

  return (
    <section className="border-border bg-surface-1 mb-3 border px-3 py-3">
      <div className="mb-3">
        <h2 className="text-[14px] font-medium leading-5">Create Cluster</h2>
        <p className="text-muted-foreground text-[13px] leading-[18px]">
          Initial edit-tree configuration; member assignment stays with managed-server configuration.
        </p>
      </div>

      {errors.configuration ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 border px-3 py-2 text-[13px]">
          {errors.configuration}
        </div>
      ) : null}

      <div className="grid gap-2 md:grid-cols-4">
        <TextField label="Cluster name" value={form.name} error={errors.name} disabled={disabled} onChange={(value) => setField('name', value)} />
        <TextField label="Cluster address" value={form.clusterAddress} error={errors.clusterAddress} disabled={disabled} onChange={(value) => setField('clusterAddress', value)} />
        <label>
          <FieldLabel>Messaging mode</FieldLabel>
          <select
            value={form.clusterMessagingMode}
            disabled={disabled}
            onChange={(event) => setField('clusterMessagingMode', event.target.value)}
            className={`${selectClass} w-full font-mono`}
          >
            <option value="">Default</option>
            <option value="unicast">unicast</option>
            <option value="multicast">multicast</option>
          </select>
          <FieldError value={errors.clusterMessagingMode} />
        </label>
        <label>
          <FieldLabel>Cluster type</FieldLabel>
          <select
            value={form.clusterType}
            disabled={disabled}
            onChange={(event) => setField('clusterType', event.target.value)}
            className={`${selectClass} w-full font-mono`}
          >
            <option value="">Default</option>
            <option value="configured">configured</option>
            <option value="dynamic">dynamic</option>
          </select>
          <FieldError value={errors.clusterType} />
        </label>
        <TextField label="Frontend host" value={form.frontendHost} error={errors.frontendHost} disabled={disabled} onChange={(value) => setField('frontendHost', value)} />
        <TextField label="Frontend HTTP port" value={form.frontendHTTPPort} error={errors.frontendHTTPPort} disabled={disabled} onChange={(value) => setField('frontendHTTPPort', value)} />
        <TextField label="Frontend HTTPS port" value={form.frontendHTTPSPort} error={errors.frontendHTTPSPort} disabled={disabled} onChange={(value) => setField('frontendHTTPSPort', value)} />
        <TextField label="Notes" value={form.notes} error={errors.notes} disabled={disabled} onChange={(value) => setField('notes', value)} />
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={disabled} onClick={onSubmit}>
          {disabled ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : <Plus className="size-3.5" strokeWidth={1.5} />}
          Create
        </Button>
      </div>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border bg-background min-h-16 border px-3 py-2">
      <div className="text-muted-foreground text-[12px] uppercase leading-[16px] tracking-[0.04em]">{label}</div>
      <MonoText>{value}</MonoText>
    </div>
  )
}

function RuntimeRows({ rows }: { rows: ClusterRuntimeRow[] }) {
  const columns = useMemo<DataTableColumn<ClusterRuntimeRow>[]>(
    () => [
      {
        id: 'server',
        header: 'SERVER',
        cell: (row) => <MonoText>{row.serverName}</MonoText>,
      },
      {
        id: 'health',
        header: 'HEALTH',
        cell: (row) => <StatusBadge kind="wls-health" value={row.healthState} />,
      },
      {
        id: 'alive',
        header: 'ALIVE',
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.aliveServerCount)}</MonoText>,
      },
      {
        id: 'primaries',
        header: 'PRIMARY',
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.primaryCount)}</MonoText>,
      },
      {
        id: 'secondaries',
        header: 'SECONDARY',
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.secondaryCount)}</MonoText>,
      },
      {
        id: 'services',
        header: 'SINGLETONS',
        cell: (row) => (
          <MonoText className={row.activeSingletonServices.length === 0 ? 'text-status-neutral' : ''}>
            {row.activeSingletonServices.join(', ') || '-'}
          </MonoText>
        ),
      },
    ],
    [],
  )

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowId={(row) => row.id}
      loading={false}
      empty="No cluster runtime rows are available."
    />
  )
}

function ReplicationRows({ rows }: { rows: ClusterReplicationRow[] }) {
  const columns = useMemo<DataTableColumn<ClusterReplicationRow>[]>(
    () => [
      {
        id: 'server',
        header: 'SERVER',
        cell: (row) => <MonoText>{row.serverName}</MonoText>,
      },
      {
        id: 'family',
        header: 'FAMILY',
        cell: (row) => <MonoText>{row.family}</MonoText>,
      },
      {
        id: 'name',
        header: 'NAME',
        cell: (row) => <MonoText>{row.name}</MonoText>,
      },
      {
        id: 'primaries',
        header: 'PRIMARY',
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.primaryCount)}</MonoText>,
      },
      {
        id: 'secondaries',
        header: 'SECONDARY',
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.secondaryCount)}</MonoText>,
      },
      {
        id: 'waiting',
        header: 'WAITING',
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.sessionsWaitingForFlushCount)}</MonoText>,
      },
      {
        id: 'remote',
        header: 'REMOTE',
        cell: (row) => (
          <MonoText className={row.remoteClusterReachable === null ? 'text-status-neutral' : ''}>
            {row.remoteClusterReachable === null ? '-' : row.remoteClusterReachable ? 'reachable' : 'unreachable'}
          </MonoText>
        ),
      },
    ],
    [],
  )

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowId={(row) => row.id}
      loading={false}
      empty="No optional replication runtime rows are available."
    />
  )
}

function ConfigFieldTable({
  endpoint,
  data,
}: {
  endpoint: TopologyEndpointCatalog
  data: unknown
}) {
  const record = isObject(data) ? data : {}

  return (
    <div className="overflow-x-auto border border-border bg-background">
      <table className="min-w-full border-collapse text-left text-[13px] leading-[18px]">
        <thead className="text-muted-foreground border-b border-border text-[11px] uppercase leading-[14px] tracking-[0.04em]">
          <tr>
            <th className="px-3 py-2 font-medium">Field</th>
            <th className="px-3 py-2 font-medium">Value</th>
            <th className="px-3 py-2 font-medium">Mode</th>
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 font-medium">Restart</th>
          </tr>
        </thead>
        <tbody>
          {endpoint.fields.map((field) => {
            const value = formatConfigValue(field, record[field.jsonProperty])
            return (
              <tr key={field.id} className="border-b border-border last:border-b-0">
                <td className="px-3 py-2">
                  <span className="block truncate" title={field.label}>{field.label}</span>
                  <MonoText className="text-muted-foreground block truncate text-[12px]" title={field.jsonProperty}>
                    {field.jsonProperty}
                  </MonoText>
                </td>
                <td className="px-3 py-2">
                  <MonoText className={value === '-' ? 'text-status-neutral' : 'block max-w-[360px] truncate'} title={value}>
                    {value}
                  </MonoText>
                </td>
                <td className="px-3 py-2">
                  <MonoText className="text-muted-foreground block truncate text-[12px]" title={supportTitle(field)}>
                    {supportLabel(field)}
                  </MonoText>
                </td>
                <td className="px-3 py-2">
                  <MonoText className="text-muted-foreground">{field.valueKind}</MonoText>
                </td>
                <td className="px-3 py-2">
                  <MonoText className="text-muted-foreground">{field.restartNote ? 'yes' : '-'}</MonoText>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ConfigEditForm({
  endpoint,
  draft,
  errors,
  pending,
  onChange,
  onCancel,
  onSubmit,
}: {
  endpoint: TopologyEndpointCatalog
  draft: ConfigEditDraft
  errors: ConfigEditErrors
  pending: boolean
  onChange: (fieldName: string, value: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const fields = editableConfigFields(endpoint)

  return (
    <div className="border-border bg-background border px-3 py-3">
      {errors.__form ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 border px-3 py-2 text-[13px]">
          {errors.__form}
        </div>
      ) : null}

      <div className="grid gap-2 md:grid-cols-3">
        {fields.map((field) => {
          const value = draft.values[field.jsonProperty] ?? ''
          const error = errors[field.jsonProperty]
          const isProtectedInput = field.sensitive || field.writeSupport === 'write-only' || field.valueKind === 'secret'

          return (
            <label key={field.id}>
              <FieldLabel>{field.label}</FieldLabel>
              {field.valueKind === 'boolean' ? (
                <select
                  value={value}
                  disabled={pending}
                  onChange={(event) => onChange(field.jsonProperty, event.target.value)}
                  className={`${selectClass} w-full font-mono ${error ? 'border-status-negative focus-visible:ring-status-negative/40' : ''}`}
                >
                  <option value="">Unset</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <Input
                  type={isProtectedInput ? 'password' : 'text'}
                  value={value}
                  disabled={pending}
                  placeholder={isProtectedInput ? 'Leave blank to keep current value' : undefined}
                  onChange={(event) => onChange(field.jsonProperty, event.target.value)}
                  className={textInputClass(error)}
                />
              )}
              <MonoText className="text-muted-foreground mt-1 block truncate text-[12px]" title={field.jsonProperty}>
                {field.jsonProperty}
              </MonoText>
              <FieldError value={error} />
            </label>
          )
        })}
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          <X className="size-3.5" strokeWidth={1.5} />
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={pending} onClick={onSubmit}>
          {pending ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : <Save className="size-3.5" strokeWidth={1.5} />}
          Review changes
        </Button>
      </div>
    </div>
  )
}

function ConfigEndpointPanel({
  endpoint,
  section,
  root,
  failure,
  readOnlyDemoMode,
  editDraft,
  editErrors,
  editPending,
  onStartEdit,
  onEditChange,
  onCancelEdit,
  onSubmitEdit,
}: {
  endpoint: TopologyEndpointCatalog
  section: TopologySectionData | null
  root: Record<string, unknown>
  failure: string | null
  readOnlyDemoMode: boolean
  editDraft: ConfigEditDraft | null
  editErrors: ConfigEditErrors
  editPending: boolean
  onStartEdit: (endpoint: TopologyEndpointCatalog, data: unknown) => void
  onEditChange: (fieldName: string, value: string) => void
  onCancelEdit: () => void
  onSubmitEdit: () => void
}) {
  const data = endpoint.endpointKind === 'root' ? root : section?.data
  const isEditing = editDraft?.endpointId === endpoint.id
  const canEdit =
    !readOnlyDemoMode &&
    !failure &&
    endpoint.endpointKind !== 'collection-child' &&
    editableConfigFields(endpoint).length > 0 &&
    isObject(data)

  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14px] font-medium leading-5">{endpoint.sectionLabel}</h3>
          <MonoText className="text-muted-foreground mt-1 block truncate text-[12px]" title={endpoint.pathTemplate}>
            {endpoint.pathTemplate}
          </MonoText>
        </div>
        <div className="flex items-center gap-2">
          <MonoText className="text-muted-foreground text-[12px] leading-[16px]">
            {endpoint.fields.length.toLocaleString()} fields
          </MonoText>
          {canEdit && !isEditing ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onStartEdit(endpoint, data)}>
              <Pencil className="size-3.5" strokeWidth={1.5} />
              Edit
            </Button>
          ) : null}
        </div>
      </div>

      {failure ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 border px-3 py-2 text-[13px]">
          <MonoText className="block truncate" title={failure}>{failure}</MonoText>
        </div>
      ) : null}

      {isEditing && editDraft ? (
        <ConfigEditForm
          endpoint={endpoint}
          draft={editDraft}
          errors={editErrors}
          pending={editPending}
          onChange={onEditChange}
          onCancel={onCancelEdit}
          onSubmit={onSubmitEdit}
        />
      ) : endpoint.endpointKind === 'collection-child' ? (
        <div className="border-border bg-background px-3 py-3 text-[13px] text-muted-foreground">
          Collection child resources are not reported for this cluster section.
        </div>
      ) : (
        <ConfigFieldTable endpoint={endpoint} data={data} />
      )}
    </section>
  )
}

function ClusterDetailTabs({
  activeTab,
  onChange,
}: {
  activeTab: ClusterDetailTab
  onChange: (tab: ClusterDetailTab) => void
}) {
  const tabClass = 'h-8 border-b-2 px-3 text-[13px] leading-[18px]'

  return (
    <div className="border-b border-border">
      <div role="tablist" aria-label="Cluster detail sections" className="flex items-center gap-1">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'overview'}
          className={`${tabClass} ${activeTab === 'overview' ? 'border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => onChange('overview')}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'configuration'}
          className={`${tabClass} ${activeTab === 'configuration' ? 'border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => onChange('configuration')}
        >
          Configuration
        </button>
      </div>
    </div>
  )
}

function ClusterConfigurationPanel({
  clusterName,
  resource,
  endpoints,
  isLoading,
  isFetching,
  isError,
  error,
  updatedAt,
  readOnlyDemoMode,
  editDraft,
  editErrors,
  editPending,
  editResult,
  editError,
  deleteBlockedReason,
  onRetry,
  onRequestDelete,
  onStartEdit,
  onEditChange,
  onCancelEdit,
  onSubmitEdit,
}: {
  clusterName: string
  resource: TopologyConfiguredResource | null
  endpoints: TopologyEndpointCatalog[]
  isLoading: boolean
  isFetching: boolean
  isError: boolean
  error: unknown
  updatedAt: number
  readOnlyDemoMode: boolean
  editDraft: ConfigEditDraft | null
  editErrors: ConfigEditErrors
  editPending: boolean
  editResult: ClusterConfigResult | null
  editError: string | null
  deleteBlockedReason: string | null
  onRetry: () => void
  onRequestDelete: () => void
  onStartEdit: (endpoint: TopologyEndpointCatalog, data: unknown) => void
  onEditChange: (fieldName: string, value: string) => void
  onCancelEdit: () => void
  onSubmitEdit: () => void
}) {
  const sectionsByEndpoint = useMemo(
    () => new Map(resource?.sections.map((section) => [section.endpointId, section]) ?? []),
    [resource?.sections],
  )
  const failuresByEndpoint = useMemo(() => {
    const map = new Map<string, string>()
    resource?.partialFailures.forEach((failure) => {
      map.set(failure.endpointId, failure.message)
    })
    return map
  }, [resource?.partialFailures])

  return (
    <div className="space-y-4">
      <section className="border-border bg-surface-1 border px-3 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[14px] font-medium leading-5">Configuration</h2>
            <p className="text-muted-foreground text-[13px] leading-[18px]">
              Edit-tree metadata for <MonoText>{clusterName}</MonoText>.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {updatedAt ? (
              <span className="text-muted-foreground text-[13px] leading-[18px]">
                Updated <RelativeTime value={updatedAt} />
              </span>
            ) : null}
            {!readOnlyDemoMode ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={editPending || !!deleteBlockedReason}
                title={deleteBlockedReason ?? undefined}
                onClick={onRequestDelete}
                className="text-status-negative hover:text-status-negative"
              >
                <Trash2 className="size-3.5" strokeWidth={1.5} />
                Delete cluster
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
              <RefreshCw className="size-3.5" strokeWidth={1.5} />
              Refresh
            </Button>
          </div>
        </div>
      </section>

      {editResult ? (
        <div
          role="status"
          aria-live="polite"
          className="border-status-positive/60 bg-status-positive/8 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]"
        >
          <span className="text-status-positive font-medium">Configuration accepted</span>
          <span className="text-muted-foreground min-w-0 truncate font-mono">{editResult.detail}</span>
        </div>
      ) : null}

      {editError ? (
        <div
          role="alert"
          className="border-status-negative/60 bg-status-negative/8 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]"
        >
          <span className="text-status-negative font-medium">Configuration failed</span>
          <span className="min-w-0 truncate font-mono">{editError}</span>
        </div>
      ) : null}

      {isLoading ? (
        <div className="text-muted-foreground flex h-24 items-center justify-center gap-2 border-b border-border text-[13px]">
          <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          Loading configuration...
        </div>
      ) : null}

      {isError ? (
        <div className="border-status-negative/60 bg-status-negative/8 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate font-mono">
            {error instanceof Error ? error.message : 'Unable to load cluster configuration.'}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}

      {!isLoading && !isError && !resource ? (
        <div className="border-border bg-surface-1 px-3 py-3 text-[13px] text-muted-foreground">
          No edit-tree configuration row reported for <MonoText>{clusterName}</MonoText>.
        </div>
      ) : null}

      {resource ? (
        <>
          {isFetching ? (
            <div className="text-muted-foreground flex items-center gap-2 text-[13px]">
              <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
              Updating configuration...
            </div>
          ) : null}
          {endpoints.map((endpoint) => (
            <ConfigEndpointPanel
              key={endpoint.id}
              endpoint={endpoint}
              root={resource.root}
              section={sectionsByEndpoint.get(endpoint.id) ?? null}
              failure={failuresByEndpoint.get(endpoint.id) ?? null}
              readOnlyDemoMode={readOnlyDemoMode}
              editDraft={editDraft}
              editErrors={editDraft?.endpointId === endpoint.id ? editErrors : {}}
              editPending={editPending}
              onStartEdit={onStartEdit}
              onEditChange={onEditChange}
              onCancelEdit={onCancelEdit}
              onSubmitEdit={onSubmitEdit}
            />
          ))}
        </>
      ) : null}
    </div>
  )
}

export function Clusters() {
  const { creds } = useAuth()
  const queryClient = useQueryClient()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [createForm, setCreateForm] = useState<CreateClusterForm>(() => initialCreateClusterForm())
  const [createErrors, setCreateErrors] = useState<CreateClusterErrors>({})
  const [createIntent, setCreateIntent] = useState<CreateClusterIntent | null>(null)
  const [configResult, setConfigResult] = useState<ClusterConfigResult | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const query = useClusterSnapshot()
  const readOnlyDemoMode = readOnlyDemoModeEnabled()
  const topologyQuery = useTopologyConfigurationSnapshot({ enabled: showCreateForm && !readOnlyDemoMode })
  const returnState = useMemo(() => detailReturnState(location), [location])
  const allRows = useMemo(() => query.data?.clusters ?? [], [query.data?.clusters])
  const configuredClusterNames = useMemo(
    () => topologyQuery.data?.clusters.map((cluster) => cluster.name).sort(compareText) ?? [],
    [topologyQuery.data?.clusters],
  )
  const clusterNames = useMemo(
    () => [...new Set([...allRows.map((row) => row.name), ...configuredClusterNames])].sort(compareText),
    [allRows, configuredClusterNames],
  )
  const tableState = useMemo(
    () => parseRuntimeTableUrlState(searchParams, CLUSTERS_TABLE_URL_CONFIG),
    [searchParams],
  )
  const sort = tableState.sort
  const effectiveSort = sort ?? DEFAULT_SORT
  const search = tableState.search
  const failures = query.data?.partialFailures ?? []
  const hasActiveFilters = search.trim().length > 0

  const updateTableState = useCallback(
    (patch: Partial<RuntimeTableUrlState>) => {
      const next = {
        search: patch.search ?? tableState.search,
        filters: tableState.filters,
        sort: patch.sort === undefined ? tableState.sort : patch.sort,
      }
      setSearchParams(serializeRuntimeTableUrlState(next, CLUSTERS_TABLE_URL_CONFIG, searchParams), { replace: true })
    },
    [searchParams, setSearchParams, tableState],
  )

  const configMutation = useMutation<ClusterConfigResult, Error, CreateClusterIntent>({
    mutationFn: async (intent) => {
      if (!creds) throw new Error('not authenticated')
      await runTopologyEditTransaction(creds, intent.detail, [
        createTopologyResourceStep(creds, 'cluster', intent.clusterName, intent.input),
      ])
      return { detail: `${intent.detail} accepted.` }
    },
    onMutate: () => {
      setConfigResult(null)
      setConfigError(null)
    },
    onSuccess: (result) => {
      setConfigResult(result)
      setCreateForm(initialCreateClusterForm())
      setCreateErrors({})
      setShowCreateForm(false)
      setCreateIntent(null)
    },
    onError: (error) => {
      setConfigError(error.message || 'Cluster configuration failed.')
    },
    onSettled: async () => {
      await Promise.all([
        query.refetch(),
        topologyQuery.refetch(),
        invalidateTopologyConfigurationQueries(queryClient, creds),
      ])
    },
  })

  const openCreateForm = useCallback(() => {
    if (readOnlyDemoMode) return
    setCreateErrors({})
    setConfigResult(null)
    setConfigError(null)
    setShowCreateForm(true)
  }, [readOnlyDemoMode])

  const cancelCreateForm = useCallback(() => {
    if (configMutation.isPending) return
    setShowCreateForm(false)
    setCreateErrors({})
    setCreateIntent(null)
  }, [configMutation.isPending])

  const submitCreateForm = useCallback(() => {
    if (!creds || readOnlyDemoMode) return
    const validation = validateCreateClusterForm(createForm, {
      configurationLoaded: !!topologyQuery.data && !topologyQuery.isFetching,
      clusterNames,
    })
    setCreateErrors(validation.errors)
    if (!validation.valid) return
    setCreateIntent(createClusterIntent(createForm))
  }, [clusterNames, createForm, creds, readOnlyDemoMode, topologyQuery.data, topologyQuery.isFetching])

  const confirmCreateIntent = useCallback(() => {
    if (!createIntent || configMutation.isPending) return
    configMutation.mutate(createIntent)
  }, [configMutation, createIntent])

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return allRows
      .filter((row) => needle.length === 0 || searchText(row).includes(needle))
      .sort((a, b) => compareRows(a, b, effectiveSort))
  }, [allRows, effectiveSort, search])

  const columns = useMemo<DataTableColumn<ClusterRow>[]>(
    () => [
      {
        id: 'name',
        header: 'CLUSTER',
        sortable: true,
        className: 'min-w-[180px]',
        cell: (row) => (
          <Link
            to={`/clusters/${encodeURIComponent(row.name)}`}
            state={returnState}
            className="hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MonoText className="font-medium">{row.name}</MonoText>
          </Link>
        ),
      },
      {
        id: 'health',
        header: 'HEALTH',
        sortable: true,
        cell: (row) => <StatusBadge kind="wls-health" value={row.healthState} />,
      },
      {
        id: 'members',
        header: 'MEMBERS',
        sortable: true,
        align: 'right',
        cell: (row) => <MonoText>{row.configuredMemberNames.length.toLocaleString()}</MonoText>,
      },
      {
        id: 'alive',
        header: 'ALIVE',
        sortable: true,
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.aliveServerCount)}</MonoText>,
      },
      {
        id: 'state',
        header: 'STATE SPREAD',
        cell: (row) => <MonoText>{stateSummary(row)}</MonoText>,
      },
      {
        id: 'primaries',
        header: 'PRIMARY',
        sortable: true,
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.primaryCount)}</MonoText>,
      },
      {
        id: 'secondaries',
        header: 'SECONDARY',
        sortable: true,
        align: 'right',
        cell: (row) => <MonoText>{formatNumber(row.secondaryCount)}</MonoText>,
      },
      {
        id: 'mode',
        header: 'MODE',
        cell: (row) => <MonoText>{formatText(row.clusterMessagingMode)}</MonoText>,
      },
    ],
    [returnState],
  )

  return (
    <div>
      <PageHeader
        title="Clusters"
        subtitle="Cluster membership, runtime health, and configuration."
        action={
          <div className="flex items-center gap-2">
            {!readOnlyDemoMode ? (
              <Button type="button" size="sm" disabled={configMutation.isPending} onClick={openCreateForm}>
                <Plus className="size-3.5" strokeWidth={1.5} />
                Create cluster
              </Button>
            ) : null}
          </div>
        }
        updatedAt={query.dataUpdatedAt}
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
        meta={
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="relative w-[320px] max-w-full">
              <Search className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2" strokeWidth={1.5} />
              <Input
                value={search}
                onChange={(event) => updateTableState({ search: event.target.value })}
                placeholder="Search clusters or members"
                className="pl-8"
              />
            </div>
            <span className="text-muted-foreground text-[13px] leading-[18px]">
              {rows.length.toLocaleString()} of {allRows.length.toLocaleString()} clusters
            </span>
          </div>
        }
      />

      <ConfirmDialog
        open={!!createIntent}
        title="Create cluster?"
        description="This will stage and activate WebLogic edit-tree changes. No servers are assigned automatically."
        subject={createIntent?.subject}
        confirmLabel="Create cluster"
        pending={configMutation.isPending}
        onConfirm={confirmCreateIntent}
        onCancel={() => setCreateIntent(null)}
      />

      {showCreateForm && !readOnlyDemoMode ? (
        <CreateClusterPanel
          form={createForm}
          errors={createErrors}
          disabled={configMutation.isPending}
          onChange={setCreateForm}
          onCancel={cancelCreateForm}
          onSubmit={submitCreateForm}
        />
      ) : null}

      {configResult ? (
        <div
          role="status"
          aria-live="polite"
          className="border-status-positive/60 bg-status-positive/8 mb-3 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]"
        >
          <span className="text-status-positive font-medium">Cluster configuration accepted</span>
          <span className="text-muted-foreground min-w-0 truncate font-mono">{configResult.detail}</span>
        </div>
      ) : null}

      {configError ? (
        <div
          role="alert"
          className="border-status-negative/60 bg-status-negative/8 mb-3 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]"
        >
          <span className="text-status-negative font-medium">Cluster configuration failed</span>
          <span className="min-w-0 truncate font-mono">{configError}</span>
        </div>
      ) : null}

      <PartialBanner failures={failures} onRetry={() => query.refetch()} />

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        sort={sort}
        onSortChange={(nextSort) => updateTableState({ sort: nextSort })}
        loading={query.isLoading || query.isFetching}
        error={query.error ? { message: query.error.message, retry: () => query.refetch() } : null}
        empty={{
          message: hasActiveFilters ? 'No clusters match the current filters.' : 'No clusters reported.',
          hint: hasActiveFilters ? 'Clear search to show all configured clusters.' : 'This domain may not define WebLogic clusters.',
        }}
      />
    </div>
  )
}

export function ClusterDetails() {
  const { creds } = useAuth()
  const queryClient = useQueryClient()
  const { clusterName = '' } = useParams()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [configEditDraft, setConfigEditDraft] = useState<ConfigEditDraft | null>(null)
  const [configEditErrors, setConfigEditErrors] = useState<ConfigEditErrors>({})
  const [configEditIntent, setConfigEditIntent] = useState<ConfigEditIntent | null>(null)
  const [configEditResult, setConfigEditResult] = useState<ClusterConfigResult | null>(null)
  const [configEditError, setConfigEditError] = useState<string | null>(null)
  const query = useClusterSnapshot()
  const readOnlyDemoMode = readOnlyDemoModeEnabled()
  const decodedClusterName = routeParam(clusterName)
  const requestedTab = searchParams.get('tab')
  const activeTab: ClusterDetailTab = requestedTab === 'configuration' ? 'configuration' : 'overview'
  const row = useMemo(
    () => (query.data?.clusters ?? []).find((candidate) => candidate.name === decodedClusterName) ?? null,
    [decodedClusterName, query.data?.clusters],
  )
  const returnPath = detailReturnPath(location.state, '/clusters')
  const topologyQuery = useTopologyConfigurationSnapshot({ enabled: activeTab === 'configuration' && !!row })
  const topologyEndpoints = useMemo(
    () => creds ? topologyEndpointsFor('cluster', creds.version) : [],
    [creds],
  )
  const clusterConfiguration = useMemo(
    () => topologyQuery.data?.clusters.find((cluster) => cluster.name === decodedClusterName) ?? null,
    [decodedClusterName, topologyQuery.data?.clusters],
  )
  const deleteBlockedReason = useMemo(
    () => row ? clusterDeleteBlockedReason(row, clusterConfiguration) : 'Cluster row is required before deletion.',
    [clusterConfiguration, row],
  )

  const configEditMutation = useMutation<ClusterConfigResult, Error, ConfigEditIntent>({
    mutationFn: async (intent) => {
      if (!creds) throw new Error('not authenticated')
      const step = intent.kind === 'delete-cluster'
        ? deleteTopologyResourceStep(creds, 'cluster', intent.clusterName)
        : intent.endpointKind === 'root'
          ? updateTopologyResourceStep(creds, 'cluster', intent.clusterName, intent.payload)
          : updateTopologyChildStep(creds, intent.endpointId, intent.clusterName, intent.payload)
      await runTopologyEditTransaction(creds, intent.detail, [step])
      return { detail: `${intent.detail} accepted.` }
    },
    onMutate: () => {
      setConfigEditResult(null)
      setConfigEditError(null)
    },
    onSuccess: (result) => {
      setConfigEditResult(result)
      setConfigEditDraft(null)
      setConfigEditErrors({})
      setConfigEditIntent(null)
    },
    onError: (error) => {
      setConfigEditError(error.message || 'Cluster configuration update failed.')
    },
    onSettled: async () => {
      await Promise.all([
        query.refetch(),
        topologyQuery.refetch(),
        invalidateTopologyConfigurationQueries(queryClient, creds),
      ])
    },
  })

  const setActiveTab = useCallback((tab: ClusterDetailTab) => {
    const next = new URLSearchParams(searchParams)
    if (tab === 'configuration') next.set('tab', 'configuration')
    else next.delete('tab')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const startConfigEdit = useCallback((endpoint: TopologyEndpointCatalog, data: unknown) => {
    if (readOnlyDemoMode || configEditMutation.isPending) return
    setConfigEditDraft(buildConfigEditDraft(endpoint, data))
    setConfigEditErrors({})
    setConfigEditResult(null)
    setConfigEditError(null)
    setConfigEditIntent(null)
  }, [configEditMutation.isPending, readOnlyDemoMode])

  const changeConfigEditValue = useCallback((fieldName: string, value: string) => {
    setConfigEditDraft((current) => current ? {
      ...current,
      values: {
        ...current.values,
        [fieldName]: value,
      },
    } : current)
    setConfigEditErrors((current) => {
      if (!current[fieldName] && !current.__form) return current
      const next = { ...current }
      delete next[fieldName]
      delete next.__form
      return next
    })
  }, [])

  const cancelConfigEdit = useCallback(() => {
    if (configEditMutation.isPending) return
    setConfigEditDraft(null)
    setConfigEditErrors({})
    setConfigEditIntent(null)
  }, [configEditMutation.isPending])

  const submitConfigEdit = useCallback(() => {
    if (!configEditDraft || !clusterConfiguration || readOnlyDemoMode) return
    const endpoint = topologyEndpoints.find((candidate) => candidate.id === configEditDraft.endpointId)
    if (!endpoint) {
      setConfigEditErrors({ __form: 'Configuration endpoint is no longer available.' })
      return
    }
    if (endpoint.endpointKind === 'collection-child') {
      setConfigEditErrors({ __form: 'Collection child resources are edited from their own action controls.' })
      return
    }

    const data = endpoint.endpointKind === 'root'
      ? clusterConfiguration.root
      : clusterConfiguration.sections.find((section) => section.endpointId === endpoint.id)?.data
    if (!isObject(data)) {
      setConfigEditErrors({ __form: 'Configuration section data is unavailable.' })
      return
    }

    const result = buildConfigEditIntent(decodedClusterName, endpoint, data, configEditDraft.values)
    setConfigEditErrors(result.errors)
    if (result.intent) setConfigEditIntent(result.intent)
  }, [clusterConfiguration, configEditDraft, decodedClusterName, readOnlyDemoMode, topologyEndpoints])

  const requestDeleteCluster = useCallback(() => {
    if (!row || readOnlyDemoMode || configEditMutation.isPending) return
    if (deleteBlockedReason) {
      setConfigEditError(deleteBlockedReason)
      return
    }
    if (!clusterConfiguration) {
      setConfigEditError('Configuration row is required before deletion.')
      return
    }
    setConfigEditDraft(null)
    setConfigEditErrors({})
    setConfigEditIntent(buildClusterDeleteIntent(row, clusterConfiguration))
  }, [
    clusterConfiguration,
    configEditMutation.isPending,
    deleteBlockedReason,
    readOnlyDemoMode,
    row,
  ])

  const confirmConfigEditIntent = useCallback(() => {
    if (!configEditIntent || configEditMutation.isPending) return
    configEditMutation.mutate(configEditIntent)
  }, [configEditIntent, configEditMutation])

  const memberColumns = useMemo<DataTableColumn<ClusterMemberRow>[]>(
    () => [
      {
        id: 'server',
        header: 'SERVER',
        className: 'min-w-[180px]',
        cell: (member) => (
          <Link to={`/servers/${encodeURIComponent(member.serverName)}`} className="hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <MonoText className="font-medium">{member.serverName}</MonoText>
          </Link>
        ),
      },
      {
        id: 'state',
        header: 'STATE',
        cell: (member) => <StatusBadge kind="wls-state" value={member.lifecycleState} />,
      },
      {
        id: 'health',
        header: 'HEALTH',
        cell: (member) => <StatusBadge kind="wls-health" value={member.healthState} />,
      },
      {
        id: 'alive',
        header: 'CLUSTER VIEW',
        cell: (member) => (
          <StatusBadge
            kind="custom"
            tone={member.alive ? 'positive' : member.runtimeAvailable ? 'warning' : 'neutral'}
            label={member.alive ? 'alive' : member.runtimeAvailable ? 'not reported' : 'runtime unavailable'}
          />
        ),
      },
      {
        id: 'listen',
        header: 'LISTEN',
        cell: (member) => <MonoText>{formatListen(member)}</MonoText>,
      },
    ],
    [],
  )

  if (query.isLoading && !row) {
    return (
      <div>
        <PageHeader title="Cluster" subtitle="Loading cluster runtime details." />
        <DataTable columns={[]} rows={[]} getRowId={() => 'loading'} loading />
      </div>
    )
  }

  if (query.error) {
    return (
      <div>
        <PageHeader
          title={decodedClusterName || 'Cluster'}
          subtitle="Cluster runtime details failed to load."
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => query.refetch()}>
              <RefreshCw className="size-4" strokeWidth={1.5} />
              Retry
            </Button>
          }
        />
        <div className="border-status-negative/60 bg-status-negative/8 border px-3 py-2 text-[13px]">{query.error.message}</div>
      </div>
    )
  }

  if (!row) {
    return (
      <div>
        <PageHeader
          title={decodedClusterName || 'Cluster'}
          subtitle="Cluster was not found in the current domain snapshot."
          action={
            <Button asChild variant="outline" size="sm">
              <Link to={returnPath}>
                <Network className="size-4" strokeWidth={1.5} />
                Back to Clusters
              </Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={row.name}
        subtitle="Cluster runtime detail and member health."
        meta={
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="-ml-2">
              <Link to={returnPath}>
                <ArrowLeft className="size-3.5" strokeWidth={1.5} />
                Clusters
              </Link>
            </Button>
            <StatusBadge kind="wls-health" value={row.healthState} />
            <MonoText className="text-muted-foreground">{stateSummary(row)}</MonoText>
          </div>
        }
        updatedAt={query.dataUpdatedAt}
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
      />

      <ConfirmDialog
        open={!!configEditIntent}
        title={configEditIntent?.kind === 'delete-cluster' ? 'Delete cluster?' : 'Activate cluster configuration changes?'}
        description={
          configEditIntent?.kind === 'delete-cluster'
            ? 'This will stage and activate a WebLogic edit-tree delete for the cluster.'
            : 'This will stage and activate WebLogic edit-tree changes for the selected cluster section.'
        }
        subject={
          configEditIntent
            ? `${configEditIntent.sectionLabel} | ${configEditIntent.changedFields.join(', ')}`
            : undefined
        }
        confirmLabel={configEditIntent?.kind === 'delete-cluster' ? 'Delete cluster' : 'Activate changes'}
        pending={configEditMutation.isPending}
        onConfirm={confirmConfigEditIntent}
        onCancel={() => setConfigEditIntent(null)}
      />

      <ClusterDetailTabs activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === 'configuration' ? (
        <ClusterConfigurationPanel
          clusterName={decodedClusterName}
          resource={clusterConfiguration}
          endpoints={topologyEndpoints}
          isLoading={topologyQuery.isLoading}
          isFetching={topologyQuery.isFetching}
          isError={topologyQuery.isError}
          error={topologyQuery.error}
          updatedAt={topologyQuery.dataUpdatedAt}
          readOnlyDemoMode={readOnlyDemoMode}
          editDraft={configEditDraft}
          editErrors={configEditErrors}
          editPending={configEditMutation.isPending}
          editResult={configEditResult}
          editError={configEditError}
          deleteBlockedReason={deleteBlockedReason}
          onRetry={() => void topologyQuery.refetch()}
          onRequestDelete={requestDeleteCluster}
          onStartEdit={startConfigEdit}
          onEditChange={changeConfigEditValue}
          onCancelEdit={cancelConfigEdit}
          onSubmitEdit={submitConfigEdit}
        />
      ) : (
        <>
          <PartialBanner failures={row.partialFailures} onRetry={() => query.refetch()} />

          <section className="grid gap-2 md:grid-cols-5">
            <Metric label="Members" value={row.configuredMemberNames.length.toLocaleString()} />
            <Metric label="Alive" value={formatNumber(row.aliveServerCount)} />
            <Metric label="Primary" value={formatNumber(row.primaryCount)} />
            <Metric label="Secondary" value={formatNumber(row.secondaryCount)} />
            <Metric label="Mode" value={formatText(row.clusterMessagingMode)} />
          </section>

          <section className="grid gap-2 md:grid-cols-3">
            <Metric label="Address" value={formatText(row.clusterAddress)} />
            <Metric label="Type" value={formatText(row.clusterType)} />
            <Metric label="Singletons" value={row.activeSingletonServices.join(', ') || '-'} />
          </section>

          <section className="space-y-2">
            <div className="text-[14px] font-medium leading-[20px]">Members</div>
            <DataTable
              columns={memberColumns}
              rows={row.members}
              getRowId={(member) => member.id}
              loading={false}
              empty="No configured cluster members were reported."
            />
          </section>

          <section className="space-y-2">
            <div className="text-[14px] font-medium leading-[20px]">Cluster Runtime</div>
            <RuntimeRows rows={row.runtimeRows} />
          </section>

          <section className="space-y-2">
            <div className="text-[14px] font-medium leading-[20px]">Replication</div>
            <ReplicationRows rows={row.replicationRows} />
          </section>
        </>
      )}
    </div>
  )
}
