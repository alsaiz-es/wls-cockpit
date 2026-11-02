import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { Loader2, Plus, Search } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { readOnlyDemoModeEnabled } from '@/api/runtime-config'
import {
  coerceConfigNumber,
  createDataSource,
  dataSourceVersionSupportsInvokeBeginEndRequest,
  deleteDataSource,
  updateDataSource,
  updateDataSourceTargets,
  type DataSourceConfigInput,
  type DataSourceConfigResult,
} from '@/api/queries/data-source-management'
import {
  runDataSourceLifecycleAction,
  type DataSourceLifecycleAction,
  type DataSourceLifecycleResult,
} from '@/api/queries/data-source-lifecycle'
import { useDeploymentTargetChoices, type DeploymentTargetChoice } from '@/api/queries/deployment-management'
import { deploymentTargetKey, deploymentTargetLabel } from '@/api/queries/deployment-targets'
import { invalidateEditSessionAffectedQueries } from '@/api/queries/edit-sessions'
import {
  getMetricHistorySeries,
  jdbcMetricResourceId,
  useMetricHistoryRecorder,
  type MetricHistorySampleInput,
} from '@/api/queries/metric-history'
import { useDataSources, type DataSourceRuntimeRow, type DataSourceSeverity } from '@/api/queries/data-sources'
import type { DeploymentTargetRef } from '@/api/queries/deployments'
import { useAuth } from '@/auth/useAuth'
import {
  ConfirmDialog,
  DataTable,
  MetricTrend,
  MonoText,
  PageHeader,
  StatusBadge,
  type DataTableColumn,
  type DataTableSort,
  type StatusTone,
} from '@/components'
import { RowActions, type RowAction } from '@/components/row-actions'
import { TargetChangeNotice } from '@/components/target-change-notice'
import { targetChange } from '@/components/target-change-model'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { filterOptionLabel } from '@/components/filter-option-label'
import {
  parseRuntimeTableUrlState,
  serializeRuntimeTableUrlState,
  type RuntimeTableUrlConfig,
  type RuntimeTableUrlState,
} from './runtime-table-url-state'
import { detailReturnState } from './detail-return-state'
import { canMutateDataSourceConfig, dataSourceRowActions } from './data-source-actions'
import {
  DATA_SOURCE_DRIVER_PRESETS,
  dataSourceDriverPreset,
  type DataSourceDriverPresetId,
} from '@/api/queries/data-source-driver-presets'
import {
  applyDriverPreset,
  formBooleanValue,
  formForRow,
  initialConfigForm,
  updateUrlMode,
  updateUrlTemplateField,
  validateDataSourceConfigForm,
  type BooleanFormValue,
  type DataSourceConfigFormState,
  type DataSourceConfigValidationResult,
  type StatementCacheTypeFormValue,
} from './data-source-config-form-model'

const DEFAULT_SORT: DataTableSort = { columnId: 'severity', direction: 'asc' }
const severityOrder: DataSourceSeverity[] = ['critical', 'warning', 'unknown', 'healthy']
const severityFilters = ['all', ...severityOrder] as const
type SeverityFilter = (typeof severityFilters)[number]

interface DataSourceLifecycleMutationVariables {
  dataSourceName: string
  serverName: string
  action: DataSourceLifecycleAction
}

type DataSourceConfigMutationVariables =
  | { action: 'create'; input: DataSourceConfigInput }
  | { action: 'edit'; row: DataSourceRuntimeRow; input: DataSourceConfigInput }
  | { action: 'targets'; row: DataSourceRuntimeRow; targets: DeploymentTargetRef[] }
  | { action: 'delete'; row: DataSourceRuntimeRow }

interface DataSourceEditorState {
  row: DataSourceRuntimeRow
  form: DataSourceConfigFormState
}

interface TargetEditorState {
  row: DataSourceRuntimeRow
  selectedKeys: string[]
}

type DestructiveDataSourceIntent =
  | { kind: 'lifecycle'; row: DataSourceRuntimeRow; action: Extract<DataSourceLifecycleAction, 'suspend' | 'reset'> }
  | { kind: 'delete'; row: DataSourceRuntimeRow }

function severityTone(severity: DataSourceSeverity): StatusTone {
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

function compareRows(a: DataSourceRuntimeRow, b: DataSourceRuntimeRow, sort: DataTableSort) {
  const direction = sort.direction === 'asc' ? 1 : -1
  switch (sort.columnId) {
    case 'severity':
      return (
        (severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)) * direction ||
        compareText(a.name, b.name) ||
        compareText(a.serverName, b.serverName)
      )
    case 'name':
      return compareText(a.name, b.name) * direction || compareText(a.serverName, b.serverName)
    case 'server':
      return compareText(a.serverName, b.serverName) * direction || compareText(a.name, b.name)
    case 'state':
      return compareText(a.state, b.state) * direction
    case 'active':
      return compareNumberWithNulls(
        a.activeConnectionsCurrentCount,
        b.activeConnectionsCurrentCount,
        sort.direction,
      )
    case 'capacity':
      return compareNumberWithNulls(a.utilizationCapacity, b.utilizationCapacity, sort.direction)
    case 'created':
      return compareNumberWithNulls(a.currCapacity, b.currCapacity, sort.direction)
    case 'utilization':
      return compareNumberWithNulls(a.utilization, b.utilization, sort.direction)
    case 'waiting':
      return compareNumberWithNulls(
        a.waitingForConnectionCurrentCount,
        b.waitingForConnectionCurrentCount,
        sort.direction,
      )
    case 'leaked':
      return compareNumberWithNulls(a.leakedConnectionCount, b.leakedConnectionCount, sort.direction)
    default:
      return compareRows(a, b, DEFAULT_SORT)
  }
}

function formatNumber(value: number | null) {
  return value === null ? '–' : value.toLocaleString()
}

function formatDeploymentState(value: string | number | null) {
  if (value === null) return '–'
  if (value === 2) return 'ACTIVE'
  if (value === 0) return 'UNPREPARED'
  return String(value)
}

function targetSummary(targets: DeploymentTargetRef[]) {
  return targets.length ? targets.map(deploymentTargetLabel).join(', ') : '–'
}

function listSummary(values: string[]) {
  return values.length ? values.join(', ') : '–'
}

function dataSourceDetailPath(row: DataSourceRuntimeRow) {
  return `/data-sources/${encodeURIComponent(row.serverName)}/${encodeURIComponent(row.name)}`
}

function searchText(row: DataSourceRuntimeRow) {
  return [
    row.name,
    row.serverName,
    row.systemResourceName ?? '',
    targetSummary(row.configuredTargets),
    listSummary(row.jndiNames),
    row.driverName ?? '',
    row.url ?? '',
    row.databaseUser ?? '',
    row.severity,
    row.state,
    formatDeploymentState(row.deploymentState),
    row.activeConnectionsCurrentCount,
    row.utilizationCapacity,
    row.currCapacity,
    row.waitingForConnectionCurrentCount,
    row.leakedConnectionCount,
  ]
    .filter((value) => value !== null && value !== undefined)
    .join(' ')
    .toLowerCase()
}

function dataSourceMetricSamples(rows: DataSourceRuntimeRow[]): MetricHistorySampleInput[] {
  return rows.flatMap((row): MetricHistorySampleInput[] => {
    const resourceId = jdbcMetricResourceId(row.serverName, row.name)
    return [
      {
        family: 'jdbc',
        resourceId,
        metric: 'connections.active',
        value: row.activeConnectionsCurrentCount,
      },
      {
        family: 'jdbc',
        resourceId,
        metric: 'connections.waiting',
        value: row.waitingForConnectionCurrentCount,
      },
      {
        family: 'jdbc',
        resourceId,
        metric: 'utilization.percent',
        value: row.utilization === null ? null : row.utilization * 100,
      },
    ]
  })
}

function actionLabel(action: DataSourceLifecycleAction) {
  if (action === 'testPool') return 'Test'
  if (action === 'clearStatementCache') return 'Clear cache'
  return action[0].toUpperCase() + action.slice(1)
}

function pendingLabel(action: DataSourceLifecycleAction) {
  if (action === 'testPool') return 'Testing…'
  if (action === 'clearStatementCache') return 'Clearing…'
  return `${actionLabel(action)}…`
}


function resultSummary(result: DataSourceLifecycleResult) {
  const message = result.message ? ` · ${result.message}` : ''
  return `${actionLabel(result.action)} ${result.dataSourceName} on ${result.serverName}${message}`
}

function configActionLabel(action: DataSourceConfigResult['action']) {
  if (action === 'create') return 'Create'
  if (action === 'edit') return 'Edit'
  if (action === 'targets') return 'Targets'
  return 'Delete'
}

function selectedTargets(keys: string[], choices: DeploymentTargetChoice[]) {
  const choiceByKey = new Map(choices.map((choice) => [deploymentTargetKey(choice), choice]))
  return keys.flatMap((key) => {
    const choice = choiceByKey.get(key)
    return choice ? [{ kind: choice.kind, name: choice.name }] : []
  })
}

function inputFromForm(form: DataSourceConfigFormState, choices: DeploymentTargetChoice[]): DataSourceConfigInput {
  return {
    name: form.name,
    jndiName: form.jndiName,
    driverName: form.driverName,
    url: form.url,
    databaseUser: form.databaseUser,
    password: form.password,
    globalTransactionsProtocol: form.globalTransactionsProtocol || null,
    useXaDataSourceInterface: formBooleanValue(form.useXaDataSourceInterface),
    keepConnAfterGlobalTx: formBooleanValue(form.keepConnAfterGlobalTx),
    initialCapacity: coerceConfigNumber(form.initialCapacity),
    minCapacity: coerceConfigNumber(form.minCapacity),
    maxCapacity: coerceConfigNumber(form.maxCapacity),
    testTableName: form.testTableName,
    testConnectionsOnReserve: formBooleanValue(form.testConnectionsOnReserve),
    testFrequencySeconds: coerceConfigNumber(form.testFrequencySeconds),
    secondsToTrustAnIdlePoolConnection: coerceConfigNumber(form.secondsToTrustAnIdlePoolConnection),
    countOfTestFailuresTillFlush: coerceConfigNumber(form.countOfTestFailuresTillFlush),
    countOfRefreshFailuresTillDisable: coerceConfigNumber(form.countOfRefreshFailuresTillDisable),
    statementCacheSize: coerceConfigNumber(form.statementCacheSize),
    statementCacheType: form.statementCacheType || null,
    statementTimeout: coerceConfigNumber(form.statementTimeout),
    shrinkFrequencySeconds: coerceConfigNumber(form.shrinkFrequencySeconds),
    inactiveConnectionTimeoutSeconds: coerceConfigNumber(form.inactiveConnectionTimeoutSeconds),
    connectionReserveTimeoutSeconds: coerceConfigNumber(form.connectionReserveTimeoutSeconds),
    connectionCreationRetryFrequencySeconds: coerceConfigNumber(form.connectionCreationRetryFrequencySeconds),
    loginDelaySeconds: coerceConfigNumber(form.loginDelaySeconds),
    highestNumWaiters: coerceConfigNumber(form.highestNumWaiters),
    removeInfectedConnections: formBooleanValue(form.removeInfectedConnections),
    pinnedToThread: formBooleanValue(form.pinnedToThread),
    wrapJdbc: formBooleanValue(form.wrapJdbc),
    wrapTypes: formBooleanValue(form.wrapTypes),
    invokeBeginEndRequest: formBooleanValue(form.invokeBeginEndRequest),
    targets: selectedTargets(form.targetKeys, choices),
  }
}

function EmptyValue() {
  return <MonoText className="text-status-neutral">–</MonoText>
}

function TargetCheckboxes({
  choices,
  selectedKeys,
  disabled,
  onChange,
}: {
  choices: DeploymentTargetChoice[]
  selectedKeys: string[]
  disabled: boolean
  onChange: (keys: string[]) => void
}) {
  if (choices.length === 0) {
    return <span className="text-muted-foreground text-[13px]">No datasource targets reported.</span>
  }

  const selected = new Set(selectedKeys)
  return (
    <div className="flex flex-wrap gap-2">
      {choices.map((choice) => {
        const key = deploymentTargetKey(choice)
        return (
          <label
            key={key}
            className="border-border bg-background hover:bg-surface-1 flex h-8 items-center gap-2 border px-2 text-[13px]"
          >
            <input
              type="checkbox"
              className="accent-primary size-3.5"
              checked={selected.has(key)}
              disabled={disabled}
              onChange={(event) => {
                const next = new Set(selected)
                if (event.target.checked) next.add(key)
                else next.delete(key)
                onChange([...next])
              }}
            />
            <MonoText>{deploymentTargetLabel(choice)}</MonoText>
          </label>
        )
      })}
    </div>
  )
}

const inputClass = 'h-8 rounded-[4px] font-mono text-[13px]'
const selectClass =
  'border-input bg-background h-8 rounded-[4px] border px-2 text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

function FieldError({ value }: { value?: string }) {
  return value ? <div className="text-status-negative mt-1 text-[11px] leading-[14px]">{value}</div> : null
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground mb-1 text-[11px] uppercase tracking-[0.04em]">{children}</div>
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-border/80 bg-background/40 border p-2">
      <div className="text-muted-foreground mb-2 text-[11px] uppercase tracking-[0.04em]">{title}</div>
      {children}
    </section>
  )
}

function BooleanSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: BooleanFormValue
  disabled: boolean
  onChange: (value: BooleanFormValue) => void
}) {
  return (
    <label>
      <FieldLabel>{label}</FieldLabel>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as BooleanFormValue)}
        className={`${selectClass} w-full`}
      >
        <option value="default">Default</option>
        <option value="true">Enabled</option>
        <option value="false">Disabled</option>
      </select>
    </label>
  )
}

function TextInput({
  label,
  value,
  disabled,
  onChange,
  placeholder,
  error,
  className,
  type = 'text',
}: {
  label: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
  placeholder?: string
  error?: string
  className?: string
  type?: string
}) {
  return (
    <label className={className}>
      <FieldLabel>{label}</FieldLabel>
      <Input
        aria-label={label}
        placeholder={placeholder ?? label}
        type={type}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      />
      <FieldError value={error} />
    </label>
  )
}

function DataSourceConfigForm({
  mode,
  form,
  errors,
  targetChoices,
  disabled,
  supportsInvokeBeginEndRequest,
  onChange,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit'
  form: DataSourceConfigFormState
  errors: DataSourceConfigValidationResult['errors']
  targetChoices: DeploymentTargetChoice[]
  disabled: boolean
  supportsInvokeBeginEndRequest: boolean
  onChange: (form: DataSourceConfigFormState) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const setField = (field: keyof DataSourceConfigFormState, value: string) => onChange({ ...form, [field]: value } as DataSourceConfigFormState)
  const setBooleanField = (field: keyof DataSourceConfigFormState, value: BooleanFormValue) => onChange({ ...form, [field]: value } as DataSourceConfigFormState)
  const preset = dataSourceDriverPreset(form.driverPresetId)
  const customDriver = form.driverPresetId === 'custom'
  return (
    <div className="mb-3 border border-border bg-surface-1/40 p-3">
      <div className="grid gap-3 xl:grid-cols-2">
        <FormSection title="Identity">
          <div className="grid gap-2 md:grid-cols-2">
            <TextInput label="Datasource name" value={form.name} disabled={disabled || mode === 'edit'} onChange={(value) => setField('name', value)} error={errors.name} />
            <TextInput label="JNDI name" value={form.jndiName} disabled={disabled} onChange={(value) => setField('jndiName', value)} error={errors.jndiName} />
            <TextInput label="Database user" value={form.databaseUser} disabled={disabled} onChange={(value) => setField('databaseUser', value)} error={errors.databaseUser} />
            <TextInput
              label="Database password"
              value={form.password}
              disabled={disabled}
              onChange={(value) => setField('password', value)}
              placeholder={mode === 'edit' ? 'New password (optional)' : 'Password (optional)'}
              type="password"
            />
          </div>
        </FormSection>

        <FormSection title="Driver and URL">
          <div className="grid gap-2 md:grid-cols-2">
            <label>
              <FieldLabel>Driver preset</FieldLabel>
              <select
                aria-label="Driver preset"
                value={form.driverPresetId}
                disabled={disabled}
                onChange={(event) => onChange(applyDriverPreset(form, event.target.value as DataSourceDriverPresetId))}
                className={`${selectClass} w-full`}
              >
                {DATA_SOURCE_DRIVER_PRESETS.map((choice) => (
                  <option key={choice.id} value={choice.id}>{choice.label}</option>
                ))}
              </select>
            </label>
            <label>
              <FieldLabel>URL mode</FieldLabel>
              <select
                aria-label="JDBC URL mode"
                value={form.urlMode}
                disabled={disabled || customDriver}
                onChange={(event) => onChange(updateUrlMode(form, event.target.value as 'template' | 'manual'))}
                className={`${selectClass} w-full`}
              >
                <option value="template">Template fields</option>
                <option value="manual">Manual URL</option>
              </select>
            </label>
            <TextInput label="Driver class" value={form.driverName} disabled={disabled || !customDriver} onChange={(value) => setField('driverName', value)} error={errors.driverName} className="md:col-span-2" />
            {form.urlMode === 'template' && preset.urlFields.length ? (
              preset.urlFields.map((field) => (
                <TextInput
                  key={field.id}
                  label={field.label}
                  value={form.urlTemplateFields[field.id] ?? ''}
                  disabled={disabled}
                  onChange={(value) => onChange(updateUrlTemplateField(form, field.id, value))}
                  placeholder={field.placeholder}
                />
              ))
            ) : null}
            <label className="md:col-span-2">
              <FieldLabel>JDBC URL</FieldLabel>
              <textarea
                aria-label="JDBC URL"
                value={form.url}
                disabled={disabled || form.urlMode === 'template'}
                onChange={(event) => setField('url', event.target.value)}
                className="border-input bg-background min-h-16 w-full resize-y rounded-[4px] border px-2 py-1.5 font-mono text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <FieldError value={errors.url} />
            </label>
          </div>
        </FormSection>

        <FormSection title="Capacity">
          <div className="grid gap-2 md:grid-cols-3">
            <TextInput label="Initial capacity" value={form.initialCapacity} disabled={disabled} onChange={(value) => setField('initialCapacity', value)} error={errors.initialCapacity} />
            <TextInput label="Min capacity" value={form.minCapacity} disabled={disabled} onChange={(value) => setField('minCapacity', value)} error={errors.minCapacity} />
            <TextInput label="Max capacity" value={form.maxCapacity} disabled={disabled} onChange={(value) => setField('maxCapacity', value)} error={errors.maxCapacity} />
          </div>
        </FormSection>

        <FormSection title="Validation">
          <div className="grid gap-2 md:grid-cols-3">
            <TextInput label="Test table / SQL" value={form.testTableName} disabled={disabled} onChange={(value) => setField('testTableName', value)} error={errors.testTableName} className="md:col-span-3" />
            <BooleanSelect label="Test on reserve" value={form.testConnectionsOnReserve} disabled={disabled} onChange={(value) => setBooleanField('testConnectionsOnReserve', value)} />
            <TextInput label="Test frequency seconds" value={form.testFrequencySeconds} disabled={disabled} onChange={(value) => setField('testFrequencySeconds', value)} error={errors.testFrequencySeconds} />
            <TextInput label="Trust idle seconds" value={form.secondsToTrustAnIdlePoolConnection} disabled={disabled} onChange={(value) => setField('secondsToTrustAnIdlePoolConnection', value)} error={errors.secondsToTrustAnIdlePoolConnection} />
            <TextInput label="Failures till flush" value={form.countOfTestFailuresTillFlush} disabled={disabled} onChange={(value) => setField('countOfTestFailuresTillFlush', value)} error={errors.countOfTestFailuresTillFlush} />
            <TextInput label="Refresh failures till disable" value={form.countOfRefreshFailuresTillDisable} disabled={disabled} onChange={(value) => setField('countOfRefreshFailuresTillDisable', value)} error={errors.countOfRefreshFailuresTillDisable} />
          </div>
        </FormSection>

        <FormSection title="Statement Cache">
          <div className="grid gap-2 md:grid-cols-3">
            <TextInput label="Cache size" value={form.statementCacheSize} disabled={disabled} onChange={(value) => setField('statementCacheSize', value)} error={errors.statementCacheSize} />
            <label>
              <FieldLabel>Cache type</FieldLabel>
              <select
                aria-label="Statement cache type"
                value={form.statementCacheType}
                disabled={disabled}
                onChange={(event) => setField('statementCacheType', event.target.value as StatementCacheTypeFormValue)}
                className={`${selectClass} w-full`}
              >
                <option value="">Default</option>
                <option value="LRU">LRU</option>
                <option value="FIXED">FIXED</option>
              </select>
            </label>
            <TextInput label="Statement timeout" value={form.statementTimeout} disabled={disabled} onChange={(value) => setField('statementTimeout', value)} error={errors.statementTimeout} />
          </div>
        </FormSection>

        <FormSection title="Lifecycle and Retry">
          <div className="grid gap-2 md:grid-cols-3">
            <TextInput label="Shrink frequency seconds" value={form.shrinkFrequencySeconds} disabled={disabled} onChange={(value) => setField('shrinkFrequencySeconds', value)} error={errors.shrinkFrequencySeconds} />
            <TextInput label="Inactive timeout seconds" value={form.inactiveConnectionTimeoutSeconds} disabled={disabled} onChange={(value) => setField('inactiveConnectionTimeoutSeconds', value)} error={errors.inactiveConnectionTimeoutSeconds} />
            <TextInput label="Reserve timeout seconds" value={form.connectionReserveTimeoutSeconds} disabled={disabled} onChange={(value) => setField('connectionReserveTimeoutSeconds', value)} error={errors.connectionReserveTimeoutSeconds} />
            <TextInput label="Creation retry seconds" value={form.connectionCreationRetryFrequencySeconds} disabled={disabled} onChange={(value) => setField('connectionCreationRetryFrequencySeconds', value)} error={errors.connectionCreationRetryFrequencySeconds} />
            <TextInput label="Login delay seconds" value={form.loginDelaySeconds} disabled={disabled} onChange={(value) => setField('loginDelaySeconds', value)} error={errors.loginDelaySeconds} />
            <TextInput label="Highest waiters" value={form.highestNumWaiters} disabled={disabled} onChange={(value) => setField('highestNumWaiters', value)} error={errors.highestNumWaiters} />
            <BooleanSelect label="Remove infected" value={form.removeInfectedConnections} disabled={disabled} onChange={(value) => setBooleanField('removeInfectedConnections', value)} />
            <BooleanSelect label="Pinned to thread" value={form.pinnedToThread} disabled={disabled} onChange={(value) => setBooleanField('pinnedToThread', value)} />
            <BooleanSelect label="Wrap JDBC" value={form.wrapJdbc} disabled={disabled} onChange={(value) => setBooleanField('wrapJdbc', value)} />
            <BooleanSelect label="Wrap types" value={form.wrapTypes} disabled={disabled} onChange={(value) => setBooleanField('wrapTypes', value)} />
            {supportsInvokeBeginEndRequest ? (
              <BooleanSelect label="Begin/end request" value={form.invokeBeginEndRequest} disabled={disabled} onChange={(value) => setBooleanField('invokeBeginEndRequest', value)} />
            ) : null}
          </div>
        </FormSection>

        <FormSection title="Transactions">
          <div className="grid gap-2 md:grid-cols-3">
            <label>
              <FieldLabel>Global TX protocol</FieldLabel>
              <select
                aria-label="Global transaction protocol"
                value={form.globalTransactionsProtocol}
                disabled={disabled}
                onChange={(event) => setField('globalTransactionsProtocol', event.target.value)}
                className={`${selectClass} w-full`}
              >
                <option value="OnePhaseCommit">OnePhaseCommit</option>
                <option value="TwoPhaseCommit">TwoPhaseCommit</option>
                <option value="LoggingLastResource">LoggingLastResource</option>
                <option value="EmulateTwoPhaseCommit">EmulateTwoPhaseCommit</option>
                <option value="None">None</option>
              </select>
            </label>
            <BooleanSelect label="XA datasource interface" value={form.useXaDataSourceInterface} disabled={disabled} onChange={(value) => setBooleanField('useXaDataSourceInterface', value)} />
            <BooleanSelect label="Keep after global TX" value={form.keepConnAfterGlobalTx} disabled={disabled} onChange={(value) => setBooleanField('keepConnAfterGlobalTx', value)} />
          </div>
        </FormSection>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <TargetCheckboxes
            choices={targetChoices}
            selectedKeys={form.targetKeys}
            disabled={disabled}
            onChange={(targetKeys) => onChange({ ...form, targetKeys })}
          />
          <FieldError value={errors.targets} />
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={disabled} onClick={onSubmit}>
            {disabled ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : null}
            {mode === 'create' ? 'Create' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function UtilizationCell({ row }: { row: DataSourceRuntimeRow }) {
  if (row.utilization === null) return <span className="text-status-neutral">–</span>
  const percent = Math.round(row.utilization * 100)
  const tone =
    row.severity === 'critical'
      ? 'text-status-negative'
      : row.severity === 'warning'
        ? 'text-status-warning'
        : 'text-status-positive'

  return (
    <span className="inline-flex items-center justify-end gap-1.5 tabular-nums">
      <span className="h-1.5 w-20 overflow-hidden rounded-[3px] bg-surface-2" aria-hidden>
        <span className={`block h-full rounded-[3px] ${tone.replace('text-', 'bg-')}`} style={{ width: `${Math.min(100, percent)}%` }} />
      </span>
      <MonoText className={`inline-block w-10 text-right text-xs leading-[14px] ${tone}`}>{percent}%</MonoText>
    </span>
  )
}

function PartialBanner({ failures, onRetry }: { failures: Array<{ serverName: string; message: string }>; onRetry: () => void }) {
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

export function DataSources() {
  const { creds } = useAuth()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [createForm, setCreateForm] = useState(initialConfigForm)
  const [createFormErrors, setCreateFormErrors] = useState<DataSourceConfigValidationResult['errors']>({})
  const [configEditor, setConfigEditor] = useState<DataSourceEditorState | null>(null)
  const [configEditorErrors, setConfigEditorErrors] = useState<DataSourceConfigValidationResult['errors']>({})
  const [targetEditor, setTargetEditor] = useState<TargetEditorState | null>(null)
  const [destructiveIntent, setDestructiveIntent] = useState<DestructiveDataSourceIntent | null>(null)
  const [lifecycleResult, setLifecycleResult] = useState<DataSourceLifecycleResult | null>(null)
  const [configResult, setConfigResult] = useState<DataSourceConfigResult | null>(null)
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  const query = useDataSources()
  const queryClient = useQueryClient()
  const readOnlyDemoMode = readOnlyDemoModeEnabled()
  const actionModeOptions = useMemo(() => ({ readOnlyDemoMode }), [readOnlyDemoMode])
  const supportsInvokeBeginEndRequest = creds ? dataSourceVersionSupportsInvokeBeginEndRequest(creds) : false
  const targetChoicesQuery = useDeploymentTargetChoices()
  const targetChoices = useMemo(() => targetChoicesQuery.data ?? [], [targetChoicesQuery.data])
  const returnState = useMemo(() => detailReturnState(location), [location])
  const failures = query.data?.partialFailures ?? []
  const allRows = useMemo(() => query.data?.rows ?? [], [query.data?.rows])
  const historySamples = useMemo(() => dataSourceMetricSamples(allRows), [allRows])
  const history = useMetricHistoryRecorder({
    creds,
    samples: historySamples,
    timestamp: query.dataUpdatedAt,
  })
  const serverOptions = useMemo(() => {
    return [...new Set(allRows.map((row) => row.serverName))].sort(compareText)
  }, [allRows])
  const stateOptions = useMemo(() => {
    return [...new Set(allRows.map((row) => row.state))].sort(compareText)
  }, [allRows])
  const tableUrlConfig = useMemo<RuntimeTableUrlConfig>(
    () => ({
      defaultSort: DEFAULT_SORT,
      sortableColumns: ['severity', 'name', 'server', 'state', 'active', 'capacity', 'created', 'utilization', 'waiting', 'leaked'],
      filters: {
        severity: { param: 'severity', defaultValue: 'all', allowedValues: severityFilters },
        server: { param: 'server', defaultValue: 'all', allowedValues: ['all', ...serverOptions] },
        state: { param: 'state', defaultValue: 'all', allowedValues: ['all', ...stateOptions] },
      },
    }),
    [serverOptions, stateOptions],
  )
  const tableState = useMemo(
    () => parseRuntimeTableUrlState(searchParams, tableUrlConfig),
    [searchParams, tableUrlConfig],
  )
  const sort = tableState.sort
  const search = tableState.search
  const severity = tableState.filters.severity as SeverityFilter
  const server = tableState.filters.server as string
  const state = tableState.filters.state as string
  const effectiveSort = sort ?? DEFAULT_SORT
  const hasActiveFilters = search.trim().length > 0 || severity !== 'all' || server !== 'all' || state !== 'all'
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
  const lifecycleMutation = useMutation<
    DataSourceLifecycleResult,
    Error,
    DataSourceLifecycleMutationVariables
  >({
    mutationFn: async ({ dataSourceName, serverName, action }) => {
      if (!creds) throw new Error('not authenticated')
      return runDataSourceLifecycleAction(creds, dataSourceName, serverName, action)
    },
    onMutate: () => {
      setLifecycleResult(null)
      setConfigResult(null)
      setLifecycleError(null)
    },
    onSuccess: (result) => {
      setLifecycleResult(result)
    },
    onError: (error) => {
      setLifecycleError(error.message || 'Datasource action failed.')
    },
    onSettled: async () => {
      await query.refetch()
    },
  })
  const configMutation = useMutation<DataSourceConfigResult, Error, DataSourceConfigMutationVariables>({
    mutationFn: async (variables) => {
      if (!creds) throw new Error('not authenticated')
      if (variables.action === 'create') return createDataSource(creds, variables.input)
      if (variables.action === 'edit') {
        return updateDataSource(creds, variables.row.systemResourceName ?? variables.row.name, variables.input)
      }
      if (variables.action === 'targets') {
        return updateDataSourceTargets(creds, variables.row.systemResourceName ?? variables.row.name, variables.targets)
      }
      return deleteDataSource(creds, variables.row.systemResourceName ?? variables.row.name)
    },
    onMutate: () => {
      setLifecycleResult(null)
      setConfigResult(null)
      setLifecycleError(null)
    },
    onSuccess: (result) => {
      setConfigResult(result)
      if (result.action === 'create') {
        setCreateForm(initialConfigForm())
        setCreateFormErrors({})
        setShowCreateForm(false)
      }
      if (result.action === 'edit') {
        setConfigEditorErrors({})
        setConfigEditor(null)
      }
      if (result.action === 'targets') setTargetEditor(null)
    },
    onError: (error) => {
      setLifecycleError(error.message || 'Datasource action failed.')
    },
    onSettled: async () => {
      await Promise.all([
        query.refetch(),
        targetChoicesQuery.refetch(),
        invalidateEditSessionAffectedQueries(queryClient, creds),
      ])
    },
  })

  const pendingLifecycle = lifecycleMutation.isPending ? lifecycleMutation.variables : null
  const pendingConfig = configMutation.isPending ? configMutation.variables : null
  const mutationPending = lifecycleMutation.isPending || configMutation.isPending

  const executeLifecycle = useCallback((row: DataSourceRuntimeRow, action: DataSourceLifecycleAction) => {
    if (readOnlyDemoMode) return
    lifecycleMutation.mutate({
      dataSourceName: row.name,
      serverName: row.serverName,
      action,
    })
  }, [lifecycleMutation, readOnlyDemoMode])

  const runLifecycle = useCallback((row: DataSourceRuntimeRow, action: DataSourceLifecycleAction) => {
    if (readOnlyDemoMode) return
    if (action === 'suspend' || action === 'reset') {
      setDestructiveIntent({ kind: 'lifecycle', row, action })
      return
    }
    executeLifecycle(row, action)
  }, [executeLifecycle, readOnlyDemoMode])

  const runCreate = useCallback(() => {
    if (readOnlyDemoMode) return
    const validation = validateDataSourceConfigForm(createForm, 'create')
    setCreateFormErrors(validation.errors)
    if (!validation.valid) return
    configMutation.mutate({ action: 'create', input: inputFromForm(createForm, targetChoices) })
  }, [configMutation, createForm, readOnlyDemoMode, targetChoices])

  const openConfigEditor = useCallback((row: DataSourceRuntimeRow) => {
    if (readOnlyDemoMode) return
    setConfigEditorErrors({})
    setConfigEditor({ row, form: formForRow(row) })
  }, [readOnlyDemoMode])

  const saveConfigEditor = useCallback(() => {
    if (readOnlyDemoMode) return
    if (!configEditor) return
    const validation = validateDataSourceConfigForm(configEditor.form, 'edit')
    setConfigEditorErrors(validation.errors)
    if (!validation.valid) return
    configMutation.mutate({
      action: 'edit',
      row: configEditor.row,
      input: inputFromForm(configEditor.form, targetChoices),
    })
  }, [configEditor, configMutation, readOnlyDemoMode, targetChoices])

  const openTargetEditor = useCallback((row: DataSourceRuntimeRow) => {
    if (readOnlyDemoMode) return
    setTargetEditor({
      row,
      selectedKeys: row.configuredTargets.map(deploymentTargetKey),
    })
  }, [readOnlyDemoMode])

  const saveTargetEditor = useCallback(() => {
    if (readOnlyDemoMode) return
    if (!targetEditor) return
    configMutation.mutate({
      action: 'targets',
      row: targetEditor.row,
      targets: selectedTargets(targetEditor.selectedKeys, targetChoices),
    })
  }, [configMutation, readOnlyDemoMode, targetChoices, targetEditor])

  const executeDelete = useCallback(
    (row: DataSourceRuntimeRow) => {
      if (readOnlyDemoMode) return
      configMutation.mutate({ action: 'delete', row })
    },
    [configMutation, readOnlyDemoMode],
  )

  const runDelete = useCallback((row: DataSourceRuntimeRow) => {
    if (readOnlyDemoMode) return
    setDestructiveIntent({ kind: 'delete', row })
  }, [readOnlyDemoMode])

  const confirmDestructiveIntent = useCallback(() => {
    if (!destructiveIntent) return
    const intent = destructiveIntent
    setDestructiveIntent(null)
    if (intent.kind === 'lifecycle') {
      executeLifecycle(intent.row, intent.action)
      return
    }
    executeDelete(intent.row)
  }, [destructiveIntent, executeDelete, executeLifecycle])

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return allRows
      .filter((row) => severity === 'all' || row.severity === severity)
      .filter((row) => server === 'all' || row.serverName === server)
      .filter((row) => state === 'all' || row.state === state)
      .filter((row) => needle.length === 0 || searchText(row).includes(needle))
      .sort((a, b) => compareRows(a, b, effectiveSort))
  }, [allRows, effectiveSort, search, server, severity, state])

  const columns = useMemo<DataTableColumn<DataSourceRuntimeRow>[]>(
    () => [
      {
        id: 'severity',
        header: 'STATUS',
        sortable: true,
        cell: (row) => <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.severity} />,
      },
      {
        id: 'name',
        header: 'NAME',
        sortable: true,
        className: 'min-w-[220px]',
        cell: (row) => (
          <Link
            to={dataSourceDetailPath(row)}
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
        id: 'server',
        header: 'SERVER',
        sortable: true,
        cell: (row) => <MonoText>{row.serverName}</MonoText>,
      },
      {
        id: 'targets',
        header: 'TARGETS',
        className: 'min-w-[160px] font-mono',
        cell: (row) => <MonoText title={targetSummary(row.configuredTargets)}>{targetSummary(row.configuredTargets)}</MonoText>,
      },
      {
        id: 'jndi',
        header: 'JNDI',
        className: 'min-w-[160px] font-mono',
        cell: (row) =>
          row.jndiNames.length ? (
            <MonoText title={listSummary(row.jndiNames)}>{listSummary(row.jndiNames)}</MonoText>
          ) : (
            <EmptyValue />
          ),
      },
      {
        id: 'state',
        header: 'STATE',
        sortable: true,
        cell: (row) => <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.state} />,
      },
      {
        id: 'deployment',
        header: 'DEPLOY',
        cell: (row) => <MonoText>{formatDeploymentState(row.deploymentState)}</MonoText>,
      },
      {
        id: 'active',
        header: 'ACTIVE',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              history.scopeKey,
              'jdbc',
              jdbcMetricResourceId(row.serverName, row.name),
              'connections.active',
            )}
            value={formatNumber(row.activeConnectionsCurrentCount)}
            title={`${row.name} active connections`}
          />
        ),
      },
      {
        id: 'capacity',
        header: 'MAX',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => formatNumber(row.utilizationCapacity),
      },
      {
        id: 'created',
        header: 'CREATED',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => formatNumber(row.currCapacity),
      },
      {
        id: 'utilization',
        header: 'UTIL',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              history.scopeKey,
              'jdbc',
              jdbcMetricResourceId(row.serverName, row.name),
              'utilization.percent',
            )}
            value={<UtilizationCell row={row} />}
            title={`${row.name} utilization`}
          />
        ),
      },
      {
        id: 'waiting',
        header: 'WAIT',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => (
          <MetricTrend
            series={getMetricHistorySeries(
              history.scopeKey,
              'jdbc',
              jdbcMetricResourceId(row.serverName, row.name),
              'connections.waiting',
            )}
            value={formatNumber(row.waitingForConnectionCurrentCount)}
            title={`${row.name} waiting connections`}
          />
        ),
      },
      {
        id: 'leaked',
        header: 'LEAKS',
        sortable: true,
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => formatNumber(row.leakedConnectionCount),
      },
      {
        id: 'actions',
        header: 'ACTIONS',
        align: 'right',
        sticky: 'right',
        className: 'w-[112px]',
        cell: (row) => {
          const actions = dataSourceRowActions(row, actionModeOptions)
          const configActions = canMutateDataSourceConfig(row, actionModeOptions)
          if (actions.length === 0 && !configActions) return <span className="text-status-neutral">–</span>
          const lifecycleAction = (action: DataSourceLifecycleAction): RowAction => ({
            key: action,
            label: actionLabel(action),
            pendingLabel: pendingLabel(action),
            ariaLabel: `${actionLabel(action)} ${row.name} on ${row.serverName}`,
            destructive: action === 'suspend' || action === 'reset',
            pending:
              pendingLifecycle?.dataSourceName === row.name &&
              pendingLifecycle.serverName === row.serverName &&
              pendingLifecycle.action === action,
            onSelect: () => runLifecycle(row, action),
          })
          const primaryAction = actions.includes('testPool') ? 'testPool' : actions[0]
          const more: RowAction[] = actions.filter((action) => action !== primaryAction).map(lifecycleAction)
          if (configActions) {
            more.push(
              {
                key: 'edit',
                label: 'Edit…',
                ariaLabel: `Edit ${row.name}`,
                separatorBefore: more.length > 0,
                onSelect: () => openConfigEditor(row),
              },
              {
                key: 'targets',
                label: 'Edit targets…',
                ariaLabel: `Edit targets for ${row.name}`,
                onSelect: () => openTargetEditor(row),
              },
              {
                key: 'delete',
                label: 'Delete…',
                ariaLabel: `Delete ${row.name}`,
                destructive: true,
                separatorBefore: true,
                pending: pendingConfig?.action === 'delete' && pendingConfig.row.systemResourceName === row.systemResourceName,
                onSelect: () => runDelete(row),
              },
            )
          }
          return (
            <RowActions
              primary={primaryAction ? lifecycleAction(primaryAction) : null}
              more={more}
              moreLabel={`More actions for ${row.name} on ${row.serverName}`}
              disabled={mutationPending}
            />
          )
        },
      },
    ],
    [
      actionModeOptions,
      mutationPending,
      openConfigEditor,
      openTargetEditor,
      pendingConfig,
      pendingLifecycle,
      history.scopeKey,
      returnState,
      runDelete,
      runLifecycle,
    ],
  )
  const destructiveSubject = destructiveIntent
    ? `${destructiveIntent.row.name} on ${destructiveIntent.row.serverName}`
    : undefined
  const destructiveLabel =
    destructiveIntent?.kind === 'delete'
      ? 'Confirm delete'
      : destructiveIntent?.action === 'reset'
        ? 'Confirm reset'
        : 'Confirm suspend'

  const targetEditorChange = targetEditor
    ? targetChange(targetEditor.row.configuredTargets.map(deploymentTargetKey), targetEditor.selectedKeys)
    : null
  const targetEditorChanged = !!targetEditorChange && (targetEditorChange.added.length > 0 || targetEditorChange.removed.length > 0)

  return (
    <>
      <PageHeader
        title="Data Sources"
        subtitle="JDBC pool status and connectivity."
        action={
          !readOnlyDemoMode ? (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setCreateFormErrors({})
                setShowCreateForm((value) => !value)
              }}
            >
              <Plus className="size-3.5" strokeWidth={1.5} />
              Create data source
            </Button>
          ) : null
        }
        updatedAt={query.dataUpdatedAt}
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
      />

      <ConfirmDialog
        open={!!destructiveIntent}
        title={
          destructiveIntent?.kind === 'delete'
            ? 'Delete datasource?'
            : destructiveIntent?.action === 'reset'
              ? 'Reset datasource?'
              : 'Suspend datasource?'
        }
        description={
          destructiveIntent?.kind === 'delete'
            ? 'This will delete the configured JDBC system resource in a WebLogic edit session.'
            : destructiveIntent?.action === 'reset'
              ? 'This will reset the datasource pool and can discard current pooled connections.'
              : 'This will suspend the datasource runtime on the selected server.'
        }
        subject={destructiveSubject}
        confirmLabel={destructiveLabel}
        pending={mutationPending}
        onConfirm={confirmDestructiveIntent}
        onCancel={() => setDestructiveIntent(null)}
      />

      {showCreateForm && !readOnlyDemoMode ? (
        <DataSourceConfigForm
          mode="create"
          form={createForm}
          errors={createFormErrors}
          targetChoices={targetChoices}
          disabled={targetChoicesQuery.isLoading || mutationPending}
          supportsInvokeBeginEndRequest={supportsInvokeBeginEndRequest}
          onChange={(form) => {
            setCreateForm(form)
            setCreateFormErrors({})
          }}
          onCancel={() => {
            setCreateFormErrors({})
            setShowCreateForm(false)
          }}
          onSubmit={runCreate}
        />
      ) : null}

      {configEditor && !readOnlyDemoMode ? (
        <DataSourceConfigForm
          mode="edit"
          form={configEditor.form}
          errors={configEditorErrors}
          targetChoices={targetChoices}
          disabled={targetChoicesQuery.isLoading || mutationPending}
          supportsInvokeBeginEndRequest={supportsInvokeBeginEndRequest}
          onChange={(form) => {
            setConfigEditor((current) => (current ? { ...current, form } : current))
            setConfigEditorErrors({})
          }}
          onCancel={() => {
            setConfigEditorErrors({})
            setConfigEditor(null)
          }}
          onSubmit={saveConfigEditor}
        />
      ) : null}

      {targetEditor && !readOnlyDemoMode ? (
        <div className="mb-3 border border-border bg-surface-1/40 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-muted-foreground text-[11px] uppercase tracking-[0.04em]">Datasource targets</div>
              <MonoText>{targetEditor.row.systemResourceName ?? targetEditor.row.name}</MonoText>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setTargetEditor(null)}>
                Cancel
              </Button>
              <Button type="button" size="sm" disabled={targetChoicesQuery.isLoading || mutationPending || !targetEditorChanged} onClick={saveTargetEditor}>
                {pendingConfig?.action === 'targets' ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : null}
                Save targets
              </Button>
            </div>
          </div>
          {targetEditorChange ? <TargetChangeNotice change={targetEditorChange} /> : null}
          <TargetCheckboxes
            choices={targetChoices}
            selectedKeys={targetEditor.selectedKeys}
            disabled={targetChoicesQuery.isLoading || mutationPending}
            onChange={(selectedKeys) => setTargetEditor((current) => (current ? { ...current, selectedKeys } : current))}
          />
        </div>
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
            aria-label="Filter data sources"
            placeholder="Filter data sources"
            value={search}
            onChange={(event) => updateTableState({ search: event.target.value })}
            className="h-8 rounded-[4px] pl-7 text-[13px]"
          />
        </div>
        <select
          aria-label="Filter datasource severity"
          value={severity}
          onChange={(event) => updateTableState({ filters: { severity: event.target.value } })}
          className="border-input bg-background h-8 min-w-[132px] rounded-[4px] border px-2 text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {severityFilters.map((option) => (
            <option key={option} value={option}>
              {filterOptionLabel(option, 'All statuses')}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter datasource server"
          value={server}
          onChange={(event) => updateTableState({ filters: { server: event.target.value } })}
          className="border-input bg-background h-8 min-w-[148px] rounded-[4px] border px-2 text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">All servers</option>
          {serverOptions.map((serverName) => (
            <option key={serverName} value={serverName}>
              {serverName}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter datasource state"
          value={state}
          onChange={(event) => updateTableState({ filters: { state: event.target.value } })}
          className="border-input bg-background h-8 min-w-[132px] rounded-[4px] border px-2 text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">All states</option>
          {stateOptions.map((option) => (
            <option key={option} value={option}>
              {option}
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
                filters: { severity: 'all', server: 'all', state: 'all' },
                sort,
              })
            }}
          >
            Reset
          </Button>
        ) : null}
      </div>

      {lifecycleResult ? (
        <div
          role="status"
          aria-live="polite"
          className="border-status-positive/60 bg-status-positive/8 mb-3 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]"
        >
          <span className="text-status-positive font-medium">Datasource action completed</span>
          <span className="text-muted-foreground min-w-0 truncate font-mono">
            {resultSummary(lifecycleResult)}
          </span>
        </div>
      ) : null}

      {configResult ? (
        <div
          role="status"
          aria-live="polite"
          className="border-status-positive/60 bg-status-positive/8 mb-3 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]"
        >
          <span className="text-status-positive font-medium">Datasource {configActionLabel(configResult.action)} accepted</span>
          <span className="text-muted-foreground min-w-0 truncate font-mono">{configResult.detail}</span>
        </div>
      ) : null}

      {lifecycleError ? (
        <div
          role="alert"
          className="border-status-negative/60 bg-status-negative/8 mb-3 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]"
        >
          <span className="text-status-negative font-medium">Datasource action failed</span>
          <span className="min-w-0 truncate font-mono">{lifecycleError}</span>
        </div>
      ) : null}

      <PartialBanner failures={failures} onRetry={() => void query.refetch()} />

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
                message: query.error instanceof Error ? query.error.message : 'Unable to load datasource runtimes.',
                retry: () => void query.refetch(),
              }
            : null
        }
        empty={{
          message:
            hasActiveFilters && allRows.length > 0
              ? 'No datasource rows match the current filters.'
              : 'No datasource rows reported by runtime or configuration discovery.',
        }}
      />
    </>
  )
}
