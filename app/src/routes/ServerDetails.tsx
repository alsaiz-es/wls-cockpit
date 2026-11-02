import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Clipboard, Download, FileText, Loader2, Pencil, Plus, RadioTower, RefreshCw, Save, Trash2, Workflow, X } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type WlsCredentials } from '@/api/client'
import { readOnlyDemoModeEnabled } from '@/api/runtime-config'
import { ServerDebugTab } from './server-debug-tab'
import {
  serverHeapDumpSupport,
  shouldShowHeapDumpUnsupported,
  fetchServerThreadDump,
  threadDumpFilename,
  type ServerHeapDumpUnsupported,
  type ServerThreadDump,
} from '@/api/queries/server-diagnostics'
import { heapUtilization } from '@/api/queries/heap-utilization'
import {
  getMetricHistorySeries,
  serverMetricResourceId,
  useMetricHistoryRecorder,
  type MetricHistorySampleInput,
} from '@/api/queries/metric-history'
import { workManagersRouteForServer } from '@/api/queries/work-managers'
import {
  useServerLifecycleTasks,
  type ServerLifecycleHistoryTask,
} from '@/api/queries/server-lifecycle-tasks'
import {
  formatNodeManagerEndpoint,
  nodeManagerTone,
  useNodeManagerForServer,
  type NodeManagerRow,
} from '@/api/queries/node-manager'
import { useServerRuntimeDetail, type ServerRuntimeRow } from '@/api/queries/server-runtimes'
import {
  invalidateTopologyConfigurationQueries,
  readTopologyReferenceName,
  readTopologyReferenceNames,
  runTopologyEditTransaction,
  topologyReference,
  topologyReferenceList,
  createTopologyChildStep,
  deleteTopologyChildStep,
  deleteTopologyResourceStep,
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog, HeapBar, MonoText, PageHeader, RelativeTime, RestartRequiredBadge, StatusBadge } from '@/components'
import { detailReturnPath } from './detail-return-state'
import type { ServerMetricCaptureFixtureName } from './server-metrics-fixtures'
import { ServerMetricsTab } from './server-metrics-tab'
import {
  buildConfigEditDraft,
  buildServerDeleteIntent,
  buildTopologySectionEditIntent,
  serverDeleteBlockedReason,
  type ConfigEditDraft,
  type ConfigEditErrors,
} from './topology-configuration-route-model'
import { routeParam } from './route-params'

type ServerDetailTab = 'overview' | 'metrics' | 'configuration' | 'debug'

interface ConfigChildDraft extends ConfigEditDraft {
  mode: 'create' | 'update'
  childName: string | null
}

interface ConfigEditIntent {
  kind: 'create-child' | 'delete-child' | 'delete-server' | 'update-child' | 'update-section'
  endpointId: string
  endpointKind: TopologyEndpointCatalog['endpointKind']
  sectionLabel: string
  serverName: string
  childName: string | null
  changedFields: string[]
  payload: Record<string, unknown>
  detail: string
}

interface ConfigEditResult {
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

function formatListen(row: ServerRuntimeRow, defaultHost: string) {
  if (row.listenPort === null) return '-'
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

function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'

  const totalMinutes = Math.max(0, Math.floor(value / 60_000))
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatTaskTime(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '-'
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatDumpBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function taskTone(task: ServerLifecycleHistoryTask) {
  const text = `${task.status ?? ''} ${task.progress ?? ''}`.toLowerCase()
  if (task.errorMessage || text.includes('fail')) return 'negative'
  if (task.running || task.completed === false || text.includes('progress')) return 'warning'
  if (task.completed || text.includes('success') || text.includes('completed')) return 'positive'
  return 'neutral'
}

function taskStatusLabel(task: ServerLifecycleHistoryTask) {
  return task.status ?? task.progress ?? (task.running ? 'RUNNING' : 'UNKNOWN')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readItems(value: unknown): Record<string, unknown>[] {
  return isObject(value) && Array.isArray(value.items)
    ? value.items.filter((item): item is Record<string, unknown> => isObject(item))
    : []
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

function splitListDraft(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function draftValueForConfigField(field: TopologyFieldMetadata, value: unknown) {
  if (field.sensitive || field.writeSupport === 'write-only') return ''
  const referenceKind = referenceKindForField(field)
  if (referenceKind && field.valueKind === 'reference') {
    return readTopologyReferenceName(value, referenceKind) ?? ''
  }
  if (referenceKind && field.valueKind === 'reference-list') {
    return readTopologyReferenceNames(value, referenceKind).join(', ')
  }
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === 'string' || typeof item === 'number' ? String(item) : '').filter(Boolean).join(', ')
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value
  return ''
}

function validateDraftPattern(field: TopologyFieldMetadata, value: string) {
  if (!field.validation?.pattern || !value) return null
  try {
    return new RegExp(field.validation.pattern).test(value) ? null : `${field.label} does not match the required format.`
  } catch {
    return null
  }
}

function parseConfigDraftValue(field: TopologyFieldMetadata, draftValue: string) {
  const normalized = draftValue.trim()
  // Hidden fields (write-only or sensitive) render empty: blank means "keep the current value",
  // never "clear it", or saving one field would wipe paths such as javaHome or classPath.
  if ((field.writeSupport === 'write-only' || field.sensitive) && !normalized) return { skip: true as const }

  if (field.valueKind === 'boolean') {
    if (!normalized) return { value: null }
    if (normalized === 'true') return { value: true }
    if (normalized === 'false') return { value: false }
    return { error: `${field.label} must be true or false.` }
  }

  if (field.valueKind === 'integer') {
    if (!normalized) return { value: null }
    const value = Number(normalized)
    if (!Number.isInteger(value)) return { error: `${field.label} must be an integer.` }
    const min = field.validation?.min
    const max = field.validation?.max
    if (typeof min === 'number' && value < min) return { error: `${field.label} must be at least ${min}.` }
    if (typeof max === 'number' && value > max) return { error: `${field.label} must be at most ${max}.` }
    return { value }
  }

  if (field.valueKind === 'string-list') {
    return { value: splitListDraft(draftValue) }
  }

  const referenceKind = referenceKindForField(field)
  if (field.valueKind === 'reference') {
    if (!referenceKind) return { error: `${field.label} reference type is unsupported.` }
    return { value: normalized ? topologyReference(referenceKind, normalized) : null }
  }
  if (field.valueKind === 'reference-list') {
    if (!referenceKind) return { error: `${field.label} reference type is unsupported.` }
    return { value: topologyReferenceList(splitListDraft(draftValue).map((name) => topologyReference(referenceKind, name))) }
  }

  if (field.valueKind === 'object') {
    if (!normalized) return { value: null }
    try {
      return { value: JSON.parse(normalized) as unknown }
    } catch {
      return { error: `${field.label} must be valid JSON.` }
    }
  }

  const patternError = validateDraftPattern(field, normalized)
  if (patternError) return { error: patternError }
  if (field.validation?.enumValues && normalized && !field.validation.enumValues.includes(normalized)) {
    return { error: `${field.label} is not a supported value.` }
  }
  return { value: draftValue }
}

function serializedValue(value: unknown) {
  return JSON.stringify(value ?? null)
}

function buildConfigEditIntent(
  serverName: string,
  endpoint: TopologyEndpointCatalog,
  data: unknown,
  values: Record<string, string>,
): { intent: ConfigEditIntent | null; errors: ConfigEditErrors } {
  const result = buildTopologySectionEditIntent({ resourceName: serverName, endpoint, data, values })
  if (!result.intent) return { intent: null, errors: result.errors }
  return {
    errors: {},
    intent: {
      ...result.intent,
      serverName,
      childName: null,
    },
  }
}

function buildConfigChildDraft(endpoint: TopologyEndpointCatalog, mode: 'create' | 'update', data?: Record<string, unknown>): ConfigChildDraft {
  const values = Object.fromEntries(
    configFieldsForMutation(endpoint, mode).map((field) => [
      field.jsonProperty,
      mode === 'create' ? '' : draftValueForConfigField(field, data?.[field.jsonProperty]),
    ]),
  )
  const childName = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : null
  return {
    endpointId: endpoint.id,
    mode,
    childName,
    values,
  }
}

function buildConfigChildIntent(
  serverName: string,
  endpoint: TopologyEndpointCatalog,
  draft: ConfigChildDraft,
  data: Record<string, unknown> | null,
  existingNames: string[],
): { intent: ConfigEditIntent | null; errors: ConfigEditErrors } {
  const errors: ConfigEditErrors = {}
  const payload: Record<string, unknown> = {}
  const changedFields: string[] = []
  const isCreate = draft.mode === 'create'
  const childName = isCreate ? (draft.values.name ?? '').trim() : draft.childName

  if (!childName) {
    errors.name = `${endpoint.childNameParam ?? 'Child resource name'} is required.`
  } else if (isCreate && existingNames.includes(childName)) {
    errors.name = `${childName} already exists.`
  }

  configFieldsForMutation(endpoint, draft.mode).forEach((field) => {
    if (field.jsonProperty === 'name') return
    const draftValue = draft.values[field.jsonProperty] ?? ''
    const originalDraft = data ? draftValueForConfigField(field, data[field.jsonProperty]) : ''
    const hidesCurrentValue = field.sensitive || field.writeSupport === 'write-only'

    if (isCreate && !draftValue.trim()) return
    if (!isCreate && !hidesCurrentValue && draftValue === originalDraft) return

    const parsed = parseConfigDraftValue(field, draftValue)
    if ('skip' in parsed) return
    if ('error' in parsed && typeof parsed.error === 'string') {
      errors[field.jsonProperty] = parsed.error
      return
    }
    if (!isCreate && data && !hidesCurrentValue && serializedValue(parsed.value) === serializedValue(data[field.jsonProperty])) return

    payload[field.jsonProperty] = parsed.value
    changedFields.push(field.label)
  })

  if (Object.keys(errors).length > 0) return { intent: null, errors }
  if (!childName) return { intent: null, errors: { name: `${endpoint.childNameParam ?? 'Child resource name'} is required.` } }

  if (isCreate) {
    changedFields.unshift('Name')
  } else if (changedFields.length === 0) {
    return { intent: null, errors: { __form: 'No changed editable fields.' } }
  }

  const detail = `${isCreate ? 'Create' : 'Update'} ${endpoint.sectionLabel} ${childName} for ${serverName}`
  return {
    errors: {},
    intent: {
      kind: isCreate ? 'create-child' : 'update-child',
      endpointId: endpoint.id,
      endpointKind: endpoint.endpointKind,
      sectionLabel: endpoint.sectionLabel,
      serverName,
      childName,
      changedFields,
      payload,
      detail,
    },
  }
}

function buildConfigChildDeleteIntent(
  serverName: string,
  endpoint: TopologyEndpointCatalog,
  childName: string,
): ConfigEditIntent {
  return {
    kind: 'delete-child',
    endpointId: endpoint.id,
    endpointKind: endpoint.endpointKind,
    sectionLabel: endpoint.sectionLabel,
    serverName,
    childName,
    changedFields: ['Delete'],
    payload: {},
    detail: `Delete ${endpoint.sectionLabel} ${childName} from ${serverName}`,
  }
}

function ConfigFieldError({ value }: { value?: string }) {
  return value ? <div className="text-status-negative mt-1 text-[12px] leading-4">{value}</div> : null
}

function ConfigFieldLabel({ children }: { children: string }) {
  return <span className="text-muted-foreground mb-1 block text-[11px] uppercase leading-[14px] tracking-[0.04em]">{children}</span>
}

const configEditInputClass = 'h-8 rounded-[4px] font-mono text-[13px]'
const configEditSelectClass =
  'border-input bg-background h-8 rounded-[4px] border px-2 font-mono text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

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
  mode,
  draft,
  errors,
  pending,
  onChange,
  onCancel,
  onSubmit,
}: {
  endpoint: TopologyEndpointCatalog
  mode: 'create' | 'update'
  draft: ConfigEditDraft
  errors: ConfigEditErrors
  pending: boolean
  onChange: (fieldName: string, value: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const fields = configFieldsForMutation(endpoint, mode)

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
              <ConfigFieldLabel>{field.label}</ConfigFieldLabel>
              {field.valueKind === 'boolean' ? (
                <select
                  value={value}
                  disabled={pending}
                  onChange={(event) => onChange(field.jsonProperty, event.target.value)}
                  className={`${configEditSelectClass} w-full ${error ? 'border-status-negative focus-visible:ring-status-negative/40' : ''}`}
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
                  className={`${configEditInputClass} ${error ? 'border-status-negative focus-visible:ring-status-negative/40' : ''}`}
                />
              )}
              <MonoText className="text-muted-foreground mt-1 block truncate text-[12px]" title={field.jsonProperty}>
                {field.jsonProperty}
              </MonoText>
              <ConfigFieldError value={error} />
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

function ConfigCollectionTable({
  endpoint,
  data,
  readOnlyDemoMode,
  childDraft,
  childErrors,
  childPending,
  onStartCreateChild,
  onStartEditChild,
  onRequestDeleteChild,
  onChildChange,
  onCancelChild,
  onSubmitChild,
}: {
  endpoint: TopologyEndpointCatalog
  data: unknown
  readOnlyDemoMode: boolean
  childDraft: ConfigChildDraft | null
  childErrors: ConfigEditErrors
  childPending: boolean
  onStartCreateChild: (endpoint: TopologyEndpointCatalog) => void
  onStartEditChild: (endpoint: TopologyEndpointCatalog, item: Record<string, unknown>) => void
  onRequestDeleteChild: (endpoint: TopologyEndpointCatalog, childName: string) => void
  onChildChange: (fieldName: string, value: string) => void
  onCancelChild: () => void
  onSubmitChild: () => void
}) {
  const items = readItems(data)
  const summaryFields = endpoint.fields.filter((field) =>
    ['name', 'protocol', 'listenAddress', 'listenPort', 'enabled'].includes(field.jsonProperty),
  )
  const activeChildDraft = childDraft?.endpointId === endpoint.id ? childDraft : null
  const canCreate = !readOnlyDemoMode && endpoint.capabilities.includes('create')
  const canUpdate = !readOnlyDemoMode && endpoint.capabilities.includes('update')
  const canDelete = !readOnlyDemoMode && endpoint.capabilities.includes('delete')

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        {canCreate ? (
          <Button type="button" variant="outline" size="sm" disabled={childPending} onClick={() => onStartCreateChild(endpoint)}>
            <Plus className="size-3.5" strokeWidth={1.5} />
            New
          </Button>
        ) : null}
      </div>

      {activeChildDraft ? (
        <ConfigEditForm
          endpoint={endpoint}
          mode={activeChildDraft.mode}
          draft={activeChildDraft}
          errors={childErrors}
          pending={childPending}
          onChange={onChildChange}
          onCancel={onCancelChild}
          onSubmit={onSubmitChild}
        />
      ) : null}

      {items.length === 0 ? (
        <div className="border-border bg-background px-3 py-3 text-[13px] text-muted-foreground">
          No child resources reported.
        </div>
      ) : (
        <div className="overflow-x-auto border border-border bg-background">
          <table className="min-w-full border-collapse text-left text-[13px] leading-[18px]">
            <thead className="text-muted-foreground border-b border-border text-[11px] uppercase leading-[14px] tracking-[0.04em]">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Fields</th>
                {!readOnlyDemoMode ? <th className="px-3 py-2 text-right font-medium">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => {
                const name = typeof item.name === 'string' && item.name ? item.name : `item-${index + 1}`
                const summary = summaryFields
                  .map((field) => `${field.jsonProperty}=${formatConfigValue(field, item[field.jsonProperty])}`)
                  .join(' | ')
                return (
                  <tr key={`${name}-${index}`} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">
                      <MonoText className="block max-w-[220px] truncate" title={name}>{name}</MonoText>
                    </td>
                    <td className="px-3 py-2">
                      <MonoText className="text-muted-foreground block max-w-[720px] truncate" title={summary}>
                        {summary || '-'}
                      </MonoText>
                    </td>
                    {!readOnlyDemoMode ? (
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          {canUpdate ? (
                            <Button type="button" variant="ghost" size="xs" disabled={childPending} onClick={() => onStartEditChild(endpoint, item)}>
                              <Pencil className="size-3" strokeWidth={1.5} />
                              Edit
                            </Button>
                          ) : null}
                          {canDelete ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              disabled={childPending}
                              onClick={() => onRequestDeleteChild(endpoint, name)}
                              className="text-status-negative hover:text-status-negative"
                            >
                              <Trash2 className="size-3" strokeWidth={1.5} />
                              Delete
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
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
  childDraft,
  childErrors,
  childPending,
  onStartEdit,
  onEditChange,
  onCancelEdit,
  onSubmitEdit,
  onStartCreateChild,
  onStartEditChild,
  onRequestDeleteChild,
  onChildChange,
  onCancelChild,
  onSubmitChild,
}: {
  endpoint: TopologyEndpointCatalog
  section: TopologySectionData | null
  root: Record<string, unknown>
  failure: string | null
  readOnlyDemoMode: boolean
  editDraft: ConfigEditDraft | null
  editErrors: ConfigEditErrors
  editPending: boolean
  childDraft: ConfigChildDraft | null
  childErrors: ConfigEditErrors
  childPending: boolean
  onStartEdit: (endpoint: TopologyEndpointCatalog, data: unknown) => void
  onEditChange: (fieldName: string, value: string) => void
  onCancelEdit: () => void
  onSubmitEdit: () => void
  onStartCreateChild: (endpoint: TopologyEndpointCatalog) => void
  onStartEditChild: (endpoint: TopologyEndpointCatalog, item: Record<string, unknown>) => void
  onRequestDeleteChild: (endpoint: TopologyEndpointCatalog, childName: string) => void
  onChildChange: (fieldName: string, value: string) => void
  onCancelChild: () => void
  onSubmitChild: () => void
}) {
  const data = endpoint.endpointKind === 'root' ? root : section?.data
  const isEditing = editDraft?.endpointId === endpoint.id
  const editableFields = editableConfigFields(endpoint)
  const canEdit =
    !readOnlyDemoMode &&
    !failure &&
    endpoint.endpointKind !== 'collection-child' &&
    editableFields.length > 0 &&
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
          mode="update"
          draft={editDraft}
          errors={editErrors}
          pending={editPending}
          onChange={onEditChange}
          onCancel={onCancelEdit}
          onSubmit={onSubmitEdit}
        />
      ) : endpoint.endpointKind === 'collection-child' ? (
        <ConfigCollectionTable
          endpoint={endpoint}
          data={data}
          readOnlyDemoMode={readOnlyDemoMode}
          childDraft={childDraft}
          childErrors={childDraft?.endpointId === endpoint.id ? childErrors : {}}
          childPending={childPending}
          onStartCreateChild={onStartCreateChild}
          onStartEditChild={onStartEditChild}
          onRequestDeleteChild={onRequestDeleteChild}
          onChildChange={onChildChange}
          onCancelChild={onCancelChild}
          onSubmitChild={onSubmitChild}
        />
      ) : (
        <ConfigFieldTable endpoint={endpoint} data={data} />
      )}
    </section>
  )
}

function ServerConfigurationPanel({
  serverName,
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
  childDraft,
  childErrors,
  childPending,
  editResult,
  editError,
  deleteServerBlockedReason,
  onRetry,
  onRequestDeleteServer,
  onStartEdit,
  onEditChange,
  onCancelEdit,
  onSubmitEdit,
  onStartCreateChild,
  onStartEditChild,
  onRequestDeleteChild,
  onChildChange,
  onCancelChild,
  onSubmitChild,
}: {
  serverName: string
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
  childDraft: ConfigChildDraft | null
  childErrors: ConfigEditErrors
  childPending: boolean
  editResult: ConfigEditResult | null
  editError: string | null
  deleteServerBlockedReason: string | null
  onRetry: () => void
  onRequestDeleteServer: () => void
  onStartEdit: (endpoint: TopologyEndpointCatalog, data: unknown) => void
  onEditChange: (fieldName: string, value: string) => void
  onCancelEdit: () => void
  onSubmitEdit: () => void
  onStartCreateChild: (endpoint: TopologyEndpointCatalog) => void
  onStartEditChild: (endpoint: TopologyEndpointCatalog, item: Record<string, unknown>) => void
  onRequestDeleteChild: (endpoint: TopologyEndpointCatalog, childName: string) => void
  onChildChange: (fieldName: string, value: string) => void
  onCancelChild: () => void
  onSubmitChild: () => void
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
              Edit-tree metadata for <MonoText>{serverName}</MonoText>.
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
                disabled={editPending || childPending || !!deleteServerBlockedReason}
                title={deleteServerBlockedReason ?? undefined}
                onClick={onRequestDeleteServer}
                className="text-status-negative hover:text-status-negative"
              >
                <Trash2 className="size-3.5" strokeWidth={1.5} />
                Delete server
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
            {error instanceof Error ? error.message : 'Unable to load server configuration.'}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}

      {!isLoading && !isError && !resource ? (
        <div className="border-border bg-surface-1 px-3 py-3 text-[13px] text-muted-foreground">
          No edit-tree configuration row reported for <MonoText>{serverName}</MonoText>.
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
              childDraft={childDraft}
              childErrors={childDraft?.endpointId === endpoint.id ? childErrors : {}}
              childPending={childPending}
              onStartEdit={onStartEdit}
              onEditChange={onEditChange}
              onCancelEdit={onCancelEdit}
              onSubmitEdit={onSubmitEdit}
              onStartCreateChild={onStartCreateChild}
              onStartEditChild={onStartEditChild}
              onRequestDeleteChild={onRequestDeleteChild}
              onChildChange={onChildChange}
              onCancelChild={onCancelChild}
              onSubmitChild={onSubmitChild}
            />
          ))}
        </>
      ) : null}
    </div>
  )
}

function HeapDumpUnsupportedSection({ support }: { support: ServerHeapDumpUnsupported }) {
  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-medium leading-5">Heap Dump</h2>
          <p className="text-muted-foreground mt-1 text-[13px] leading-[18px]">{support.reason}</p>
          <p className="mt-1 text-[13px] leading-[18px]">{support.howTo}</p>
        </div>
        <StatusBadge kind="custom" tone="unknown" label="NOT AVAILABLE" />
      </div>
      <details className="border-border bg-background mt-3 border px-3 py-2">
        <summary className="text-muted-foreground cursor-pointer text-[12px]">Why</summary>
        <div className="mt-1 space-y-1">
          {support.evidence.map((item) => (
            <MonoText key={item} className="text-muted-foreground block text-[12px] leading-4">
              {item}
            </MonoText>
          ))}
        </div>
      </details>
    </section>
  )
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

function ServerDetailTabs({
  activeTab,
  onChange,
}: {
  activeTab: ServerDetailTab
  onChange: (tab: ServerDetailTab) => void
}) {
  const tabClass = 'h-8 border-b-2 px-3 text-[13px] leading-[18px]'

  return (
    <div className="border-b border-border">
      <div role="tablist" aria-label="Server detail sections" className="flex items-center gap-1">
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
          aria-selected={activeTab === 'metrics'}
          className={`${tabClass} ${activeTab === 'metrics' ? 'border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => onChange('metrics')}
        >
          Metrics
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
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'debug'}
          className={`${tabClass} ${activeTab === 'debug' ? 'border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => onChange('debug')}
        >
          Debug
        </button>
      </div>
    </div>
  )
}

function NodeManagerSection({
  row,
  isLoading,
  isFetching,
  isError,
  error,
  onRetry,
}: {
  row: NodeManagerRow | null
  isLoading: boolean
  isFetching: boolean
  isError: boolean
  error: unknown
  onRetry: () => void
}) {
  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-medium leading-5">Node Manager</h2>
          <p className="text-muted-foreground text-[13px] leading-[18px]">
            Machine reachability context used by managed-server start operations.
          </p>
        </div>
        {isFetching ? (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-[13px] leading-[18px]">
            <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
            Updating
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="text-muted-foreground flex min-h-16 items-center justify-center gap-2 border border-border bg-background text-[13px]">
          <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          Loading Node Manager status...
        </div>
      ) : null}

      {isError ? (
        <div className="border-status-warning/60 bg-status-warning/8 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate font-mono">
            {error instanceof Error ? error.message : 'Unable to load Node Manager status.'}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}

      {!isLoading && !isError && !row ? (
        <div className="border-border bg-background flex min-h-14 items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground">
          <RadioTower className="size-4 shrink-0 text-status-neutral" strokeWidth={1.5} />
          Node Manager status is not reported for this server.
        </div>
      ) : null}

      {!isLoading && !isError && row ? (
        <div className="grid gap-3 md:grid-cols-4">
          <div className="border-border bg-background min-h-[72px] border px-3 py-2">
            <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Reachability</div>
            <div className="mt-2">
              <StatusBadge kind="custom" tone={nodeManagerTone(row)} label={row.reachable} />
            </div>
          </div>
          <Metric label="Machine" value={row.machineName} />
          <Metric label="Listen" value={formatNodeManagerEndpoint(row)} detail={row.nmType ?? row.runtimeType ?? '-'} />
          <Metric
            label="Socket Timeout"
            value={row.socketCreateTimeoutMillis === null ? '-' : row.socketCreateTimeoutMillis.toLocaleString()}
            detail="milliseconds"
          />
        </div>
      ) : null}
    </section>
  )
}

function LifecycleTasksSection({
  tasks,
  isLoading,
  isFetching,
  isError,
  error,
  onRetry,
}: {
  tasks: ServerLifecycleHistoryTask[] | undefined
  isLoading: boolean
  isFetching: boolean
  isError: boolean
  error: unknown
  onRetry: () => void
}) {
  const visibleTasks = tasks ?? []

  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-medium leading-5">Lifecycle Tasks</h2>
          <p className="text-muted-foreground text-[13px] leading-[18px]">
            Retained start, suspend, resume, and shutdown task history.
          </p>
        </div>
        {isFetching ? (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-[13px] leading-[18px]">
            <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
            Updating
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="text-muted-foreground flex min-h-16 items-center justify-center gap-2 border border-border bg-background text-[13px]">
          <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          Loading lifecycle tasks...
        </div>
      ) : null}

      {isError ? (
        <div className="border-status-negative/60 bg-status-negative/8 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate font-mono">
            {error instanceof Error ? error.message : 'Unable to load lifecycle tasks.'}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}

      {!isLoading && !isError && visibleTasks.length === 0 ? (
        <div className="border-border bg-background px-3 py-3 text-[13px] text-muted-foreground">
          No retained lifecycle tasks reported.
        </div>
      ) : null}

      {!isLoading && !isError && visibleTasks.length > 0 ? (
        <div className="overflow-x-auto border border-border bg-background">
          <table className="min-w-full border-collapse text-left text-[13px] leading-[18px]">
            <thead className="text-muted-foreground border-b border-border text-[11px] uppercase leading-[14px] tracking-[0.04em]">
              <tr>
                <th className="px-3 py-2 font-medium">Operation</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Ended</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 font-medium">Task</th>
              </tr>
            </thead>
            <tbody>
              {visibleTasks.map((task, index) => (
                <tr key={task.name ?? `${task.operation ?? 'task'}-${index}`} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2">
                    <MonoText className="block max-w-[180px] truncate" title={task.operation ?? '-'}>
                      {task.operation ?? '-'}
                    </MonoText>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge kind="custom" tone={taskTone(task)} label={taskStatusLabel(task)} />
                    {task.errorMessage ? (
                      <MonoText className="text-status-negative mt-1 block max-w-[240px] truncate" title={task.errorMessage}>
                        {task.errorMessage}
                      </MonoText>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <MonoText className="whitespace-nowrap text-muted-foreground">{formatTaskTime(task.startTime)}</MonoText>
                  </td>
                  <td className="px-3 py-2">
                    <MonoText className="whitespace-nowrap text-muted-foreground">
                      {task.running ? 'RUNNING' : formatTaskTime(task.endTime)}
                    </MonoText>
                  </td>
                  <td className="px-3 py-2">
                    <span className="block max-w-[360px] truncate" title={task.description ?? undefined}>
                      {task.description ?? '-'}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <MonoText className="block max-w-[180px] truncate text-muted-foreground" title={task.name ?? '-'}>
                      {task.name ?? '-'}
                    </MonoText>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}

export function ServerDetails() {
  const { creds } = useAuth()
  const queryClient = useQueryClient()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const params = useParams()
  const serverName = routeParam(params.serverName)
  const [threadDump, setThreadDump] = useState<ServerThreadDump | null>(null)
  const [threadDumpFeedback, setThreadDumpFeedback] = useState<string | null>(null)
  const [configEditDraft, setConfigEditDraft] = useState<ConfigEditDraft | null>(null)
  const [configEditErrors, setConfigEditErrors] = useState<ConfigEditErrors>({})
  const [configChildDraft, setConfigChildDraft] = useState<ConfigChildDraft | null>(null)
  const [configChildErrors, setConfigChildErrors] = useState<ConfigEditErrors>({})
  const [configEditIntent, setConfigEditIntent] = useState<ConfigEditIntent | null>(null)
  const [configEditResult, setConfigEditResult] = useState<ConfigEditResult | null>(null)
  const [configEditError, setConfigEditError] = useState<string | null>(null)
  const query = useServerRuntimeDetail(serverName)
  const readOnlyDemoMode = readOnlyDemoModeEnabled()
  const defaultHost = useMemo(() => parseDefaultHost(creds), [creds])
  const returnPath = useMemo(() => detailReturnPath(location.state, '/servers'), [location.state])
  const requestedTab = searchParams.get('tab')
  const activeTab: ServerDetailTab =
    requestedTab === 'metrics'
      ? 'metrics'
      : requestedTab === 'configuration'
        ? 'configuration'
        : requestedTab === 'debug'
          ? 'debug'
          : 'overview'
  const metricsFixture = import.meta.env.DEV && (
    searchParams.get('metricsFixture') === 'active' ||
    searchParams.get('metricsFixture') === 'stopped' ||
    searchParams.get('metricsFixture') === 'unavailable' ||
    searchParams.get('metricsFixture') === 'gap'
  )
    ? searchParams.get('metricsFixture') as ServerMetricCaptureFixtureName
    : null
  const row = query.data ?? null
  const taskQuery = useServerLifecycleTasks(serverName, !!row)
  const nodeManagerQuery = useNodeManagerForServer(serverName, !!row)
  const topologyQuery = useTopologyConfigurationSnapshot({ enabled: activeTab === 'configuration' && !!row })
  const topologyEndpoints = useMemo(
    () => creds ? topologyEndpointsFor('server', creds.version) : [],
    [creds],
  )
  const serverConfiguration = useMemo(
    () => topologyQuery.data?.servers.find((server) => server.name === serverName) ?? null,
    [serverName, topologyQuery.data?.servers],
  )
  const deleteServerBlockedReason = useMemo(
    () => serverDeleteBlockedReason(serverName, row, serverConfiguration),
    [row, serverConfiguration, serverName],
  )
  const heapDumpSupport = useMemo(() => serverHeapDumpSupport(creds?.version ?? 'unknown'), [creds?.version])
  const threadDumpMutation = useMutation({
    mutationFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchServerThreadDump(creds, serverName)
    },
    onMutate: () => {
      setThreadDumpFeedback(null)
    },
    onSuccess: (dump) => {
      setThreadDump(dump)
      setThreadDumpFeedback(null)
    },
  })
  const configEditMutation = useMutation<ConfigEditResult, Error, ConfigEditIntent>({
    mutationFn: async (intent) => {
      if (!creds) throw new Error('not authenticated')
      const step = intent.kind === 'create-child'
        ? createTopologyChildStep(creds, intent.endpointId, intent.serverName, intent.childName ?? '', intent.payload)
        : intent.kind === 'delete-child'
          ? deleteTopologyChildStep(creds, intent.endpointId, intent.serverName, intent.childName ?? '')
          : intent.kind === 'delete-server'
            ? deleteTopologyResourceStep(creds, 'server', intent.serverName)
            : intent.kind === 'update-child'
              ? updateTopologyChildStep(creds, intent.endpointId, intent.serverName, intent.payload, intent.childName ?? '')
              : intent.endpointKind === 'root'
                ? updateTopologyResourceStep(creds, 'server', intent.serverName, intent.payload)
                : updateTopologyChildStep(creds, intent.endpointId, intent.serverName, intent.payload)
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
      setConfigChildDraft(null)
      setConfigChildErrors({})
      setConfigEditIntent(null)
    },
    onError: (error) => {
      setConfigEditError(error.message || 'Server configuration update failed.')
    },
    onSettled: async () => {
      await Promise.all([
        query.refetch(),
        topologyQuery.refetch(),
        invalidateTopologyConfigurationQueries(queryClient, creds),
      ])
    },
  })
  const canCaptureThreadDump = row?.state === 'RUNNING' && !readOnlyDemoMode
  const showHeapDumpUnsupported = shouldShowHeapDumpUnsupported({
    lifecycleState: row?.state,
    readOnlyDemoMode,
    support: heapDumpSupport,
  })
  const currentThreadDump = threadDump?.serverName === serverName ? threadDump : null
  const heapMetricSamples = useMemo((): MetricHistorySampleInput[] => {
    if (!row) return []
    const heapPercent = heapUtilization(row.heap)
    return [
      {
        family: 'servers',
        resourceId: serverMetricResourceId(row.name),
        metric: 'heap.percent',
        value: heapPercent === null ? null : heapPercent * 100,
      },
    ]
  }, [row])
  const heapHistory = useMetricHistoryRecorder({
    creds,
    samples: heapMetricSamples,
    timestamp: query.dataUpdatedAt,
    enabled: !!row,
  })
  const heapSeries = row
    ? getMetricHistorySeries(heapHistory.scopeKey, 'servers', serverMetricResourceId(row.name), 'heap.percent')
    : undefined

  const captureThreadDump = useCallback(() => {
    if (!canCaptureThreadDump || threadDumpMutation.isPending) return
    threadDumpMutation.mutate()
  }, [canCaptureThreadDump, threadDumpMutation])

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
    if (!configEditDraft || !serverConfiguration || readOnlyDemoMode) return
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
      ? serverConfiguration.root
      : serverConfiguration.sections.find((section) => section.endpointId === endpoint.id)?.data
    if (!isObject(data)) {
      setConfigEditErrors({ __form: 'Configuration section data is unavailable.' })
      return
    }

    const result = buildConfigEditIntent(serverName, endpoint, data, configEditDraft.values)
    setConfigEditErrors(result.errors)
    if (result.intent) setConfigEditIntent(result.intent)
  }, [configEditDraft, readOnlyDemoMode, serverConfiguration, serverName, topologyEndpoints])

  const confirmConfigEditIntent = useCallback(() => {
    if (!configEditIntent || configEditMutation.isPending) return
    // Runtime polling continues while the dialog is open: the server may have started since it
    // was opened, so the delete guard is evaluated again on the latest state.
    if (configEditIntent.kind === 'delete-server' && deleteServerBlockedReason) {
      setConfigEditIntent(null)
      setConfigEditError(deleteServerBlockedReason)
      return
    }
    configEditMutation.mutate(configEditIntent)
  }, [configEditIntent, configEditMutation, deleteServerBlockedReason])

  const startCreateChild = useCallback((endpoint: TopologyEndpointCatalog) => {
    if (readOnlyDemoMode || configEditMutation.isPending) return
    setConfigChildDraft(buildConfigChildDraft(endpoint, 'create'))
    setConfigChildErrors({})
    setConfigEditDraft(null)
    setConfigEditErrors({})
    setConfigEditResult(null)
    setConfigEditError(null)
    setConfigEditIntent(null)
  }, [configEditMutation.isPending, readOnlyDemoMode])

  const startEditChild = useCallback((endpoint: TopologyEndpointCatalog, item: Record<string, unknown>) => {
    if (readOnlyDemoMode || configEditMutation.isPending) return
    setConfigChildDraft(buildConfigChildDraft(endpoint, 'update', item))
    setConfigChildErrors({})
    setConfigEditDraft(null)
    setConfigEditErrors({})
    setConfigEditResult(null)
    setConfigEditError(null)
    setConfigEditIntent(null)
  }, [configEditMutation.isPending, readOnlyDemoMode])

  const changeConfigChildValue = useCallback((fieldName: string, value: string) => {
    setConfigChildDraft((current) => current ? {
      ...current,
      values: {
        ...current.values,
        [fieldName]: value,
      },
    } : current)
    setConfigChildErrors((current) => {
      if (!current[fieldName] && !current.__form) return current
      const next = { ...current }
      delete next[fieldName]
      delete next.__form
      return next
    })
  }, [])

  const cancelConfigChild = useCallback(() => {
    if (configEditMutation.isPending) return
    setConfigChildDraft(null)
    setConfigChildErrors({})
    setConfigEditIntent(null)
  }, [configEditMutation.isPending])

  const submitConfigChild = useCallback(() => {
    if (!configChildDraft || !serverConfiguration || readOnlyDemoMode) return
    const endpoint = topologyEndpoints.find((candidate) => candidate.id === configChildDraft.endpointId)
    if (!endpoint || endpoint.endpointKind !== 'collection-child') {
      setConfigChildErrors({ __form: 'Child-resource endpoint is no longer available.' })
      return
    }

    const section = serverConfiguration.sections.find((candidate) => candidate.endpointId === endpoint.id)
    const items = readItems(section?.data)
    const existingNames = items.flatMap((item) => typeof item.name === 'string' && item.name ? [item.name] : [])
    const currentItem = configChildDraft.mode === 'update'
      ? items.find((item) => item.name === configChildDraft.childName) ?? null
      : null

    if (configChildDraft.mode === 'update' && !currentItem) {
      setConfigChildErrors({ __form: 'Child resource is no longer reported.' })
      return
    }

    const result = buildConfigChildIntent(serverName, endpoint, configChildDraft, currentItem, existingNames)
    setConfigChildErrors(result.errors)
    if (result.intent) setConfigEditIntent(result.intent)
  }, [configChildDraft, readOnlyDemoMode, serverConfiguration, serverName, topologyEndpoints])

  const requestDeleteChild = useCallback((endpoint: TopologyEndpointCatalog, childName: string) => {
    if (readOnlyDemoMode || configEditMutation.isPending) return
    setConfigChildDraft(null)
    setConfigChildErrors({})
    setConfigEditIntent(buildConfigChildDeleteIntent(serverName, endpoint, childName))
  }, [configEditMutation.isPending, readOnlyDemoMode, serverName])

  const requestDeleteServer = useCallback(() => {
    if (readOnlyDemoMode || configEditMutation.isPending) return
    if (deleteServerBlockedReason) {
      setConfigEditError(deleteServerBlockedReason)
      return
    }
    if (!serverConfiguration) {
      setConfigEditError('Configuration row is required before deletion.')
      return
    }
    setConfigEditDraft(null)
    setConfigEditErrors({})
    setConfigChildDraft(null)
    setConfigChildErrors({})
    setConfigEditIntent(buildServerDeleteIntent(serverName, serverConfiguration))
  }, [
    configEditMutation.isPending,
    deleteServerBlockedReason,
    readOnlyDemoMode,
    serverConfiguration,
    serverName,
  ])

  const setActiveTab = useCallback((tab: ServerDetailTab) => {
    const next = new URLSearchParams(searchParams)
    if (tab === 'metrics') next.set('tab', 'metrics')
    else if (tab === 'configuration') next.set('tab', 'configuration')
    else if (tab === 'debug') next.set('tab', 'debug')
    else next.delete('tab')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const copyThreadDump = useCallback(async () => {
    if (!currentThreadDump) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(currentThreadDump.text)
      setThreadDumpFeedback('Copied thread dump to clipboard.')
    } catch (error) {
      setThreadDumpFeedback(error instanceof Error ? `Copy failed: ${error.message}` : 'Copy failed.')
    }
  }, [currentThreadDump])

  const downloadThreadDump = useCallback(() => {
    if (!currentThreadDump) return
    const blob = new Blob([currentThreadDump.text], { type: 'text/plain;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = threadDumpFilename(currentThreadDump.serverName, currentThreadDump.capturedAt)
    anchor.click()
    URL.revokeObjectURL(href)
    setThreadDumpFeedback('Thread dump download prepared.')
  }, [currentThreadDump])

  return (
    <>
      <PageHeader
        title={serverName || 'Server'}
        subtitle="Single server runtime snapshot."
        meta={
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-muted-foreground flex items-center gap-1 text-[13px] leading-[18px]">
              Updated <RelativeTime value={Math.max(query.dataUpdatedAt, taskQuery.dataUpdatedAt)} />
            </span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" asChild>
                <Link to={returnPath}>
                  <ArrowLeft className="size-3.5" strokeWidth={1.5} />
                  Servers
                </Link>
              </Button>
              <Button type="button" variant="ghost" size="sm" asChild>
                <Link to={workManagersRouteForServer(serverName)}>
                  <Workflow className="size-3.5" strokeWidth={1.5} />
                  Work Managers
                </Link>
              </Button>
              {canCaptureThreadDump ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={threadDumpMutation.isPending}
                  onClick={captureThreadDump}
                >
                  {threadDumpMutation.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
                  ) : (
                    <FileText className="size-3.5" strokeWidth={1.5} />
                  )}
                  {threadDumpMutation.isPending ? 'Capturing' : 'Thread dump'}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void query.refetch()
                  if (row) void taskQuery.refetch()
                }}
              >
                <RefreshCw className="size-3.5" strokeWidth={1.5} />
                Refresh
              </Button>
            </div>
          </div>
        }
      />

      <ConfirmDialog
        open={!!configEditIntent}
        title={
          configEditIntent?.kind === 'delete-server'
            ? 'Delete managed server?'
            : configEditIntent?.kind === 'delete-child'
              ? `Delete ${configEditIntent.sectionLabel}?`
              : 'Activate server configuration changes?'
        }
        description={
          configEditIntent?.kind === 'delete-server'
            ? 'This will stage and activate a WebLogic edit-tree delete for the managed server.'
            : configEditIntent?.kind === 'delete-child'
            ? 'This will stage and activate a WebLogic edit-tree delete for the selected child resource.'
            : 'This will stage and activate WebLogic edit-tree changes for the selected server section.'
        }
        subject={
          configEditIntent
            ? `${configEditIntent.sectionLabel} | ${configEditIntent.childName ?? configEditIntent.changedFields.join(', ')}`
            : undefined
        }
        confirmLabel={
          configEditIntent?.kind === 'delete-server'
            ? 'Delete server'
            : configEditIntent?.kind === 'delete-child'
              ? 'Delete resource'
              : 'Activate changes'
        }
        pending={configEditMutation.isPending}
        onConfirm={confirmConfigEditIntent}
        onCancel={() => setConfigEditIntent(null)}
      />

      {query.isFetching && !query.data ? (
        <div className="text-muted-foreground flex h-24 items-center justify-center gap-2 border-b border-border text-[13px]">
          <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          Loading...
        </div>
      ) : null}

      {query.isError ? (
        <div className="border-status-negative/60 bg-status-negative/8 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate font-mono">
            {query.error instanceof Error ? query.error.message : 'Unable to load server runtimes.'}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}

      {!query.isFetching && !query.isError && !row ? (
        <div className="border-border bg-surface-1 flex min-h-28 items-center justify-between gap-3 border px-3 py-3 text-[13px]">
          <div className="min-w-0">
            <div className="font-medium">Server not found</div>
            <MonoText className="text-muted-foreground mt-1 block truncate">{serverName || '-'}</MonoText>
          </div>
          <Button type="button" variant="outline" size="sm" asChild>
            <Link to={returnPath}>Back to servers</Link>
          </Button>
        </div>
      ) : null}

      {threadDumpMutation.isError ? (
        <div className="border-status-negative/60 bg-status-negative/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate font-mono">
            {threadDumpMutation.error instanceof Error
              ? threadDumpMutation.error.message
              : 'Unable to capture thread dump.'}
          </span>
          {canCaptureThreadDump ? (
            <Button type="button" variant="ghost" size="sm" onClick={captureThreadDump}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {row ? (
        <div className="space-y-4">
          <ServerDetailTabs activeTab={activeTab} onChange={setActiveTab} />

          {activeTab === 'metrics' ? (
            <ServerMetricsTab serverName={serverName} creds={creds} fixtureName={metricsFixture} />
          ) : activeTab === 'debug' ? (
            <ServerDebugTab serverName={serverName} readOnlyDemoMode={readOnlyDemoMode} />
          ) : activeTab === 'configuration' ? (
            <ServerConfigurationPanel
              serverName={serverName}
              resource={serverConfiguration}
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
              childDraft={configChildDraft}
              childErrors={configChildErrors}
              childPending={configEditMutation.isPending}
              editResult={configEditResult}
              editError={configEditError}
              deleteServerBlockedReason={deleteServerBlockedReason}
              onRetry={() => void topologyQuery.refetch()}
              onRequestDeleteServer={requestDeleteServer}
              onStartEdit={startConfigEdit}
              onEditChange={changeConfigEditValue}
              onCancelEdit={cancelConfigEdit}
              onSubmitEdit={submitConfigEdit}
              onStartCreateChild={startCreateChild}
              onStartEditChild={startEditChild}
              onRequestDeleteChild={requestDeleteChild}
              onChildChange={changeConfigChildValue}
              onCancelChild={cancelConfigChild}
              onSubmitChild={submitConfigChild}
            />
          ) : (
            <>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
              <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Lifecycle</div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusBadge kind="wls-state" value={row.state} />
                {row.restartRequired ? <RestartRequiredBadge /> : null}
              </div>
            </div>
            <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
              <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Health</div>
              <div className="mt-2">
                <StatusBadge kind="wls-health" value={row.healthState} />
              </div>
            </div>
            <Metric label="Listen" value={formatListen(row, defaultHost)} />
            <Metric
              label="Threads"
              value={row.threads ? row.threads.total.toLocaleString() : '-'}
              detail={`Pending ${row.threads?.pending ?? '-'} · Hogging ${row.threads?.hogging ?? '-'} · Stuck ${row.threads?.stuck ?? '-'}`}
            />
          </div>

          <section className="border-border bg-surface-1 border px-3 py-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[14px] font-medium leading-5">JVM Heap</h2>
                <p className="text-muted-foreground text-[13px] leading-[18px]">Current usage from the latest runtime snapshot.</p>
              </div>
            </div>
            <HeapBar heap={row.heap} variant="detail" series={heapSeries} />
          </section>

          <section className="border-border bg-surface-1 border px-3 py-3">
            <div className="mb-3">
              <h2 className="text-[14px] font-medium leading-5">JVM Runtime</h2>
              <p className="text-muted-foreground text-[13px] leading-[18px]">
                Runtime identity from the latest per-server JVM snapshot.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <Metric label="Uptime" value={formatDuration(row.jvm?.uptime)} />
              <Metric label="Java" value={row.jvm?.javaVersion ?? '-'} detail={row.jvm?.javaVendor ?? '-'} />
              <Metric label="VM Vendor" value={row.jvm?.javaVmVendor ?? '-'} />
              <Metric label="OS" value={row.jvm?.osName ?? '-'} detail={row.jvm?.osVersion ?? '-'} />
            </div>
          </section>

          {showHeapDumpUnsupported ? <HeapDumpUnsupportedSection support={heapDumpSupport} /> : null}

          <NodeManagerSection
            row={nodeManagerQuery.data}
            isLoading={nodeManagerQuery.isLoading}
            isFetching={nodeManagerQuery.isFetching}
            isError={nodeManagerQuery.isError}
            error={nodeManagerQuery.error}
            onRetry={() => void nodeManagerQuery.refetch()}
          />

          <LifecycleTasksSection
            tasks={taskQuery.data}
            isLoading={taskQuery.isLoading}
            isFetching={taskQuery.isFetching}
            isError={taskQuery.isError}
            error={taskQuery.error}
            onRetry={() => void taskQuery.refetch()}
          />

          {currentThreadDump ? (
            <section className="border-border bg-surface-1 border px-3 py-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-[14px] font-medium leading-5">Thread Dump</h2>
                  <p className="text-muted-foreground truncate text-[13px] leading-[18px]">
                    Captured <RelativeTime value={currentThreadDump.capturedAt} /> | {currentThreadDump.lineCount.toLocaleString()} lines | {formatDumpBytes(currentThreadDump.bytes)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => void copyThreadDump()}>
                    <Clipboard className="size-3.5" strokeWidth={1.5} />
                    Copy
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={downloadThreadDump}>
                    <Download className="size-3.5" strokeWidth={1.5} />
                    Download
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setThreadDump(null)
                      setThreadDumpFeedback(null)
                    }}
                  >
                    <X className="size-3.5" strokeWidth={1.5} />
                    Clear
                  </Button>
                </div>
              </div>
              {threadDumpFeedback ? (
                <div className="border-border bg-background mb-3 border px-3 py-2 text-[13px] text-muted-foreground">
                  {threadDumpFeedback}
                </div>
              ) : null}
              <pre className="border-border bg-background max-h-[440px] overflow-auto border p-3 text-[12px] leading-[17px] text-foreground">
                {currentThreadDump.text}
              </pre>
            </section>
          ) : null}
            </>
          )}
        </div>
      ) : null}
    </>
  )
}
