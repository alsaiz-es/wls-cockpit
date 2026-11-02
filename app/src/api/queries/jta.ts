import { useQuery } from '@tanstack/react-query'
import {
  WLS_REST_PROXY_BASE_URL,
  wlsBasicAuthHeader,
  wlsCredentialCacheKey,
  type WlsCredentials,
} from '../client.ts'
import { actionAuditHeaders } from '../action-audit-headers.ts'
import { useRefreshStaleQueryOnVisibleReturn, useVisiblePollingInterval } from '../query-polling.ts'
import { WlsRestError, normalizeWlsRestError, withWlsRestTimeout } from '../wls-errors.ts'
import { useAuth } from '../../auth/useAuth.ts'
import {
  WLS_HEALTH_STATES,
  WLS_LIFECYCLE_STATES,
  type StatusTone,
  type WlsHealthState,
  type WlsLifecycleState,
} from '../../components/status-model.ts'

export const JTA_RUNTIME_FIELDS = [
  'name',
  'type',
  'healthState',
  'transactionServiceState',
  'activeTransactionsTotalCount',
  'transactionTotalCount',
  'transactionCommittedTotalCount',
  'transactionRolledBackTotalCount',
  'transactionRolledBackTimeoutTotalCount',
  'transactionAbandonedTotalCount',
  'transactionHeuristicsTotalCount',
  'secondsActiveTotalCount',
  'registeredResourceNames',
  'registeredNonXAResourceNames',
].join(',')

export const JTA_RESOURCE_FIELDS = [
  'name',
  'resourceName',
  'healthState',
  'transactionTotalCount',
  'transactionCommittedTotalCount',
  'transactionRolledBackTotalCount',
  'transactionHeuristicsTotalCount',
  'transactionHeuristicCommitTotalCount',
  'transactionHeuristicRollbackTotalCount',
  'transactionHeuristicHazardTotalCount',
  'transactionHeuristicMixedTotalCount',
].join(',')

export const JTA_RECOVERY_FIELDS = [
  'name',
  'active',
  'initialRecoveredTransactionTotalCount',
  'recoveredTransactionCompletionPercent',
  'initialRecoveredUnloggedTransactionTotalCount',
  'recoveredUnloggedTransactionCompletionPercent',
].join(',')

export const JTA_TRANSACTION_NAME_FIELDS = [
  'name',
  'transactionName',
  'transactionTotalCount',
  'transactionCommittedTotalCount',
  'transactionRolledBackTotalCount',
  'transactionHeuristicsTotalCount',
  'transactionAbandonedTotalCount',
  'secondsActiveTotalCount',
].join(',')

export const JTA_REQUEST_TIMEOUT_MS = 7_500

export type JtaSeverity = 'critical' | 'warning' | 'healthy' | 'unknown'
export type JtaRecoveryAction = 'forceCommit' | 'forceRollback'

export interface JtaPartialFailure {
  serverName: string
  family: string
  message: string
}

export interface JtaResourceRow {
  id: string
  serverName: string
  name: string
  resourceName: string
  healthState: WlsHealthState
  transactionTotalCount: number | null
  transactionCommittedTotalCount: number | null
  transactionRolledBackTotalCount: number | null
  transactionHeuristicsTotalCount: number | null
  transactionHeuristicCommitTotalCount: number | null
  transactionHeuristicRollbackTotalCount: number | null
  transactionHeuristicHazardTotalCount: number | null
  transactionHeuristicMixedTotalCount: number | null
}

export interface JtaRecoveryRow {
  id: string
  serverName: string
  name: string
  active: boolean | null
  initialRecoveredTransactionTotalCount: number | null
  recoveredTransactionCompletionPercent: number | null
  initialRecoveredUnloggedTransactionTotalCount: number | null
  recoveredUnloggedTransactionCompletionPercent: number | null
}

export interface JtaTransactionNameRow {
  id: string
  serverName: string
  name: string
  transactionName: string
  transactionTotalCount: number | null
  transactionCommittedTotalCount: number | null
  transactionRolledBackTotalCount: number | null
  transactionHeuristicsTotalCount: number | null
  transactionAbandonedTotalCount: number | null
  secondsActiveTotalCount: number | null
}

export interface JtaServerRow {
  id: string
  serverName: string
  lifecycleState: WlsLifecycleState
  available: boolean
  severity: JtaSeverity
  healthState: WlsHealthState
  transactionServiceState: string | null
  activeTransactionsTotalCount: number | null
  transactionTotalCount: number | null
  transactionCommittedTotalCount: number | null
  transactionRolledBackTotalCount: number | null
  transactionRolledBackTimeoutTotalCount: number | null
  transactionAbandonedTotalCount: number | null
  transactionHeuristicsTotalCount: number | null
  secondsActiveTotalCount: number | null
  registeredResourceCount: number | null
  registeredNonXAResourceCount: number | null
  resources: JtaResourceRow[]
  recoveryRows: JtaRecoveryRow[]
  transactionNames: JtaTransactionNameRow[]
  transactionRowsSupported: boolean
  recoveryActionsSupported: boolean
  unsupportedReason: string
}

export interface JtaSnapshot {
  servers: JtaServerRow[]
  partialFailures: JtaPartialFailure[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => (typeof item === 'string' ? [item] : [])) : []
}

function normalizeLifecycle(value: unknown): WlsLifecycleState {
  return WLS_LIFECYCLE_STATES.includes(value as WlsLifecycleState)
    ? (value as WlsLifecycleState)
    : 'UNKNOWN'
}

function normalizeHealth(value: unknown): WlsHealthState {
  if (typeof value !== 'string') return 'unknown'
  const normalized = value.toLowerCase() === 'warning' ? 'warn' : value.toLowerCase()
  return WLS_HEALTH_STATES.includes(normalized as WlsHealthState)
    ? (normalized as WlsHealthState)
    : 'unknown'
}

function healthFrom(value: unknown) {
  const health = isObject(value) ? value.healthState : null
  return normalizeHealth(isObject(health) ? health.state : null)
}

export function jtaSeverity(row: Pick<JtaServerRow, 'available' | 'healthState' | 'transactionHeuristicsTotalCount' | 'transactionAbandonedTotalCount' | 'transactionRolledBackTimeoutTotalCount' | 'activeTransactionsTotalCount'>): JtaSeverity {
  if (!row.available) return 'unknown'
  if (row.healthState === 'critical' || row.healthState === 'failed') return 'critical'
  if ((row.transactionHeuristicsTotalCount ?? 0) > 0 || (row.transactionAbandonedTotalCount ?? 0) > 0) return 'critical'
  if (row.healthState === 'warn' || row.healthState === 'overloaded') return 'warning'
  if ((row.transactionRolledBackTimeoutTotalCount ?? 0) > 0 || (row.activeTransactionsTotalCount ?? 0) > 0) return 'warning'
  return 'healthy'
}

export function jtaSeverityTone(severity: JtaSeverity): StatusTone {
  if (severity === 'critical') return 'negative'
  if (severity === 'warning') return 'warning'
  if (severity === 'healthy') return 'positive'
  return 'unknown'
}

export function jtaRuntimeQueryParams() {
  return { fields: JTA_RUNTIME_FIELDS, links: 'none' } as const
}

export function jtaResourceQueryParams() {
  return { fields: JTA_RESOURCE_FIELDS, links: 'none' } as const
}

export function jtaRecoveryQueryParams() {
  return { fields: JTA_RECOVERY_FIELDS, links: 'none' } as const
}

export function jtaTransactionNameQueryParams() {
  return { fields: JTA_TRANSACTION_NAME_FIELDS, links: 'none' } as const
}

function queryString(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}

function managementPath(creds: WlsCredentials, path: string, params?: Record<string, string>) {
  const suffix = params ? `?${queryString(params)}` : ''
  return `/management/weblogic/${encodeURIComponent(creds.version)}${path}${suffix}`
}

function serverRuntimePath(creds: WlsCredentials, serverName: string, suffix = '', params?: Record<string, string>) {
  return managementPath(
    creds,
    `/domainRuntime/serverRuntimes/${encodeURIComponent(serverName)}${suffix}`,
    params,
  )
}

async function fetchWlsJson(creds: WlsCredentials, operation: string, path: string, timeoutMs = JTA_REQUEST_TIMEOUT_MS) {
  try {
    const response = await withWlsRestTimeout(
      operation,
      (signal) =>
        fetch(`${WLS_REST_PROXY_BASE_URL}${path}`, {
          signal,
          headers: {
            Accept: 'application/json',
            Authorization: wlsBasicAuthHeader(creds),
            ...actionAuditHeaders(creds),
          },
        }),
      timeoutMs,
    )

    if (!response.ok) {
      throw new WlsRestError({
        kind: 'http',
        operation,
        status: response.status,
        statusText: response.statusText,
        message: `${operation}: HTTP ${response.status} ${response.statusText || 'HTTP error'}`,
      })
    }

    return response.status === 204 ? null : response.json()
  } catch (error) {
    throw normalizeWlsRestError(operation, error, timeoutMs)
  }
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : 'JTA request failed.'
}

function hasRuntimeMBean(state: WlsLifecycleState) {
  return state === 'RUNNING' || state === 'ADMIN' || state === 'STANDBY'
}

export function normalizeJtaResourceRows(data: unknown, serverName: string): JtaResourceRow[] {
  const items = isObject(data) && Array.isArray(data.items) ? data.items : []
  return items.flatMap((item): JtaResourceRow[] => {
    if (!isObject(item)) return []
    const name = readString(item.name)
    if (!name) return []
    const resourceName = readString(item.resourceName) ?? name
    return [{
      id: `${serverName}:resource:${resourceName}`,
      serverName,
      name,
      resourceName,
      healthState: healthFrom(item),
      transactionTotalCount: readNumber(item.transactionTotalCount),
      transactionCommittedTotalCount: readNumber(item.transactionCommittedTotalCount),
      transactionRolledBackTotalCount: readNumber(item.transactionRolledBackTotalCount),
      transactionHeuristicsTotalCount: readNumber(item.transactionHeuristicsTotalCount),
      transactionHeuristicCommitTotalCount: readNumber(item.transactionHeuristicCommitTotalCount),
      transactionHeuristicRollbackTotalCount: readNumber(item.transactionHeuristicRollbackTotalCount),
      transactionHeuristicHazardTotalCount: readNumber(item.transactionHeuristicHazardTotalCount),
      transactionHeuristicMixedTotalCount: readNumber(item.transactionHeuristicMixedTotalCount),
    }]
  })
}

export function normalizeJtaRecoveryRows(data: unknown, serverName: string): JtaRecoveryRow[] {
  const items = isObject(data) && Array.isArray(data.items) ? data.items : []
  return items.flatMap((item): JtaRecoveryRow[] => {
    if (!isObject(item)) return []
    const name = readString(item.name)
    if (!name) return []
    return [{
      id: `${serverName}:recovery:${name}`,
      serverName,
      name,
      active: readBoolean(item.active),
      initialRecoveredTransactionTotalCount: readNumber(item.initialRecoveredTransactionTotalCount),
      recoveredTransactionCompletionPercent: readNumber(item.recoveredTransactionCompletionPercent),
      initialRecoveredUnloggedTransactionTotalCount: readNumber(item.initialRecoveredUnloggedTransactionTotalCount),
      recoveredUnloggedTransactionCompletionPercent: readNumber(item.recoveredUnloggedTransactionCompletionPercent),
    }]
  })
}

export function normalizeJtaTransactionNameRows(data: unknown, serverName: string): JtaTransactionNameRow[] {
  const items = isObject(data) && Array.isArray(data.items) ? data.items : []
  return items.flatMap((item): JtaTransactionNameRow[] => {
    if (!isObject(item)) return []
    const name = readString(item.name)
    if (!name) return []
    const transactionName = readString(item.transactionName) ?? name
    return [{
      id: `${serverName}:transactionName:${transactionName}`,
      serverName,
      name,
      transactionName,
      transactionTotalCount: readNumber(item.transactionTotalCount),
      transactionCommittedTotalCount: readNumber(item.transactionCommittedTotalCount),
      transactionRolledBackTotalCount: readNumber(item.transactionRolledBackTotalCount),
      transactionHeuristicsTotalCount: readNumber(item.transactionHeuristicsTotalCount),
      transactionAbandonedTotalCount: readNumber(item.transactionAbandonedTotalCount),
      secondsActiveTotalCount: readNumber(item.secondsActiveTotalCount),
    }]
  })
}

export function normalizeJtaServerRow({
  serverName,
  lifecycleState,
  runtime,
  resources = [],
  recoveryRows = [],
  transactionNames = [],
}: {
  serverName: string
  lifecycleState: WlsLifecycleState
  runtime: unknown
  resources?: JtaResourceRow[]
  recoveryRows?: JtaRecoveryRow[]
  transactionNames?: JtaTransactionNameRow[]
}): JtaServerRow {
  const available = isObject(runtime)
  const registeredResourceNames = available ? readStringArray(runtime.registeredResourceNames) : []
  const registeredNonXAResourceNames = available ? readStringArray(runtime.registeredNonXAResourceNames) : []
  const base = {
    id: serverName,
    serverName,
    lifecycleState,
    available,
    severity: 'unknown' as JtaSeverity,
    healthState: available ? healthFrom(runtime) : 'unknown',
    transactionServiceState: available ? readString(runtime.transactionServiceState) : null,
    activeTransactionsTotalCount: available ? readNumber(runtime.activeTransactionsTotalCount) : null,
    transactionTotalCount: available ? readNumber(runtime.transactionTotalCount) : null,
    transactionCommittedTotalCount: available ? readNumber(runtime.transactionCommittedTotalCount) : null,
    transactionRolledBackTotalCount: available ? readNumber(runtime.transactionRolledBackTotalCount) : null,
    transactionRolledBackTimeoutTotalCount: available ? readNumber(runtime.transactionRolledBackTimeoutTotalCount) : null,
    transactionAbandonedTotalCount: available ? readNumber(runtime.transactionAbandonedTotalCount) : null,
    transactionHeuristicsTotalCount: available ? readNumber(runtime.transactionHeuristicsTotalCount) : null,
    secondsActiveTotalCount: available ? readNumber(runtime.secondsActiveTotalCount) : null,
    registeredResourceCount: available ? registeredResourceNames.length : null,
    registeredNonXAResourceCount: available ? registeredNonXAResourceNames.length : null,
    resources,
    recoveryRows,
    transactionNames,
    transactionRowsSupported: false,
    recoveryActionsSupported: false,
    unsupportedReason: 'This WebLogic runtime exposes JTA counters, recovery services, and resource statistics, but no bounded transaction row source was verified.',
  }

  return {
    ...base,
    severity: jtaSeverity(base),
  }
}

function unavailableJtaServerRow(serverName: string, lifecycleState: WlsLifecycleState): JtaServerRow {
  return normalizeJtaServerRow({ serverName, lifecycleState, runtime: null })
}

export function jtaSnapshotQueryKey(creds: WlsCredentials | null | undefined) {
  return ['jtaSnapshot', wlsCredentialCacheKey(creds)] as const
}

async function fetchLifecycleStates(creds: WlsCredentials) {
  const path = managementPath(creds, '/domainRuntime/serverLifeCycleRuntimes', {
    fields: 'name,state',
    links: 'none',
  })
  const data = await fetchWlsJson(creds, 'JTA server lifecycle states', path)
  const rows = isObject(data) && Array.isArray(data.items) ? data.items : []
  return rows.flatMap((item): Array<{ serverName: string; state: WlsLifecycleState }> => {
    if (!isObject(item)) return []
    const serverName = readString(item.name)
    if (!serverName) return []
    return [{ serverName, state: normalizeLifecycle(item.state) }]
  })
}

async function fetchJtaServerRow(
  creds: WlsCredentials,
  serverName: string,
  lifecycleState: WlsLifecycleState,
): Promise<{ row: JtaServerRow; failures: JtaPartialFailure[] }> {
  if (!hasRuntimeMBean(lifecycleState)) {
    return {
      row: unavailableJtaServerRow(serverName, lifecycleState),
      // A stopped server is shown as a row in its state, not reported as a request failure.
      failures: [],
    }
  }

  const failures: JtaPartialFailure[] = []
  let runtime: unknown
  try {
    runtime = await fetchWlsJson(
      creds,
      `JTA runtime ${serverName}`,
      serverRuntimePath(creds, serverName, '/JTARuntime', jtaRuntimeQueryParams()),
    )
  } catch (error) {
    return {
      row: unavailableJtaServerRow(serverName, lifecycleState),
      failures: [{ serverName, family: 'runtime', message: failureMessage(error) }],
    }
  }

  const [resourcesResult, recoveryResult, transactionNamesResult] = await Promise.allSettled([
    fetchWlsJson(
      creds,
      `JTA resources ${serverName}`,
      serverRuntimePath(creds, serverName, '/JTARuntime/transactionResourceRuntimeMBeans', jtaResourceQueryParams()),
    ),
    fetchWlsJson(
      creds,
      `JTA recovery ${serverName}`,
      serverRuntimePath(creds, serverName, '/JTARuntime/recoveryRuntimeMBeans', jtaRecoveryQueryParams()),
    ),
    fetchWlsJson(
      creds,
      `JTA transaction names ${serverName}`,
      serverRuntimePath(creds, serverName, '/JTARuntime/transactionNameRuntimeMBeans', jtaTransactionNameQueryParams()),
    ),
  ])

  const resources = resourcesResult.status === 'fulfilled'
    ? normalizeJtaResourceRows(resourcesResult.value, serverName)
    : []
  const recoveryRows = recoveryResult.status === 'fulfilled'
    ? normalizeJtaRecoveryRows(recoveryResult.value, serverName)
    : []
  const transactionNames = transactionNamesResult.status === 'fulfilled'
    ? normalizeJtaTransactionNameRows(transactionNamesResult.value, serverName)
    : []

  if (resourcesResult.status === 'rejected') failures.push({ serverName, family: 'resources', message: failureMessage(resourcesResult.reason) })
  if (recoveryResult.status === 'rejected') failures.push({ serverName, family: 'recovery', message: failureMessage(recoveryResult.reason) })
  if (transactionNamesResult.status === 'rejected') failures.push({ serverName, family: 'transactionNames', message: failureMessage(transactionNamesResult.reason) })

  return {
    row: normalizeJtaServerRow({ serverName, lifecycleState, runtime, resources, recoveryRows, transactionNames }),
    failures,
  }
}

export async function fetchJtaSnapshot(creds: WlsCredentials): Promise<JtaSnapshot> {
  const lifecycleStates = await fetchLifecycleStates(creds)
  // Every server gets a row: hiding stopped ones made a server that went down look like it never
  // existed on this page.
  const results = await Promise.all(
    lifecycleStates.map((server) => fetchJtaServerRow(creds, server.serverName, server.state)),
  )
  return {
    servers: results.map((result) => result.row),
    partialFailures: results.flatMap((result) => result.failures),
  }
}

export function jtaRecoveryActionPath(creds: WlsCredentials, serverName: string, action: JtaRecoveryAction) {
  return serverRuntimePath(creds, serverName, `/JTARuntime/${action}`)
}

export function jtaRecoveryActionAvailable(row: JtaServerRow | null | undefined) {
  return row?.transactionRowsSupported === true && row.recoveryActionsSupported === true
}

export function jtaRecoveryUnavailableReason(row: JtaServerRow | null | undefined) {
  if (!row) return 'No JTA server row is selected.'
  if (!row.transactionRowsSupported) return row.unsupportedReason
  if (!row.recoveryActionsSupported) return 'No verified recovery operation is available for the selected transaction.'
  return null
}

export function useJtaSnapshot() {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval(60_000)
  const query = useQuery({
    queryKey: jtaSnapshotQueryKey(creds),
    enabled: !!creds,
    staleTime: 30_000,
    refetchInterval: livePollingInterval,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchJtaSnapshot(creds)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds,
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}
