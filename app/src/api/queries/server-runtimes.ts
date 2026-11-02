import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { createClient12, createClient14, wlsCredentialCacheKey, type WlsCredentials } from '../client.ts'
import {
  useRefreshStaleQueryOnVisibleReturn,
  useVisiblePollingInterval,
} from '../query-polling.ts'
import { createWlsHttpError, withWlsRestTimeout } from '../wls-errors.ts'
import { useAuth } from '../../auth/useAuth.ts'
import {
  WLS_HEALTH_STATES,
  WLS_LIFECYCLE_STATES,
  type WlsHealthState,
  type WlsLifecycleState,
} from '../../components/status-model.ts'
import {
  jvmHeapQueryParams,
  serverLifecycleQueryParams,
  serverRuntimeBaseQueryParams,
  threadPoolQueryParams,
} from './server-runtime-query-params.ts'
import { normalizeHeapUsage, type HeapUsage } from './heap-utilization.ts'

/*
 * WLS 14.1.2 OpenAPI confirms:
 * - GET /management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}
 *   accepts query params `fields`, `excludeFields`, `links`, and `excludeLinks`.
 * - There is no GET `expand` parameter for compound child expansion.
 * - POST /management/weblogic/{version}/domainRuntime/search supports nested
 *   `children.serverRuntimes.children.{JVMRuntime,threadPoolRuntime}` shapes.
 *
 * This hook first reads lifecycle-controller rows:
 *   /serverLifeCycleRuntimes?fields=name,state&links=none
 * It then fans out bounded per-server base runtime reads for runtime-capable
 * states instead of using the federated /serverRuntimes collection:
 *   /serverRuntimes/{serverName}?fields=name,state,healthState,listenAddress,listenPort,defaultURL&links=none
 * It then reads JVM and thread-pool metrics with allow-listed N + 1 requests:
 *   /serverRuntimes/{serverName}/JVMRuntime?fields=heapFreeCurrent,heapSizeCurrent,heapSizeMax,uptime,...&links=none
 *   /serverRuntimes/{serverName}/threadPoolRuntime?fields=executeThreadTotalCount,...,stuckThreadCount&links=none
 *
 * Do not request `JVMRuntime` as an embedded collection child here. WLS exposes
 * `JVMRuntime.threadStackDump` as a large field and the real 14.1.2 endpoint
 * rejects `excludeFields=threadStackDump` on the collection with HTTP 400.
 *
 * If one per-server base runtime read times out or fails, the row is
 * synthesized from lifecycle state so one blocked managed server does not
 * block the full domain backbone.
 */

export interface ServerRuntimeRow {
  name: string
  state: WlsLifecycleState
  healthState: WlsHealthState
  listenAddress: string | null
  listenPort: number | null
  heap: HeapUsage | null
  jvm: {
    uptime: number | null
    javaVersion: string | null
    javaVendor: string | null
    javaVmVendor: string | null
    osName: string | null
    osVersion: string | null
    processCpuLoad: number | null
  } | null
  threads: {
    total: number
    idle: number | null
    standby: number | null
    pending: number | null
    queueLength: number | null
    hogging: number | null
    stuck: number
  } | null
}

interface BaseServerRuntimeRow extends ServerRuntimeRow {
  needsDetails: boolean
}

interface ServerDetails {
  heap: ServerRuntimeRow['heap']
  jvm: ServerRuntimeRow['jvm']
  threads: ServerRuntimeRow['threads']
}

export interface ServerLifecycleHeartbeat {
  serverCount: number
}

const SERVER_RUNTIME_FANOUT_TIMEOUT_MS = 7_500

export function serverRuntimesQueryKey(creds: WlsCredentials | null | undefined) {
  return ['serverRuntimes', wlsCredentialCacheKey(creds)] as const
}

export function serverLifecycleHeartbeatQueryKey(creds: WlsCredentials | null | undefined) {
  return ['serverLifecycleHeartbeat', wlsCredentialCacheKey(creds)] as const
}

export function serverRuntimeDetailsQueryKey(
  creds: WlsCredentials | null | undefined,
  serverName: string | null | undefined,
) {
  return ['serverRuntimeDetails', wlsCredentialCacheKey(creds), serverName ?? ''] as const
}

export function serverRuntimeDetailQueryKey(
  creds: WlsCredentials | null | undefined,
  serverName: string | null | undefined,
) {
  return ['serverRuntimeDetail', wlsCredentialCacheKey(creds), serverName ?? ''] as const
}

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
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

function normalizeProcessCpuLoad(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}

export function normalizeJvmRuntime(value: unknown): ServerRuntimeRow['jvm'] {
  if (!isObject(value)) return null

  return {
    uptime: readNumber(value.uptime),
    javaVersion: readString(value.javaVersion),
    javaVendor: readString(value.javaVendor),
    javaVmVendor: readString(value.javaVMVendor),
    osName: readString(value.OSName),
    osVersion: readString(value.OSVersion),
    processCpuLoad: normalizeProcessCpuLoad(value.processCpuLoad),
  }
}

function normalizeThreads(value: unknown): ServerRuntimeRow['threads'] {
  if (!isObject(value)) return null

  const total = readNumber(value.executeThreadTotalCount)
  const stuck = readNumber(value.stuckThreadCount)
  if (total === null || stuck === null) return null

  return {
    total,
    idle: readNumber(value.executeThreadIdleCount),
    standby: readNumber(value.standbyThreadCount),
    pending: readNumber(value.pendingUserRequestCount),
    queueLength: readNumber(value.queueLength),
    hogging: readNumber(value.hoggingThreadCount),
    stuck,
  }
}

function listenFromDefaultUrl(value: unknown) {
  const raw = readString(value)
  if (!raw) return { address: null, port: null }

  try {
    const url = new URL(raw)
    return {
      address: readString(url.hostname),
      port: url.port ? Number(url.port) : null,
    }
  } catch {
    const match = raw.match(/^[a-z][a-z0-9+.-]*:\/\/([^:/]+):(\d+)/i)
    return {
      address: match?.[1] ?? null,
      port: match?.[2] ? Number(match[2]) : null,
    }
  }
}

function normalizeServer(value: unknown): BaseServerRuntimeRow | null {
  if (!isObject(value)) return null

  const health = isObject(value.healthState) ? value.healthState : null
  const defaultListen = listenFromDefaultUrl(value.defaultURL)

  return {
    name: String(value.name ?? '?'),
    state: normalizeLifecycle(value.state),
    healthState: normalizeHealth(health?.state),
    listenAddress: readString(value.listenAddress) ?? defaultListen.address,
    listenPort: readNumber(value.listenPort) ?? defaultListen.port,
    heap: null,
    jvm: null,
    threads: null,
    needsDetails: true,
  }
}

function hasRuntimeMBean(state: WlsLifecycleState) {
  return state === 'RUNNING' || state === 'ADMIN' || state === 'STANDBY'
}

function needsRuntimeDetails(state: WlsLifecycleState) {
  return state === 'RUNNING'
}

function synthesizeServerRow(name: string, state: WlsLifecycleState): BaseServerRuntimeRow {
  return {
    name,
    state,
    healthState: 'unknown',
    listenAddress: null,
    listenPort: null,
    heap: null,
    jvm: null,
    threads: null,
    needsDetails: false,
  }
}

async function fetchBaseServerRuntime(
  creds: WlsCredentials,
  serverName: string,
  lifecycleState: WlsLifecycleState,
): Promise<BaseServerRuntimeRow> {
  if (!hasRuntimeMBean(lifecycleState)) return synthesizeServerRow(serverName, lifecycleState)

  try {
    const res = await withWlsRestTimeout(
      `Server runtime ${serverName}`,
      (signal) =>
        clientFor(creds).GET('/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}', {
          signal,
          params: {
            path: { version: creds.version, serverName },
            query: serverRuntimeBaseQueryParams(),
          },
        }),
      SERVER_RUNTIME_FANOUT_TIMEOUT_MS,
    )

    if (res.error) throw createWlsHttpError(`Server runtime ${serverName}`, res.response, res.error)
    const row = normalizeServer(res.data)
    if (!row) return synthesizeServerRow(serverName, lifecycleState)

    const state = row.state === 'UNKNOWN' ? lifecycleState : row.state
    return {
      ...row,
      state,
      needsDetails: needsRuntimeDetails(state),
    }
  } catch {
    return synthesizeServerRow(serverName, lifecycleState)
  }
}

export async function fetchBaseServerRuntimes(creds: WlsCredentials) {
  const lifecycleStates = await fetchLifecycleStates(creds)
  return Promise.all(
    Array.from(lifecycleStates.entries()).map(([serverName, lifecycleState]) =>
      fetchBaseServerRuntime(creds, serverName, lifecycleState),
    ),
  )
}

async function fetchServerDetails(creds: WlsCredentials, serverName: string): Promise<ServerDetails> {
  const client = clientFor(creds)
  const commonParams = {
    path: { version: creds.version, serverName },
    query: { links: 'none' },
  }

  const [jvm, threads] = await Promise.all([
    withWlsRestTimeout(`JVM ${serverName}`, (signal) =>
      client.GET('/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JVMRuntime', {
        signal,
        params: {
          ...commonParams,
          query: {
            ...commonParams.query,
            ...jvmHeapQueryParams(),
          },
        },
      }),
    ).catch(() => null),
    withWlsRestTimeout(`Threads ${serverName}`, (signal) =>
      client.GET('/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/threadPoolRuntime', {
        signal,
        params: {
          ...commonParams,
          query: {
            ...commonParams.query,
            ...threadPoolQueryParams(),
          },
        },
      }),
    ).catch(() => null),
  ])

  return {
    heap: !jvm || jvm.error ? null : normalizeHeapUsage(jvm.data),
    jvm: !jvm || jvm.error ? null : normalizeJvmRuntime(jvm.data),
    threads: !threads || threads.error ? null : normalizeThreads(threads.data),
  }
}

async function fetchLifecycleState(creds: WlsCredentials, serverName: string) {
  const res = await withWlsRestTimeout(`Server lifecycle ${serverName}`, (signal) =>
    clientFor(creds).GET('/management/weblogic/{version}/domainRuntime/serverLifeCycleRuntimes/{serverName}', {
      signal,
      params: {
        path: { version: creds.version, serverName },
        query: serverLifecycleQueryParams(),
      },
    }),
  )

  if (res.error) {
    if (res.response.status === 404) return null
    throw createWlsHttpError(`Server lifecycle ${serverName}`, res.response, res.error)
  }

  if (!isObject(res.data)) return null
  const name = readString(res.data.name) ?? serverName
  return {
    name,
    state: normalizeLifecycle(res.data.state),
  }
}

export async function fetchServerRuntimeRows(creds: WlsCredentials): Promise<ServerRuntimeRow[]> {
  const baseRows = await fetchBaseServerRuntimes(creds)
  const details = await Promise.all(
    baseRows.map(async (row) => {
      if (!row.needsDetails) return [row.name, null] as const
      return [row.name, await fetchServerDetails(creds, row.name)] as const
    }),
  )
  const detailsByName = new Map(details)

  return baseRows.map((row) => {
    const detail = detailsByName.get(row.name)
    return {
      name: row.name,
      state: row.state,
      healthState: row.healthState,
      listenAddress: row.listenAddress,
      listenPort: row.listenPort,
      heap: row.heap ?? detail?.heap ?? null,
      jvm: row.jvm ?? detail?.jvm ?? null,
      threads: row.threads ?? detail?.threads ?? null,
    }
  })
}

export async function fetchServerRuntimeDetail(
  creds: WlsCredentials,
  serverName: string,
): Promise<ServerRuntimeRow | null> {
  const lifecycle = await fetchLifecycleState(creds, serverName)
  if (!lifecycle) return null

  const row = await fetchBaseServerRuntime(creds, lifecycle.name, lifecycle.state)
  const detail = row.needsDetails ? await fetchServerDetails(creds, row.name) : null

  return {
    name: row.name,
    state: row.state,
    healthState: row.healthState,
    listenAddress: row.listenAddress,
    listenPort: row.listenPort,
    heap: row.heap ?? detail?.heap ?? null,
    jvm: row.jvm ?? detail?.jvm ?? null,
    threads: row.threads ?? detail?.threads ?? null,
  }
}

export async function fetchServerLifecycleHeartbeat(creds: WlsCredentials): Promise<ServerLifecycleHeartbeat> {
  const lifecycleStates = await fetchLifecycleStates(creds)
  return { serverCount: lifecycleStates.size }
}

async function fetchLifecycleStates(creds: WlsCredentials) {
  const res = await withWlsRestTimeout('Server lifecycle runtimes', (signal) =>
    clientFor(creds).GET('/management/weblogic/{version}/domainRuntime/serverLifeCycleRuntimes', {
      signal,
      params: {
        path: { version: creds.version },
        query: serverLifecycleQueryParams(),
      },
    }),
  )

  const states = new Map<string, WlsLifecycleState>()
  if (res.error) throw createWlsHttpError('Server lifecycle runtimes', res.response, res.error)
  if (!isObject(res.data) || !Array.isArray(res.data.items)) return states

  res.data.items.forEach((item) => {
    if (!isObject(item)) return
    const name = readString(item.name)
    if (name) states.set(name, normalizeLifecycle(item.state))
  })

  return states
}

export function useServerRuntimes() {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval()

  const baseQuery = useQuery({
    queryKey: serverRuntimesQueryKey(creds),
    enabled: !!creds,
    staleTime: 0,
    refetchInterval: livePollingInterval,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchBaseServerRuntimes(creds)
    },
  })

  const rowsNeedingDetails = useMemo(
    () => (baseQuery.data ?? []).filter((row) => row.needsDetails),
    [baseQuery.data],
  )

  const detailQueries = useQueries({
    queries: rowsNeedingDetails.map((row) => ({
      queryKey: serverRuntimeDetailsQueryKey(creds, row.name),
      enabled: !!creds,
      staleTime: 0,
      refetchInterval: livePollingInterval,
      queryFn: async () => {
        if (!creds) throw new Error('not authenticated')
        return fetchServerDetails(creds, row.name)
      },
    })),
  })

  const detailByName = useMemo(() => {
    const map = new Map<string, ServerDetails>()
    detailQueries.forEach((query, index) => {
      const name = rowsNeedingDetails[index]?.name
      if (name && query.data) map.set(name, query.data)
    })
    return map
  }, [detailQueries, rowsNeedingDetails])

  const data = useMemo<ServerRuntimeRow[]>(() => {
    return (baseQuery.data ?? []).map((row) => {
      const detail = detailByName.get(row.name)
      const normalizedRow = {
        name: row.name,
        state: row.state,
        healthState: row.healthState,
        listenAddress: row.listenAddress,
        listenPort: row.listenPort,
        heap: row.heap,
        jvm: row.jvm,
        threads: row.threads,
      }
      if (!detail) return normalizedRow
      return {
        ...normalizedRow,
        heap: row.heap ?? detail.heap,
        jvm: row.jvm ?? detail.jvm,
        threads: row.threads ?? detail.threads,
      }
    })
  }, [baseQuery.data, detailByName])

  const dataUpdatedAt = Math.max(
    baseQuery.dataUpdatedAt,
    ...detailQueries.map((query) => query.dataUpdatedAt),
  )

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds,
    isFetching: baseQuery.isFetching || detailQueries.some((query) => query.isFetching),
    isStale: baseQuery.isStale || detailQueries.some((query) => query.isStale),
    refetch: async () => {
      const base = await baseQuery.refetch()
      await Promise.all(detailQueries.map((query) => query.refetch()))
      return base
    },
  })

  return {
    ...baseQuery,
    data,
    dataUpdatedAt,
    isFetching: baseQuery.isFetching || detailQueries.some((query) => query.isFetching),
    refetch: async () => {
      const base = await baseQuery.refetch()
      await Promise.all(detailQueries.map((query) => query.refetch()))
      return base
    },
  }
}

export function useServerRuntimeDetail(serverName: string) {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval()

  const query = useQuery({
    queryKey: serverRuntimeDetailQueryKey(creds, serverName),
    enabled: !!creds && !!serverName,
    staleTime: 0,
    refetchInterval: livePollingInterval,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchServerRuntimeDetail(creds, serverName)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds && !!serverName,
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}
