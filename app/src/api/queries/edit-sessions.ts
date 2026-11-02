import { useQuery, type QueryClient } from '@tanstack/react-query'
import { createClient12, createClient14, wlsCredentialCacheKey, type WlsCredentials } from '../client.ts'
import { useRefreshStaleQueryOnVisibleReturn, useVisiblePollingInterval } from '../query-polling.ts'
import { createWlsHttpError, withWlsRestTimeout } from '../wls-errors.ts'
import { useAuth } from '../../auth/useAuth.ts'

export const EDIT_SESSION_STATUS_POLL_INTERVAL_MS = 60_000
export const EDIT_SESSION_STATUS_FIELDS = 'locked,lockOwner,hasChanges,mergeNeeded,editSession'
const EDIT_SESSION_ACTION_TIMEOUT_MS = 60_000

export type EditSessionState = 'idle' | 'locked' | 'pending' | 'conflict' | 'unknown'
export type EditSessionOwnership = 'none' | 'current-user' | 'other-user' | 'unknown'
export type EditSessionAction = 'activate' | 'cancel'

export interface EditSessionStatus {
  state: EditSessionState
  locked: boolean | null
  lockOwner: string | null
  editSession: string | null
  hasPendingChanges: boolean | null
  pendingChangeCount: number | null
  mergeNeeded: boolean | null
  ownership: EditSessionOwnership
  ownerEvidence: string | null
  canActivate: boolean
  canCancel: boolean
  visible: boolean
  unavailableFields: string[]
  fetchedAt: number
}

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeOwner(value: string | null) {
  if (!value) return null
  const user = value.includes('/') ? value.split('/').at(-1) : value
  return user?.trim() || value
}

function readPendingChangeCount(record: Record<string, unknown>) {
  return (
    readNumber(record.pendingChangeCount) ??
    readNumber(record.pendingChangesCount) ??
    readNumber(record.unactivatedChangeCount) ??
    readNumber(record.changeCount)
  )
}

export function normalizeEditSessionStatus(
  data: unknown,
  options: { username?: string | null; fetchedAt?: number } = {},
): EditSessionStatus {
  const record = isObject(data) ? data : {}
  const locked = readBoolean(record.locked)
  const lockOwner = readString(record.lockOwner)
  const editSession = readString(record.editSession)
  const hasPendingChanges = readBoolean(record.hasChanges)
  const mergeNeeded = readBoolean(record.mergeNeeded)
  const pendingChangeCount = readPendingChangeCount(record)
  const normalizedOwner = normalizeOwner(lockOwner)
  const normalizedUsername = normalizeOwner(readString(options.username))

  const unavailableFields = [
    locked === null ? 'locked' : null,
    lockOwner === null && locked === true ? 'lockOwner' : null,
    hasPendingChanges === null ? 'hasChanges' : null,
    mergeNeeded === null ? 'mergeNeeded' : null,
  ].filter((field): field is string => field !== null)

  const ownership: EditSessionOwnership =
    locked === false
      ? 'none'
      : normalizedOwner && normalizedUsername
        ? normalizedOwner === normalizedUsername
          ? 'current-user'
          : 'other-user'
        : locked === true
          ? 'unknown'
          : 'none'

  const state: EditSessionState =
    mergeNeeded === true
      ? 'conflict'
      : hasPendingChanges === true || (pendingChangeCount ?? 0) > 0
        ? 'pending'
        : locked === true
          ? 'locked'
          : locked === false
            ? 'idle'
            : 'unknown'

  const canAct = ownership === 'current-user' && mergeNeeded !== true
  const canActivate = canAct && (hasPendingChanges === true || (pendingChangeCount ?? 0) > 0)
  const canCancel = canAct && locked === true

  return {
    state,
    locked,
    lockOwner,
    editSession,
    hasPendingChanges,
    pendingChangeCount,
    mergeNeeded,
    ownership,
    ownerEvidence: lockOwner ?? (locked === true ? 'Lock owner unavailable' : null),
    canActivate,
    canCancel,
    visible: state !== 'idle',
    unavailableFields,
    fetchedAt: options.fetchedAt ?? Date.now(),
  }
}

export function editSessionStatusQueryKey(creds: WlsCredentials | null | undefined) {
  return ['editSessionStatus', wlsCredentialCacheKey(creds)] as const
}

export function editSessionActionRequestOptions(creds: WlsCredentials) {
  return {
    params: {
      path: { version: creds.version },
      header: { 'X-Requested-By': 'wls-cockpit' },
    },
    body: {},
  } as const
}

export async function fetchEditSessionStatus(creds: WlsCredentials): Promise<EditSessionStatus> {
  const res = await withWlsRestTimeout('Edit-session status', (signal) =>
    clientFor(creds).GET('/management/weblogic/{version}/edit/changeManager', {
      signal,
      params: {
        path: { version: creds.version },
        query: { fields: EDIT_SESSION_STATUS_FIELDS, links: 'none' },
      } as never,
    }),
  )
  if (res.error) throw createWlsHttpError('Edit-session status', res.response, res.error)
  return normalizeEditSessionStatus(res.data, { username: creds.username })
}

export async function runEditSessionAction(creds: WlsCredentials, action: EditSessionAction): Promise<void> {
  const operation = action === 'activate' ? 'Activate edit session' : 'Cancel edit session'
  const path =
    action === 'activate'
      ? '/management/weblogic/{version}/edit/changeManager/activate'
      : '/management/weblogic/{version}/edit/changeManager/cancelEdit'
  const res = await withWlsRestTimeout(
    operation,
    (signal) =>
      clientFor(creds).POST(path, {
        signal,
        ...editSessionActionRequestOptions(creds),
      } as never),
    EDIT_SESSION_ACTION_TIMEOUT_MS,
  )
  if (res.error) throw createWlsHttpError(operation, res.response, res.error)
}

export function invalidateEditSessionStatus(queryClient: QueryClient, creds: WlsCredentials | null | undefined) {
  return queryClient.invalidateQueries({ queryKey: editSessionStatusQueryKey(creds) })
}

export async function invalidateEditSessionAffectedQueries(
  queryClient: QueryClient,
  creds: WlsCredentials | null | undefined,
) {
  const cacheKey = wlsCredentialCacheKey(creds)
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: editSessionStatusQueryKey(creds) }),
    queryClient.invalidateQueries({ queryKey: ['dataSources', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['dataSourceConfigs', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['deployments', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['deploymentConfigs', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['deploymentLifecycleNames', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['deploymentDataSourceNames', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['deploymentJmsModules', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['deploymentTargets', cacheKey] }),
    // An activation can leave servers waiting for a restart (ServerRuntime.restartRequired).
    queryClient.invalidateQueries({ queryKey: ['serverRuntimes', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['serverRuntimeDetail', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['domainDashboard', cacheKey] }),
  ])
}

export function useEditSessionStatus() {
  const { creds } = useAuth()
  const pollingInterval = useVisiblePollingInterval(EDIT_SESSION_STATUS_POLL_INTERVAL_MS)
  const query = useQuery({
    queryKey: editSessionStatusQueryKey(creds),
    enabled: !!creds,
    staleTime: 30_000,
    refetchInterval: pollingInterval,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchEditSessionStatus(creds)
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
