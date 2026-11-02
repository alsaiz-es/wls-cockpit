import { useQuery } from '@tanstack/react-query'
import {
  WLS_REST_PROXY_BASE_URL,
  wlsBasicAuthHeader,
  wlsCredentialCacheKey,
  type WlsCredentials,
} from '../client.ts'
import { WLS_TARGET_HEADER } from '../proxy-target.ts'
import { useRefreshStaleQueryOnVisibleReturn, useVisiblePollingInterval } from '../query-polling.ts'
import { WlsRestError, isWlsRestError, normalizeWlsRestError, withWlsRestTimeout } from '../wls-errors.ts'
import { useAuth } from '../../auth/useAuth.ts'
import {
  WLS_HEALTH_STATES,
  WLS_LIFECYCLE_STATES,
  type WlsHealthState,
  type WlsLifecycleState,
} from '../../components/status-model.ts'

export const WORK_MANAGER_REQUEST_TIMEOUT_MS = 10_000
export const WORK_MANAGER_POLL_INTERVAL_MS = 30_000
export const WORK_MANAGER_NESTED_DETAIL_LIMIT = 30
export const WORK_MANAGER_NESTED_REQUEST_LIMIT = WORK_MANAGER_NESTED_DETAIL_LIMIT * 4
export const WORK_MANAGER_NESTED_CONCURRENCY_LIMIT = 8

export type WorkManagerSeverity = 'critical' | 'warning' | 'neutral'
export type WorkManagerFamily = 'threadPool' | 'workManager' | 'executeQueue'
export type WorkManagerNestedFamily = 'capacity' | 'maxThreads' | 'minThreads' | 'requestClass'

export interface WorkManagerPartialFailure {
  serverName: string | null
  family: string
  runtimeName?: string
  message: string
}

export interface WorkManagerRuntimeContext {
  name: string | null
  count: number | null
  configuredCount: number | null
  executingRequests: number | null
  deferredRequests: number | null
  pendingRequests: number | null
  completedRequests: number | null
  currentWaitTime: number | null
  mustRunCount: number | null
  requestClassType: string | null
  unavailable: boolean
}

export interface WorkManagerConfigContext {
  capacityName: string | null
  maxThreadsConstraintName: string | null
  minThreadsConstraintName: string | null
  requestClassName: string | null
  fairShare: number | null
  responseTimeGoalMs: number | null
  count: number | null
  targets: string[]
}

export interface WorkManagerRuntimeRow {
  id: string
  serverName: string
  family: WorkManagerFamily
  name: string
  severity: WorkManagerSeverity
  // Why the row is not neutral, for the status tooltip.
  severityReasons: string[]
  healthState: WlsHealthState
  applicationName: string | null
  moduleName: string | null
  partitionName: string | null
  completedRequests: number | null
  pendingRequests: number | null
  rejectedRequests: number | null
  stuckThreadCount: number | null
  hoggingThreadCount: number | null
  threadTotalCount: number | null
  threadIdleCount: number | null
  throughput: number | null
  constraintValue: number | null
  constraintLimit: number | null
  nested: Record<WorkManagerNestedFamily, WorkManagerRuntimeContext | null>
  unavailable: string[]
  nestedDetailSkipped: boolean
  config: WorkManagerConfigContext | null
  updatedAt: number
}

export interface WorkManagerRuntimeSnapshot {
  rows: WorkManagerRuntimeRow[]
  partialFailures: WorkManagerPartialFailure[]
  nestedOverflowCount: number
  nestedRequestLimit: number
  updatedAt: number
}

interface SeverityInput {
  healthState?: unknown
  stuckThreadCount?: number | null
  suspended?: boolean | null
  rejectedRequests?: number | null
  queueLength?: number | null
  sharedCapacityForWorkManagers?: number | null
  executingRequests?: number | null
  maxThreadsCount?: number | null
  pendingRequests?: number | null
  pendingDaemonRequests?: number | null
  pendingUserRequestCount?: number | null
  pendingRequestCurrentCount?: number | null
  pendingRequestCount?: number | null
  minThreadsPendingRequests?: number | null
  mustRunCount?: number | null
  hoggingThreadCount?: number | null
  currentWaitTime?: number | null
}

const SERVER_LIFECYCLE_FIELDS = 'name,state'
const THREAD_POOL_FIELDS = [
  'name',
  'type',
  'healthState',
  'completedRequestCount',
  'executeThreadIdleCount',
  'executeThreadTotalCount',
  'hoggingThreadCount',
  'minThreadsConstraintsPending',
  'overloadRejectedRequestsCount',
  'pendingUserRequestCount',
  'queueLength',
  'sharedCapacityForWorkManagers',
  'standbyThreadCount',
  'stuckThreadCount',
  'suspended',
  'throughput',
].join(',')
const WORK_MANAGER_FIELDS = [
  'name',
  'type',
  'applicationName',
  'moduleName',
  'partitionName',
  'healthState',
  'completedRequests',
  'completedDaemonRequests',
  'pendingRequests',
  'pendingDaemonRequests',
  'stuckThreadCount',
].join(',')
const EXECUTE_QUEUE_FIELDS = [
  'name',
  'type',
  'executeThreadCurrentIdleCount',
  'executeThreadTotalCount',
  'pendingRequestCurrentCount',
  'pendingRequestOldestTime',
  'servicedRequestTotalCount',
].join(',')
const CAPACITY_FIELDS = 'name,type,count'
const MAX_THREADS_FIELDS = 'name,type,configuredCount,count,deferredRequests,executingRequests'
const MIN_THREADS_FIELDS = [
  'name',
  'type',
  'completedRequests',
  'configuredCount',
  'count',
  'currentWaitTime',
  'executingRequests',
  'maxWaitTime',
  'mustRunCount',
  'outOfOrderExecutionCount',
  'partitionLimitReached',
  'pendingRequests',
].join(',')
const REQUEST_CLASS_FIELDS = [
  'name',
  'type',
  'completedCount',
  'pendingRequestCount',
  'requestClassType',
  'totalThreadUse',
  'virtualTimeIncrement',
].join(',')
const SELF_TUNING_WORK_MANAGER_FIELDS =
  'name,capacity,maxThreadsConstraint,minThreadsConstraint,requestClass,targets'
const SELF_TUNING_CAPACITY_FIELDS = 'name,count,targets'
const SELF_TUNING_MAX_THREADS_FIELDS = 'name,count,targets'
const SELF_TUNING_MIN_THREADS_FIELDS = 'name,count,targets'
const SELF_TUNING_FAIR_SHARE_FIELDS = 'name,fairShare,targets'
const SELF_TUNING_RESPONSE_TIME_FIELDS = 'name,goalMs,targets'
const EXECUTE_QUEUE_CONFIG_FIELDS = 'name,queueLength,queueLengthThresholdPercent,threadCount,threadsMinimum,threadsMaximum'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readItems(data: unknown): unknown[] {
  return isObject(data) && Array.isArray(data.items) ? data.items : []
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

function normalizeLifecycle(value: unknown): WlsLifecycleState {
  return WLS_LIFECYCLE_STATES.includes(value as WlsLifecycleState)
    ? (value as WlsLifecycleState)
    : 'UNKNOWN'
}

export function normalizeWorkManagerHealth(value: unknown): WlsHealthState {
  const raw = isObject(value) ? value.state : value
  if (typeof raw !== 'string') return 'unknown'
  const normalized = raw.toLowerCase() === 'warning' ? 'warn' : raw.toLowerCase()
  return WLS_HEALTH_STATES.includes(normalized as WlsHealthState)
    ? (normalized as WlsHealthState)
    : 'unknown'
}

function positive(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function atCapacity(current: number | null | undefined, limit: number | null | undefined) {
  return typeof limit === 'number' && limit > 0 && typeof current === 'number' && current >= limit
}

function nearCapacity(current: number | null | undefined, limit: number | null | undefined) {
  return typeof limit === 'number' && limit > 0 && typeof current === 'number' && current >= limit * 0.9
}

// A last request that waited a few milliseconds for a thread is normal; only a wait the operator
// would notice is reported (12.2.1.4 flagged idle Work Managers for currentWaitTime = 1 ms).
export const WORK_MANAGER_WAIT_WARNING_MS = 1_000

interface SeverityRule {
  severity: Exclude<WorkManagerSeverity, 'neutral'>
  matches: (input: SeverityInput) => boolean
  reason: (input: SeverityInput) => string
}

const SEVERITY_RULES: SeverityRule[] = [
  {
    severity: 'critical',
    matches: (input) => ['critical', 'failed', 'overloaded'].includes(normalizeWorkManagerHealth(input.healthState)),
    reason: (input) => `health ${normalizeWorkManagerHealth(input.healthState)}`,
  },
  { severity: 'critical', matches: (input) => positive(input.stuckThreadCount), reason: (input) => `${input.stuckThreadCount} stuck threads` },
  { severity: 'critical', matches: (input) => input.suspended === true, reason: () => 'suspended' },
  { severity: 'critical', matches: (input) => positive(input.rejectedRequests), reason: (input) => `${input.rejectedRequests} rejected requests` },
  {
    severity: 'critical',
    matches: (input) => atCapacity(input.queueLength, input.sharedCapacityForWorkManagers),
    reason: (input) => `queue full (${input.queueLength}/${input.sharedCapacityForWorkManagers})`,
  },
  {
    severity: 'critical',
    matches: (input) => atCapacity(input.executingRequests, input.maxThreadsCount),
    reason: (input) => `max threads reached (${input.executingRequests}/${input.maxThreadsCount})`,
  },
  { severity: 'warning', matches: (input) => normalizeWorkManagerHealth(input.healthState) === 'warn', reason: () => 'health warn' },
  {
    severity: 'warning',
    matches: (input) =>
      positive(input.pendingRequests) ||
      positive(input.pendingDaemonRequests) ||
      positive(input.pendingUserRequestCount) ||
      positive(input.queueLength) ||
      positive(input.pendingRequestCurrentCount) ||
      positive(input.pendingRequestCount) ||
      positive(input.minThreadsPendingRequests) ||
      positive(input.mustRunCount),
    reason: (input) => {
      const pending = [
        input.pendingRequests,
        input.pendingDaemonRequests,
        input.pendingUserRequestCount,
        input.queueLength,
        input.pendingRequestCurrentCount,
        input.pendingRequestCount,
        input.minThreadsPendingRequests,
        input.mustRunCount,
      ].reduce<number>((max, value) => (typeof value === 'number' && value > max ? value : max), 0)
      return `${pending} ${pending === 1 ? 'request' : 'requests'} waiting`
    },
  },
  { severity: 'warning', matches: (input) => positive(input.hoggingThreadCount), reason: (input) => `${input.hoggingThreadCount} hogging threads` },
  {
    severity: 'warning',
    matches: (input) => typeof input.currentWaitTime === 'number' && input.currentWaitTime >= WORK_MANAGER_WAIT_WARNING_MS,
    reason: (input) => `last request waited ${input.currentWaitTime} ms for a thread`,
  },
  {
    severity: 'warning',
    matches: (input) => nearCapacity(input.queueLength, input.sharedCapacityForWorkManagers),
    reason: (input) => `queue at ${input.queueLength}/${input.sharedCapacityForWorkManagers}`,
  },
  {
    severity: 'warning',
    matches: (input) => nearCapacity(input.executingRequests, input.maxThreadsCount),
    reason: (input) => `near max threads (${input.executingRequests}/${input.maxThreadsCount})`,
  },
]

export function assessWorkManager(input: SeverityInput): { severity: WorkManagerSeverity; severityReasons: string[] } {
  const matched = SEVERITY_RULES.filter((rule) => rule.matches(input))
  const severity = matched.some((rule) => rule.severity === 'critical')
    ? 'critical'
    : matched.length > 0
      ? 'warning'
      : 'neutral'
  return { severity, severityReasons: matched.map((rule) => rule.reason(input)) }
}

export function deriveWorkManagerSeverity(input: SeverityInput): WorkManagerSeverity {
  return assessWorkManager(input).severity
}

function queryString(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}

export function workManagerManagementPath(creds: WlsCredentials, path: string, params?: Record<string, string>) {
  const suffix = params ? `?${queryString(params)}` : ''
  return `/management/weblogic/${encodeURIComponent(creds.version)}${path}${suffix}`
}

export function workManagerServerRuntimePath(
  creds: WlsCredentials,
  serverName: string,
  suffix = '',
  params?: Record<string, string>,
) {
  return workManagerManagementPath(
    creds,
    `/domainRuntime/serverRuntimes/${encodeURIComponent(serverName)}${suffix}`,
    params,
  )
}

async function fetchWlsJson(creds: WlsCredentials, operation: string, path: string, timeoutMs = WORK_MANAGER_REQUEST_TIMEOUT_MS) {
  try {
    const response = await withWlsRestTimeout(
      operation,
      (signal) =>
        fetch(`${WLS_REST_PROXY_BASE_URL}${path}`, {
          signal,
          headers: {
            Accept: 'application/json',
            Authorization: wlsBasicAuthHeader(creds),
            [WLS_TARGET_HEADER]: creds.targetUrl,
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
  return error instanceof Error ? error.message : 'Work Manager request failed.'
}

function isOptionalNestedMissing(error: unknown) {
  if (isWlsRestError(error) && error.kind === 'http' && error.status === 404) return true
  if (!isObject(error)) return false
  return error.kind === 'http' && error.status === 404
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapItem: (item: T) => Promise<R>,
) {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapItem(items[index])
    }
  }))

  return results
}

function emptyNested(): Record<WorkManagerNestedFamily, WorkManagerRuntimeContext | null> {
  return {
    capacity: null,
    maxThreads: null,
    minThreads: null,
    requestClass: null,
  }
}

function rowId(serverName: string, family: WorkManagerFamily, name: string) {
  return `${serverName}:${family}:${name}`
}

function unavailableRow(serverName: string, family: WorkManagerFamily, name: string, message: string): WorkManagerRuntimeRow {
  return {
    id: rowId(serverName, family, name),
    serverName,
    family,
    name,
    severity: 'neutral',
    severityReasons: [],
    healthState: 'unknown',
    applicationName: null,
    moduleName: null,
    partitionName: null,
    completedRequests: null,
    pendingRequests: null,
    rejectedRequests: null,
    stuckThreadCount: null,
    hoggingThreadCount: null,
    threadTotalCount: null,
    threadIdleCount: null,
    throughput: null,
    constraintValue: null,
    constraintLimit: null,
    nested: emptyNested(),
    unavailable: [message],
    nestedDetailSkipped: false,
    config: null,
    updatedAt: Date.now(),
  }
}

export function normalizeThreadPoolRow(serverName: string, data: unknown, updatedAt = Date.now()): WorkManagerRuntimeRow | null {
  if (!isObject(data)) return null
  const name = readString(data.name) ?? 'ThreadPoolRuntime'
  const healthState = normalizeWorkManagerHealth(data.healthState)
  const pendingUserRequestCount = readNumber(data.pendingUserRequestCount)
  const queueLength = readNumber(data.queueLength)
  const rejectedRequests = readNumber(data.overloadRejectedRequestsCount)
  const stuckThreadCount = readNumber(data.stuckThreadCount)
  const hoggingThreadCount = readNumber(data.hoggingThreadCount)
  const sharedCapacityForWorkManagers = readNumber(data.sharedCapacityForWorkManagers)
  return {
    id: rowId(serverName, 'threadPool', name),
    serverName,
    family: 'threadPool',
    name,
    ...assessWorkManager({
      healthState,
      stuckThreadCount,
      suspended: readBoolean(data.suspended),
      rejectedRequests,
      queueLength,
      sharedCapacityForWorkManagers,
      pendingUserRequestCount,
      hoggingThreadCount,
    }),
    healthState,
    applicationName: null,
    moduleName: null,
    partitionName: null,
    completedRequests: readNumber(data.completedRequestCount),
    pendingRequests: pendingUserRequestCount ?? queueLength,
    rejectedRequests,
    stuckThreadCount,
    hoggingThreadCount,
    threadTotalCount: readNumber(data.executeThreadTotalCount),
    threadIdleCount: readNumber(data.executeThreadIdleCount),
    throughput: readNumber(data.throughput),
    constraintValue: queueLength,
    constraintLimit: sharedCapacityForWorkManagers,
    nested: emptyNested(),
    unavailable: [],
    nestedDetailSkipped: false,
    config: null,
    updatedAt,
  }
}

export function normalizeWorkManagerRow(serverName: string, data: unknown, updatedAt = Date.now()): WorkManagerRuntimeRow | null {
  if (!isObject(data)) return null
  const name = readString(data.name)
  if (!name) return null
  const healthState = normalizeWorkManagerHealth(data.healthState)
  const pendingRequests = readNumber(data.pendingRequests)
  const pendingDaemonRequests = readNumber(data.pendingDaemonRequests)
  const stuckThreadCount = readNumber(data.stuckThreadCount)
  return {
    id: rowId(serverName, 'workManager', name),
    serverName,
    family: 'workManager',
    name,
    ...assessWorkManager({
      healthState,
      pendingRequests,
      pendingDaemonRequests,
      stuckThreadCount,
    }),
    healthState,
    applicationName: readString(data.applicationName),
    moduleName: readString(data.moduleName),
    partitionName: readString(data.partitionName),
    completedRequests: readNumber(data.completedRequests),
    pendingRequests,
    rejectedRequests: null,
    stuckThreadCount,
    hoggingThreadCount: null,
    threadTotalCount: null,
    threadIdleCount: null,
    throughput: null,
    constraintValue: pendingRequests,
    constraintLimit: null,
    nested: emptyNested(),
    unavailable: [],
    nestedDetailSkipped: false,
    config: null,
    updatedAt,
  }
}

export function normalizeExecuteQueueRow(serverName: string, data: unknown, updatedAt = Date.now()): WorkManagerRuntimeRow | null {
  if (!isObject(data)) return null
  const name = readString(data.name)
  if (!name) return null
  const pendingRequestCurrentCount = readNumber(data.pendingRequestCurrentCount)
  return {
    id: rowId(serverName, 'executeQueue', name),
    serverName,
    family: 'executeQueue',
    name,
    ...assessWorkManager({ pendingRequestCurrentCount }),
    healthState: 'unknown',
    applicationName: null,
    moduleName: null,
    partitionName: null,
    completedRequests: readNumber(data.servicedRequestTotalCount),
    pendingRequests: pendingRequestCurrentCount,
    rejectedRequests: null,
    stuckThreadCount: null,
    hoggingThreadCount: null,
    threadTotalCount: readNumber(data.executeThreadTotalCount),
    threadIdleCount: readNumber(data.executeThreadCurrentIdleCount),
    throughput: null,
    constraintValue: pendingRequestCurrentCount,
    constraintLimit: null,
    nested: emptyNested(),
    unavailable: [],
    nestedDetailSkipped: false,
    config: null,
    updatedAt,
  }
}

function normalizeNestedContext(family: WorkManagerNestedFamily, data: unknown): WorkManagerRuntimeContext | null {
  if (!isObject(data)) return null
  return {
    name: readString(data.name),
    count: readNumber(data.count),
    configuredCount: readNumber(data.configuredCount),
    executingRequests: readNumber(data.executingRequests),
    deferredRequests: readNumber(data.deferredRequests),
    pendingRequests: family === 'requestClass' ? readNumber(data.pendingRequestCount) : readNumber(data.pendingRequests),
    completedRequests: family === 'requestClass' ? readNumber(data.completedCount) : readNumber(data.completedRequests),
    currentWaitTime: readNumber(data.currentWaitTime),
    mustRunCount: readNumber(data.mustRunCount),
    requestClassType: readString(data.requestClassType),
    unavailable: false,
  }
}

function unavailableNested(): WorkManagerRuntimeContext {
  return {
    name: null,
    count: null,
    configuredCount: null,
    executingRequests: null,
    deferredRequests: null,
    pendingRequests: null,
    completedRequests: null,
    currentWaitTime: null,
    mustRunCount: null,
    requestClassType: null,
    unavailable: true,
  }
}

function recomputeWorkManagerSeverity(row: WorkManagerRuntimeRow): WorkManagerRuntimeRow {
  const maxThreads = row.nested.maxThreads
  const minThreads = row.nested.minThreads
  const requestClass = row.nested.requestClass
  return {
    ...row,
    rejectedRequests: maxThreads?.deferredRequests ?? row.rejectedRequests,
    constraintValue: maxThreads?.executingRequests ?? minThreads?.executingRequests ?? requestClass?.pendingRequests ?? row.constraintValue,
    constraintLimit: maxThreads?.count ?? minThreads?.count ?? row.constraintLimit,
    ...assessWorkManager({
      healthState: row.healthState,
      stuckThreadCount: row.stuckThreadCount,
      rejectedRequests: maxThreads?.deferredRequests ?? row.rejectedRequests,
      pendingRequests: row.pendingRequests,
      executingRequests: maxThreads?.executingRequests,
      maxThreadsCount: maxThreads?.count,
      minThreadsPendingRequests: minThreads?.pendingRequests,
      mustRunCount: minThreads?.mustRunCount,
      currentWaitTime: minThreads?.currentWaitTime,
      pendingRequestCount: requestClass?.pendingRequests,
    }),
  }
}

const severityRank: Record<WorkManagerSeverity, number> = {
  critical: 0,
  warning: 1,
  neutral: 2,
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function descendingNumber(value: number | null) {
  return value ?? Number.NEGATIVE_INFINITY
}

export function compareWorkManagerPressure(a: WorkManagerRuntimeRow, b: WorkManagerRuntimeRow) {
  return (
    severityRank[a.severity] - severityRank[b.severity] ||
    descendingNumber(b.pendingRequests) - descendingNumber(a.pendingRequests) ||
    descendingNumber(b.rejectedRequests) - descendingNumber(a.rejectedRequests) ||
    descendingNumber(b.stuckThreadCount) - descendingNumber(a.stuckThreadCount) ||
    descendingNumber(b.hoggingThreadCount) - descendingNumber(a.hoggingThreadCount) ||
    compareText(a.serverName, b.serverName) ||
    compareText(a.name, b.name)
  )
}

export function selectNestedDetailCandidates(rows: WorkManagerRuntimeRow[], limit = WORK_MANAGER_NESTED_DETAIL_LIMIT) {
  return rows
    .filter((row) => row.family === 'workManager')
    .sort(compareWorkManagerPressure)
    .slice(0, limit)
}

function readRefName(value: unknown): string | null {
  if (Array.isArray(value)) {
    const last = value[value.length - 1]
    return readString(last)
  }
  if (isObject(value)) return readString(value.name)
  return readString(value)
}

function readTargets(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (Array.isArray(item)) {
      const kind = readString(item[0])
      const name = readString(item[1])
      return kind && name ? [`${kind}:${name}`] : []
    }
    const name = readRefName(item)
    return name ? [name] : []
  })
}

function contextFromConfig(item: unknown, countKey = 'count'): WorkManagerConfigContext | null {
  if (!isObject(item)) return null
  const name = readString(item.name)
  if (!name) return null
  return {
    capacityName: null,
    maxThreadsConstraintName: null,
    minThreadsConstraintName: null,
    requestClassName: null,
    fairShare: readNumber(item.fairShare),
    responseTimeGoalMs: readNumber(item.goalMs),
    count: readNumber(item[countKey]),
    targets: readTargets(item.targets),
  }
}

function normalizeSelfTuningConfig(data: {
  workManagers: unknown
  capacities: unknown
  maxThreads: unknown
  minThreads: unknown
  fairShare: unknown
  responseTime: unknown
}) {
  const capacities = new Map(readItems(data.capacities).flatMap((item) => {
    const context = contextFromConfig(item)
    const name = isObject(item) ? readString(item.name) : null
    return name && context ? [[name, context] as const] : []
  }))
  const maxThreads = new Map(readItems(data.maxThreads).flatMap((item) => {
    const context = contextFromConfig(item)
    const name = isObject(item) ? readString(item.name) : null
    return name && context ? [[name, context] as const] : []
  }))
  const minThreads = new Map(readItems(data.minThreads).flatMap((item) => {
    const context = contextFromConfig(item)
    const name = isObject(item) ? readString(item.name) : null
    return name && context ? [[name, context] as const] : []
  }))
  const fairShare = new Map(readItems(data.fairShare).flatMap((item) => {
    const context = contextFromConfig(item)
    const name = isObject(item) ? readString(item.name) : null
    return name && context ? [[name, context] as const] : []
  }))
  const responseTime = new Map(readItems(data.responseTime).flatMap((item) => {
    const context = contextFromConfig(item, 'goalMs')
    const name = isObject(item) ? readString(item.name) : null
    return name && context ? [[name, context] as const] : []
  }))

  return new Map(readItems(data.workManagers).flatMap((item) => {
    if (!isObject(item)) return []
    const name = readString(item.name)
    if (!name) return []
    const capacityName = readRefName(item.capacity)
    const maxThreadsConstraintName = readRefName(item.maxThreadsConstraint)
    const minThreadsConstraintName = readRefName(item.minThreadsConstraint)
    const requestClassName = readRefName(item.requestClass)
    const requestClass = (requestClassName ? fairShare.get(requestClassName) ?? responseTime.get(requestClassName) : null) ?? null
    const capacity = capacityName ? capacities.get(capacityName) : null
    const max = maxThreadsConstraintName ? maxThreads.get(maxThreadsConstraintName) : null
    const min = minThreadsConstraintName ? minThreads.get(minThreadsConstraintName) : null
    const config: WorkManagerConfigContext = {
      capacityName,
      maxThreadsConstraintName,
      minThreadsConstraintName,
      requestClassName,
      fairShare: requestClass?.fairShare ?? null,
      responseTimeGoalMs: requestClass?.responseTimeGoalMs ?? null,
      count: capacity?.count ?? max?.count ?? min?.count ?? null,
      targets: readTargets(item.targets),
    }
    return [[name, config] as const]
  }))
}

function normalizeExecuteQueueConfig(data: unknown) {
  return new Map(readItems(data).flatMap((item) => {
    if (!isObject(item)) return []
    const name = readString(item.name)
    if (!name) return []
    const config: WorkManagerConfigContext = {
      capacityName: null,
      maxThreadsConstraintName: null,
      minThreadsConstraintName: null,
      requestClassName: null,
      fairShare: null,
      responseTimeGoalMs: null,
      count: readNumber(item.queueLength),
      targets: [],
    }
    return [[name, config] as const]
  }))
}

function applyConfigContext(
  rows: WorkManagerRuntimeRow[],
  workManagerConfig: Map<string, WorkManagerConfigContext>,
  executeQueueConfig: Map<string, Map<string, WorkManagerConfigContext>>,
) {
  return rows.map((row) => {
    const config =
      row.family === 'workManager'
        ? workManagerConfig.get(row.name) ?? null
        : row.family === 'executeQueue'
          ? executeQueueConfig.get(row.serverName)?.get(row.name) ?? null
          : null
    return config ? { ...row, config } : row
  })
}

async function fetchLifecycleStates(creds: WlsCredentials) {
  const data = await fetchWlsJson(
    creds,
    'Work Manager server lifecycle runtimes',
    workManagerManagementPath(creds, '/domainRuntime/serverLifeCycleRuntimes', {
      fields: SERVER_LIFECYCLE_FIELDS,
      links: 'none',
    }),
  )
  const states = new Map<string, WlsLifecycleState>()
  readItems(data).forEach((item) => {
    if (!isObject(item)) return
    const name = readString(item.name)
    if (name) states.set(name, normalizeLifecycle(item.state))
  })
  return states
}

function hasRuntimeMBean(state: WlsLifecycleState) {
  return state === 'RUNNING' || state === 'ADMIN' || state === 'STANDBY'
}

async function fetchServerRuntimeFamilies(creds: WlsCredentials, serverName: string, lifecycleState: WlsLifecycleState, updatedAt: number) {
  const rows: WorkManagerRuntimeRow[] = []
  const failures: WorkManagerPartialFailure[] = []
  if (!hasRuntimeMBean(lifecycleState)) {
    rows.push(unavailableRow(serverName, 'threadPool', 'ThreadPoolRuntime', `Server is ${lifecycleState}; Work Manager runtime is unavailable.`))
    return { rows, failures }
  }

  const [threadPool, workManagers, executeQueues] = await Promise.allSettled([
    fetchWlsJson(creds, `Thread pool ${serverName}`, workManagerServerRuntimePath(creds, serverName, '/threadPoolRuntime', {
      fields: THREAD_POOL_FIELDS,
      links: 'none',
    })),
    fetchWlsJson(creds, `Work Managers ${serverName}`, workManagerServerRuntimePath(creds, serverName, '/workManagerRuntimes', {
      fields: WORK_MANAGER_FIELDS,
      links: 'none',
    })),
    fetchWlsJson(creds, `Execute queues ${serverName}`, workManagerServerRuntimePath(creds, serverName, '/executeQueueRuntimes', {
      fields: EXECUTE_QUEUE_FIELDS,
      links: 'none',
    })),
  ])

  if (threadPool.status === 'fulfilled') {
    const row = normalizeThreadPoolRow(serverName, threadPool.value, updatedAt)
    if (row) rows.push(row)
  } else {
    rows.push(unavailableRow(serverName, 'threadPool', 'ThreadPoolRuntime', failureMessage(threadPool.reason)))
    failures.push({ serverName, family: 'threadPoolRuntime', message: failureMessage(threadPool.reason) })
  }

  if (workManagers.status === 'fulfilled') {
    rows.push(...readItems(workManagers.value).flatMap((item) => normalizeWorkManagerRow(serverName, item, updatedAt) ?? []))
  } else {
    failures.push({ serverName, family: 'workManagerRuntimes', message: failureMessage(workManagers.reason) })
  }

  if (executeQueues.status === 'fulfilled') {
    rows.push(...readItems(executeQueues.value).flatMap((item) => normalizeExecuteQueueRow(serverName, item, updatedAt) ?? []))
  } else {
    failures.push({ serverName, family: 'executeQueueRuntimes', message: failureMessage(executeQueues.reason) })
  }

  return { rows, failures }
}

async function fetchNestedContext(
  creds: WlsCredentials,
  serverName: string,
  workManagerName: string,
  family: WorkManagerNestedFamily,
) {
  const suffixByFamily: Record<WorkManagerNestedFamily, string> = {
    capacity: '/capacityRuntime',
    maxThreads: '/maxThreadsConstraintRuntime',
    minThreads: '/minThreadsConstraintRuntime',
    requestClass: '/requestClassRuntime',
  }
  const fieldsByFamily: Record<WorkManagerNestedFamily, string> = {
    capacity: CAPACITY_FIELDS,
    maxThreads: MAX_THREADS_FIELDS,
    minThreads: MIN_THREADS_FIELDS,
    requestClass: REQUEST_CLASS_FIELDS,
  }
  const data = await fetchWlsJson(
    creds,
    `Work Manager ${family} ${serverName}/${workManagerName}`,
    workManagerServerRuntimePath(
      creds,
      serverName,
      `/workManagerRuntimes/${encodeURIComponent(workManagerName)}${suffixByFamily[family]}`,
      { fields: fieldsByFamily[family], links: 'none' },
    ),
  )
  return normalizeNestedContext(family, data) ?? unavailableNested()
}

const NESTED_SEARCH_CHILDREN: Record<WorkManagerNestedFamily, { child: string; fields: string }> = {
  capacity: { child: 'capacityRuntime', fields: CAPACITY_FIELDS },
  maxThreads: { child: 'maxThreadsConstraintRuntime', fields: MAX_THREADS_FIELDS },
  minThreads: { child: 'minThreadsConstraintRuntime', fields: MIN_THREADS_FIELDS },
  requestClass: { child: 'requestClassRuntime', fields: REQUEST_CLASS_FIELDS },
}

export function workManagerNestedSearchBody() {
  const children = Object.fromEntries(
    Object.values(NESTED_SEARCH_CHILDREN).map(({ child, fields }) => [child, { fields: fields.split(','), links: [] }]),
  )
  return {
    fields: [],
    links: [],
    children: {
      serverRuntimes: {
        fields: ['name'],
        links: [],
        children: { workManagerRuntimes: { fields: ['name'], links: [], children } },
      },
    },
  }
}

export function workManagerNestedKey(serverName: string, workManagerName: string) {
  return `${serverName}\u0000${workManagerName}`
}

// Most Work Managers have no capacity or max-threads constraint, so asking for each child of each
// Work Manager produced ~56 HTTP 404s per visit on a 12.2.1.4 domain. One search returns the
// children that exist, for every server at once.
export function readWorkManagerNestedSearch(data: unknown) {
  const nested = new Map<string, Record<WorkManagerNestedFamily, WorkManagerRuntimeContext>>()
  const servers = isObject(data) && isObject(data.serverRuntimes) ? readItems(data.serverRuntimes) : []
  servers.forEach((server) => {
    if (!isObject(server)) return
    const serverName = readString(server.name)
    const workManagers = isObject(server.workManagerRuntimes) ? readItems(server.workManagerRuntimes) : []
    workManagers.forEach((workManager) => {
      if (!serverName || !isObject(workManager)) return
      const workManagerName = readString(workManager.name)
      if (!workManagerName) return
      const families = Object.fromEntries(
        (Object.keys(NESTED_SEARCH_CHILDREN) as WorkManagerNestedFamily[]).map((family) => [
          family,
          normalizeNestedContext(family, workManager[NESTED_SEARCH_CHILDREN[family].child]) ?? unavailableNested(),
        ]),
      ) as Record<WorkManagerNestedFamily, WorkManagerRuntimeContext>
      nested.set(workManagerNestedKey(serverName, workManagerName), families)
    })
  })
  return nested
}

async function searchNestedDetails(creds: WlsCredentials) {
  const operation = 'Work Manager constraints search'
  try {
    const response = await withWlsRestTimeout(
      operation,
      (signal) =>
        fetch(`${WLS_REST_PROXY_BASE_URL}/management/weblogic/${encodeURIComponent(creds.version)}/domainRuntime/search`, {
          method: 'POST',
          signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Requested-By': 'wls-cockpit',
            Authorization: wlsBasicAuthHeader(creds),
            [WLS_TARGET_HEADER]: creds.targetUrl,
          },
          body: JSON.stringify(workManagerNestedSearchBody()),
        }),
      WORK_MANAGER_REQUEST_TIMEOUT_MS,
    )
    if (!response.ok) return null
    return readWorkManagerNestedSearch(await response.json())
  } catch {
    return null
  }
}

async function applyNestedDetails(creds: WlsCredentials, rows: WorkManagerRuntimeRow[]) {
  const candidates = new Set(selectNestedDetailCandidates(rows).map((row) => row.id))
  const workManagerRows = rows.filter((row) => row.family === 'workManager')
  const overflowCount = Math.max(0, workManagerRows.length - candidates.size)
  const failures: WorkManagerPartialFailure[] = []
  const nestedByRowId = new Map<string, Record<WorkManagerNestedFamily, WorkManagerRuntimeContext | null>>()
  const families: WorkManagerNestedFamily[] = ['capacity', 'maxThreads', 'minThreads', 'requestClass']
  const searched = await searchNestedDetails(creds)
  if (searched) {
    workManagerRows
      .filter((row) => candidates.has(row.id))
      .forEach((row) => {
        const found = searched.get(workManagerNestedKey(row.serverName, row.name))
        if (found) nestedByRowId.set(row.id, { ...row.nested, ...found })
      })
  }
  // Per-request fallback for releases or servers the search did not cover.
  const nestedTasks = workManagerRows
    .filter((row) => candidates.has(row.id) && !nestedByRowId.has(row.id))
    .flatMap((row) => families.map((family) => ({ row, family })))

  const nestedResults = await mapWithConcurrency(
    nestedTasks,
    WORK_MANAGER_NESTED_CONCURRENCY_LIMIT,
    async ({ row, family }) => {
      try {
        return {
          row,
          family,
          value: await fetchNestedContext(creds, row.serverName, row.name, family),
          reason: null,
        }
      } catch (error) {
        return {
          row,
          family,
          value: unavailableNested(),
          reason: error,
        }
      }
    },
  )

  nestedResults.forEach((result) => {
    const nested = nestedByRowId.get(result.row.id) ?? { ...result.row.nested }
    nested[result.family] = result.value
    nestedByRowId.set(result.row.id, nested)
    if (result.reason && !isOptionalNestedMissing(result.reason)) {
      failures.push({
        serverName: result.row.serverName,
        family: result.family,
        runtimeName: result.row.name,
        message: failureMessage(result.reason),
      })
    }
  })

  const byId = new Map<string, WorkManagerRuntimeRow>()
  workManagerRows.forEach((row) => {
    if (!candidates.has(row.id)) {
      byId.set(row.id, { ...row, nestedDetailSkipped: true })
      return
    }
    const nested = nestedByRowId.get(row.id)
    if (nested) byId.set(row.id, recomputeWorkManagerSeverity({ ...row, nested }))
    else byId.set(row.id, row)
  })

  return {
    rows: rows.map((row) => byId.get(row.id) ?? row),
    failures,
    overflowCount,
  }
}

async function fetchOptionalConfig(creds: WlsCredentials, serverNames: string[], hasWorkManagers: boolean) {
  const failures: WorkManagerPartialFailure[] = []
  const selfTuningResults = hasWorkManagers
    ? await Promise.allSettled([
        fetchWlsJson(creds, 'Self-tuning Work Managers', workManagerManagementPath(creds, '/edit/selfTuning/workManagers', {
          fields: SELF_TUNING_WORK_MANAGER_FIELDS,
          links: 'none',
        })),
        fetchWlsJson(creds, 'Self-tuning capacities', workManagerManagementPath(creds, '/edit/selfTuning/capacities', {
          fields: SELF_TUNING_CAPACITY_FIELDS,
          links: 'none',
        })),
        fetchWlsJson(creds, 'Self-tuning max threads constraints', workManagerManagementPath(creds, '/edit/selfTuning/maxThreadsConstraints', {
          fields: SELF_TUNING_MAX_THREADS_FIELDS,
          links: 'none',
        })),
        fetchWlsJson(creds, 'Self-tuning min threads constraints', workManagerManagementPath(creds, '/edit/selfTuning/minThreadsConstraints', {
          fields: SELF_TUNING_MIN_THREADS_FIELDS,
          links: 'none',
        })),
        fetchWlsJson(creds, 'Self-tuning fair-share request classes', workManagerManagementPath(creds, '/edit/selfTuning/fairShareRequestClasses', {
          fields: SELF_TUNING_FAIR_SHARE_FIELDS,
          links: 'none',
        })),
        fetchWlsJson(creds, 'Self-tuning response-time request classes', workManagerManagementPath(creds, '/edit/selfTuning/responseTimeRequestClasses', {
          fields: SELF_TUNING_RESPONSE_TIME_FIELDS,
          links: 'none',
        })),
      ])
    : []
  const [workManagers, capacities, maxThreads, minThreads, fairShare, responseTime] = selfTuningResults

  const selfTuningInputs = {
    workManagers: workManagers?.status === 'fulfilled' ? workManagers.value : null,
    capacities: capacities?.status === 'fulfilled' ? capacities.value : null,
    maxThreads: maxThreads?.status === 'fulfilled' ? maxThreads.value : null,
    minThreads: minThreads?.status === 'fulfilled' ? minThreads.value : null,
    fairShare: fairShare?.status === 'fulfilled' ? fairShare.value : null,
    responseTime: responseTime?.status === 'fulfilled' ? responseTime.value : null,
  }
  const configFailures = [
    ['selfTuning.workManagers', workManagers],
    ['selfTuning.capacities', capacities],
    ['selfTuning.maxThreadsConstraints', maxThreads],
    ['selfTuning.minThreadsConstraints', minThreads],
    ['selfTuning.fairShareRequestClasses', fairShare],
    ['selfTuning.responseTimeRequestClasses', responseTime],
  ] as const
  configFailures.forEach(([family, result]) => {
    if (result?.status === 'rejected') failures.push({ serverName: null, family, message: failureMessage(result.reason) })
  })

  const executeQueueEntries = await Promise.all(serverNames.map(async (serverName) => {
    try {
      const data = await fetchWlsJson(creds, `Execute queue config ${serverName}`, workManagerManagementPath(
        creds,
        `/edit/servers/${encodeURIComponent(serverName)}/executeQueues`,
        { fields: EXECUTE_QUEUE_CONFIG_FIELDS, links: 'none' },
      ))
      return [serverName, normalizeExecuteQueueConfig(data)] as const
    } catch (error) {
      failures.push({ serverName, family: 'executeQueueConfig', message: failureMessage(error) })
      return [serverName, new Map<string, WorkManagerConfigContext>()] as const
    }
  }))

  return {
    workManagerConfig: normalizeSelfTuningConfig(selfTuningInputs),
    executeQueueConfig: new Map(executeQueueEntries),
    failures,
  }
}

export async function fetchWorkManagerRuntimeSnapshot(creds: WlsCredentials, serverFilter = 'all'): Promise<WorkManagerRuntimeSnapshot> {
  const updatedAt = Date.now()
  const lifecycleStates = await fetchLifecycleStates(creds)
  const serverNames = Array.from(lifecycleStates.keys())
    .filter((serverName) => serverFilter === 'all' || serverName === serverFilter)
    .sort(compareText)
  const serverResults = await Promise.all(
    serverNames.map((serverName) => fetchServerRuntimeFamilies(creds, serverName, lifecycleStates.get(serverName) ?? 'UNKNOWN', updatedAt)),
  )
  const runtimeRows = serverResults.flatMap((result) => result.rows)
  const runtimeFailures = serverResults.flatMap((result) => result.failures)
  const nested = await applyNestedDetails(creds, runtimeRows)
  const config = await fetchOptionalConfig(creds, serverNames, runtimeRows.some((row) => row.family === 'workManager'))
  const rows = applyConfigContext(nested.rows, config.workManagerConfig, config.executeQueueConfig)
  return {
    rows,
    partialFailures: [...runtimeFailures, ...nested.failures, ...config.failures],
    nestedOverflowCount: nested.overflowCount,
    nestedRequestLimit: WORK_MANAGER_NESTED_REQUEST_LIMIT,
    updatedAt,
  }
}

export function workManagersQueryKey(
  creds: WlsCredentials | null | undefined,
  serverFilter: string | null | undefined,
) {
  return ['workManagers', wlsCredentialCacheKey(creds), serverFilter ?? 'all'] as const
}

export function workManagersRouteForServer(serverName: string) {
  const params = new URLSearchParams()
  params.set('server', serverName)
  return `/work-managers?${params.toString()}`
}

export function useWorkManagerRuntimeSnapshot(serverFilter = 'all') {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval(WORK_MANAGER_POLL_INTERVAL_MS)
  const query = useQuery({
    queryKey: workManagersQueryKey(creds, serverFilter),
    enabled: !!creds,
    staleTime: 0,
    refetchInterval: livePollingInterval,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchWorkManagerRuntimeSnapshot(creds, serverFilter)
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
