import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { NormalizedWlsTarget } from '../src/api/proxy-target.ts'
import {
  AUDIT_PROFILE_ID_HEADER,
  AUDIT_PROFILE_NAME_HEADER,
  AUDIT_USERNAME_HEADER,
  AUDIT_VERSION_HEADER,
} from '../src/api/action-audit-headers.ts'

export const ACTION_AUDIT_DEFAULT_MAX_RECORDS = 5_000
export const ACTION_AUDIT_DEFAULT_LIMIT = 500
export {
  AUDIT_PROFILE_ID_HEADER,
  AUDIT_PROFILE_NAME_HEADER,
  AUDIT_USERNAME_HEADER,
  AUDIT_VERSION_HEADER,
}

export type ActionAuditFamily = 'server' | 'cluster' | 'deployment' | 'datasource' | 'jms' | 'edit-session' | 'jta' | 'other'
export type ActionAuditStatus = 'success' | 'failure'

export interface ActionAuditResource {
  type: string
  name: string
  parent?: string
}

export interface ActionAuditAction {
  family: ActionAuditFamily
  action: string
  resource: ActionAuditResource
}

export interface ActionAuditRecord extends ActionAuditAction {
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
  status: ActionAuditStatus
  httpStatus: number | null
  errorSummary: string | null
}

export interface ActionAuditStoreOptions {
  path?: string
  dataDir?: string
  maxRecords?: number
  enabled?: boolean
}

export interface ActionAuditFilters {
  family?: ActionAuditFamily
  status?: ActionAuditStatus
  target?: string
  since?: number
  until?: number
  limit?: number
}

interface AuditDraft extends ActionAuditAction {
  startedAtMs: number
  method: string
  path: string
  target: string
  profileId: string | null
  profileName: string | null
  username: string | null
  version: string | null
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const SECRET_KEY_PATTERN = /(password|passwd|pwd|secret|credential|token|apikey|api_key|apiKey|authorization|body|properties)/i
const PATH_KEY_PATTERN = /(^path$|Path$|sourceFile|staging|absolute|directory|^dir$|fileName$)/i

function headerValue(req: IncomingMessage, name: string) {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function readRecordText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function sanitizeTarget(value: string) {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.pathname = ''
    url.search = ''
    url.hash = ''
    return url.host
  } catch {
    return sanitizeAuditText(value)
  }
}

export function sanitizeAuditText(value: string) {
  return value
    .replace(/\bBasic\s+[A-Za-z0-9+/=._-]+/gi, 'Basic [redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, '$1[credentials]@')
    .replace(/\b(password|passwd|pwd|secret|token|apikey|api_key)=([^&\s]+)/gi, '$1=[redacted]')
    .slice(0, 1_000)
}

export function sanitizeAuditValue(value: unknown, key = '', depth = 0): unknown {
  if (depth > 6) return '[redacted]'
  if (SECRET_KEY_PATTERN.test(key) || PATH_KEY_PATTERN.test(key)) return '[redacted]'
  if (typeof value === 'string') return sanitizeAuditText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeAuditValue(item, key, depth + 1))
  if (typeof value !== 'object') return null

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([entryKey, entryValue]) => [entryKey, sanitizeAuditValue(entryValue, entryKey, depth + 1)]),
  )
}

function auditId() {
  return `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function resolveActionAuditPath(options: ActionAuditStoreOptions = {}, env: NodeJS.ProcessEnv = process.env) {
  if (options.path) return options.path
  if (env.WLS_COCKPIT_AUDIT_PATH) return env.WLS_COCKPIT_AUDIT_PATH
  const dataDir = options.dataDir ?? env.WLS_COCKPIT_DATA_DIR ?? path.join(os.homedir(), '.wls-cockpit')
  return path.join(dataDir, 'action-audit.jsonl')
}

function maxRecords(options: ActionAuditStoreOptions) {
  const configured = options.maxRecords ?? Number(process.env.WLS_COCKPIT_AUDIT_MAX_RECORDS)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : ACTION_AUDIT_DEFAULT_MAX_RECORDS
}

function enabled(options: ActionAuditStoreOptions) {
  return options.enabled !== false
}

function normalizeLine(line: string): ActionAuditRecord | null {
  if (!line.trim()) return null
  try {
    const value = JSON.parse(line) as ActionAuditRecord
    if (!value.id || !value.startedAt || !value.family || !value.action || !value.resource) return null
    return value
  } catch {
    return null
  }
}

export async function readActionAuditRecords(
  options: ActionAuditStoreOptions = {},
  filters: ActionAuditFilters = {},
): Promise<ActionAuditRecord[]> {
  if (!enabled(options)) return []
  let text: string
  try {
    text = await readFile(resolveActionAuditPath(options), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const limit = Math.min(Math.max(filters.limit ?? ACTION_AUDIT_DEFAULT_LIMIT, 1), 5_000)
  return text
    .split('\n')
    .flatMap((line) => {
      const record = normalizeLine(line)
      return record ? [record] : []
    })
    .filter((record) => !filters.family || record.family === filters.family)
    .filter((record) => !filters.status || record.status === filters.status)
    .filter((record) => !filters.target || record.target === filters.target)
    .filter((record) => !filters.since || Date.parse(record.startedAt) >= filters.since)
    .filter((record) => !filters.until || Date.parse(record.startedAt) <= filters.until)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, limit)
}

async function compactAuditFile(auditPath: string, retainedRecords: number) {
  const text = await readFile(auditPath, 'utf8')
  const lines = text.split('\n').filter(Boolean)
  if (lines.length <= retainedRecords) return
  const tmpPath = `${auditPath}.${randomUUID()}.tmp`
  await writeFile(tmpPath, `${lines.slice(-retainedRecords).join('\n')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(tmpPath, auditPath)
}

// Append + compact is a read-modify-write of the whole file, so concurrent writes (one per server
// in a batch lifecycle action) are serialized per file; otherwise an append landing between the
// read and the rename is lost.
const auditWriteQueues = new Map<string, Promise<void>>()

function serializeAuditWrite(auditPath: string, task: () => Promise<void>) {
  const previous = auditWriteQueues.get(auditPath) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  const settled = next.catch(() => undefined)
  auditWriteQueues.set(auditPath, settled)
  void settled.then(() => {
    if (auditWriteQueues.get(auditPath) === settled) auditWriteQueues.delete(auditPath)
  })
  return next
}

export async function writeActionAuditRecord(record: ActionAuditRecord, options: ActionAuditStoreOptions = {}) {
  if (!enabled(options)) return
  const auditPath = resolveActionAuditPath(options)
  await serializeAuditWrite(auditPath, async () => {
    await mkdir(path.dirname(auditPath), { recursive: true })
    await appendFile(auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    await compactAuditFile(auditPath, maxRecords(options))
  })
}

export async function writeActionAuditRecordSafely(record: ActionAuditRecord, options: ActionAuditStoreOptions = {}) {
  try {
    await writeActionAuditRecord(record, options)
    return true
  } catch {
    return false
  }
}

function matchPath(pathname: string, pattern: RegExp) {
  const match = pattern.exec(pathname)
  if (!match?.groups) return null
  return Object.fromEntries(Object.entries(match.groups).map(([key, value]) => [key, safeDecode(value ?? '')]))
}

function resource(type: string, name: string, parent?: string): ActionAuditResource {
  return parent ? { type, name, parent } : { type, name }
}

function bodyName(body: unknown) {
  if (typeof body !== 'object' || body === null) return null
  return readRecordText((body as Record<string, unknown>).name)
}

function topologyAction(method: string, createAction = 'create', updateAction = 'configure', deleteAction = 'delete') {
  if (method === 'DELETE') return deleteAction
  if (method === 'POST') return createAction
  return updateAction
}

export function classifyActionAuditRequest(method: string, pathname: string, body?: unknown): ActionAuditAction | null {
  const normalizedMethod = method.toUpperCase()
  if (!MUTATING_METHODS.has(normalizedMethod)) return null
  const withoutProxy = pathname
    .replace(/^\/api\/wls(?=\/|$)/, '')
    .replace(/^\/management\/weblogic\/[^/]+(?=\/|$)/, '')
    // WebLogic accepts '.../shutdown/' as well; without this the action rules (anchored with $)
    // would let it through unrecorded.
    .replace(/\/+$/, '')

  let match = matchPath(withoutProxy, /\/domainRuntime\/serverLifeCycleRuntimes\/(?<name>[^/]+)\/(?<action>start|shutdown|forceShutdown|suspend|resume)$/)
  if (match) return { family: 'server', action: match.action, resource: resource('server', match.name) }

  match = matchPath(withoutProxy, /\/domainRuntime\/deploymentManager\/appDeploymentRuntimes\/(?<name>[^/]+)\/(?<action>start|stop|redeploy)$/)
  if (match) return { family: 'deployment', action: match.action, resource: resource('deployment', match.name) }

  if (/^\/domainRuntime\/deploymentManager\/deploy\/?$/.test(withoutProxy)) {
    return { family: 'deployment', action: 'deploy', resource: resource('deployment', bodyName(body) ?? 'new') }
  }

  match = matchPath(withoutProxy, /\/edit\/appDeployments\/(?<name>[^/]+)$/)
  if (match) {
    return {
      family: 'deployment',
      action: normalizedMethod === 'DELETE' ? 'undeploy' : 'configure',
      resource: resource('deployment', match.name),
    }
  }

  match = matchPath(
    withoutProxy,
    /\/domainRuntime\/serverRuntimes\/(?<server>[^/]+)\/JDBCServiceRuntime\/JDBCDataSourceRuntimeMBeans\/(?<name>[^/]+)\/(?<action>testPool|suspend|resume|shrink|reset|clearStatementCache)$/,
  )
  if (match) return { family: 'datasource', action: match.action, resource: resource('datasource', match.name, match.server) }

  match = matchPath(
    withoutProxy,
    /\/domainRuntime\/serverRuntimes\/(?<server>[^/]+)\/JMSRuntime\/JMSServers\/(?<jmsServer>[^/]+)\/destinations\/(?<name>[^/]+)\/(?<action>pauseConsumption|pauseInsertion|pauseProduction|resumeConsumption|resumeInsertion|resumeProduction)$/,
  )
  if (match) return { family: 'jms', action: match.action, resource: resource('destination', match.name, `${match.server}/${match.jmsServer}`) }

  match = matchPath(withoutProxy, /\/edit\/changeManager\/(?<action>startEdit|activate|cancelEdit)$/)
  if (match) return { family: 'edit-session', action: match.action, resource: resource('editSession', 'default') }

  if (/\/edit\/servers$/.test(withoutProxy) && normalizedMethod === 'POST') {
    return { family: 'server', action: 'create', resource: resource('server', bodyName(body) ?? 'new') }
  }

  match = matchPath(withoutProxy, /\/edit\/servers\/(?<server>[^/]+)$/)
  if (match) {
    return {
      family: 'server',
      action: topologyAction(normalizedMethod, 'configure'),
      resource: resource('server', match.server),
    }
  }

  match = matchPath(withoutProxy, /\/edit\/servers\/(?<server>[^/]+)\/networkAccessPoints$/)
  if (match && normalizedMethod === 'POST') {
    return {
      family: 'server',
      action: 'create-child',
      resource: resource('networkAccessPoint', bodyName(body) ?? 'new', match.server),
    }
  }

  match = matchPath(withoutProxy, /\/edit\/servers\/(?<server>[^/]+)\/networkAccessPoints\/(?<name>[^/]+)$/)
  if (match) {
    return {
      family: 'server',
      action: normalizedMethod === 'DELETE' ? 'delete-child' : 'configure-child',
      resource: resource('networkAccessPoint', match.name, match.server),
    }
  }

  match = matchPath(withoutProxy, /\/edit\/servers\/(?<server>[^/]+)\/(?<section>[^/]+)(?:\/(?<child>[^/]+))?$/)
  if (match) {
    return {
      family: 'server',
      action: normalizedMethod === 'DELETE' ? 'delete-child' : 'configure-child',
      resource: resource('serverSection', match.child || match.section, match.server),
    }
  }

  if (/\/edit\/clusters$/.test(withoutProxy) && normalizedMethod === 'POST') {
    return { family: 'cluster', action: 'create', resource: resource('cluster', bodyName(body) ?? 'new') }
  }

  match = matchPath(withoutProxy, /\/edit\/clusters\/(?<cluster>[^/]+)$/)
  if (match) {
    return {
      family: 'cluster',
      action: topologyAction(normalizedMethod, 'configure'),
      resource: resource('cluster', match.cluster),
    }
  }

  match = matchPath(withoutProxy, /\/edit\/clusters\/(?<cluster>[^/]+)\/(?<section>[^/]+)(?:\/(?<child>[^/]+))?$/)
  if (match) {
    return {
      family: 'cluster',
      action: normalizedMethod === 'DELETE' ? 'delete-child' : 'configure-child',
      resource: resource('clusterSection', match.child || match.section, match.cluster),
    }
  }

  match = matchPath(withoutProxy, /\/edit\/JDBCSystemResources(?:\/(?<name>[^/]+).*)?$/)
  if (match) {
    const action = normalizedMethod === 'DELETE' ? 'delete' : 'configure'
    return { family: 'datasource', action, resource: resource('datasource', match.name || 'new') }
  }

  match = matchPath(withoutProxy, /\/domainRuntime\/serverRuntimes\/(?<server>[^/]+)\/JTARuntime\/(?<action>forceCommit|forceRollback)$/)
  if (match) return { family: 'jta', action: match.action, resource: resource('server', match.server) }

  if (pathname === '/api/jms/messages/delete' || pathname === '/api/jms/messages/produce') {
    const payload = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    const action = pathname.endsWith('/delete') ? 'delete' : 'produce'
    const destination = readRecordText(payload.destinationName) ?? 'destination'
    const server = readRecordText(payload.serverName)
    const jmsServer = readRecordText(payload.jmsServerName)
    return {
      family: 'jms',
      action,
      resource: resource('destination', destination, [server, jmsServer].filter(Boolean).join('/') || undefined),
    }
  }

  // Any other write to the configuration tree is still recorded. Runtime POSTs are not, because
  // WebLogic also uses POST for read operations such as log searches.
  match = matchPath(withoutProxy, /^\/edit\/(?<path>.+?)\/?$/)
  if (match) {
    const action = normalizedMethod === 'DELETE' ? 'delete' : normalizedMethod === 'POST' ? 'configure' : normalizedMethod.toLowerCase()
    return { family: 'other', action, resource: resource('editPath', match.path) }
  }

  return null
}

export function createAuditDraft({
  req,
  method,
  pathname,
  target,
  action,
}: {
  req: IncomingMessage
  method: string
  pathname: string
  target: Extract<NormalizedWlsTarget, { ok: true }>
  action: ActionAuditAction
}): AuditDraft {
  return {
    ...action,
    startedAtMs: Date.now(),
    method,
    path: pathname,
    target: sanitizeTarget(target.targetUrl),
    profileId: headerValue(req, AUDIT_PROFILE_ID_HEADER),
    profileName: headerValue(req, AUDIT_PROFILE_NAME_HEADER),
    username: headerValue(req, AUDIT_USERNAME_HEADER),
    version: headerValue(req, AUDIT_VERSION_HEADER),
  }
}

function errorSummaryFromPayload(payload: unknown, depth = 0): string | null {
  if (depth > 4) return null
  const direct = readRecordText(payload)
  if (direct) return sanitizeAuditText(direct)
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  for (const key of ['message', 'localizedMessage', 'detail', 'details', 'reason', 'exception', 'cause', 'error']) {
    const found = errorSummaryFromPayload(record[key], depth + 1)
    if (found) return found
  }
  return null
}

export function errorSummaryFromBody(body: Buffer | Uint8Array | string | null, fallback: string | null = null) {
  if (!body) return fallback ? sanitizeAuditText(fallback) : null
  const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8')
  if (!text.trim()) return fallback ? sanitizeAuditText(fallback) : null
  try {
    return errorSummaryFromPayload(JSON.parse(text)) ?? (fallback ? sanitizeAuditText(fallback) : null)
  } catch {
    return sanitizeAuditText(text)
  }
}

export function settleAuditDraft(
  draft: AuditDraft,
  status: ActionAuditStatus,
  httpStatus: number | null,
  errorSummary: string | null = null,
): ActionAuditRecord {
  const settledAtMs = Date.now()
  return {
    id: auditId(),
    startedAt: new Date(draft.startedAtMs).toISOString(),
    settledAt: new Date(settledAtMs).toISOString(),
    durationMs: Math.max(0, settledAtMs - draft.startedAtMs),
    method: draft.method,
    path: draft.path,
    target: draft.target,
    profileId: draft.profileId,
    profileName: draft.profileName,
    username: draft.username,
    version: draft.version,
    family: draft.family,
    action: draft.action,
    resource: draft.resource,
    status,
    httpStatus,
    errorSummary,
  }
}

export function parseActionAuditFilters(searchParams: URLSearchParams): ActionAuditFilters {
  const family = searchParams.get('family') as ActionAuditFamily | null
  const status = searchParams.get('status') as ActionAuditStatus | null
  const target = searchParams.get('target') ?? undefined
  const since = Number(searchParams.get('since'))
  const until = Number(searchParams.get('until'))
  const limit = Number(searchParams.get('limit'))
  return {
    family: family && ['server', 'cluster', 'deployment', 'datasource', 'jms', 'edit-session', 'jta', 'other'].includes(family) ? family : undefined,
    status: status && ['success', 'failure'].includes(status) ? status : undefined,
    target,
    since: Number.isFinite(since) && since > 0 ? since : undefined,
    until: Number.isFinite(until) && until > 0 ? until : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  }
}
