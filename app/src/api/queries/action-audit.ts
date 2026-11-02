import { useQuery } from '@tanstack/react-query'
import { readRuntimeConfig } from '../runtime-config.ts'

export type ActionAuditFamily = 'server' | 'cluster' | 'deployment' | 'datasource' | 'jms' | 'edit-session' | 'jta' | 'other'
export type ActionAuditStatus = 'success' | 'failure'

export interface ActionAuditRecord {
  id: string
  startedAt: string
  settledAt: string
  durationMs: number
  method: string
  path: string
  target: string
  profileId: string | null
  profileName: string | null
  username: string | null
  version: string | null
  family: ActionAuditFamily
  action: string
  resource: {
    type: string
    name: string
    parent?: string
  }
  status: ActionAuditStatus
  httpStatus: number | null
  errorSummary: string | null
}

export interface ActionAuditFilters {
  family?: ActionAuditFamily | 'all'
  status?: ActionAuditStatus | 'all'
  target?: string
  since?: number
  limit?: number
}

export const actionAuditFamilies: Array<ActionAuditFamily | 'all'> = [
  'all',
  'server',
  'cluster',
  'deployment',
  'datasource',
  'jms',
  'edit-session',
  'jta',
  'other',
]

export const actionAuditStatuses: Array<ActionAuditStatus | 'all'> = ['all', 'success', 'failure']

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readFamily(value: unknown): ActionAuditFamily | null {
  return actionAuditFamilies.includes(value as ActionAuditFamily) && value !== 'all'
    ? (value as ActionAuditFamily)
    : null
}

function readStatus(value: unknown): ActionAuditStatus | null {
  return value === 'success' || value === 'failure' ? value : null
}

export function normalizeActionAuditRecord(value: unknown): ActionAuditRecord | null {
  if (!isObject(value)) return null
  const id = readString(value.id)
  const startedAt = readString(value.startedAt)
  const settledAt = readString(value.settledAt)
  const family = readFamily(value.family)
  const action = readString(value.action)
  const status = readStatus(value.status)
  const resource = isObject(value.resource) ? value.resource : null
  const resourceName = readString(resource?.name)
  const resourceType = readString(resource?.type)
  if (!id || !startedAt || !settledAt || !family || !action || !status || !resourceName || !resourceType) return null

  return {
    id,
    startedAt,
    settledAt,
    durationMs: readNumber(value.durationMs) ?? 0,
    method: readString(value.method) ?? 'POST',
    path: readString(value.path) ?? '',
    target: readString(value.target) ?? 'unknown',
    profileId: readString(value.profileId),
    profileName: readString(value.profileName),
    username: readString(value.username),
    version: readString(value.version),
    family,
    action,
    resource: {
      type: resourceType,
      name: resourceName,
      parent: readString(resource?.parent) ?? undefined,
    },
    status,
    httpStatus: readNumber(value.httpStatus),
    errorSummary: readString(value.errorSummary),
  }
}

export function normalizeActionAuditRecords(value: unknown): ActionAuditRecord[] {
  const rows = isObject(value) && Array.isArray(value.records) ? value.records : []
  return rows.flatMap((row) => {
    const record = normalizeActionAuditRecord(row)
    return record ? [record] : []
  })
}

export function actionAuditQueryParams(filters: ActionAuditFilters = {}) {
  const params = new URLSearchParams()
  if (filters.family && filters.family !== 'all') params.set('family', filters.family)
  if (filters.status && filters.status !== 'all') params.set('status', filters.status)
  if (filters.target?.trim()) params.set('target', filters.target.trim())
  if (filters.since) params.set('since', String(filters.since))
  if (filters.limit) params.set('limit', String(filters.limit))
  return params
}

export async function fetchActionAuditRecords(filters: ActionAuditFilters = {}) {
  const params = actionAuditQueryParams(filters)
  const suffix = params.size ? `?${params.toString()}` : ''
  const response = await fetch(`/api/audit/records${suffix}`, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Audit records: HTTP ${response.status}`)
  return normalizeActionAuditRecords(await response.json())
}

export function actionAuditQueryKey(filters: ActionAuditFilters = {}) {
  return ['actionAudit', filters.family ?? 'all', filters.status ?? 'all', filters.target ?? '', filters.since ?? 0, filters.limit ?? 0] as const
}

export function useActionAuditRecords(filters: ActionAuditFilters = {}) {
  const runtimeConfig = readRuntimeConfig()
  return useQuery({
    queryKey: actionAuditQueryKey(filters),
    enabled: runtimeConfig.actionAuditAvailable,
    staleTime: 5_000,
    queryFn: () => fetchActionAuditRecords(filters),
  })
}

export function actionAuditJsonl(records: ActionAuditRecord[]) {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '')
}
