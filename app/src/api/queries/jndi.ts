import { useQuery } from '@tanstack/react-query'
import {
  WLS_REST_PROXY_BASE_URL,
  wlsBasicAuthHeader,
  wlsCredentialCacheKey,
  type WlsCredentials,
} from '../client.ts'
import { WLS_TARGET_HEADER } from '../proxy-target.ts'
import { useRefreshStaleQueryOnVisibleReturn, useVisiblePollingInterval } from '../query-polling.ts'
import { actionAuditHeaders } from '../action-audit-headers.ts'
import { readRuntimeConfig } from '../runtime-config.ts'
import { WlsRestError, normalizeWlsRestError, withWlsRestTimeout } from '../wls-errors.ts'
import { useAuth } from '../../auth/useAuth.ts'

export const JNDI_QUERY_PARAMS = { links: 'none' } as const
export const JNDI_REQUEST_TIMEOUT_MS = 15_000
export const JNDI_MAX_ROWS = 2_000

export type JndiStatus = 'available' | 'empty' | 'unsupported' | 'partial'
export type JndiNodeKind = 'context' | 'binding'

export interface JndiBindingRow {
  id: string
  serverName: string
  context: string
  name: string
  path: string
  className: string | null
  error: string | null
  isContext: false
}

export interface JndiTreeNode {
  id: string
  serverName: string
  kind: JndiNodeKind
  name: string
  path: string
  depth: number
  className: string | null
  error: string | null
  childCount: number
  binding: JndiBindingRow | null
}

export interface JndiSnapshot {
  status: JndiStatus
  serverName: string
  rows: JndiBindingRow[]
  tree: JndiTreeNode[]
  truncated: boolean
  unsupportedReason: string | null
  partialFailures: Array<{ serverName: string; message: string }>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function joinPath(context: string, name: string) {
  return context ? `${context}/${name}` : name
}

// WebLogic resolves '.' and '/' alike, but names are configured with slashes (jdbc/OrdersDS), so
// that is how paths are shown; the REST payload separates contexts with dots.
export function displayJndiPath(path: string) {
  return path.replaceAll('.', '/')
}

function treeSegments(context: string, name: string) {
  const contexts = context
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
  return [...contexts, name]
}

function safeNodeId(serverName: string, path: string, kind: JndiNodeKind) {
  return `${serverName}:${kind}:${path}`
}

function ancestorContextPaths(node: JndiTreeNode) {
  const paths: string[] = []
  if (node.kind === 'binding' && node.binding?.context) {
    const parts = treeSegments(node.binding.context, node.binding.name).slice(0, -1)
    let currentPath = ''
    parts.forEach((part) => {
      currentPath = currentPath ? `${currentPath}.${part}` : part
      paths.push(currentPath)
    })
    return paths
  }

  const parts = node.path.split('.').filter(Boolean)
  let currentPath = ''
  parts.slice(0, -1).forEach((part) => {
    currentPath = currentPath ? `${currentPath}.${part}` : part
    paths.push(currentPath)
  })
  return paths
}

export function isSafeJndiServerName(value: string) {
  return value.trim().length > 0 && !/[/?#\\]/.test(value)
}

export function jndiEndpointPath(creds: WlsCredentials, serverName: string) {
  const normalizedServerName = serverName.trim()
  if (!isSafeJndiServerName(normalizedServerName)) {
    throw new Error('JNDI server name contains unsupported path characters.')
  }
  const query = new URLSearchParams(JNDI_QUERY_PARAMS).toString()
  return `/management/weblogic/${encodeURIComponent(creds.version)}/domainRuntime/JNDI/${encodeURIComponent(normalizedServerName)}?${query}`
}

export function normalizeJndiBindings(data: unknown, serverName: string): JndiBindingRow[] {
  const rows = isObject(data) && Array.isArray(data.jndi) ? data.jndi : []
  return rows.flatMap((item): JndiBindingRow[] => {
    if (!isObject(item)) return []
    const name = readString(item.name)
    if (!name) return []
    const context = readString(item.context) ?? ''
    const path = joinPath(context, name)
    return [
      {
        id: safeNodeId(serverName, path, 'binding'),
        serverName,
        context,
        name,
        path,
        className: readString(item.class),
        error: readString(item.error),
        isContext: false,
      },
    ]
  })
}

export function buildJndiTree(rows: JndiBindingRow[], serverName: string): JndiTreeNode[] {
  const contextPaths = new Map<string, JndiTreeNode>()
  const bindingNodes: JndiTreeNode[] = []

  rows.forEach((row) => {
    const segments = treeSegments(row.context, row.name)
    let currentPath = ''
    segments.slice(0, -1).forEach((segment, index) => {
      currentPath = currentPath ? `${currentPath}.${segment}` : segment
      if (contextPaths.has(currentPath)) return
      contextPaths.set(currentPath, {
        id: safeNodeId(serverName, currentPath, 'context'),
        serverName,
        kind: 'context',
        name: segment,
        path: currentPath,
        depth: index,
        className: null,
        error: null,
        childCount: 0,
        binding: null,
      })
    })

    bindingNodes.push({
      id: row.id,
      serverName,
      kind: 'binding',
      name: row.name,
      path: row.path,
      depth: Math.max(0, segments.length - 1),
      className: row.className,
      error: row.error,
      childCount: 0,
      binding: row,
    })
  })

  const nodes = [...contextPaths.values(), ...bindingNodes].sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }) ||
    a.kind.localeCompare(b.kind),
  )
  const byPath = new Map(nodes.map((node) => [node.path, node]))
  nodes.forEach((node) => {
    const parentPath = node.kind === 'binding'
      ? node.binding?.context ?? ''
      : node.path.includes('.')
        ? node.path.slice(0, node.path.lastIndexOf('.'))
        : ''
    const parent = parentPath ? byPath.get(parentPath) : null
    if (parent) parent.childCount += 1
  })
  return nodes
}

export function visibleJndiTreeNodes(nodes: JndiTreeNode[], expandedPaths: ReadonlySet<string>, search: string) {
  const needle = search.trim().toLowerCase()
  if (needle) {
    const contextByPath = new Map(nodes.filter((node) => node.kind === 'context').map((node) => [node.path, node]))
    const visibleIds = new Set<string>()

    nodes.forEach((node) => {
      const matches = [node.path, displayJndiPath(node.path), node.name, node.className ?? '', node.error ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle)
      if (!matches) return

      ancestorContextPaths(node).forEach((path) => {
        const context = contextByPath.get(path)
        if (context) visibleIds.add(context.id)
      })
      visibleIds.add(node.id)
    })

    return nodes.filter((node) => visibleIds.has(node.id))
  }

  return nodes.filter((node) => {
    if (node.depth === 0) return true
    const parts = node.kind === 'binding' && node.binding
      ? treeSegments(node.binding.context, node.binding.name).slice(0, -1)
      : node.path.split('.')
    let parentPath = ''
    for (let index = 0; index < parts.length - (node.kind === 'context' ? 1 : 0); index += 1) {
      parentPath = parentPath ? `${parentPath}.${parts[index]}` : parts[index]
      if (parentPath && !expandedPaths.has(parentPath)) return false
    }
    return true
  })
}

export function normalizeJndiSnapshot(data: unknown, serverName: string): JndiSnapshot {
  const rows = normalizeJndiBindings(data, serverName)
  // The T3 helper stops at the same cap and says so, which a row count cannot tell.
  const truncated = rows.length > JNDI_MAX_ROWS || (isObject(data) && data.truncated === true)
  const outOfTime = isObject(data) && data.truncatedReason === 'time'
  const boundedRows = truncated ? rows.slice(0, JNDI_MAX_ROWS) : rows
  const tree = buildJndiTree(boundedRows, serverName)
  return {
    status: boundedRows.length ? (truncated ? 'partial' : 'available') : 'empty',
    serverName,
    rows: boundedRows,
    tree,
    truncated,
    unsupportedReason: null,
    partialFailures: truncated
      ? [
          {
            serverName,
            message: outOfTime
              ? 'The JNDI tree was not read completely within the time limit; the bindings read so far are shown.'
              : `JNDI result was capped at ${JNDI_MAX_ROWS.toLocaleString()} bindings.`,
          },
        ]
      : [],
  }
}

function unsupportedSnapshot(serverName: string, message: string): JndiSnapshot {
  return {
    status: 'unsupported',
    serverName,
    rows: [],
    tree: [],
    truncated: false,
    unsupportedReason: message,
    partialFailures: [],
  }
}

export function jndiSnapshotQueryKey(creds: WlsCredentials | null | undefined, serverName: string | null | undefined) {
  return ['jndiSnapshot', wlsCredentialCacheKey(creds), serverName ?? ''] as const
}

export const JNDI_UNSUPPORTED_ON_12C =
  'WebLogic REST exposes the JNDI tree from 14.1.x; this domain runs 12.2.1.4, which answers 404 for it. Configure the local WebLogic client (the same as for JMS message browsing: WLS_COCKPIT_WLS_CLIENT_CLASSPATH, WL_HOME or ORACLE_HOME) to read it over T3, or use the WebLogic Console or WLST.'

// The T3 helper connects, reads the domain runtime and walks the tree; allow it a little longer
// than the server-side helper limit.
export const JNDI_T3_TIMEOUT_MS = 50_000

async function fetchJndiOverT3(creds: WlsCredentials, serverName: string): Promise<JndiSnapshot> {
  const operation = `JNDI ${serverName} (T3)`
  try {
    const response = await withWlsRestTimeout(
      operation,
      (signal) =>
        fetch('/api/jndi/bindings', {
          method: 'POST',
          signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: wlsBasicAuthHeader(creds),
            ...actionAuditHeaders(creds),
          },
          body: JSON.stringify({ serverName }),
        }),
      JNDI_T3_TIMEOUT_MS,
    )
    const data = (await response.json().catch(() => null)) as { error?: { message?: string } | string } | null
    if (!response.ok) {
      const detail = typeof data?.error === 'string' ? data.error : data?.error?.message
      throw new WlsRestError({
        kind: 'http',
        operation,
        status: response.status,
        statusText: response.statusText,
        message: `${operation}: ${detail ?? `HTTP ${response.status}`}`,
      })
    }
    return normalizeJndiSnapshot(data, serverName)
  } catch (error) {
    throw normalizeWlsRestError(operation, error, JNDI_T3_TIMEOUT_MS)
  }
}

export async function fetchJndiSnapshot(
  creds: WlsCredentials,
  serverName: string,
  options: { t3HelperAvailable?: boolean } = {},
): Promise<JndiSnapshot> {
  // domainRuntime/JNDI does not exist on 12.2.1.4 (with or without the console REST extension
  // flags); the tree is read over T3 when the local WebLogic client is configured.
  if (creds.version === '12.2.1.4.0') {
    const t3HelperAvailable = options.t3HelperAvailable ?? readRuntimeConfig().jmsJmxAvailable
    return t3HelperAvailable ? fetchJndiOverT3(creds, serverName) : unsupportedSnapshot(serverName, JNDI_UNSUPPORTED_ON_12C)
  }
  const path = jndiEndpointPath(creds, serverName)
  try {
    const response = await withWlsRestTimeout(
      `JNDI ${serverName}`,
      (signal) =>
        fetch(`${WLS_REST_PROXY_BASE_URL}${path}`, {
          signal,
          headers: {
            Accept: 'application/json',
            Authorization: wlsBasicAuthHeader(creds),
            [WLS_TARGET_HEADER]: creds.targetUrl,
          },
        }),
      JNDI_REQUEST_TIMEOUT_MS,
    )

    if (response.status === 404) {
      return unsupportedSnapshot(serverName, 'Verified JNDI tree lookup is unavailable for this server or WebLogic version.')
    }
    if (!response.ok) {
      throw new WlsRestError({
        kind: 'http',
        operation: `JNDI ${serverName}`,
        status: response.status,
        statusText: response.statusText,
        message: `JNDI ${serverName}: HTTP ${response.status} ${response.statusText || 'HTTP error'}`,
      })
    }

    return normalizeJndiSnapshot(await response.json(), serverName)
  } catch (error) {
    throw normalizeWlsRestError(`JNDI ${serverName}`, error, JNDI_REQUEST_TIMEOUT_MS)
  }
}

export function useJndiSnapshot(serverName: string | null) {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval(60_000)
  // On 12.2.1.4 each read starts a JVM and walks the tree over T3 (several seconds): refresh on
  // demand only, neither polled nor refreshed when the tab becomes visible again.
  const onDemandOnly = creds?.version === '12.2.1.4.0'
  const query = useQuery({
    queryKey: jndiSnapshotQueryKey(creds, serverName),
    enabled: !!creds && !!serverName,
    staleTime: 30_000,
    refetchInterval: onDemandOnly ? false : livePollingInterval,
    queryFn: async () => {
      if (!creds || !serverName) throw new Error('not authenticated')
      return fetchJndiSnapshot(creds, serverName)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds && !!serverName && !onDemandOnly,
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}
