import { useQuery, type QueryClient } from '@tanstack/react-query'
import {
  WLS_REST_PROXY_BASE_URL,
  wlsBasicAuthHeader,
  wlsCredentialCacheKey,
  type WlsCredentials,
} from '../client.ts'
import { editSessionStatusQueryKey } from './edit-sessions.ts'
import { actionAuditHeaders } from '../action-audit-headers.ts'
import { WLS_TARGET_HEADER } from '../proxy-target.ts'
import { useRefreshStaleQueryOnVisibleReturn, useVisiblePollingInterval } from '../query-polling.ts'
import { normalizeWlsRestError, WlsRestError, withWlsRestTimeout } from '../wls-errors.ts'
import { runInEditSession } from './edit-session-transaction.ts'
import { useAuth } from '../../auth/useAuth.ts'

export const NODE_MANAGER_RUNTIME_FIELDS = ['name', 'type', 'reachable'].join(',')
export const NODE_MANAGER_MACHINE_FIELDS = ['name'].join(',')
export const NODE_MANAGER_CONFIG_FIELDS = [
  'name',
  'listenAddress',
  'listenPort',
  'NMType',
  'NMSocketCreateTimeoutInMillis',
].join(',')
export const NODE_MANAGER_SERVER_FIELDS = ['name', 'machine'].join(',')
export const NODE_MANAGER_LIFECYCLE_FIELDS = ['name', 'state'].join(',')
export const NODE_MANAGER_REQUEST_TIMEOUT_MS = 7_500
const NODE_MANAGER_CONFIG_TIMEOUT_MS = 60_000
const NODE_MANAGER_LISTENER_TRANSACTION_TIMEOUT_MS = 90_000
const NODE_MANAGER_ASSIGNMENT_TRANSACTION_TIMEOUT_MS = 180_000
export const NODE_MANAGER_NM_TYPES = ['Plain', 'SSL', 'SSH', 'RSH'] as const

export type NodeManagerSupportStatus = 'supported' | 'unsupported'
export type NodeManagerReachability = 'reachable' | 'unreachable' | 'unknown'
export type NodeManagerNmType = (typeof NODE_MANAGER_NM_TYPES)[number]

export interface NodeManagerPartialFailure {
  machineName: string | null
  family: string
  message: string
}

export interface NodeManagerRuntimeRow {
  name: string
  reachable: boolean | null
  type: string | null
}

export interface NodeManagerConfigRow {
  machineName: string
  name: string | null
  listenAddress: string | null
  listenPort: number | null
  nmType: string | null
  socketCreateTimeoutMillis: number | null
}

export interface NodeManagerServerRow {
  serverName: string
  machineName: string | null
  lifecycleState: string | null
}

export interface NodeManagerRow {
  id: string
  machineName: string
  runtimeName: string | null
  reachable: NodeManagerReachability
  runtimeType: string | null
  listenAddress: string | null
  listenPort: number | null
  nmType: string | null
  socketCreateTimeoutMillis: number | null
  serverNames: string[]
  partialFailures: NodeManagerPartialFailure[]
}

export interface NodeManagerSnapshot {
  status: NodeManagerSupportStatus
  rows: NodeManagerRow[]
  machines: string[]
  servers: NodeManagerServerRow[]
  unassignedServers: string[]
  partialFailures: NodeManagerPartialFailure[]
  unsupportedReason: string | null
}

export interface NodeManagerListenerDraft {
  listenAddress: string
  listenPort: string
  nmType: string
  socketCreateTimeoutMillis: string
}

export interface NodeManagerListenerPatch {
  listenAddress?: string
  listenPort?: number
  NMType?: NodeManagerNmType
  NMSocketCreateTimeoutInMillis?: number
}

export interface NodeManagerConfigChange {
  field: keyof NodeManagerListenerPatch
  label: string
  before: string
  after: string
}

export interface NodeManagerValidationResult {
  ok: boolean
  errors: string[]
  patch: NodeManagerListenerPatch
  config: Required<NodeManagerListenerPatch> | null
}

export interface UpdateNodeManagerListenerInput {
  machineName: string
  patch: NodeManagerListenerPatch
  changes: NodeManagerConfigChange[]
}

export interface CreateNodeManagerMachineInput {
  machineName: string
  listener: Required<NodeManagerListenerPatch>
  changes: NodeManagerConfigChange[]
}

export interface AssignNodeManagerServersInput {
  assignments: {
    serverName: string
    fromMachineName: string | null
    toMachineName: string
  }[]
}

export type NodeManagerConfigAction = 'listener' | 'create-machine' | 'assign-servers'

export interface NodeManagerConfigResult {
  action: NodeManagerConfigAction
  detail: string
  affectedMachines: string[]
  affectedServers: string[]
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

function definedFields(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

function readIdentityName(value: unknown, expectedKind: string) {
  if (!Array.isArray(value)) return null
  const kind = readString(value[0])
  const name = readString(value[1])
  return kind === expectedKind ? name : null
}

function queryString(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}

function managementPath(creds: WlsCredentials, path: string, params?: Record<string, string>) {
  const suffix = params ? `?${queryString(params)}` : ''
  return `/management/weblogic/${encodeURIComponent(creds.version)}${path}${suffix}`
}

async function fetchWlsJson(creds: WlsCredentials, operation: string, path: string, timeoutMs = NODE_MANAGER_REQUEST_TIMEOUT_MS) {
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

    if (response.status === 204) return null
    const text = await response.text()
    return text ? JSON.parse(text) : null
  } catch (error) {
    throw normalizeWlsRestError(operation, error, timeoutMs)
  }
}

async function postWlsJson(
  creds: WlsCredentials,
  operation: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs = NODE_MANAGER_CONFIG_TIMEOUT_MS,
) {
  try {
    const response = await withWlsRestTimeout(
      operation,
      (signal) =>
        fetch(`${WLS_REST_PROXY_BASE_URL}${path}`, {
          method: 'POST',
          signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: wlsBasicAuthHeader(creds),
            'X-Requested-By': 'wls-cockpit',
            // Same audit metadata as every other mutation path, so the record names user and profile.
            ...actionAuditHeaders(creds),
          },
          body: JSON.stringify(body),
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

    if (response.status === 204) return null
    const text = await response.text()
    return text ? JSON.parse(text) : null
  } catch (error) {
    throw normalizeWlsRestError(operation, error, timeoutMs)
  }
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Node Manager request failed.'
}

export function normalizeNodeManagerRuntimes(data: unknown): NodeManagerRuntimeRow[] {
  const items = isObject(data) && Array.isArray(data.items) ? data.items : []
  return items.flatMap((item): NodeManagerRuntimeRow[] => {
    if (!isObject(item)) return []
    const name = readString(item.name)
    if (!name) return []
    return [{
      name,
      reachable: readBoolean(item.reachable),
      type: readString(item.type),
    }]
  })
}

export function normalizeNodeManagerConfig(data: unknown, machineName: string): NodeManagerConfigRow {
  const row = isObject(data) ? data : {}
  return {
    machineName,
    name: readString(row.name),
    listenAddress: readString(row.listenAddress),
    listenPort: readNumber(row.listenPort),
    nmType: readString(row.NMType),
    socketCreateTimeoutMillis: readNumber(row.NMSocketCreateTimeoutInMillis),
  }
}

export function normalizeNodeManagerMachines(data: unknown): string[] {
  const items = isObject(data) && Array.isArray(data.items) ? data.items : []
  return items.flatMap((item) => {
    if (!isObject(item)) return []
    const name = readString(item.name)
    return name ? [name] : []
  })
}

export function normalizeNodeManagerServerRows(
  data: unknown,
  lifecycleStates: Map<string, string | null> = new Map(),
): NodeManagerServerRow[] {
  const items = isObject(data) && Array.isArray(data.items) ? data.items : []
  return items.flatMap((item): NodeManagerServerRow[] => {
    if (!isObject(item)) return []
    const serverName = readString(item.name)
    if (!serverName) return []
    return [{
      serverName,
      machineName: readIdentityName(item.machine, 'machines'),
      lifecycleState: lifecycleStates.get(serverName) ?? null,
    }]
  })
}

export function normalizeNodeManagerLifecycleStates(data: unknown): Map<string, string | null> {
  const items = isObject(data) && Array.isArray(data.items) ? data.items : []
  return new Map(items.flatMap((item): [string, string | null][] => {
    if (!isObject(item)) return []
    const name = readString(item.name)
    if (!name) return []
    return [[name, readString(item.state)?.toUpperCase() ?? null]]
  }))
}

function reachabilityFrom(value: boolean | null): NodeManagerReachability {
  if (value === true) return 'reachable'
  if (value === false) return 'unreachable'
  return 'unknown'
}

// WebLogic reports only reachable=false, without a reason. The hint names what the AdminServer is
// trying to reach so the operator knows what to check.
export function nodeManagerUnreachableHint(
  row: Pick<NodeManagerRow, 'reachable' | 'listenAddress' | 'listenPort' | 'nmType'>,
): string | null {
  if (row.reachable !== 'unreachable') return null
  const endpoint = `${row.listenAddress ?? 'the configured address'}:${row.listenPort ?? '?'}`
  const type = row.nmType ? ` (${row.nmType})` : ''
  return `The AdminServer cannot reach Node Manager at ${endpoint}${type}. Check that it is running there and that its listener type (SSL or Plain) matches this machine's configuration.`
}

export function nodeManagerTone(row: Pick<NodeManagerRow, 'reachable'>) {
  if (row.reachable === 'reachable') return 'positive'
  if (row.reachable === 'unreachable') return 'negative'
  return 'unknown'
}

export function buildNodeManagerRows({
  machines,
  runtimes,
  configs,
  servers,
  partialFailures,
}: {
  machines: string[]
  runtimes: NodeManagerRuntimeRow[]
  configs: NodeManagerConfigRow[]
  servers: NodeManagerServerRow[]
  partialFailures: NodeManagerPartialFailure[]
}): { rows: NodeManagerRow[]; unassignedServers: string[] } {
  const runtimeByName = new Map(runtimes.map((runtime) => [runtime.name, runtime]))
  const configByMachine = new Map(configs.map((config) => [config.machineName, config]))
  const serversByMachine = new Map<string, string[]>()
  const unassignedServers: string[] = []
  servers.forEach((server) => {
    if (!server.machineName) {
      unassignedServers.push(server.serverName)
      return
    }
    const current = serversByMachine.get(server.machineName) ?? []
    current.push(server.serverName)
    serversByMachine.set(server.machineName, current)
  })

  const machineNames = [...new Set([
    ...machines,
    ...configs.map((config) => config.machineName),
    ...runtimes.map((runtime) => runtime.name),
    ...servers.flatMap((server) => server.machineName ? [server.machineName] : []),
  ])].sort((a, b) => a.localeCompare(b))

  return {
    rows: machineNames.map((machineName) => {
      const runtime = runtimeByName.get(machineName)
      const config = configByMachine.get(machineName)
      const serverNames = [...new Set(serversByMachine.get(machineName) ?? [])].sort((a, b) => a.localeCompare(b))
      return {
        id: machineName,
        machineName,
        runtimeName: runtime?.name ?? null,
        reachable: reachabilityFrom(runtime?.reachable ?? null),
        runtimeType: runtime?.type ?? null,
        listenAddress: config?.listenAddress ?? null,
        listenPort: config?.listenPort ?? null,
        nmType: config?.nmType ?? null,
        socketCreateTimeoutMillis: config?.socketCreateTimeoutMillis ?? null,
        serverNames,
        partialFailures: partialFailures.filter((failure) => failure.machineName === machineName),
      }
    }),
    unassignedServers: unassignedServers.sort((a, b) => a.localeCompare(b)),
  }
}

async function fetchNodeManagerRuntimes(creds: WlsCredentials) {
  const data = await fetchWlsJson(
    creds,
    'Node Manager runtimes',
    managementPath(creds, '/domainRuntime/nodeManagerRuntimes', {
      fields: NODE_MANAGER_RUNTIME_FIELDS,
      links: 'none',
    }),
  )
  return normalizeNodeManagerRuntimes(data)
}

async function fetchNodeManagerMachines(creds: WlsCredentials) {
  const data = await fetchWlsJson(
    creds,
    'Machine configuration',
    managementPath(creds, '/edit/machines', {
      fields: NODE_MANAGER_MACHINE_FIELDS,
      links: 'none',
    }),
  )
  return normalizeNodeManagerMachines(data)
}

async function fetchNodeManagerConfig(creds: WlsCredentials, machineName: string) {
  const data = await fetchWlsJson(
    creds,
    `Node Manager configuration ${machineName}`,
    managementPath(creds, `/edit/machines/${encodeURIComponent(machineName)}/nodeManager`, {
      fields: NODE_MANAGER_CONFIG_FIELDS,
      links: 'none',
    }),
  )
  return normalizeNodeManagerConfig(data, machineName)
}

async function fetchNodeManagerServers(creds: WlsCredentials) {
  const data = await fetchWlsJson(
    creds,
    'Server machine mapping',
    managementPath(creds, '/edit/servers', {
      fields: NODE_MANAGER_SERVER_FIELDS,
      links: 'none',
    }),
  )
  return data
}

async function fetchNodeManagerLifecycleStates(creds: WlsCredentials) {
  const data = await fetchWlsJson(
    creds,
    'Server lifecycle states',
    managementPath(creds, '/domainRuntime/serverLifeCycleRuntimes', {
      fields: NODE_MANAGER_LIFECYCLE_FIELDS,
      links: 'none',
    }),
  )
  return normalizeNodeManagerLifecycleStates(data)
}

export function nodeManagerQueryKey(creds: WlsCredentials | null | undefined) {
  return ['nodeManager', wlsCredentialCacheKey(creds)] as const
}

export async function fetchNodeManagerSnapshot(creds: WlsCredentials): Promise<NodeManagerSnapshot> {
  const partialFailures: NodeManagerPartialFailure[] = []
  let runtimes: NodeManagerRuntimeRow[]
  try {
    runtimes = await fetchNodeManagerRuntimes(creds)
  } catch (error) {
    const status = error instanceof WlsRestError && error.kind === 'http' ? error.status : null
    if (status === 404) {
      return {
        status: 'unsupported',
        rows: [],
        machines: [],
        servers: [],
        unassignedServers: [],
        partialFailures: [],
        unsupportedReason: failureMessage(error),
      }
    }
    throw error
  }

  const [machinesResult, serversResult, lifecycleResult] = await Promise.allSettled([
    fetchNodeManagerMachines(creds),
    fetchNodeManagerServers(creds),
    fetchNodeManagerLifecycleStates(creds),
  ])

  const machines = machinesResult.status === 'fulfilled' ? machinesResult.value : []
  if (machinesResult.status === 'rejected') {
    partialFailures.push({
      machineName: null,
      family: 'machines',
      message: failureMessage(machinesResult.reason),
    })
  }

  const lifecycleStates = lifecycleResult.status === 'fulfilled' ? lifecycleResult.value : new Map<string, string | null>()
  if (lifecycleResult.status === 'rejected') {
    partialFailures.push({
      machineName: null,
      family: 'serverLifecycle',
      message: failureMessage(lifecycleResult.reason),
    })
  }

  const servers = serversResult.status === 'fulfilled' ? normalizeNodeManagerServerRows(serversResult.value, lifecycleStates) : []
  if (serversResult.status === 'rejected') {
    partialFailures.push({
      machineName: null,
      family: 'servers',
      message: failureMessage(serversResult.reason),
    })
  }

  const configResults = await Promise.allSettled(machines.map((machineName) =>
    fetchNodeManagerConfig(creds, machineName),
  ))
  const configs = configResults.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [result.value]
    partialFailures.push({
      machineName: machines[index] ?? null,
      family: 'nodeManagerConfig',
      message: failureMessage(result.reason),
    })
    return []
  })

  const built = buildNodeManagerRows({
    machines,
    runtimes,
    configs,
    servers,
    partialFailures,
  })

  return {
    status: 'supported',
    rows: built.rows,
    machines,
    servers,
    unassignedServers: built.unassignedServers,
    partialFailures,
    unsupportedReason: null,
  }
}

export async function nodeManagerContextForServer(creds: WlsCredentials, serverName: string) {
  const snapshot = await fetchNodeManagerSnapshot(creds)
  if (snapshot.status !== 'supported') return null
  return snapshot.rows.find((row) => row.serverNames.includes(serverName)) ?? null
}

export function formatNodeManagerEndpoint(row: Pick<NodeManagerRow, 'listenAddress' | 'listenPort'>) {
  if (!row.listenAddress && row.listenPort === null) return '-'
  if (!row.listenAddress) return `:${row.listenPort}`
  if (row.listenPort === null) return row.listenAddress
  return `${row.listenAddress}:${row.listenPort}`
}

export function formatNodeManagerLifecycleContext(row: NodeManagerRow | null) {
  if (!row) return null
  const endpoint = formatNodeManagerEndpoint(row)
  const parts = [
    `Node Manager ${row.machineName}: ${row.reachable}`,
    endpoint !== '-' ? endpoint : null,
    row.nmType,
  ].filter((value): value is string => !!value)
  return parts.join(' · ')
}

export function enrichLifecycleFailureWithNodeManager(message: string, row: NodeManagerRow | null) {
  const context = formatNodeManagerLifecycleContext(row)
  if (!context) return message
  if (message.includes(context)) return message
  return `${message} (${context})`
}

function canonicalNmType(value: string): NodeManagerNmType | null {
  const match = NODE_MANAGER_NM_TYPES.find((candidate) => candidate.toLowerCase() === value.trim().toLowerCase())
  return match ?? null
}

function normalizeTextInput(value: string) {
  return value.trim()
}

function displayNullable(value: string | number | null) {
  if (value === null || value === '') return '-'
  return String(value)
}

function parseIntegerField(value: string, label: string, min: number, max: number, errors: string[]) {
  const normalized = value.trim()
  const parsed = Number(normalized)
  if (!normalized || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    errors.push(`${label} must be an integer from ${min} to ${max}.`)
    return null
  }
  return parsed
}

export function listenerDraftFromRow(row: NodeManagerRow | null): NodeManagerListenerDraft {
  return {
    listenAddress: row?.listenAddress ?? '',
    listenPort: row?.listenPort === null || row?.listenPort === undefined ? '' : String(row.listenPort),
    nmType: row?.nmType ?? 'SSL',
    socketCreateTimeoutMillis:
      row?.socketCreateTimeoutMillis === null || row?.socketCreateTimeoutMillis === undefined
        ? '180000'
        : String(row.socketCreateTimeoutMillis),
  }
}

export function validateMachineName(value: string) {
  const normalized = value.trim()
  if (!normalized) return { ok: false, value: normalized, error: 'Machine name is required.' }
  const hasUnsafeCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return character === '/' || character === '\\' || codePoint < 32
  })
  if (hasUnsafeCharacter) {
    return { ok: false, value: normalized, error: 'Machine name cannot contain slashes or control characters.' }
  }
  return { ok: true, value: normalized, error: null }
}

export function validateNodeManagerListenerDraft(draft: NodeManagerListenerDraft): NodeManagerValidationResult {
  const errors: string[] = []
  const listenAddress = normalizeTextInput(draft.listenAddress)
  const listenPort = parseIntegerField(draft.listenPort, 'Listen port', 1, 65_535, errors)
  const socketCreateTimeoutMillis = parseIntegerField(
    draft.socketCreateTimeoutMillis,
    'Socket create timeout',
    0,
    2_147_483_647,
    errors,
  )
  const nmType = canonicalNmType(draft.nmType)
  if (!nmType) errors.push(`Node Manager type must be one of ${NODE_MANAGER_NM_TYPES.join(', ')}.`)

  if (listenPort === null || socketCreateTimeoutMillis === null || !nmType) {
    return { ok: false, errors, patch: {}, config: null }
  }

  const config = {
    listenAddress,
    listenPort,
    NMType: nmType,
    NMSocketCreateTimeoutInMillis: socketCreateTimeoutMillis,
  }

  return {
    ok: errors.length === 0,
    errors,
    patch: config,
    config,
  }
}

export function diffNodeManagerListenerConfig(
  current: Pick<NodeManagerRow, 'listenAddress' | 'listenPort' | 'nmType' | 'socketCreateTimeoutMillis'>,
  next: Required<NodeManagerListenerPatch>,
) {
  const changes: NodeManagerConfigChange[] = []
  const patch: NodeManagerListenerPatch = {}
  const candidates: {
    field: keyof NodeManagerListenerPatch
    label: string
    before: string | number | null
    after: string | number | null
    value: string | number
  }[] = [
    {
      field: 'listenAddress',
      label: 'Listen address',
      before: current.listenAddress ?? '',
      after: next.listenAddress,
      value: next.listenAddress,
    },
    {
      field: 'listenPort',
      label: 'Listen port',
      before: current.listenPort,
      after: next.listenPort,
      value: next.listenPort,
    },
    {
      field: 'NMType',
      label: 'Type',
      before: current.nmType,
      after: next.NMType,
      value: next.NMType,
    },
    {
      field: 'NMSocketCreateTimeoutInMillis',
      label: 'Socket timeout',
      before: current.socketCreateTimeoutMillis,
      after: next.NMSocketCreateTimeoutInMillis,
      value: next.NMSocketCreateTimeoutInMillis,
    },
  ]

  candidates.forEach((candidate) => {
    if (String(candidate.before ?? '') === String(candidate.after ?? '')) return
    Object.assign(patch, { [candidate.field]: candidate.value })
    changes.push({
      field: candidate.field,
      label: candidate.label,
      before: displayNullable(candidate.before),
      after: displayNullable(candidate.after),
    })
  })

  return { patch, changes }
}

export function machineCreationChanges(listener: Required<NodeManagerListenerPatch>) {
  return [
    { field: 'listenAddress', label: 'Listen address', before: '-', after: displayNullable(listener.listenAddress) },
    { field: 'listenPort', label: 'Listen port', before: '-', after: displayNullable(listener.listenPort) },
    { field: 'NMType', label: 'Type', before: '-', after: displayNullable(listener.NMType) },
    {
      field: 'NMSocketCreateTimeoutInMillis',
      label: 'Socket timeout',
      before: '-',
      after: displayNullable(listener.NMSocketCreateTimeoutInMillis),
    },
  ] satisfies NodeManagerConfigChange[]
}

export function isNodeManagerServerAssignable(server: NodeManagerServerRow) {
  if (server.serverName === 'AdminServer') return false
  return server.lifecycleState === 'SHUTDOWN' || server.lifecycleState === 'FAILED_NOT_RESTARTABLE'
}

export function nodeManagerAssignmentBlockedReason(server: NodeManagerServerRow) {
  if (server.serverName === 'AdminServer') return 'AdminServer is protected.'
  if (!server.lifecycleState) return 'Lifecycle state is unavailable.'
  if (isNodeManagerServerAssignable(server)) return null
  return 'Machine assignment is available only for stopped eligible managed servers.'
}

export function nodeManagerAssignmentServerChoices(servers: NodeManagerServerRow[]) {
  return servers.filter((server) => server.serverName !== 'AdminServer')
}

function nodeManagerTransactionTimeout(operation: string, startedAt: number, timeoutMs: number) {
  const remainingMs = timeoutMs - (Date.now() - startedAt)
  if (remainingMs <= 0) {
    throw new WlsRestError({
      kind: 'timeout',
      operation,
      message: `${operation}: timed out after ${Math.round(timeoutMs / 1000)}s`,
    })
  }
  return Math.min(NODE_MANAGER_CONFIG_TIMEOUT_MS, remainingMs)
}

async function editSessionPost(
  creds: WlsCredentials,
  action: 'startEdit' | 'activate' | 'cancelEdit',
  timeoutMs = NODE_MANAGER_CONFIG_TIMEOUT_MS,
) {
  const label = action === 'startEdit'
    ? 'Start edit session'
    : action === 'activate'
      ? 'Activate edit session'
      : 'Cancel edit session'
  await postWlsJson(creds, label, managementPath(creds, `/edit/changeManager/${action}`), {}, timeoutMs)
}

async function withNodeManagerEditSession<T>(
  creds: WlsCredentials,
  operation: string,
  timeoutMs: number,
  mutation: (operationTimeoutMs: () => number) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  const operationTimeoutMs = () => nodeManagerTransactionTimeout(operation, startedAt, timeoutMs)
  return runInEditSession(
    {
      startEdit: () => editSessionPost(creds, 'startEdit', operationTimeoutMs()),
      activate: () => editSessionPost(creds, 'activate', operationTimeoutMs()),
      cancelEdit: () => editSessionPost(creds, 'cancelEdit'),
    },
    () => mutation(operationTimeoutMs),
  )
}

export async function updateNodeManagerListener(
  creds: WlsCredentials,
  input: UpdateNodeManagerListenerInput,
): Promise<NodeManagerConfigResult> {
  const machine = validateMachineName(input.machineName)
  if (!machine.ok) throw new Error(machine.error ?? 'Invalid machine name.')
  if (input.changes.length === 0) throw new Error('No Node Manager listener changes to save.')

  return withNodeManagerEditSession(creds, `Update Node Manager ${machine.value}`, NODE_MANAGER_LISTENER_TRANSACTION_TIMEOUT_MS, async (operationTimeoutMs) => {
    await postWlsJson(
      creds,
      `Update Node Manager ${machine.value}`,
      managementPath(creds, `/edit/machines/${encodeURIComponent(machine.value)}/nodeManager`),
      definedFields({ ...input.patch }),
      operationTimeoutMs(),
    )
    return {
      action: 'listener',
      detail: `Updated Node Manager ${machine.value}: ${input.changes.map((change) => change.label).join(', ')}`,
      affectedMachines: [machine.value],
      affectedServers: [],
    }
  })
}

export async function createNodeManagerMachine(
  creds: WlsCredentials,
  input: CreateNodeManagerMachineInput,
): Promise<NodeManagerConfigResult> {
  const machine = validateMachineName(input.machineName)
  if (!machine.ok) throw new Error(machine.error ?? 'Invalid machine name.')

  return withNodeManagerEditSession(creds, `Create machine ${machine.value}`, NODE_MANAGER_LISTENER_TRANSACTION_TIMEOUT_MS, async (operationTimeoutMs) => {
    await postWlsJson(
      creds,
      `Create machine ${machine.value}`,
      managementPath(creds, '/edit/machines'),
      { name: machine.value, type: 'Machine' },
      operationTimeoutMs(),
    )
    await postWlsJson(
      creds,
      `Configure Node Manager ${machine.value}`,
      managementPath(creds, `/edit/machines/${encodeURIComponent(machine.value)}/nodeManager`),
      { ...input.listener },
      operationTimeoutMs(),
    )
    return {
      action: 'create-machine',
      detail: `Created machine ${machine.value}`,
      affectedMachines: [machine.value],
      affectedServers: [],
    }
  })
}

export async function assignNodeManagerServers(
  creds: WlsCredentials,
  input: AssignNodeManagerServersInput,
): Promise<NodeManagerConfigResult> {
  if (input.assignments.length === 0) throw new Error('No server machine assignment changes to save.')
  for (const assignment of input.assignments) {
    const machine = validateMachineName(assignment.toMachineName)
    if (!machine.ok) throw new Error(machine.error ?? 'Invalid machine name.')
    if (assignment.serverName === 'AdminServer') throw new Error('AdminServer machine assignment is protected.')
  }

  return withNodeManagerEditSession(creds, 'Assign server machines', NODE_MANAGER_ASSIGNMENT_TRANSACTION_TIMEOUT_MS, async (operationTimeoutMs) => {
    for (const assignment of input.assignments) {
      const machine = validateMachineName(assignment.toMachineName)
      if (!machine.ok) throw new Error(machine.error ?? 'Invalid machine name.')
      await postWlsJson(
        creds,
        `Assign ${assignment.serverName} to ${machine.value}`,
        managementPath(creds, `/edit/servers/${encodeURIComponent(assignment.serverName)}`),
        { machine: ['machines', machine.value] },
        operationTimeoutMs(),
      )
    }

    return {
      action: 'assign-servers',
      detail: `Updated machine assignment for ${input.assignments.length.toLocaleString()} server${input.assignments.length === 1 ? '' : 's'}`,
      affectedMachines: [...new Set(input.assignments.map((assignment) => assignment.toMachineName))],
      affectedServers: input.assignments.map((assignment) => assignment.serverName),
    }
  })
}

export async function invalidateNodeManagerConfigurationQueries(
  queryClient: QueryClient,
  creds: WlsCredentials | null | undefined,
  affectedServers: string[] = [],
) {
  const cacheKey = wlsCredentialCacheKey(creds)
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: nodeManagerQueryKey(creds) }),
    queryClient.invalidateQueries({ queryKey: editSessionStatusQueryKey(creds) }),
    queryClient.invalidateQueries({ queryKey: ['serverRuntimes', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['serverRuntimeDetails', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['serverRuntimeDetail', cacheKey] }),
    ...affectedServers.map((serverName) =>
      queryClient.invalidateQueries({ queryKey: ['serverRuntimeDetail', cacheKey, serverName] }),
    ),
  ])
}

export function useNodeManagerSnapshot({ enabled = true }: { enabled?: boolean } = {}) {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval(60_000)
  const queryEnabled = enabled && !!creds
  const query = useQuery({
    queryKey: nodeManagerQueryKey(creds),
    enabled: queryEnabled,
    staleTime: 30_000,
    refetchInterval: livePollingInterval,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchNodeManagerSnapshot(creds)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: queryEnabled,
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}

export function useNodeManagerForServer(serverName: string, enabled = true) {
  const query = useNodeManagerSnapshot({ enabled })
  const row = query.data?.status === 'supported'
    ? query.data.rows.find((candidate) => candidate.serverNames.includes(serverName)) ?? null
    : null

  return {
    ...query,
    data: enabled ? row : null,
  }
}
