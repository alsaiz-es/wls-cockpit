import { useQuery, type QueryClient } from '@tanstack/react-query'
import { WLS_REST_PROXY_BASE_URL, wlsBasicAuthHeader, wlsCredentialCacheKey, type WlsCredentials } from '../client.ts'
import { actionAuditHeaders } from '../action-audit-headers.ts'
import { createWlsHttpError, withWlsRestTimeout } from '../wls-errors.ts'
import { useAuth } from '../../auth/useAuth.ts'
import { runTopologyEditTransaction, topologyManagementPath, type TopologyMutationResult } from './topology-configuration.ts'

/*
 * Debug flags are attributes of ServerDebugMBean (/edit/servers/{server}/serverDebug), and most of
 * them take effect on the running server as soon as the change is activated. Their output goes to
 * the server log at Debug severity, so it only shows when the server's "minimum severity to log"
 * (log.loggerSeverity) is Debug or Trace.
 */

export interface ServerDebugFlag {
  attribute: string
  label: string
}

export interface ServerDebugGroup {
  id: string
  label: string
  flags: ServerDebugFlag[]
}

// Flags commonly used when troubleshooting a running domain; all exist in 12.2.1.4 and 14.1.2.
export const SERVER_DEBUG_GROUPS: ServerDebugGroup[] = [
  {
    id: 'security',
    label: 'Security',
    flags: [
      { attribute: 'debugSecurityAtn', label: 'Authentication' },
      { attribute: 'debugSecurityAtz', label: 'Authorization' },
      { attribute: 'debugSecurityUserLockout', label: 'User lockout' },
      { attribute: 'debugSecuritySSL', label: 'SSL' },
      { attribute: 'debugSecurityCertPath', label: 'Certificate path' },
      { attribute: 'debugSecuritySAML2Service', label: 'SAML 2.0 service' },
    ],
  },
  {
    id: 'jdbc',
    label: 'JDBC',
    flags: [
      { attribute: 'debugJDBCSQL', label: 'SQL' },
      { attribute: 'debugJDBCConn', label: 'Connections' },
      { attribute: 'debugJDBCInternal', label: 'Internal' },
      { attribute: 'debugJDBCRAC', label: 'RAC' },
    ],
  },
  {
    id: 'jms',
    label: 'JMS and SAF',
    flags: [
      { attribute: 'debugJMSBackEnd', label: 'JMS back end' },
      { attribute: 'debugJMSFrontEnd', label: 'JMS front end' },
      { attribute: 'debugJMSMessagePath', label: 'JMS message path' },
      { attribute: 'debugSAFSendingAgent', label: 'SAF sending agent' },
      { attribute: 'debugSAFReceivingAgent', label: 'SAF receiving agent' },
      { attribute: 'debugStoreAdmin', label: 'Persistent store' },
    ],
  },
  {
    id: 'jta',
    label: 'JTA',
    flags: [
      { attribute: 'debugJTAXA', label: 'XA' },
      { attribute: 'debugJTA2PC', label: 'Two-phase commit' },
      { attribute: 'debugJTARecovery', label: 'Recovery' },
      { attribute: 'debugJTAJDBC', label: 'JDBC' },
    ],
  },
  {
    id: 'web',
    label: 'Deployment and web',
    flags: [
      { attribute: 'debugDeploymentConcise', label: 'Deployment (concise)' },
      { attribute: 'debugHttp', label: 'HTTP' },
      { attribute: 'debugHttpSessions', label: 'HTTP sessions' },
      { attribute: 'debugClassLoadingVerbose', label: 'Class loading' },
      { attribute: 'debugJNDI', label: 'JNDI' },
    ],
  },
]

const KNOWN_FLAG_LABELS = new Map(SERVER_DEBUG_GROUPS.flatMap((group) => group.flags.map((flag) => [flag.attribute, flag.label])))
const SERVER_DEBUG_TIMEOUT_MS = 15_000

export interface ServerDebugSnapshot {
  serverName: string
  // Every boolean debug attribute the server reports, by attribute name.
  flags: Record<string, boolean>
  enabled: string[]
  loggerSeverity: string | null
  debugReachesLog: boolean | null
}

export function serverDebugQueryKey(creds: WlsCredentials | null | undefined, serverName: string) {
  return ['serverDebug', wlsCredentialCacheKey(creds), serverName] as const
}

export function serverDebugPath(version: WlsCredentials['version'], serverName: string, child: 'serverDebug' | 'log') {
  return topologyManagementPath(version, `/edit/servers/${encodeURIComponent(serverName)}/${child}`)
}

export function serverDebugFlagLabel(attribute: string) {
  return KNOWN_FLAG_LABELS.get(attribute) ?? attribute.replace(/^debug/, '')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function normalizeServerDebug(serverName: string, debug: unknown, log: unknown): ServerDebugSnapshot {
  const flags: Record<string, boolean> = {}
  if (isObject(debug)) {
    for (const [key, value] of Object.entries(debug)) {
      if (/^debug[A-Z0-9]/.test(key) && typeof value === 'boolean') flags[key] = value
    }
  }
  const loggerSeverity = isObject(log) && typeof log.loggerSeverity === 'string' ? log.loggerSeverity : null
  return {
    serverName,
    flags,
    enabled: Object.keys(flags).filter((key) => flags[key]).sort(),
    loggerSeverity,
    debugReachesLog: loggerSeverity === null ? null : ['debug', 'trace'].includes(loggerSeverity.toLowerCase()),
  }
}

async function readJson(creds: WlsCredentials, operation: string, path: string) {
  const response = await withWlsRestTimeout(
    operation,
    (signal) =>
      fetch(`${WLS_REST_PROXY_BASE_URL}${path}?links=none`, {
        signal,
        headers: { Accept: 'application/json', Authorization: wlsBasicAuthHeader(creds), ...actionAuditHeaders(creds) },
      }),
    SERVER_DEBUG_TIMEOUT_MS,
  )
  if (!response.ok) throw createWlsHttpError(operation, response, await response.json().catch(() => undefined))
  return response.json() as Promise<unknown>
}

export async function fetchServerDebug(creds: WlsCredentials, serverName: string): Promise<ServerDebugSnapshot> {
  const [debug, log] = await Promise.all([
    readJson(creds, `Debug flags of ${serverName}`, serverDebugPath(creds.version, serverName, 'serverDebug')),
    readJson(creds, `Log settings of ${serverName}`, serverDebugPath(creds.version, serverName, 'log')).catch(() => null),
  ])
  return normalizeServerDebug(serverName, debug, log)
}

// Only attributes the server reported are sent, so a typo cannot create an unknown attribute.
export function serverDebugPatch(snapshot: ServerDebugSnapshot, changes: Record<string, boolean>) {
  return Object.fromEntries(
    Object.entries(changes).filter(([attribute, value]) => attribute in snapshot.flags && snapshot.flags[attribute] !== value),
  )
}

export async function updateServerDebugFlags(
  creds: WlsCredentials,
  snapshot: ServerDebugSnapshot,
  changes: Record<string, boolean>,
): Promise<TopologyMutationResult> {
  const patch = serverDebugPatch(snapshot, changes)
  const names = Object.keys(patch)
  if (names.length === 0) throw new Error('No debug flag changes to apply.')
  const summary = names.map((name) => `${serverDebugFlagLabel(name)} ${patch[name] ? 'on' : 'off'}`).join(', ')
  return runTopologyEditTransaction(creds, `Debug ${snapshot.serverName}: ${summary}`, [
    {
      operation: `Set debug flags of ${snapshot.serverName}`,
      method: 'POST',
      path: serverDebugPath(creds.version, snapshot.serverName, 'serverDebug'),
      body: patch,
    },
  ])
}

export function invalidateServerDebug(queryClient: QueryClient, creds: WlsCredentials | null | undefined, serverName: string) {
  return queryClient.invalidateQueries({ queryKey: serverDebugQueryKey(creds, serverName) })
}

export function useServerDebug(serverName: string, enabled = true) {
  const { creds } = useAuth()
  return useQuery({
    queryKey: serverDebugQueryKey(creds, serverName),
    enabled: enabled && !!creds && !!serverName,
    staleTime: 15_000,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchServerDebug(creds, serverName)
    },
  })
}
