import { useQuery } from '@tanstack/react-query'
import { wlsBasicAuthHeader, wlsCredentialCacheKey, type WlsCredentials } from '../client.ts'
import { actionAuditHeaders } from '../action-audit-headers.ts'
import { useRefreshStaleQueryOnVisibleReturn, useVisiblePollingInterval } from '../query-polling.ts'
import { createWlsHttpError, withWlsRestTimeout } from '../wls-errors.ts'
import { useAuth } from '../../auth/useAuth.ts'
import type { WlsLifecycleState } from '../../components/status-model.ts'
import { fetchBaseServerRuntimes } from './server-runtimes.ts'

/*
 * User lockout lives in each server's security runtime:
 *   GET  /domainRuntime/serverRuntimes/{server}/serverSecurityRuntime/defaultRealmRuntime/userLockoutManagerRuntime
 *   POST .../userLockoutManagerRuntime/clearLockout {"userName": "..."}
 * WebLogic counts lockouts per server (a cluster shares login failures between its members), and
 * there is no operation that lists the locked user names: the operator types the user to clear.
 * clearLockout is overloaded (userName, and userName plus identityDomain); sending only userName
 * selects the one-argument form.
 */

export const USER_LOCKOUT_FIELDS =
  'lockedUsersCurrentCount,userLockoutTotalCount,invalidLoginAttemptsTotalCount,invalidLoginUsersHighCount,loginAttemptsWhileLockedTotalCount,unlockedUsersTotalCount'

const USER_LOCKOUT_TIMEOUT_MS = 10_000

export interface UserLockoutServerRow {
  serverName: string
  lifecycleState: WlsLifecycleState
  // false when the server has no runtime to ask (not running) or the read failed.
  available: boolean
  error: string | null
  lockedUsersCurrentCount: number | null
  userLockoutTotalCount: number | null
  invalidLoginAttemptsTotalCount: number | null
  invalidLoginUsersHighCount: number | null
  loginAttemptsWhileLockedTotalCount: number | null
  unlockedUsersTotalCount: number | null
}

export interface UserLockoutSnapshot {
  rows: UserLockoutServerRow[]
  lockedUsersCurrentCount: number
  fetchedAt: number
}

export interface ClearLockoutResult {
  serverName: string
  ok: boolean
  message: string | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function userLockoutPath(version: string, serverName: string) {
  return `/management/weblogic/${encodeURIComponent(version)}/domainRuntime/serverRuntimes/${encodeURIComponent(
    serverName,
  )}/serverSecurityRuntime/defaultRealmRuntime/userLockoutManagerRuntime`
}

export function userLockoutQueryKey(creds: WlsCredentials | null | undefined) {
  return ['userLockout', wlsCredentialCacheKey(creds)] as const
}

function hasSecurityRuntime(state: WlsLifecycleState) {
  return state === 'RUNNING' || state === 'ADMIN' || state === 'STANDBY'
}

export function normalizeUserLockoutRow(
  serverName: string,
  lifecycleState: WlsLifecycleState,
  data: unknown,
): UserLockoutServerRow {
  const value = isObject(data) ? data : {}
  return {
    serverName,
    lifecycleState,
    available: isObject(data),
    error: null,
    lockedUsersCurrentCount: readNumber(value.lockedUsersCurrentCount),
    userLockoutTotalCount: readNumber(value.userLockoutTotalCount),
    invalidLoginAttemptsTotalCount: readNumber(value.invalidLoginAttemptsTotalCount),
    invalidLoginUsersHighCount: readNumber(value.invalidLoginUsersHighCount),
    loginAttemptsWhileLockedTotalCount: readNumber(value.loginAttemptsWhileLockedTotalCount),
    unlockedUsersTotalCount: readNumber(value.unlockedUsersTotalCount),
  }
}

function unavailableRow(serverName: string, lifecycleState: WlsLifecycleState, error: string | null) {
  return { ...normalizeUserLockoutRow(serverName, lifecycleState, null), error }
}

function requestHeaders(creds: WlsCredentials) {
  return {
    Accept: 'application/json',
    Authorization: wlsBasicAuthHeader(creds),
  }
}

async function fetchServerUserLockout(
  creds: WlsCredentials,
  serverName: string,
  lifecycleState: WlsLifecycleState,
): Promise<UserLockoutServerRow> {
  if (!hasSecurityRuntime(lifecycleState)) return unavailableRow(serverName, lifecycleState, null)
  const operation = `User lockout on ${serverName}`
  try {
    const query = new URLSearchParams({ fields: USER_LOCKOUT_FIELDS, links: 'none' })
    const response = await withWlsRestTimeout(
      operation,
      (signal) =>
        fetch(`/api/wls${userLockoutPath(creds.version, serverName)}?${query}`, {
          signal,
          headers: requestHeaders(creds),
        }),
      USER_LOCKOUT_TIMEOUT_MS,
    )
    if (!response.ok) throw createWlsHttpError(operation, response)
    return normalizeUserLockoutRow(serverName, lifecycleState, await response.json())
  } catch (error) {
    return unavailableRow(serverName, lifecycleState, error instanceof Error ? error.message : `${operation} failed`)
  }
}

export function summarizeUserLockout(rows: UserLockoutServerRow[], fetchedAt = Date.now()): UserLockoutSnapshot {
  const sortedRows = [...rows].sort((a, b) => a.serverName.localeCompare(b.serverName, undefined, { numeric: true }))
  return {
    rows: sortedRows,
    // Highest per-server count, not a sum: cluster members share login failures, so one locked
    // user shows on each of them.
    lockedUsersCurrentCount: Math.max(0, ...sortedRows.map((row) => row.lockedUsersCurrentCount ?? 0)),
    fetchedAt,
  }
}

export async function fetchUserLockoutSnapshot(creds: WlsCredentials): Promise<UserLockoutSnapshot> {
  const servers = await fetchBaseServerRuntimes(creds)
  const rows = await Promise.all(servers.map((server) => fetchServerUserLockout(creds, server.name, server.state)))
  return summarizeUserLockout(rows)
}

export function normalizeLockoutUserName(value: string) {
  return value.trim()
}

// Clears the lockout of one user on every server that can answer, since each server keeps its
// own lockout record.
export async function clearUserLockout(
  creds: WlsCredentials,
  userName: string,
  serverNames: string[],
): Promise<ClearLockoutResult[]> {
  const name = normalizeLockoutUserName(userName)
  if (!name) throw new Error('Enter the user name to unlock.')

  return Promise.all(
    serverNames.map(async (serverName): Promise<ClearLockoutResult> => {
      const operation = `Clear lockout of ${name} on ${serverName}`
      try {
        const response = await withWlsRestTimeout(
          operation,
          (signal) =>
            fetch(`/api/wls${userLockoutPath(creds.version, serverName)}/clearLockout`, {
              method: 'POST',
              signal,
              headers: {
                ...requestHeaders(creds),
                'Content-Type': 'application/json',
                'X-Requested-By': 'wls-cockpit',
                ...actionAuditHeaders(creds),
              },
              body: JSON.stringify({ userName: name }),
            }),
          USER_LOCKOUT_TIMEOUT_MS,
        )
        if (!response.ok) throw createWlsHttpError(operation, response, await response.json().catch(() => undefined))
        return { serverName, ok: true, message: null }
      } catch (error) {
        return { serverName, ok: false, message: error instanceof Error ? error.message : `${operation} failed` }
      }
    }),
  )
}

export function useUserLockoutSnapshot() {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval(60_000)
  const query = useQuery({
    queryKey: userLockoutQueryKey(creds),
    enabled: !!creds,
    staleTime: 30_000,
    refetchInterval: livePollingInterval,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchUserLockoutSnapshot(creds)
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
