import type { WlsVersion } from '../wls-version'

export interface LogArchiveRuntime {
  name: string
  kind: LogArchiveKind
  label: string
  description: string
  latestRecordId: number | null
  earliestAvailableTimestamp: number | null
  latestAvailableTimestamp: number | null
  timestampAvailable: boolean | null
}

export type LogArchiveKind =
  | 'server'
  | 'domain'
  | 'httpAccess'
  | 'jmsMessage'
  | 'diagnosticEvent'
  | 'harvested'
  | 'dataSource'
  | 'custom'
  | 'archive'

export type LogSignalSeverity = 'healthy' | 'warning' | 'critical' | 'unknown'

export interface LogRuntimeSignalRow {
  id: string
  serverName: string
  state: string
  messagesLogged: number | null
  logFileStreamOpened: boolean | null
  broadcasterAvailable: boolean
  serverLogAvailable: boolean
  archives: LogArchiveRuntime[]
  serverLogLatestTimestamp: number | null
  severity: LogSignalSeverity
}

export interface LogDataAccessRuntimeDetail extends LogArchiveRuntime {
  type: string | null
  columnCount: number | null
  columnIndexCount: number | null
  columnInfoCount: number | null
  columnTypeCount: number | null
  dataArchiveParameterCount: number | null
}

export interface LogArchiveRuntimeCounters {
  name: string
  type: string | null
  recordRetrievalTime: number | null
  recordSeekCount: number | null
  recordSeekTime: number | null
  retrievedRecordCount: number | null
  dataRetirementCycles: number | null
  dataRetirementTotalTime: number | null
  lastDataRetirementStartTime: number | null
  lastDataRetirementTime: number | null
  retiredRecordCount: number | null
  deletionCount: number | null
  deletionTime: number | null
  insertionCount: number | null
  insertionTime: number | null
  indexPageCount: number | null
  recordCount: number | null
  incrementalIndexCycleCount: number | null
  incrementalIndexTime: number | null
  indexCycleCount: number | null
  indexTime: number | null
  rotatedFilesCount: number | null
}

export interface LogRecordSearchWindow {
  since: string | null
  until: string | null
  limit: number
}

export interface LogRecordSearchPayload {
  since?: string
  until?: string
  limit: number
}

export interface LogRecordTailCursor {
  latestRecordId: number | null
  latestTimestamp: number | null
}

export interface LogRecordPreviewRow {
  recordId: number | null
  timestamp: number | null
  date: string | null
  severity: string | null
  severityValue: number | null
  subsystem: string | null
  machine: string | null
  server: string | null
  thread: string | null
  userId: string | null
  txId: string | null
  contextId: string | null
  messageId: string | null
  message: string | null
  supplementalAttributes: string | null
  rid: string | null
  httpAccess?: HttpAccessLogFields | null
}

export interface HttpAccessLogFields {
  raw: string
  client: string | null
  ident: string | null
  user: string | null
  timestamp: string | null
  date: string | null
  time: string | null
  request: string | null
  method: string | null
  path: string | null
  protocol: string | null
  status: number | null
  bytes: number | null
  host: string | null
  referer: string | null
  userAgent: string | null
  durationMs: number | null
  durationSeconds: number | null
  ecid: string | null
  rid: string | null
}

export interface LogRecordPreviewSnapshot {
  status: 'available' | 'empty'
  archiveName: string
  records: LogRecordPreviewRow[]
  nextRecordId: number | null
  window: LogRecordSearchWindow
  skippedAhead?: boolean
}

export interface MultiLogTailSource {
  id: string
  serverName: string
  archive: LogArchiveRuntime
}

export interface MultiLogTailRecord extends LogRecordPreviewRow {
  sourceId: string
  sourceServerName: string
  sourceArchiveName: string
  sourceArchiveKind: LogArchiveKind
  sourceArchiveLabel: string
}

export interface MultiLogTailSourceFailure {
  sourceId: string
  serverName: string
  archiveName: string
  message: string
  retryable: boolean
}

export interface MultiLogTailSourceOutcome {
  source: MultiLogTailSource
  outcome: PromiseSettledResult<LogRecordPreviewSnapshot>
}

export interface MultiLogTailSnapshot {
  records: MultiLogTailRecord[]
  partialFailures: MultiLogTailSourceFailure[]
}

export interface LogDetailMetadataSnapshot {
  status: 'available' | 'empty' | 'partial'
  dataAccessRuntimes: LogDataAccessRuntimeDetail[]
  archiveRuntimes: LogArchiveRuntimeCounters[]
  partialFailures: Array<{ serverName: string; signal: string; message: string }>
}

export interface SelectedLogRuntimeSnapshot {
  status: 'available' | 'empty' | 'partial'
  row: LogRuntimeSignalRow | null
  partialFailures: Array<{ serverName: string; signal: string; message: string }>
}

export function logServerRuntimeQueryParams() {
  return { fields: 'name,state', links: 'none' } as const
}

export function logBroadcasterQueryParams() {
  return { fields: 'messagesLogged', links: 'none' } as const
}

export function serverLogRuntimeQueryParams() {
  return { fields: 'logFileStreamOpened', links: 'none' } as const
}

export function logDataAccessSummaryQueryParams() {
  return {
    fields: 'name,latestRecordId,earliestAvailableTimestamp,latestAvailableTimestamp,timestampAvailable',
    links: 'none',
  } as const
}

export function logDataAccessDetailQueryParams() {
  return {
    fields:
      'name,type,columnIndexMap,columnInfoMap,columnTypeMap,columns,earliestAvailableTimestamp,latestAvailableTimestamp,latestRecordId,timestampAvailable,dataArchiveParameters',
    links: 'none',
  } as const
}

export function logArchiveRuntimeQueryParams() {
  return {
    fields:
      'name,type,recordRetrievalTime,recordSeekCount,recordSeekTime,retrievedRecordCount,dataRetirementCycles,dataRetirementTotalTime,lastDataRetirementStartTime,lastDataRetirementTime,retiredRecordCount,deletionCount,deletionTime,insertionCount,insertionTime,indexPageCount,recordCount,incrementalIndexCycleCount,incrementalIndexTime,indexCycleCount,indexTime,rotatedFilesCount',
    links: 'none',
  } as const
}

export const LOG_RECORD_PREVIEW_ARCHIVE_NAME = 'ServerLog'
export const LOG_RECORD_PREVIEW_LIMIT = 25
export const LOG_RECORD_PREVIEW_LOOKBACK_MS = 15 * 60 * 1000
export const LOG_RECORD_PREVIEW_FORWARD_MS = 1_000
export const LOG_RECORD_TAIL_LIMIT = 50
export const LOG_RECORD_TAIL_BUFFER_LIMIT = 500
export const LOG_RECORD_TAIL_OVERLAP_MS = 2_000
export const LOG_TAIL_ARCHIVE_SEARCH_PARAM = 'archive'
export const MULTI_LOG_TAIL_MAX_SOURCES = 6
export const MULTI_LOG_TAIL_SOURCE_BUFFER_LIMIT = 150
export const MULTI_LOG_TAIL_BUFFER_LIMIT = 600

export function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readNumberLike(value: unknown): number | null {
  const numberValue = readNumber(value)
  if (numberValue !== null) return numberValue
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readTimestamp(value: unknown): number | null {
  const numberValue = readNumberLike(value)
  return numberValue !== null && numberValue >= 0 ? numberValue : null
}

function readAccessLogToken(value: string | undefined): string | null {
  if (!value || value === '-') return null
  return value
}

function tokenizeAccessLogLine(line: string): string[] {
  const tokens: string[] = []
  let index = 0

  while (index < line.length) {
    while (index < line.length && /\s/.test(line[index])) index += 1
    if (index >= line.length) break

    const startChar = line[index]
    if (startChar === '"') {
      index += 1
      let token = ''
      while (index < line.length) {
        const char = line[index]
        if (char === '\\' && index + 1 < line.length) {
          token += line[index + 1]
          index += 2
          continue
        }
        if (char === '"') {
          index += 1
          break
        }
        token += char
        index += 1
      }
      tokens.push(token)
      continue
    }

    if (startChar === '[') {
      index += 1
      let token = ''
      while (index < line.length) {
        const char = line[index]
        if (char === ']') {
          index += 1
          break
        }
        token += char
        index += 1
      }
      tokens.push(token)
      continue
    }

    const start = index
    while (index < line.length && !/\s/.test(line[index])) index += 1
    tokens.push(line.slice(start, index))
  }

  return tokens
}

const HTTP_ACCESS_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'TRACE', 'CONNECT'])

function parseHttpRequestToken(value: string | undefined) {
  const parts = value?.trim().split(/\s+/) ?? []
  if (parts.length < 2) return null
  const method = parts[0].toUpperCase()
  if (!HTTP_ACCESS_METHODS.has(method)) return null
  return {
    request: value?.trim() ?? null,
    method,
    path: parts[1] ?? null,
    protocol: parts[2] ?? null,
  }
}

function readHttpStatus(value: string | undefined): number | null {
  if (!value || !/^\d{3}$/.test(value)) return null
  const parsed = Number(value)
  return parsed >= 100 && parsed <= 599 ? parsed : null
}

function readAccessLogNumber(value: string | undefined): number | null {
  if (!value || value === '-' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function readAccessLogFixed(value: string | undefined): number | null {
  if (!value || value === '-') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const ACCESS_LOG_MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
}

function parseAccessLogTimestamp(value: string | null | undefined): number | null {
  const match = value?.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{2})(\d{2})$/)
  if (!match) return null
  const month = ACCESS_LOG_MONTHS[match[2]]
  if (month === undefined) return null
  const utc = Date.UTC(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
  const offsetMinutes = Number(match[7]) * 60 + Math.sign(Number(match[7])) * Number(match[8])
  return utc - offsetMinutes * 60_000
}

function normalizeFieldName(name: string) {
  return name.trim().toLowerCase()
}

function readLogRecordField(value: Record<string, unknown>, names: string[]): string | null {
  const wanted = new Set(names.map(normalizeFieldName))
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!wanted.has(normalizeFieldName(key))) continue
    if (typeof fieldValue === 'string') return readAccessLogToken(fieldValue.trim())
    if (typeof fieldValue === 'number' && Number.isFinite(fieldValue)) return String(fieldValue)
  }
  return null
}

function joinUri(stem: string | null, query: string | null) {
  if (!stem) return null
  if (!query) return stem
  return `${stem}?${query}`
}

function parseHttpAccessLogFields(value: Record<string, unknown>): HttpAccessLogFields | null {
  // Common log format columns, as 14.1.2 returns them: REQUEST "GET /path HTTP/2", TIMESTAMP
  // "16/Dec/2025:18:55:52 +0100", BYTECOUNT, REMOTEUSER/AUTHUSER.
  const requestLine = parseHttpRequestToken(readLogRecordField(value, ['REQUEST', 'request']) ?? undefined)
  const method = readLogRecordField(value, ['cs-method', 'CS-METHOD', 'METHOD', 'REQUEST_METHOD']) ?? requestLine?.method ?? null
  const uri = readLogRecordField(value, ['cs-uri', 'CS-URI', 'URI', 'REQUEST_URI', 'cs-uri-stem'])
  const uriStem = readLogRecordField(value, ['cs-uri-stem', 'CS-URI-STEM', 'URI_STEM'])
  const uriQuery = readLogRecordField(value, ['cs-uri-query', 'CS-URI-QUERY', 'QUERY_STRING'])
  const path = uri ?? joinUri(uriStem, uriQuery) ?? requestLine?.path ?? null
  const commonLogTimestamp = readLogRecordField(value, ['TIMESTAMP'])
  const commonLogTime = parseAccessLogTimestamp(commonLogTimestamp)
  const status = readHttpStatus(readLogRecordField(value, ['sc-status', 'SC-STATUS', 'STATUS', 'STATUS_CODE']) ?? undefined)
  const date = readLogRecordField(value, ['date', 'DATE'])
  const time = readLogRecordField(value, ['time', 'TIME'])
  const durationSeconds = readAccessLogFixed(readLogRecordField(value, ['time-taken', 'TIME-TAKEN']) ?? undefined)
  const bytes = readAccessLogNumber(readLogRecordField(value, ['bytes', 'BYTES', 'sc-bytes', 'SC-BYTES', 'BYTECOUNT']) ?? undefined)

  if (!method && !path && status === null) return null

  const request = method && path ? `${method} ${path}` : null
  const raw = [
    date,
    time,
    durationSeconds !== null ? durationSeconds.toString() : null,
    method,
    path,
    status !== null ? status.toString() : null,
    bytes !== null ? bytes.toString() : null,
  ].filter((part): part is string => Boolean(part)).join(' ')

  return {
    raw,
    client: readLogRecordField(value, ['c-ip', 'C-IP', 'CLIENT_IP', 'HOST']),
    ident: null,
    user: readLogRecordField(value, ['cs-username', 'CS-USERNAME', 'auth_user', 'AUTH_USER', 'USER', 'AUTHUSER', 'REMOTEUSER']),
    timestamp: date && time ? `${date} ${time}` : date ?? time ?? (commonLogTime !== null ? commonLogTimestamp : null),
    date,
    time,
    request: request ?? requestLine?.request ?? null,
    method,
    path,
    protocol: readLogRecordField(value, ['cs-version', 'CS-VERSION', 'PROTOCOL']) ?? requestLine?.protocol ?? null,
    status,
    bytes,
    host: readLogRecordField(value, ['cs-host', 'CS-HOST', 'HOST', 's-dns', 'S-DNS']),
    referer: readLogRecordField(value, ['cs(Referer)', 'CS(REFERER)', 'referer', 'REFERER']),
    userAgent: readLogRecordField(value, ['cs(User-Agent)', 'CS(USER-AGENT)', 'user-agent', 'USER_AGENT']),
    durationMs: durationSeconds !== null ? Math.round(durationSeconds * 1000) : null,
    durationSeconds,
    ecid: readLogRecordField(value, ['ctx-ecid', 'CTX-ECID']),
    rid: readLogRecordField(value, ['ctx-rid', 'CTX-RID']),
  }
}

export function parseHttpAccessLogMessage(message: string | null | undefined): HttpAccessLogFields | null {
  const raw = message?.trim()
  if (!raw) return null

  const tokens = tokenizeAccessLogLine(raw)
  if (tokens.length < 2) return null

  let requestIndex = tokens.findIndex((token) => parseHttpRequestToken(token) !== null)
  let request = requestIndex >= 0 ? parseHttpRequestToken(tokens[requestIndex]) : null

  if (!request) {
    const methodIndex = tokens.findIndex((token, index) => {
      const method = token.toUpperCase()
      return HTTP_ACCESS_METHODS.has(method) && typeof tokens[index + 1] === 'string'
    })
    if (methodIndex >= 0) {
      requestIndex = methodIndex
      request = {
        request: [tokens[methodIndex], tokens[methodIndex + 1], tokens[methodIndex + 2]]
          .filter((part) => typeof part === 'string')
          .join(' '),
        method: tokens[methodIndex].toUpperCase(),
        path: tokens[methodIndex + 1],
        protocol: tokens[methodIndex + 2] ?? null,
      }
    }
  }

  if (!request) return null

  const statusIndex = tokens.findIndex((token, index) => index > requestIndex && readHttpStatus(token) !== null)
  const status = statusIndex >= 0 ? readHttpStatus(tokens[statusIndex]) : null
  const bytes = statusIndex >= 0 ? readAccessLogNumber(tokens[statusIndex + 1]) : null
  const firstAfterBytes = statusIndex >= 0 ? tokens[statusIndex + 2] : undefined
  const firstAfterBytesIsDuration = readAccessLogNumber(firstAfterBytes) !== null
  const referer = !firstAfterBytesIsDuration && statusIndex >= 0 ? readAccessLogToken(firstAfterBytes) : null
  const userAgent = !firstAfterBytesIsDuration && statusIndex >= 0 ? readAccessLogToken(tokens[statusIndex + 3]) : null
  const durationMs = firstAfterBytesIsDuration
    ? readAccessLogNumber(firstAfterBytes)
    : statusIndex >= 0
      ? readAccessLogNumber(tokens.find((token, index) => index > statusIndex + 3 && readAccessLogNumber(token) !== null))
      : null

  return {
    raw,
    client: requestIndex > 0 && !HTTP_ACCESS_METHODS.has(tokens[0].toUpperCase())
      ? readAccessLogToken(tokens[0])
      : null,
    ident: requestIndex >= 4 ? readAccessLogToken(tokens[1]) : null,
    user: requestIndex >= 4 ? readAccessLogToken(tokens[2]) : null,
    timestamp: requestIndex >= 4 ? readAccessLogToken(tokens[3]) : null,
    date: null,
    time: null,
    request: request.request,
    method: request.method,
    path: request.path,
    protocol: request.protocol,
    status,
    bytes,
    host: null,
    referer,
    userAgent,
    durationMs,
    durationSeconds: null,
    ecid: null,
    rid: null,
  }
}

export function parseHttpAccessLogRecord(record: Pick<LogRecordPreviewRow, 'message' | 'httpAccess'>): HttpAccessLogFields | null {
  return record.httpAccess ?? parseHttpAccessLogMessage(record.message)
}

function normalizePlainTextHttpAccessLogSnapshot(value: string): Pick<LogRecordPreviewSnapshot, 'records' | 'nextRecordId'> {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  let nextRecordId: number | null = null
  const records = lines.flatMap((line, index): LogRecordPreviewRow[] => {
    const nextRecordMatch = line.match(/^nextRecordId=(\d+)$/i)
    if (nextRecordMatch) {
      nextRecordId = readNumberLike(nextRecordMatch[1])
      return []
    }

    const access = parseHttpAccessLogMessage(line)
    return [{
      recordId: null,
      timestamp: parseAccessLogTimestamp(access?.timestamp),
      date: access?.timestamp ?? null,
      severity: null,
      severityValue: null,
      subsystem: null,
      machine: null,
      server: null,
      thread: null,
      userId: access?.user ?? null,
      txId: null,
      contextId: null,
      messageId: null,
      message: line,
      supplementalAttributes: null,
      rid: index.toString(),
      httpAccess: access,
    }]
  })

  return { records, nextRecordId }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function countEntries(value: unknown): number | null {
  if (Array.isArray(value)) return value.length
  if (isObject(value)) return Object.keys(value).length
  return null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error'
}

function serverLogLatestTimestamp(archives: LogArchiveRuntime[]) {
  return archives.find((archive) => archive.name === 'ServerLog')?.latestAvailableTimestamp ?? null
}

export function isHttpAccessLogArchiveName(name: string | null | undefined) {
  const lower = name?.trim().toLowerCase() ?? ''
  if (!lower) return false
  const compact = lower.replace(/[^a-z0-9]/g, '')
  return compact.includes('httpaccesslog') || (lower.includes('http') && lower.includes('access') && lower.includes('log'))
}

export function classifyLogArchiveName(name: string): Pick<LogArchiveRuntime, 'kind' | 'label' | 'description'> {
  const normalized = name.trim()
  const lower = normalized.toLowerCase()

  if (normalized === 'ServerLog') {
    return {
      kind: 'server',
      label: 'SERVER',
      description: 'WebLogic server log archive.',
    }
  }
  if (normalized === 'DomainLog') {
    return {
      kind: 'domain',
      label: 'DOMAIN',
      description: 'Domain log archive.',
    }
  }
  if (isHttpAccessLogArchiveName(normalized)) {
    return {
      kind: 'httpAccess',
      label: 'HTTP',
      description: 'HTTP access log archive.',
    }
  }
  if (lower.startsWith('jmsmessagelog/')) {
    return {
      kind: 'jmsMessage',
      label: 'JMS',
      description: 'JMS message log archive.',
    }
  }
  if (normalized === 'EventsDataArchive' || lower.includes('event') || lower.includes('alert') || lower.includes('monitoring')) {
    return {
      kind: 'diagnosticEvent',
      label: 'DIAG/EVENT',
      description: 'WLDF diagnostic event archive; OSB/FMW activity may be exposed here even when the physical ODL log filename is not reported.',
    }
  }
  if (normalized === 'HarvestedDataArchive') {
    return {
      kind: 'harvested',
      label: 'HARVESTED',
      description: 'WLDF harvested metrics archive.',
    }
  }
  if (normalized === 'DataSourceLog') {
    return {
      kind: 'dataSource',
      label: 'DATASOURCE',
      description: 'Datasource log archive.',
    }
  }
  if (lower.startsWith('custom/')) {
    return {
      kind: 'custom',
      label: 'CUSTOM',
      description: 'Custom WLDF data-access archive reported by WebLogic.',
    }
  }
  return {
    kind: 'archive',
    label: 'ARCHIVE',
    description: 'WLDF data-access archive reported by WebLogic.',
  }
}

function hasTailAnchor(archive: LogArchiveRuntime) {
  return (
    (archive.latestRecordId !== null && archive.latestRecordId > 0) ||
    archive.latestAvailableTimestamp !== null ||
    archive.earliestAvailableTimestamp !== null ||
    archive.timestampAvailable === true
  )
}

export function selectDefaultLogTailArchive(archives: LogArchiveRuntime[]) {
  return (
    archives.find((archive) => archive.name === LOG_RECORD_PREVIEW_ARCHIVE_NAME) ??
    archives.find((archive) => archive.kind === 'diagnosticEvent' && hasTailAnchor(archive)) ??
    archives.find(hasTailAnchor) ??
    archives[0] ??
    null
  )
}

export function resolveLogTailArchiveSelection(
  archives: LogArchiveRuntime[],
  selectedArchiveName: string | null | undefined,
) {
  const selectedName = selectedArchiveName?.trim()
  return (
    (selectedName ? archives.find((archive) => archive.name === selectedName) : null) ??
    selectDefaultLogTailArchive(archives)
  )
}

export function logTailArchiveUrlValue(
  archive: LogArchiveRuntime | null | undefined,
  defaultArchive: LogArchiveRuntime | null | undefined,
) {
  if (!archive?.name) return null
  if (defaultArchive?.name === archive.name) return null
  return archive.name
}

export function logTailSelectionKey(serverName: string | null | undefined, archive: LogArchiveRuntime | null | undefined) {
  return `${serverName?.trim() ?? ''}:${archive?.name ?? ''}`
}

export function classifyLogSignals(row: Omit<LogRuntimeSignalRow, 'id' | 'severity'>): LogSignalSeverity {
  if (!row.broadcasterAvailable && !row.serverLogAvailable) return 'critical'
  if (!row.broadcasterAvailable || !row.serverLogAvailable || row.logFileStreamOpened === false) return 'warning'
  if (row.logFileStreamOpened === true && row.messagesLogged !== null) return 'healthy'
  return 'unknown'
}

export function applyLogArchiveSummaries<T extends LogRuntimeSignalRow>(
  rows: T[],
  archivesByServer: ReadonlyMap<string, LogArchiveRuntime[]>,
) {
  return rows.map((row) => {
    const archives = archivesByServer.get(row.serverName)
    if (!archives) return row

    const next = {
      ...row,
      archives,
      serverLogLatestTimestamp: serverLogLatestTimestamp(archives),
    }

    return {
      ...next,
      severity: classifyLogSignals(next),
    } as T
  })
}

export function normalizeArchive(value: unknown): LogArchiveRuntime | null {
  if (!isObject(value)) return null
  const name = readString(value.name)
  if (!name) return null
  const model = classifyLogArchiveName(name)

  return {
    name,
    ...model,
    latestRecordId: readNumber(value.latestRecordId),
    earliestAvailableTimestamp: readTimestamp(value.earliestAvailableTimestamp),
    latestAvailableTimestamp: readTimestamp(value.latestAvailableTimestamp),
    timestampAvailable: readBoolean(value.timestampAvailable),
  }
}

export function normalizeLogDataAccessRuntimeDetail(value: unknown): LogDataAccessRuntimeDetail | null {
  const archive = normalizeArchive(value)
  if (!archive || !isObject(value)) return null

  return {
    ...archive,
    type: readString(value.type),
    columnCount: countEntries(value.columns),
    columnIndexCount: countEntries(value.columnIndexMap),
    columnInfoCount: countEntries(value.columnInfoMap),
    columnTypeCount: countEntries(value.columnTypeMap),
    dataArchiveParameterCount: countEntries(value.dataArchiveParameters),
  }
}

export function normalizeLogArchiveRuntimeCounters(value: unknown): LogArchiveRuntimeCounters | null {
  if (!isObject(value)) return null
  const name = readString(value.name)
  if (!name) return null

  return {
    name,
    type: readString(value.type),
    recordRetrievalTime: readNumber(value.recordRetrievalTime),
    recordSeekCount: readNumber(value.recordSeekCount),
    recordSeekTime: readNumber(value.recordSeekTime),
    retrievedRecordCount: readNumber(value.retrievedRecordCount),
    dataRetirementCycles: readNumber(value.dataRetirementCycles),
    dataRetirementTotalTime: readNumber(value.dataRetirementTotalTime),
    lastDataRetirementStartTime: readTimestamp(value.lastDataRetirementStartTime),
    lastDataRetirementTime: readTimestamp(value.lastDataRetirementTime),
    retiredRecordCount: readNumber(value.retiredRecordCount),
    deletionCount: readNumber(value.deletionCount),
    deletionTime: readNumber(value.deletionTime),
    insertionCount: readNumber(value.insertionCount),
    insertionTime: readNumber(value.insertionTime),
    indexPageCount: readNumber(value.indexPageCount),
    recordCount: readNumber(value.recordCount),
    incrementalIndexCycleCount: readNumber(value.incrementalIndexCycleCount),
    incrementalIndexTime: readNumber(value.incrementalIndexTime),
    indexCycleCount: readNumber(value.indexCycleCount),
    indexTime: readNumber(value.indexTime),
    rotatedFilesCount: readNumber(value.rotatedFilesCount),
  }
}

export function buildLogRecordSearchWindow(
  archive: LogArchiveRuntime | null | undefined,
  now = Date.now(),
): LogRecordSearchWindow {
  const latest = archive?.latestAvailableTimestamp ?? null
  const untilMs = latest ?? now
  const sinceMs = Math.max(0, untilMs - LOG_RECORD_PREVIEW_LOOKBACK_MS)

  return {
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs + LOG_RECORD_PREVIEW_FORWARD_MS).toISOString(),
    limit: LOG_RECORD_PREVIEW_LIMIT,
  }
}

export function buildLogRecordTailSearchWindow(
  archive: LogArchiveRuntime | null | undefined,
  cursor: LogRecordTailCursor | null | undefined,
  now = Date.now(),
): LogRecordSearchWindow {
  if (cursor?.latestTimestamp !== null && cursor?.latestTimestamp !== undefined) {
    return {
      since: new Date(Math.max(0, cursor.latestTimestamp - LOG_RECORD_TAIL_OVERLAP_MS)).toISOString(),
      until: new Date(now + LOG_RECORD_PREVIEW_FORWARD_MS).toISOString(),
      limit: LOG_RECORD_TAIL_LIMIT,
    }
  }

  return {
    ...buildLogRecordSearchWindow(archive, now),
    limit: LOG_RECORD_TAIL_LIMIT,
  }
}

export function logRecordSearchPayload(window: LogRecordSearchWindow): LogRecordSearchPayload {
  return {
    ...(window.since ? { since: window.since } : {}),
    ...(window.until ? { until: window.until } : {}),
    limit: window.limit,
  }
}

export function wldfLogRecordSearchRequest(
  version: WlsVersion,
  serverName: string,
  archiveName: string,
  window: LogRecordSearchWindow,
) {
  return {
    params: {
      path: { version, serverName, WLDFDataAccessName: archiveName },
      query: {
        internal: true,
        expandedValues: false,
        saveChanges: false,
        enableConsoleRestExtension: true,
      },
      header: { 'X-Requested-By': 'wls-cockpit' },
    },
    body: logRecordSearchPayload(window),
  }
}

export function logRecordTailKey(record: LogRecordPreviewRow) {
  if (record.recordId !== null) return `id:${record.recordId}`
  return [
    'fallback',
    record.timestamp ?? '',
    record.date ?? '',
    record.severity ?? '',
    record.subsystem ?? '',
    record.messageId ?? '',
    record.thread ?? '',
    record.message ?? '',
  ].join('|')
}

export function compareLogRecords(a: LogRecordPreviewRow, b: LogRecordPreviewRow) {
  const aTimestamp = a.timestamp ?? Number.MAX_SAFE_INTEGER
  const bTimestamp = b.timestamp ?? Number.MAX_SAFE_INTEGER
  if (aTimestamp !== bTimestamp) return aTimestamp - bTimestamp

  const aId = a.recordId ?? Number.MAX_SAFE_INTEGER
  const bId = b.recordId ?? Number.MAX_SAFE_INTEGER
  if (aId !== bId) return aId - bId

  return logRecordTailKey(a).localeCompare(logRecordTailKey(b))
}

export function mergeLogRecordTailBuffer(
  existing: LogRecordPreviewRow[],
  incoming: LogRecordPreviewRow[],
  limit = LOG_RECORD_TAIL_BUFFER_LIMIT,
) {
  const byKey = new Map<string, LogRecordPreviewRow>()
  ;[...existing, ...incoming].forEach((record) => {
    byKey.set(logRecordTailKey(record), record)
  })

  return Array.from(byKey.values())
    .sort(compareLogRecords)
    .slice(Math.max(0, byKey.size - limit))
}

export function latestLogRecordTailCursor(records: LogRecordPreviewRow[]): LogRecordTailCursor | null {
  const latest = records.at(-1)
  if (!latest) return null
  return {
    latestRecordId: latest.recordId,
    latestTimestamp: latest.timestamp,
  }
}

export function multiLogTailSourceId(serverName: string, archiveName: string) {
  return [serverName, archiveName].map(encodeURIComponent).join('|')
}

export function buildMultiLogTailSources<T extends { serverName: string; archives: LogArchiveRuntime[] }>(
  rows: T[],
  selectedSourceIds: ReadonlySet<string>,
  maxSources = MULTI_LOG_TAIL_MAX_SOURCES,
): MultiLogTailSource[] {
  const sources = rows.flatMap((row) =>
    row.archives.map((archive) => ({
      id: multiLogTailSourceId(row.serverName, archive.name),
      serverName: row.serverName,
      archive,
    })),
  )

  return sources
    .filter((source) => selectedSourceIds.has(source.id))
    .slice(0, maxSources)
}

export function multiLogTailRecordsForSource(
  source: MultiLogTailSource,
  records: LogRecordPreviewRow[],
): MultiLogTailRecord[] {
  return records.map((record) => ({
    ...record,
    sourceId: source.id,
    sourceServerName: source.serverName,
    sourceArchiveName: source.archive.name,
    sourceArchiveKind: source.archive.kind,
    sourceArchiveLabel: source.archive.label,
  }))
}

function multiLogRecordKey(record: MultiLogTailRecord) {
  return `${record.sourceId}:${logRecordTailKey(record)}`
}

function compareMultiLogRecords(a: MultiLogTailRecord, b: MultiLogTailRecord) {
  return (
    compareLogRecords(a, b) ||
    a.sourceServerName.localeCompare(b.sourceServerName, undefined, { numeric: true, sensitivity: 'base' }) ||
    a.sourceArchiveName.localeCompare(b.sourceArchiveName, undefined, { numeric: true, sensitivity: 'base' })
  )
}

export function mergeMultiLogTailBuffer(
  existing: MultiLogTailRecord[],
  incoming: MultiLogTailRecord[],
  perSourceLimit = MULTI_LOG_TAIL_SOURCE_BUFFER_LIMIT,
  globalLimit = MULTI_LOG_TAIL_BUFFER_LIMIT,
) {
  const byKey = new Map<string, MultiLogTailRecord>()
  ;[...existing, ...incoming].forEach((record) => {
    byKey.set(multiLogRecordKey(record), record)
  })

  const bySource = new Map<string, MultiLogTailRecord[]>()
  Array.from(byKey.values()).forEach((record) => {
    const records = bySource.get(record.sourceId) ?? []
    records.push(record)
    bySource.set(record.sourceId, records)
  })

  const cappedPerSource = Array.from(bySource.values()).flatMap((records) =>
    records
      .sort(compareMultiLogRecords)
      .slice(Math.max(0, records.length - perSourceLimit)),
  )

  return cappedPerSource
    .sort(compareMultiLogRecords)
    .slice(Math.max(0, cappedPerSource.length - globalLimit))
}

export function latestMultiLogTailCursors(records: MultiLogTailRecord[]) {
  const bySource = new Map<string, LogRecordPreviewRow[]>()
  records.forEach((record) => {
    const sourceRecords = bySource.get(record.sourceId) ?? []
    sourceRecords.push(record)
    bySource.set(record.sourceId, sourceRecords)
  })

  return Object.fromEntries(
    Array.from(bySource.entries()).map(([sourceId, sourceRecords]) => [
      sourceId,
      latestLogRecordTailCursor(sourceRecords.sort(compareLogRecords)),
    ]),
  )
}

export function buildMultiLogTailSnapshot(outcomes: MultiLogTailSourceOutcome[]): MultiLogTailSnapshot {
  const records = outcomes.flatMap(({ source, outcome }) =>
    outcome.status === 'fulfilled'
      ? multiLogTailRecordsForSource(source, outcome.value.records)
      : [],
  )
  const partialFailures = outcomes.flatMap(({ source, outcome }) =>
    outcome.status === 'rejected'
      ? [{
          sourceId: source.id,
          serverName: source.serverName,
          archiveName: source.archive.name,
          message: errorMessage(outcome.reason),
          retryable: true,
        }]
      : [],
  )

  return { records, partialFailures }
}

export function normalizeLogRecordPreviewRow(value: unknown): LogRecordPreviewRow | null {
  if (!isObject(value)) return null
  const httpAccess = parseHttpAccessLogFields(value)
  const message = readString(value.MESSAGE)
  const hasKnownField = 'RECORDID' in value || 'TIMESTAMP' in value || 'MESSAGE' in value || 'MSGID' in value || httpAccess !== null
  if (!hasKnownField) return null

  return {
    recordId: readNumberLike(value.RECORDID),
    timestamp: readTimestamp(value.TIMESTAMP) ?? parseAccessLogTimestamp(readString(value.TIMESTAMP)),
    date: readString(value.DATE),
    severity: readString(value.SEVERITY),
    severityValue: readNumberLike(value.SEVERITY_VALUE),
    subsystem: readString(value.SUBSYSTEM),
    machine: readString(value.MACHINE),
    server: readString(value.SERVER),
    thread: readString(value.THREAD),
    userId: readString(value.USERID),
    txId: readString(value.TXID),
    contextId: readString(value.CONTEXTID),
    messageId: readString(value.MSGID),
    message,
    supplementalAttributes: readString(value.SUPP_ATTRS),
    rid: readString(value.RID),
    httpAccess: httpAccess ?? parseHttpAccessLogMessage(message),
  }
}

export function normalizeLogRecordPreviewSnapshot(
  archiveName: string,
  window: LogRecordSearchWindow,
  value: unknown,
): LogRecordPreviewSnapshot {
  if (typeof value === 'string') {
    const { records, nextRecordId } = normalizePlainTextHttpAccessLogSnapshot(value)
    return {
      status: records.length ? 'available' : 'empty',
      archiveName,
      records,
      nextRecordId,
      window,
    }
  }

  if (!isObject(value)) {
    return { status: 'empty', archiveName, records: [], nextRecordId: null, window }
  }

  const records = Array.isArray(value.records)
    ? value.records.flatMap((record) => {
        const normalized = normalizeLogRecordPreviewRow(record)
        return normalized ? [normalized] : []
      })
    : []

  return {
    status: records.length ? 'available' : 'empty',
    archiveName,
    records,
    nextRecordId: readNumberLike(value.nextRecordId),
    window,
  }
}

export function buildLogDetailMetadataSnapshot(
  serverName: string,
  dataAccess: PromiseSettledResult<LogDataAccessRuntimeDetail[]>,
  archiveRuntimes: PromiseSettledResult<LogArchiveRuntimeCounters[]>,
  options: { isOptionalArchiveRuntimeFailure?: (error: unknown) => boolean } = {},
): LogDetailMetadataSnapshot {
  const archiveRuntimeCountersUnavailable =
    archiveRuntimes.status === 'rejected' &&
    options.isOptionalArchiveRuntimeFailure?.(archiveRuntimes.reason) === true
  const partialFailures = [
    dataAccess.status === 'rejected'
      ? { serverName, signal: 'dataAccessDetail', message: errorMessage(dataAccess.reason) }
      : null,
    archiveRuntimes.status === 'rejected' && !archiveRuntimeCountersUnavailable
      ? { serverName, signal: 'archiveRuntimes', message: errorMessage(archiveRuntimes.reason) }
      : null,
  ].filter((failure): failure is { serverName: string; signal: string; message: string } => failure !== null)
  const dataAccessRuntimes = dataAccess.status === 'fulfilled' ? dataAccess.value : []
  const archiveRuntimeRows = archiveRuntimes.status === 'fulfilled' ? archiveRuntimes.value : []

  return {
    status: partialFailures.length ? 'partial' : dataAccessRuntimes.length || archiveRuntimeRows.length ? 'available' : 'empty',
    dataAccessRuntimes,
    archiveRuntimes: archiveRuntimeRows,
    partialFailures,
  }
}

export function buildSelectedLogRuntimeSnapshot(
  serverName: string,
  state: string,
  broadcaster: PromiseSettledResult<number | null>,
  serverLog: PromiseSettledResult<boolean | null>,
  archives: PromiseSettledResult<LogArchiveRuntime[]>,
): SelectedLogRuntimeSnapshot {
  const partialFailures = [
    broadcaster.status === 'rejected'
      ? { serverName, signal: 'broadcaster', message: errorMessage(broadcaster.reason) }
      : null,
    serverLog.status === 'rejected'
      ? { serverName, signal: 'serverLog', message: errorMessage(serverLog.reason) }
      : null,
    archives.status === 'rejected'
      ? { serverName, signal: 'archives', message: errorMessage(archives.reason) }
      : null,
  ].filter((failure): failure is { serverName: string; signal: string; message: string } => failure !== null)
  const hasAnySignal =
    broadcaster.status === 'fulfilled' || serverLog.status === 'fulfilled' || archives.status === 'fulfilled'

  if (!hasAnySignal) {
    return {
      status: partialFailures.length ? 'partial' : 'empty',
      row: null,
      partialFailures,
    }
  }

  const archiveRows = archives.status === 'fulfilled' ? archives.value : []
  const row = {
    serverName,
    state,
    messagesLogged: broadcaster.status === 'fulfilled' ? broadcaster.value : null,
    logFileStreamOpened: serverLog.status === 'fulfilled' ? serverLog.value : null,
    broadcasterAvailable: broadcaster.status === 'fulfilled',
    serverLogAvailable: serverLog.status === 'fulfilled',
    archives: archiveRows,
    serverLogLatestTimestamp: serverLogLatestTimestamp(archiveRows),
  } satisfies Omit<LogRuntimeSignalRow, 'id' | 'severity'>

  return {
    status: partialFailures.length ? 'partial' : 'available',
    row: {
      id: serverName,
      ...row,
      severity: classifyLogSignals(row),
    },
    partialFailures,
  }
}
