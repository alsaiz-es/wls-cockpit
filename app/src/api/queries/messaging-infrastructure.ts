import { useQuery } from '@tanstack/react-query'
import { WLS_REST_PROXY_BASE_URL, wlsBasicAuthHeader, wlsCredentialCacheKey, type WlsCredentials } from '../client.ts'
import { actionAuditHeaders } from '../action-audit-headers.ts'
import { useRefreshStaleQueryOnVisibleReturn, useVisiblePollingInterval } from '../query-polling.ts'
import { createWlsHttpError, withWlsRestTimeout } from '../wls-errors.ts'
import { useAuth } from '../../auth/useAuth.ts'
import { WLS_HEALTH_STATES, type WlsHealthState } from '../../components/status-model.ts'
import { fetchBaseServerRuntimes } from './server-runtimes.ts'

/*
 * Read-only runtime of the messaging plumbing under JMS, per running server:
 *   /domainRuntime/serverRuntimes/{server}/persistentStoreRuntimes
 *   /domainRuntime/serverRuntimes/{server}/SAFRuntime/agents (and each agent's remoteEndpoints)
 *   /domainRuntime/serverRuntimes/{server}/messagingBridgeRuntimes
 * The REST API exposes no lifecycle operations for these resources in 12.2.1.4 or 14.1.2.
 * A server without SAF answers 404 for SAFRuntime; that is an empty list, not a failure.
 */

export type MessagingSeverity = 'critical' | 'warning' | 'healthy' | 'unknown'

export interface PersistentStoreRow {
  id: string
  serverName: string
  name: string
  healthState: WlsHealthState
  healthReason: string | null
  objectCount: number | null
  createCount: number | null
  readCount: number | null
  updateCount: number | null
  deleteCount: number | null
  physicalWriteCount: number | null
  severity: MessagingSeverity
}

export interface SafRemoteEndpointRow {
  name: string
  url: string | null
  endpointType: string | null
  operationState: string | null
  messagesCurrentCount: number | null
  messagesPendingCount: number | null
  failedMessagesTotal: number | null
  pausedForForwarding: boolean | null
  lastException: string | null
  lastTimeConnected: number | null
  lastTimeFailedToConnect: number | null
}

export interface SafAgentRow {
  id: string
  serverName: string
  name: string
  healthState: WlsHealthState
  healthReason: string | null
  messagesCurrentCount: number | null
  messagesPendingCount: number | null
  messagesReceivedCount: number | null
  failedMessagesTotal: number | null
  pausedForForwarding: boolean | null
  pausedForIncoming: boolean | null
  pausedForReceiving: boolean | null
  remoteEndpoints: SafRemoteEndpointRow[]
  severity: MessagingSeverity
}

export interface MessagingBridgeRow {
  id: string
  serverName: string
  name: string
  state: string | null
  description: string | null
  severity: MessagingSeverity
}

export interface MessagingPartialFailure {
  serverName: string
  family: 'stores' | 'saf' | 'bridges'
  message: string
}

export interface MessagingInfrastructureSnapshot {
  stores: PersistentStoreRow[]
  safAgents: SafAgentRow[]
  bridges: MessagingBridgeRow[]
  partialFailures: MessagingPartialFailure[]
  serversAsked: string[]
}

export const PERSISTENT_STORE_FIELDS =
  'name,healthState,objectCount,createCount,readCount,updateCount,deleteCount,physicalWriteCount'
export const SAF_AGENT_FIELDS =
  'name,healthState,messagesCurrentCount,messagesPendingCount,messagesReceivedCount,failedMessagesTotal,pausedForForwarding,pausedForIncoming,pausedForReceiving,remoteEndpointsCurrentCount'
export const SAF_REMOTE_ENDPOINT_FIELDS =
  'name,URL,endpointType,operationState,messagesCurrentCount,messagesPendingCount,failedMessagesTotal,pausedForForwarding,lastException,lastTimeConnected,lastTimeFailedToConnect'
export const MESSAGING_BRIDGE_FIELDS = 'name,state,description'

const MESSAGING_TIMEOUT_MS = 10_000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readItems(value: unknown): Record<string, unknown>[] {
  return isObject(value) && Array.isArray(value.items) ? value.items.filter(isObject) : []
}

function readHealth(value: unknown): { state: WlsHealthState; reason: string | null } {
  if (!isObject(value)) return { state: 'unknown', reason: null }
  const raw = typeof value.state === 'string' ? value.state.toLowerCase() : ''
  const normalized = raw === 'warning' ? 'warn' : raw
  const state = WLS_HEALTH_STATES.includes(normalized as WlsHealthState) ? (normalized as WlsHealthState) : 'unknown'
  // 12.2.1.4 and 14.1.2 report why in `symptoms` ({type, severity, info}); older payloads used
  // a `reasons` string list.
  const symptoms = Array.isArray(value.symptoms) ? value.symptoms.filter(isObject) : []
  const symptom = symptoms.map((item) => readString(item.info) ?? readString(item.type)).find((text) => text !== null)
  const reasons = Array.isArray(value.reasons) ? value.reasons.filter((reason): reason is string => typeof reason === 'string') : []
  return { state, reason: symptom ?? reasons[0] ?? null }
}

function healthSeverity(state: WlsHealthState): MessagingSeverity {
  if (state === 'critical' || state === 'failed') return 'critical'
  if (state === 'warn' || state === 'overloaded') return 'warning'
  if (state === 'ok') return 'healthy'
  return 'unknown'
}

function worse(a: MessagingSeverity, b: MessagingSeverity): MessagingSeverity {
  const order: MessagingSeverity[] = ['critical', 'warning', 'unknown', 'healthy']
  return order[Math.min(order.indexOf(a), order.indexOf(b))] ?? 'unknown'
}

export function normalizePersistentStores(serverName: string, data: unknown): PersistentStoreRow[] {
  return readItems(data).map((item) => {
    const name = readString(item.name) ?? '?'
    const health = readHealth(item.healthState)
    return {
      id: `${serverName}/${name}`,
      serverName,
      name,
      healthState: health.state,
      healthReason: health.reason,
      objectCount: readNumber(item.objectCount),
      createCount: readNumber(item.createCount),
      readCount: readNumber(item.readCount),
      updateCount: readNumber(item.updateCount),
      deleteCount: readNumber(item.deleteCount),
      physicalWriteCount: readNumber(item.physicalWriteCount),
      severity: healthSeverity(health.state),
    }
  })
}

export function normalizeSafRemoteEndpoints(data: unknown): SafRemoteEndpointRow[] {
  return readItems(data).map((item) => ({
    name: readString(item.name) ?? '?',
    url: readString(item.URL),
    endpointType: readString(item.endpointType),
    operationState: readString(item.operationState),
    messagesCurrentCount: readNumber(item.messagesCurrentCount),
    messagesPendingCount: readNumber(item.messagesPendingCount),
    failedMessagesTotal: readNumber(item.failedMessagesTotal),
    pausedForForwarding: readBoolean(item.pausedForForwarding),
    lastException: readString(item.lastException),
    lastTimeConnected: readNumber(item.lastTimeConnected),
    lastTimeFailedToConnect: readNumber(item.lastTimeFailedToConnect),
  }))
}

// A remote endpoint is failing when its last connection attempt failed after its last success.
export function safEndpointFailing(endpoint: SafRemoteEndpointRow) {
  if (endpoint.lastTimeFailedToConnect === null || endpoint.lastTimeFailedToConnect <= 0) return false
  return endpoint.lastTimeConnected === null || endpoint.lastTimeFailedToConnect > endpoint.lastTimeConnected
}

export function classifySafAgent(agent: Omit<SafAgentRow, 'severity'>): MessagingSeverity {
  let severity = healthSeverity(agent.healthState)
  if (agent.pausedForForwarding || agent.remoteEndpoints.some((endpoint) => endpoint.pausedForForwarding)) {
    severity = worse(severity, 'warning')
  }
  if (agent.remoteEndpoints.some(safEndpointFailing) && (agent.messagesCurrentCount ?? 0) > 0) severity = worse(severity, 'critical')
  else if (agent.remoteEndpoints.some(safEndpointFailing)) severity = worse(severity, 'warning')
  if ((agent.failedMessagesTotal ?? 0) > 0) severity = worse(severity, 'warning')
  return severity
}

export function normalizeSafAgent(serverName: string, item: Record<string, unknown>, endpoints: SafRemoteEndpointRow[]): SafAgentRow {
  const name = readString(item.name) ?? '?'
  const health = readHealth(item.healthState)
  const agent = {
    id: `${serverName}/${name}`,
    serverName,
    name,
    healthState: health.state,
    healthReason: health.reason,
    messagesCurrentCount: readNumber(item.messagesCurrentCount),
    messagesPendingCount: readNumber(item.messagesPendingCount),
    messagesReceivedCount: readNumber(item.messagesReceivedCount),
    failedMessagesTotal: readNumber(item.failedMessagesTotal),
    pausedForForwarding: readBoolean(item.pausedForForwarding),
    pausedForIncoming: readBoolean(item.pausedForIncoming),
    pausedForReceiving: readBoolean(item.pausedForReceiving),
    remoteEndpoints: endpoints,
  }
  return { ...agent, severity: classifySafAgent(agent) }
}

// Bridge states are Active, Inactive (started, not forwarding) and Stopped, plus transient text.
export function classifyBridgeState(state: string | null): MessagingSeverity {
  if (!state) return 'unknown'
  const normalized = state.toLowerCase()
  if (normalized === 'active') return 'healthy'
  if (normalized.includes('stop') || normalized.includes('fail')) return 'critical'
  return 'warning'
}

export function normalizeMessagingBridges(serverName: string, data: unknown): MessagingBridgeRow[] {
  return readItems(data).map((item) => {
    const name = readString(item.name) ?? '?'
    const state = readString(item.state)
    return { id: `${serverName}/${name}`, serverName, name, state, description: readString(item.description), severity: classifyBridgeState(state) }
  })
}

function runtimePath(creds: WlsCredentials, serverName: string, child: string, fields: string) {
  const query = new URLSearchParams({ fields, links: 'none' })
  return `/management/weblogic/${encodeURIComponent(creds.version)}/domainRuntime/serverRuntimes/${encodeURIComponent(serverName)}/${child}?${query}`
}

// null when the resource does not exist on this server (HTTP 404).
async function readRuntime(creds: WlsCredentials, operation: string, path: string): Promise<unknown | null> {
  const response = await withWlsRestTimeout(
    operation,
    (signal) =>
      fetch(`${WLS_REST_PROXY_BASE_URL}${path}`, {
        signal,
        headers: { Accept: 'application/json', Authorization: wlsBasicAuthHeader(creds), ...actionAuditHeaders(creds) },
      }),
    MESSAGING_TIMEOUT_MS,
  )
  if (response.status === 404) return null
  if (!response.ok) throw createWlsHttpError(operation, response, await response.json().catch(() => undefined))
  return response.json()
}

function failureMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

async function fetchServerSafAgents(creds: WlsCredentials, serverName: string) {
  const agents = readItems(await readRuntime(creds, `SAF agents on ${serverName}`, runtimePath(creds, serverName, 'SAFRuntime/agents', SAF_AGENT_FIELDS)))
  return Promise.all(
    agents.map(async (item) => {
      const name = readString(item.name)
      const endpoints =
        name && (readNumber(item.remoteEndpointsCurrentCount) ?? 1) > 0
          ? normalizeSafRemoteEndpoints(
              await readRuntime(
                creds,
                `SAF remote endpoints of ${name} on ${serverName}`,
                runtimePath(creds, serverName, `SAFRuntime/agents/${encodeURIComponent(name)}/remoteEndpoints`, SAF_REMOTE_ENDPOINT_FIELDS),
              ).catch(() => null),
            )
          : []
      return normalizeSafAgent(serverName, item, endpoints)
    }),
  )
}

export async function fetchMessagingInfrastructure(creds: WlsCredentials): Promise<MessagingInfrastructureSnapshot> {
  const servers = (await fetchBaseServerRuntimes(creds)).filter(
    (server) => server.state === 'RUNNING' || server.state === 'ADMIN' || server.state === 'STANDBY',
  )
  const snapshot: MessagingInfrastructureSnapshot = {
    stores: [],
    safAgents: [],
    bridges: [],
    partialFailures: [],
    serversAsked: servers.map((server) => server.name),
  }

  await Promise.all(
    servers.map(async ({ name: serverName }) => {
      const [stores, saf, bridges] = await Promise.allSettled([
        readRuntime(creds, `Persistent stores on ${serverName}`, runtimePath(creds, serverName, 'persistentStoreRuntimes', PERSISTENT_STORE_FIELDS)),
        fetchServerSafAgents(creds, serverName),
        readRuntime(creds, `Messaging bridges on ${serverName}`, runtimePath(creds, serverName, 'messagingBridgeRuntimes', MESSAGING_BRIDGE_FIELDS)),
      ])
      if (stores.status === 'fulfilled') snapshot.stores.push(...normalizePersistentStores(serverName, stores.value))
      else snapshot.partialFailures.push({ serverName, family: 'stores', message: failureMessage(stores.reason, 'Persistent stores failed.') })
      if (saf.status === 'fulfilled') snapshot.safAgents.push(...saf.value)
      else snapshot.partialFailures.push({ serverName, family: 'saf', message: failureMessage(saf.reason, 'SAF agents failed.') })
      if (bridges.status === 'fulfilled') snapshot.bridges.push(...normalizeMessagingBridges(serverName, bridges.value))
      else snapshot.partialFailures.push({ serverName, family: 'bridges', message: failureMessage(bridges.reason, 'Messaging bridges failed.') })
    }),
  )

  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, undefined, { numeric: true })
  snapshot.stores.sort(byId)
  snapshot.safAgents.sort(byId)
  snapshot.bridges.sort(byId)
  return snapshot
}

export function messagingInfrastructureQueryKey(creds: WlsCredentials | null | undefined) {
  return ['messagingInfrastructure', wlsCredentialCacheKey(creds)] as const
}

export function useMessagingInfrastructure() {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval(60_000)
  const query = useQuery({
    queryKey: messagingInfrastructureQueryKey(creds),
    enabled: !!creds,
    staleTime: 30_000,
    refetchInterval: livePollingInterval,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchMessagingInfrastructure(creds)
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
