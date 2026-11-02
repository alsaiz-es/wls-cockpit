import { useCallback, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronRight, CornerDownRight, List, Loader2, PackagePlus, RefreshCw, Search, Table2 } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { readOnlyDemoModeEnabled } from '@/api/runtime-config'
import {
  deployApplication,
  deploymentNameFromFileName,
  undeployApplication,
  updateDeploymentTargets,
  useDeploymentTargetChoices,
  type DeployApplicationInput,
  type DeploymentSource,
  type DeploymentConfigAction,
  type DeploymentConfigResult,
  type DeploymentTargetChoice,
} from '@/api/queries/deployment-management'
import { deploymentTargetKey, deploymentTargetLabel } from '@/api/queries/deployment-targets'
import { invalidateEditSessionAffectedQueries } from '@/api/queries/edit-sessions'
import {
  runDeploymentLifecycleAction,
  type DeploymentLifecycleAction,
  type DeploymentLifecycleProgress,
} from '@/api/queries/deployment-lifecycle'
import {
  useDeployments,
  buildDeploymentRuntimeGroups,
  type DeploymentRuntimeGroup,
  type DeploymentRuntimeRow,
  type DeploymentSeverity,
  type DeploymentTargetRef,
} from '@/api/queries/deployments'
import {
  buildDeploymentTargetingMatrix,
  matrixRowMatchesCluster,
  matrixRowMatchesTarget,
  type DeploymentMatrixCellState,
  type DeploymentMatrixDrift,
  type DeploymentMatrixRow,
  type DeploymentMatrixTargetColumn,
} from '@/api/queries/deployment-targeting-matrix'
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
  type StatusTone,
  type WlsHealthState,
} from '@/components'
import { JMS_MODULE_TYPE } from '@/api/queries/deployment-config-normalization'
import { deploymentStateLabel } from '@/api/queries/deployment-progress'
import { RowActions, type RowAction } from '@/components/row-actions'
import { TargetChangeNotice } from '@/components/target-change-notice'
import { targetChange } from '@/components/target-change-model'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  parseRuntimeTableUrlState,
  serializeRuntimeTableUrlState,
  type RuntimeTableUrlConfig,
  type RuntimeTableUrlState,
} from './runtime-table-url-state'
import { detailReturnState } from './detail-return-state'
import {
  availableDeploymentLifecycleActions,
  canMutateDeploymentConfig,
  deploymentConfirmCopy,
  formatActiveVersionState,
  formatDeploymentState,
  rowStateLabel,
  type DeploymentConfirmKind,
} from './deployment-actions'

const DEFAULT_SORT: DataTableSort = { columnId: 'severity', direction: 'asc' }
const severityOrder: DeploymentSeverity[] = ['critical', 'warning', 'unknown', 'healthy']
const healthOrder: WlsHealthState[] = ['critical', 'failed', 'overloaded', 'warn', 'unknown', 'ok']
const matrixDriftOptions: Array<{ value: DeploymentMatrixDrift; label: string }> = [
  { value: 'none', label: 'No drift' },
  { value: 'missing-runtime', label: 'Missing runtime' },
  { value: 'runtime-only', label: 'Runtime only' },
  { value: 'unavailable', label: 'Unavailable data' },
]

interface DeploymentLifecycleMutationVariables {
  deploymentName: string
  applicationName: string
  targetName: string
  action: DeploymentLifecycleAction
}

type DeploymentConfigMutationVariables =
  | { action: 'deploy'; input: DeployApplicationInput }
  | { action: 'undeploy'; deploymentName: string; applicationName: string }
  | { action: 'targets'; deploymentName: string; applicationName: string; targets: DeploymentTargetRef[] }

interface TargetEditorState {
  row: DeploymentRuntimeRow
  selectedKeys: string[]
}

type DeploymentTableRow =
  | { kind: 'group'; group: DeploymentRuntimeGroup }
  | { kind: 'instance'; group: DeploymentRuntimeGroup; row: DeploymentRuntimeRow }

type DestructiveDeploymentIntent = { kind: DeploymentConfirmKind; row: DeploymentRuntimeRow }

function severityTone(severity: DeploymentSeverity): StatusTone {
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

function compareGroupScope(a: DeploymentRuntimeGroup, b: DeploymentRuntimeGroup) {
  const order = ['external', 'mixed', 'internal']
  return order.indexOf(a.scope) - order.indexOf(b.scope)
}

function groupServerText(group: DeploymentRuntimeGroup) {
  return group.instances.map((row) => row.serverName).join(', ')
}

function compareGroups(a: DeploymentRuntimeGroup, b: DeploymentRuntimeGroup, sort: DataTableSort) {
  const direction = sort.direction === 'asc' ? 1 : -1
  switch (sort.columnId) {
    case 'severity':
      return (
        (severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)) * direction ||
        compareGroupScope(a, b) ||
        compareText(a.name, b.name) ||
        compareText(a.deploymentName, b.deploymentName)
      )
    case 'name':
      return compareText(a.name, b.name) * direction || compareText(a.deploymentName, b.deploymentName)
    case 'server':
      return (
        compareNumberWithNulls(a.instances.length, b.instances.length, sort.direction) ||
        compareText(groupServerText(a), groupServerText(b)) * direction
      )
    case 'health':
      return (healthOrder.indexOf(a.healthState) - healthOrder.indexOf(b.healthState)) * direction
    case 'overallHealth':
      return (healthOrder.indexOf(a.overallHealthState) - healthOrder.indexOf(b.overallHealthState)) * direction
    case 'activeVersion':
      return compareText(formatGroupActiveVersionState(a), formatGroupActiveVersionState(b)) * direction
    case 'deploymentState':
      return compareText(formatGroupDeploymentState(a), formatGroupDeploymentState(b)) * direction
    case 'scope':
      return compareGroupScope(a, b) * direction || compareText(a.name, b.name)
    case 'version':
      return compareText(formatGroupVersion(a), formatGroupVersion(b)) * direction
    default:
      return compareGroups(a, b, DEFAULT_SORT)
  }
}




function deploymentDetailPath(row: DeploymentRuntimeRow) {
  return `/deployments/${encodeURIComponent(row.serverName)}/${encodeURIComponent(row.deploymentName)}`
}

function targetSummary(targets: DeploymentTargetRef[]) {
  return targets.length ? targets.map(deploymentTargetLabel).join(', ') : '–'
}

function formatGroupValues<T>(values: T[], formatter: (value: T) => string) {
  const labels = Array.from(new Set(values.map(formatter).filter((value) => value !== '–')))
  return labels.length ? labels.join(', ') : '–'
}

function formatGroupActiveVersionState(group: DeploymentRuntimeGroup) {
  return formatGroupValues(group.activeVersionStates, formatActiveVersionState)
}

function formatGroupDeploymentState(group: DeploymentRuntimeGroup) {
  return formatGroupValues(group.deploymentStates, formatDeploymentState)
}

function formatGroupVersion(group: DeploymentRuntimeGroup) {
  return group.applicationVersions.length ? group.applicationVersions.join(', ') : '–'
}

function searchText(row: DeploymentRuntimeRow) {
  return [
    row.name,
    row.deploymentName,
    row.serverName,
    targetSummary(row.configuredTargets),
    row.healthState,
    row.overallHealthState,
    row.scope,
    formatDeploymentState(row.deploymentState),
    formatActiveVersionState(row.activeVersionState),
    row.applicationVersion ?? '',
  ]
    .join(' ')
    .toLowerCase()
}

function actionLabel(action: DeploymentLifecycleAction) {
  if (action === 'start') return 'Start'
  if (action === 'stop') return 'Stop'
  return 'Redeploy'
}

function pendingLabel(action: DeploymentLifecycleAction) {
  if (action === 'start') return 'Starting…'
  if (action === 'stop') return 'Stopping…'
  return 'Redeploying…'
}


function progressSummary(progress: DeploymentLifecycleProgress) {
  const target = progress.targets.length ? progress.targets.join(', ') : progress.targetName
  const label = deploymentStateLabel(progress.state)
  const state = label ? ` · ${label}` : ''
  return `${actionLabel(progress.action)} ${progress.applicationName} on ${target}${state}`
}

function configActionLabel(action: DeploymentConfigAction) {
  if (action === 'deploy') return 'Deploy'
  if (action === 'undeploy') return 'Undeploy'
  return 'Targets'
}

function selectedTargets(keys: string[], choices: DeploymentTargetChoice[]) {
  const choiceByKey = new Map(choices.map((choice) => [deploymentTargetKey(choice), choice]))
  return keys.flatMap((key) => {
    const choice = choiceByKey.get(key)
    return choice ? [{ kind: choice.kind, name: choice.name }] : []
  })
}

function initialDeployForm() {
  return {
    name: '',
    source: 'upload' as DeploymentSource,
    applicationPath: '',
    planPath: '',
    file: null as File | null,
    targetKeys: [] as string[],
  }
}

function EmptyValue() {
  return <MonoText className="text-status-neutral">–</MonoText>
}

function matrixDriftLabel(value: DeploymentMatrixDrift) {
  return matrixDriftOptions.find((option) => option.value === value)?.label ?? value
}

function matrixDriftTone(value: DeploymentMatrixDrift): StatusTone {
  if (value === 'none') return 'positive'
  if (value === 'missing-runtime' || value === 'runtime-only') return 'warning'
  return 'unknown'
}

function matrixCellLabel(state: DeploymentMatrixCellState) {
  switch (state) {
    case 'configured-active':
      return 'CONFIG + ACTIVE'
    case 'configured-inactive':
      return 'CONFIG + INACTIVE'
    case 'configured-missing':
      return 'MISSING'
    case 'configured-unavailable':
      return 'CONFIG'
    case 'runtime-active':
      return 'RUNTIME'
    case 'runtime-inactive':
      return 'RUNTIME INACTIVE'
    default:
      return '–'
  }
}

function matrixCellTone(state: DeploymentMatrixCellState): StatusTone {
  if (state === 'configured-active') return 'positive'
  if (state === 'configured-missing') return 'negative'
  if (state === 'configured-inactive' || state === 'runtime-active' || state === 'runtime-inactive') return 'warning'
  if (state === 'configured-unavailable') return 'unknown'
  return 'neutral'
}

function matrixCellTitle(state: DeploymentMatrixCellState) {
  switch (state) {
    case 'configured-active':
      return 'Configured target with active runtime.'
    case 'configured-inactive':
      return 'Configured target with inactive runtime.'
    case 'configured-missing':
      return 'Configured server target without an observed runtime row.'
    case 'configured-unavailable':
      return 'Configured cluster target; member runtime mapping is not available.'
    case 'runtime-active':
      return 'Runtime is active on this server, but the server is not a configured target.'
    case 'runtime-inactive':
      return 'Runtime is inactive on this server, but the server is not a configured target.'
    default:
      return 'No configured target or runtime observed.'
  }
}

function matrixRowSearchText(row: DeploymentMatrixRow) {
  return [
    row.name,
    row.deploymentName,
    row.scope,
    matrixDriftLabel(row.drift),
    ...row.configuredTargets.map(deploymentTargetLabel),
    ...row.cells.flatMap((cell) => [cell.target.label, matrixCellLabel(cell.state), cell.runtimeRow?.serverName ?? '']),
  ].join(' ').toLowerCase()
}

function matrixRowDeploymentStateMatches(row: DeploymentMatrixRow, state: string) {
  if (state === 'all') return true
  return row.cells.some((cell) => cell.runtimeRow && rowStateLabel(cell.runtimeRow) === state)
}

function matrixVisibleTargets(
  targets: DeploymentMatrixTargetColumn[],
  targetFilter: string,
  clusterFilter: string,
) {
  if (targetFilter !== 'all') return targets.filter((target) => target.key === targetFilter)
  if (clusterFilter !== 'all') return targets.filter((target) => target.kind === 'clusters' && target.name === clusterFilter)
  return targets
}

function DeploymentMatrixCellBadge({ state }: { state: DeploymentMatrixCellState }) {
  if (state === 'empty') return <span className="text-status-neutral">–</span>
  return (
    <span title={matrixCellTitle(state)}>
      <StatusBadge kind="custom" tone={matrixCellTone(state)} label={matrixCellLabel(state)} />
    </span>
  )
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
    return <span className="text-muted-foreground text-[13px]">No deployment targets reported.</span>
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

function DeploymentMatrixView({
  rows,
  targets,
  readOnlyDemoMode,
  mutationPending,
  pendingConfig,
  onEditTargets,
}: {
  rows: DeploymentMatrixRow[]
  targets: DeploymentMatrixTargetColumn[]
  readOnlyDemoMode: boolean
  mutationPending: boolean
  pendingConfig: DeploymentConfigMutationVariables | null
  onEditTargets: (row: DeploymentMatrixRow) => void
}) {
  if (rows.length === 0) {
    return (
      <div className="border-border bg-surface-1 flex min-h-28 items-center justify-center border px-3 py-3 text-[13px] text-muted-foreground">
        No deployment matrix rows match the current filters.
      </div>
    )
  }

  return (
    <div className="border-border bg-surface-1 overflow-x-auto border">
      <table className="min-w-full border-collapse text-left text-[13px] leading-[18px]">
        <thead className="text-muted-foreground sticky top-0 z-20 border-b border-border bg-background text-[11px] uppercase leading-[14px] tracking-[0.04em]">
          <tr>
            <th className="sticky left-0 z-10 min-w-[240px] bg-background px-3 py-2 font-medium">Deployment</th>
            <th className="min-w-[132px] px-3 py-2 font-medium">Drift</th>
            <th className="min-w-[132px] px-3 py-2 font-medium">Edit</th>
            {targets.map((target) => (
              <th key={target.key} className="min-w-[132px] px-3 py-2 font-medium">
                <MonoText className="block truncate" title={target.label}>{target.label}</MonoText>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const pendingTargets =
              pendingConfig?.action === 'targets' &&
              pendingConfig.deploymentName === row.deploymentName &&
              pendingConfig.applicationName === row.name
            return (
              <tr key={row.id} className="border-b border-border last:border-b-0">
                <td className="sticky left-0 z-10 border-r border-border bg-surface-1 px-3 py-2">
                  <MonoText className="block max-w-[220px] truncate font-medium" title={row.name}>{row.name}</MonoText>
                  {row.deploymentName !== row.name ? (
                    <MonoText className="text-muted-foreground block max-w-[220px] truncate text-[11px]" title={row.deploymentName}>
                      {row.deploymentName}
                    </MonoText>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge kind="custom" tone={matrixDriftTone(row.drift)} label={matrixDriftLabel(row.drift)} />
                </td>
                <td className="px-3 py-2">
                  {row.editable && !readOnlyDemoMode ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={mutationPending}
                      aria-label={`Edit targets for ${row.name} from matrix`}
                      onClick={() => onEditTargets(row)}
                    >
                      {pendingTargets ? <Loader2 className="size-3 animate-spin" strokeWidth={1.5} /> : null}
                      Targets
                    </Button>
                  ) : (
                    <MonoText className="text-muted-foreground" title={readOnlyDemoMode ? 'Read-only demo mode.' : (row.protectedReason ?? undefined)}>
                      READ-ONLY
                    </MonoText>
                  )}
                </td>
                {targets.map((target) => {
                  const cell = row.cellsByTargetKey.get(target.key)
                  return (
                    <td key={target.key} className="px-3 py-2">
                      <DeploymentMatrixCellBadge state={cell?.state ?? 'empty'} />
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function Deployments() {
  const { creds } = useAuth()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [showDeployForm, setShowDeployForm] = useState(false)
  const [deployForm, setDeployForm] = useState(initialDeployForm)
  const [targetEditor, setTargetEditor] = useState<TargetEditorState | null>(null)
  const [viewMode, setViewMode] = useState<'list' | 'matrix'>('list')
  const [matrixTargetFilter, setMatrixTargetFilter] = useState('all')
  const [matrixClusterFilter, setMatrixClusterFilter] = useState('all')
  const [matrixDriftFilter, setMatrixDriftFilter] = useState<'all' | DeploymentMatrixDrift>('all')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const [destructiveIntent, setDestructiveIntent] = useState<DestructiveDeploymentIntent | null>(null)
  const [lifecycleProgress, setLifecycleProgress] = useState<DeploymentLifecycleProgress | null>(null)
  const [configProgress, setConfigProgress] = useState<DeploymentConfigResult | null>(null)
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  const query = useDeployments()
  const queryClient = useQueryClient()
  const readOnlyDemoMode = readOnlyDemoModeEnabled()
  const actionModeOptions = useMemo(() => ({ readOnlyDemoMode }), [readOnlyDemoMode])
  const targetChoicesQuery = useDeploymentTargetChoices()
  const targetChoices = useMemo(() => targetChoicesQuery.data ?? [], [targetChoicesQuery.data])
  const returnState = useMemo(() => detailReturnState(location), [location])
  const failures = query.data?.partialFailures ?? []
  const allRows = useMemo(() => query.data?.rows ?? [], [query.data?.rows])
  const serverOptions = useMemo(() => {
    return [...new Set(allRows.map((row) => row.serverName))].sort(compareText)
  }, [allRows])
  const deploymentStateOptions = useMemo(() => {
    return [...new Set(allRows.map(rowStateLabel))].sort(compareText)
  }, [allRows])
  const tableUrlConfig = useMemo<RuntimeTableUrlConfig>(
    () => ({
      defaultSort: DEFAULT_SORT,
      sortableColumns: ['severity', 'name', 'server', 'health', 'overallHealth', 'activeVersion', 'deploymentState', 'scope', 'version'],
      filters: {
        server: { param: 'server', defaultValue: 'all', allowedValues: ['all', ...serverOptions] },
        deploymentState: { param: 'deployment', defaultValue: 'all', allowedValues: ['all', ...deploymentStateOptions] },
        hideInternal: { param: 'internal', defaultValue: false },
      },
    }),
    [deploymentStateOptions, serverOptions],
  )
  const tableState = useMemo(
    () => parseRuntimeTableUrlState(searchParams, tableUrlConfig),
    [searchParams, tableUrlConfig],
  )
  const sort = tableState.sort
  const search = tableState.search
  const server = tableState.filters.server as string
  const deploymentState = tableState.filters.deploymentState as string
  const hideInternal = tableState.filters.hideInternal as boolean
  const effectiveSort = sort ?? DEFAULT_SORT
  const hasActiveMatrixFilters =
    viewMode === 'matrix' &&
    (matrixTargetFilter !== 'all' || matrixClusterFilter !== 'all' || matrixDriftFilter !== 'all')
  const hasActiveFilters =
    search.trim().length > 0 || server !== 'all' || deploymentState !== 'all' || hideInternal || hasActiveMatrixFilters
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
  const lifecycleMutation = useMutation<DeploymentLifecycleProgress, Error, DeploymentLifecycleMutationVariables>({
    mutationFn: async ({ deploymentName, targetName, action }) => {
      if (!creds) throw new Error('not authenticated')
      return runDeploymentLifecycleAction(creds, deploymentName, targetName, action)
    },
    onMutate: () => {
      setLifecycleProgress(null)
      setConfigProgress(null)
      setLifecycleError(null)
    },
    onSuccess: (progress) => {
      setLifecycleProgress(progress)
    },
    onError: (error) => {
      setLifecycleError(error.message || 'Deployment action failed.')
    },
    onSettled: async () => {
      await query.refetch()
    },
  })
  const configMutation = useMutation<DeploymentConfigResult, Error, DeploymentConfigMutationVariables>({
    mutationFn: async (variables) => {
      if (!creds) throw new Error('not authenticated')
      if (variables.action === 'deploy') return deployApplication(creds, variables.input)
      if (variables.action === 'undeploy') return undeployApplication(creds, variables.deploymentName)
      return updateDeploymentTargets(creds, variables.deploymentName, variables.targets)
    },
    onMutate: () => {
      setLifecycleProgress(null)
      setConfigProgress(null)
      setLifecycleError(null)
    },
    onSuccess: (progress) => {
      setConfigProgress(progress)
      if (progress.action === 'deploy') {
        setDeployForm(initialDeployForm())
        setShowDeployForm(false)
      }
      if (progress.action === 'targets') {
        setTargetEditor(null)
      }
    },
    onError: (error) => {
      setLifecycleError(error.message || 'Deployment action failed.')
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

  const executeLifecycle = useCallback(
    (row: DeploymentRuntimeRow, action: DeploymentLifecycleAction) => {
      if (readOnlyDemoMode) return
      lifecycleMutation.mutate({
        deploymentName: row.deploymentName,
        applicationName: row.name,
        targetName: row.targetName,
        action,
      })
    },
    [lifecycleMutation, readOnlyDemoMode],
  )

  const runLifecycle = useCallback(
    (row: DeploymentRuntimeRow, action: DeploymentLifecycleAction) => {
      if (readOnlyDemoMode) return
      setDestructiveIntent({ kind: action, row })
    },
    [readOnlyDemoMode],
  )

  const runDeploy = useCallback(() => {
    if (readOnlyDemoMode) return
    const targets = selectedTargets(deployForm.targetKeys, targetChoices)
    configMutation.mutate({
      action: 'deploy',
      input: {
        name: deployForm.name,
        source: deployForm.source,
        applicationPath: deployForm.applicationPath,
        planPath: deployForm.planPath,
        file: deployForm.file,
        targets,
      },
    })
  }, [configMutation, deployForm, readOnlyDemoMode, targetChoices])

  const executeUndeploy = useCallback(
    (row: DeploymentRuntimeRow) => {
      if (readOnlyDemoMode) return
      configMutation.mutate({
        action: 'undeploy',
        deploymentName: row.deploymentName,
        applicationName: row.name,
      })
    },
    [configMutation, readOnlyDemoMode],
  )

  const runUndeploy = useCallback((row: DeploymentRuntimeRow) => {
    if (readOnlyDemoMode) return
    setDestructiveIntent({ kind: 'undeploy', row })
  }, [readOnlyDemoMode])

  const confirmDestructiveIntent = useCallback(() => {
    if (!destructiveIntent) return
    const intent = destructiveIntent
    setDestructiveIntent(null)
    if (intent.kind === 'undeploy') {
      executeUndeploy(intent.row)
      return
    }
    executeLifecycle(intent.row, intent.kind)
  }, [destructiveIntent, executeLifecycle, executeUndeploy])

  const openTargetEditor = useCallback((row: DeploymentRuntimeRow) => {
    if (readOnlyDemoMode) return
    setTargetEditor({
      row,
      selectedKeys: row.configuredTargets.map(deploymentTargetKey),
    })
  }, [readOnlyDemoMode])

  const openMatrixTargetEditor = useCallback((row: DeploymentMatrixRow) => {
    if (readOnlyDemoMode || !row.editable || !row.sourceRow) return
    setTargetEditor({
      row: row.sourceRow,
      selectedKeys: row.configuredTargets.map(deploymentTargetKey),
    })
  }, [readOnlyDemoMode])

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  const saveTargetEditor = useCallback(() => {
    if (readOnlyDemoMode) return
    if (!targetEditor) return
    configMutation.mutate({
      action: 'targets',
      deploymentName: targetEditor.row.deploymentName,
      applicationName: targetEditor.row.name,
      targets: selectedTargets(targetEditor.selectedKeys, targetChoices),
    })
  }, [configMutation, readOnlyDemoMode, targetChoices, targetEditor])

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const filteredRows = allRows
      .filter((row) => !hideInternal || row.scope !== 'internal')
      .filter((row) => server === 'all' || row.serverName === server)
      .filter((row) => deploymentState === 'all' || rowStateLabel(row) === deploymentState)
      .filter((row) => needle.length === 0 || searchText(row).includes(needle))
    return buildDeploymentRuntimeGroups(filteredRows).sort((a, b) => compareGroups(a, b, effectiveSort))
  }, [allRows, deploymentState, effectiveSort, hideInternal, search, server])

  const tableRows = useMemo<DeploymentTableRow[]>(() => {
    return groups.flatMap((group) => {
      const children = collapsedGroups.has(group.id)
        ? []
        : group.instances.map((row): DeploymentTableRow => ({ kind: 'instance', group, row }))
      return [{ kind: 'group', group } as DeploymentTableRow, ...children]
    })
  }, [collapsedGroups, groups])

  const matrix = useMemo(() => {
    const matrixGroups = buildDeploymentRuntimeGroups(allRows).sort((a, b) => compareGroups(a, b, effectiveSort))
    return buildDeploymentTargetingMatrix(matrixGroups, targetChoices)
  }, [allRows, effectiveSort, targetChoices])
  const matrixClusterOptions = useMemo(() => {
    return matrix.targets.filter((target) => target.kind === 'clusters').map((target) => target.name)
  }, [matrix.targets])
  const matrixTargets = useMemo(
    () => matrixVisibleTargets(matrix.targets, matrixTargetFilter, matrixClusterFilter),
    [matrix.targets, matrixClusterFilter, matrixTargetFilter],
  )
  const matrixRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return matrix.rows.filter((row) => {
      if (hideInternal && row.scope !== 'external') return false
      if (deploymentState !== 'all' && !matrixRowDeploymentStateMatches(row, deploymentState)) return false
      if (matrixTargetFilter !== 'all' && !matrixRowMatchesTarget(row, matrixTargetFilter)) return false
      if (matrixClusterFilter !== 'all' && !matrixRowMatchesCluster(row, matrixClusterFilter)) return false
      if (matrixDriftFilter !== 'all' && row.drift !== matrixDriftFilter) return false
      if (server !== 'all' && !matrixRowMatchesTarget(row, `servers:${server}`)) return false
      return needle.length === 0 || matrixRowSearchText(row).includes(needle)
    })
  }, [deploymentState, hideInternal, matrix.rows, matrixClusterFilter, matrixDriftFilter, matrixTargetFilter, search, server])

  const hasDeploymentState = useMemo(() => allRows.some((row) => row.deploymentState !== null), [allRows])
  const allColumns = useMemo<DataTableColumn<DeploymentTableRow>[]>(
    () => [
      {
        id: 'severity',
        header: 'STATUS',
        sortable: true,
        cell: (tableRow) => {
          const severity = tableRow.kind === 'group' ? tableRow.group.severity : tableRow.row.severity
          return <StatusBadge kind="custom" tone={severityTone(severity)} label={severity} />
        },
      },
      {
        id: 'name',
        header: 'NAME',
        sortable: true,
        className: 'min-w-[240px]',
        cell: (tableRow) => {
          if (tableRow.kind === 'group') {
            const expanded = !collapsedGroups.has(tableRow.group.id)
            const Icon = expanded ? ChevronDown : ChevronRight
            return (
              <button
                type="button"
                className="hover:text-accent flex max-w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${tableRow.group.name}`}
                onClick={() => toggleGroup(tableRow.group.id)}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                <span className="min-w-0">
                  <MonoText className="block truncate font-medium" title={tableRow.group.name}>
                    {tableRow.group.name}
                  </MonoText>
                  {tableRow.group.deploymentName !== tableRow.group.name ? (
                    <MonoText className="text-muted-foreground block truncate text-[11px]" title={tableRow.group.deploymentName}>
                      {tableRow.group.deploymentName}
                    </MonoText>
                  ) : null}
                </span>
              </button>
            )
          }

          return (
            <Link
              to={deploymentDetailPath(tableRow.row)}
              state={returnState}
              className="hover:text-accent flex min-w-0 items-center gap-2 pl-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
              <MonoText className="block truncate" title={tableRow.row.name}>
                {tableRow.row.name}
              </MonoText>
            </Link>
          )
        },
      },
      {
        id: 'server',
        header: 'INSTANCES',
        sortable: true,
        cell: (tableRow) =>
          tableRow.kind === 'group' ? (
            <MonoText>{tableRow.group.instances.length.toLocaleString()} instances</MonoText>
          ) : (
            <MonoText>{tableRow.row.serverName}</MonoText>
          ),
      },
      {
        id: 'health',
        header: 'HEALTH',
        sortable: true,
        cell: (tableRow) => (
          <StatusBadge kind="wls-health" value={tableRow.kind === 'group' ? tableRow.group.healthState : tableRow.row.healthState} />
        ),
      },
      {
        id: 'overallHealth',
        header: 'OVERALL',
        sortable: true,
        cell: (tableRow) => (
          <StatusBadge
            kind="wls-health"
            value={tableRow.kind === 'group' ? tableRow.group.overallHealthState : tableRow.row.overallHealthState}
          />
        ),
      },
      {
        id: 'activeVersion',
        header: 'ACTIVE',
        sortable: true,
        className: 'font-mono',
        cell: (tableRow) => (
          <MonoText>
            {tableRow.kind === 'group'
              ? formatGroupActiveVersionState(tableRow.group)
              : formatActiveVersionState(tableRow.row.activeVersionState)}
          </MonoText>
        ),
      },
      {
        id: 'deploymentState',
        header: 'DEPLOY',
        sortable: true,
        className: 'font-mono',
        cell: (tableRow) => (
          <MonoText>
            {tableRow.kind === 'group'
              ? formatGroupDeploymentState(tableRow.group)
              : formatDeploymentState(tableRow.row.deploymentState)}
          </MonoText>
        ),
      },
      {
        id: 'scope',
        header: 'SCOPE',
        sortable: true,
        cell: (tableRow) => {
          const scope = tableRow.kind === 'group' ? tableRow.group.scope : tableRow.row.scope
          return (
          <StatusBadge
            kind="custom"
            tone={scope === 'external' ? 'positive' : scope === 'mixed' ? 'warning' : 'neutral'}
            label={scope}
          />
          )
        },
      },
      {
        id: 'targets',
        header: 'TARGETS',
        className: 'min-w-[140px] max-w-[220px] font-mono',
        cell: (tableRow) => {
          const targets = tableRow.kind === 'group' ? tableRow.group.configuredTargets : tableRow.row.configuredTargets
          return (
            <MonoText className="block truncate" title={targetSummary(targets)}>
              {targetSummary(targets)}
            </MonoText>
          )
        },
      },
      {
        id: 'version',
        header: 'VERSION',
        sortable: true,
        className: 'font-mono',
        cell: (tableRow) => {
          const version = tableRow.kind === 'group' ? formatGroupVersion(tableRow.group) : tableRow.row.applicationVersion
          return version && version !== '–' ? (
            <MonoText title={version}>{version}</MonoText>
          ) : (
            <EmptyValue />
          )
        },
      },
      {
        id: 'actions',
        header: 'ACTIONS',
        align: 'right',
        sticky: 'right',
        className: 'w-[112px]',
        cell: (tableRow) => {
          if (tableRow.kind === 'group') return <span className="text-status-neutral">–</span>
          const row = tableRow.row
          const actions = availableDeploymentLifecycleActions(row, actionModeOptions)
          const configActions = canMutateDeploymentConfig(row, actionModeOptions)
          if (actions.length === 0 && !configActions) {
            return row.moduleType === JMS_MODULE_TYPE ? (
              <Link
                to={`/jms?server=${encodeURIComponent(row.serverName)}`}
                className="text-accent text-[12px] hover:underline"
                title="JMS modules are managed as JMS system resources, not as application deployments."
              >
                Open in JMS
              </Link>
            ) : (
              <span className="text-status-neutral">–</span>
            )
          }
          const lifecycleAction = (action: DeploymentLifecycleAction): RowAction => ({
            key: action,
            label: actionLabel(action),
            pendingLabel: pendingLabel(action),
            ariaLabel: `${actionLabel(action)} ${row.name} on ${row.targetName}`,
            destructive: action === 'stop',
            pending:
              pendingLifecycle?.deploymentName === row.deploymentName &&
              pendingLifecycle.targetName === row.targetName &&
              pendingLifecycle.action === action,
            onSelect: () => runLifecycle(row, action),
          })
          const primaryAction = actions.find((action) => action !== 'redeploy')
          const more: RowAction[] = actions.filter((action) => action !== primaryAction).map(lifecycleAction)
          if (configActions) {
            more.push(
              {
                key: 'targets',
                label: 'Edit targets…',
                ariaLabel: `Edit targets for ${row.name}`,
                onSelect: () => openTargetEditor(row),
              },
              {
                key: 'undeploy',
                label: 'Undeploy…',
                ariaLabel: `Undeploy ${row.name}`,
                destructive: true,
                separatorBefore: true,
                pending: pendingConfig?.action === 'undeploy' && pendingConfig.deploymentName === row.deploymentName,
                onSelect: () => runUndeploy(row),
              },
            )
          }
          return (
            <RowActions
              primary={primaryAction ? lifecycleAction(primaryAction) : null}
              more={more}
              moreLabel={`More actions for ${row.name} on ${row.targetName}`}
              disabled={mutationPending}
            />
          )
        },
      },
    ],
    [
      collapsedGroups,
      actionModeOptions,
      mutationPending,
      openTargetEditor,
      pendingConfig,
      pendingLifecycle,
      returnState,
      runLifecycle,
      runUndeploy,
      toggleGroup,
    ],
  )
  const columns = useMemo(
    () => (hasDeploymentState ? allColumns : allColumns.filter((column) => column.id !== 'deploymentState')),
    [allColumns, hasDeploymentState],
  )
  const confirmCopy = destructiveIntent ? deploymentConfirmCopy(destructiveIntent.kind, destructiveIntent.row) : null

  const targetEditorChange = targetEditor
    ? targetChange(targetEditor.row.configuredTargets.map(deploymentTargetKey), targetEditor.selectedKeys)
    : null
  const targetEditorChanged = !!targetEditorChange && (targetEditorChange.added.length > 0 || targetEditorChange.removed.length > 0)

  return (
    <>
      <PageHeader
        title="Deployments"
        subtitle="Applications and deployment state."
        meta={
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <span className="text-muted-foreground flex items-center gap-1 text-[13px] leading-[18px]">
              Updated <RelativeTime value={query.dataUpdatedAt} />
            </span>
            <div className="flex items-center gap-3">
              <div className="border-border bg-background flex h-8 items-center border">
                <Button
                  type="button"
                  variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('list')}
                >
                  <List className="size-3.5" strokeWidth={1.5} />
                  List
                </Button>
                <Button
                  type="button"
                  variant={viewMode === 'matrix' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('matrix')}
                >
                  <Table2 className="size-3.5" strokeWidth={1.5} />
                  Matrix
                </Button>
              </div>
              {!readOnlyDemoMode ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => setShowDeployForm((value) => !value)}>
                  <PackagePlus className="size-3.5" strokeWidth={1.5} />
                  Deploy
                </Button>
              ) : null}
              <label className="text-muted-foreground hover:text-foreground flex h-8 items-center gap-2 text-[13px] leading-[18px]">
                <input
                  type="checkbox"
                  className="accent-primary size-3.5"
                  checked={hideInternal}
                  onChange={(event) => updateTableState({ filters: { hideInternal: event.target.checked } })}
                />
                Hide internal
              </label>
              <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()}>
                <RefreshCw className="size-3.5" strokeWidth={1.5} />
                Refresh
              </Button>
            </div>
          </div>
        }
      />

      <ConfirmDialog
        open={!!confirmCopy}
        title={confirmCopy?.title ?? ''}
        description={confirmCopy?.description ?? ''}
        subject={confirmCopy?.subject}
        confirmLabel={confirmCopy?.confirmLabel}
        pending={mutationPending}
        onConfirm={confirmDestructiveIntent}
        onCancel={() => setDestructiveIntent(null)}
      />

      {showDeployForm && !readOnlyDemoMode ? (
        <div className="mb-3 border border-border bg-surface-1/40 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-3 text-[13px] leading-[18px]" role="radiogroup" aria-label="Deployment source">
            {(
              [
                ['upload', 'Upload from this computer'],
                ['path', 'Path on the AdminServer host'],
              ] as const
            ).map(([source, label]) => (
              <label key={source} className="flex h-8 items-center gap-2">
                <input
                  type="radio"
                  name="deployment-source"
                  className="accent-primary size-3.5"
                  checked={deployForm.source === source}
                  onChange={() => setDeployForm((current) => ({ ...current, source }))}
                />
                {label}
              </label>
            ))}
          </div>
          <p className="text-muted-foreground mb-2 text-[13px] leading-[18px]">
            {deployForm.source === 'upload' ? (
              <>
                Uploads a <MonoText>.war</MonoText>, <MonoText>.ear</MonoText>, <MonoText>.jar</MonoText> or{' '}
                <MonoText>.rar</MonoText> archive (up to 2 GiB) to the AdminServer, which stores it and deploys it to the
                targets you pick.
              </>
            ) : (
              <>
                Deploys an archive or exploded directory that already exists on the AdminServer host. Enter the path as the
                AdminServer sees it (for example <MonoText>/u01/apps/orders.war</MonoText>) and WebLogic stages it from
                there. The plan path is optional.
              </>
            )}
          </p>
          {deployForm.source === 'upload' ? (
            <div className="grid gap-2 md:grid-cols-[minmax(160px,0.8fr)_minmax(220px,2.1fr)]">
              <Input
                aria-label="Deployment name"
                placeholder="Deployment name"
                value={deployForm.name}
                onChange={(event) => setDeployForm((current) => ({ ...current, name: event.target.value }))}
                className="h-8 rounded-[4px] font-mono text-[13px]"
              />
              <Input
                type="file"
                aria-label="Archive to upload"
                accept=".war,.ear,.jar,.rar"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null
                  setDeployForm((current) => ({
                    ...current,
                    file,
                    name: current.name.trim() || !file ? current.name : deploymentNameFromFileName(file.name),
                  }))
                }}
                className="h-8 rounded-[4px] py-1 font-mono text-[13px]"
              />
            </div>
          ) : (
            <div className="grid gap-2 md:grid-cols-[minmax(160px,0.8fr)_minmax(220px,1.3fr)_minmax(160px,0.8fr)]">
              <Input
                aria-label="Deployment name"
                placeholder="Deployment name"
                value={deployForm.name}
                onChange={(event) => setDeployForm((current) => ({ ...current, name: event.target.value }))}
                className="h-8 rounded-[4px] font-mono text-[13px]"
              />
              <Input
                aria-label="AdminServer application path"
                placeholder="AdminServer path: /u01/apps/app.war"
                value={deployForm.applicationPath}
                onChange={(event) => setDeployForm((current) => ({ ...current, applicationPath: event.target.value }))}
                className="h-8 rounded-[4px] font-mono text-[13px]"
              />
              <Input
                aria-label="Deployment plan path"
                placeholder="Plan path (optional)"
                value={deployForm.planPath}
                onChange={(event) => setDeployForm((current) => ({ ...current, planPath: event.target.value }))}
                className="h-8 rounded-[4px] font-mono text-[13px]"
              />
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <TargetCheckboxes
              choices={targetChoices}
              selectedKeys={deployForm.targetKeys}
              disabled={targetChoicesQuery.isLoading || mutationPending}
              onChange={(targetKeys) => setDeployForm((current) => ({ ...current, targetKeys }))}
            />
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowDeployForm(false)}>
                Cancel
              </Button>
              <Button type="button" size="sm" disabled={mutationPending} onClick={runDeploy}>
                {pendingConfig?.action === 'deploy' ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : null}
                Deploy
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {targetEditor && !readOnlyDemoMode ? (
        <div className="mb-3 border border-border bg-surface-1/40 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-muted-foreground text-[11px] uppercase tracking-[0.04em]">Deployment targets</div>
              <MonoText>{targetEditor.row.deploymentName}</MonoText>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setTargetEditor(null)}>
                Cancel
              </Button>
              <Button type="button" size="sm" disabled={mutationPending || !targetEditorChanged} onClick={saveTargetEditor}>
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
            aria-label="Filter deployments"
            placeholder="Filter deployments"
            value={search}
            onChange={(event) => updateTableState({ search: event.target.value })}
            className="h-8 rounded-[4px] pl-7 text-[13px]"
          />
        </div>
        <select
          aria-label="Filter deployment server"
          value={server}
          onChange={(event) => updateTableState({ filters: { server: event.target.value } })}
          className="border-input bg-background h-8 min-w-[148px] rounded-[4px] border px-2 font-mono text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">All servers</option>
          {serverOptions.map((serverName) => (
            <option key={serverName} value={serverName}>
              {serverName}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter deployment state"
          value={deploymentState}
          onChange={(event) => updateTableState({ filters: { deploymentState: event.target.value } })}
          className="border-input bg-background h-8 min-w-[132px] rounded-[4px] border px-2 font-mono text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">All states</option>
          {deploymentStateOptions.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
        {viewMode === 'matrix' ? (
          <>
            <select
              aria-label="Filter matrix target"
              value={matrixTargetFilter}
              onChange={(event) => setMatrixTargetFilter(event.target.value)}
              className="border-input bg-background h-8 min-w-[164px] rounded-[4px] border px-2 font-mono text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="all">All targets</option>
              {matrix.targets.map((target) => (
                <option key={target.key} value={target.key}>
                  {target.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter matrix cluster"
              value={matrixClusterFilter}
              onChange={(event) => setMatrixClusterFilter(event.target.value)}
              className="border-input bg-background h-8 min-w-[156px] rounded-[4px] border px-2 font-mono text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="all">All clusters</option>
              {matrixClusterOptions.map((cluster) => (
                <option key={cluster} value={cluster}>
                  {cluster}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter matrix drift"
              value={matrixDriftFilter}
              onChange={(event) => setMatrixDriftFilter(event.target.value as 'all' | DeploymentMatrixDrift)}
              className="border-input bg-background h-8 min-w-[156px] rounded-[4px] border px-2 font-mono text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="all">All drift</option>
              {matrixDriftOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {hasActiveFilters ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setMatrixTargetFilter('all')
              setMatrixClusterFilter('all')
              setMatrixDriftFilter('all')
              updateTableState({
                search: '',
                filters: { server: 'all', deploymentState: 'all', hideInternal: false },
                sort,
              })
            }}
          >
            Reset
          </Button>
        ) : null}
      </div>

      {lifecycleProgress ? (
        <div
          role="status"
          aria-live="polite"
          className="border-status-positive/60 bg-status-positive/8 mb-3 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]"
        >
          <span className="text-status-positive font-medium">Deployment progress accepted</span>
          <span className="text-muted-foreground min-w-0 truncate font-mono">
            {progressSummary(lifecycleProgress)}
          </span>
        </div>
      ) : null}

      {configProgress ? (
        <div
          role="status"
          aria-live="polite"
          className="border-status-positive/60 bg-status-positive/8 mb-3 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]"
        >
          <span className="text-status-positive font-medium">Deployment {configActionLabel(configProgress.action)} accepted</span>
          <span className="text-muted-foreground min-w-0 truncate font-mono">{configProgress.detail}</span>
        </div>
      ) : null}

      {lifecycleError ? (
        <div
          role="alert"
          className="border-status-negative/60 bg-status-negative/8 mb-3 flex min-h-10 items-center gap-3 border px-3 py-2 text-[13px]"
        >
          <span className="text-status-negative font-medium">Deployment action failed</span>
          <span className="min-w-0 truncate font-mono">{lifecycleError}</span>
        </div>
      ) : null}

      <PartialBanner failures={failures} onRetry={() => void query.refetch()} />

      {viewMode === 'matrix' && !query.isError ? (
        query.isFetching && !query.data ? (
          <div className="text-muted-foreground flex h-24 items-center justify-center gap-2 border border-border text-[13px]">
            <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
            Loading deployment matrix...
          </div>
        ) : (
          <DeploymentMatrixView
            rows={matrixRows}
            targets={matrixTargets}
            readOnlyDemoMode={readOnlyDemoMode}
            mutationPending={mutationPending}
            pendingConfig={pendingConfig}
            onEditTargets={openMatrixTargetEditor}
          />
        )
      ) : (
        <DataTable
          columns={columns}
          rows={tableRows}
          getRowId={(row) => (row.kind === 'group' ? `group:${row.group.id}` : `instance:${row.row.id}`)}
          sort={effectiveSort}
          onSortChange={(nextSort) => updateTableState({ sort: nextSort })}
          loading={query.isFetching}
          error={
            query.isError
              ? {
                  message: query.error instanceof Error ? query.error.message : 'Unable to load application runtimes.',
                  retry: () => void query.refetch(),
                }
              : null
          }
          empty={{
            message:
              hasActiveFilters && allRows.length > 0
                ? 'No deployment rows match the current filters.'
                : 'No application runtimes reported by running servers.',
          }}
        />
      )}
    </>
  )
}
