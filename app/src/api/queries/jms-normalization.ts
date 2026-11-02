import { classifyDashboardJms } from './dashboard-jms-classification.ts'

export type JmsSeverity = 'healthy' | 'warning' | 'critical' | 'unknown'
export type JmsStatus = 'available' | 'empty' | 'partial'
export type JmsRowKind = 'jmsServer' | 'destination'
export type JmsMessageBrowseSupport = 'unsupported' | 'supported'
export type JmsPauseDimension = 'production' | 'consumption' | 'insertion'
export type JmsPauseAction = 'pause' | 'resume'

export interface JmsPartialFailure {
  serverName: string
  jmsServerName?: string
  family: 'jmsServers' | 'destinations' | 'destinationDetail' | 'tasks' | 'messages'
  message: string
  details?: string[]
}

export interface JmsDestinationRow {
  id: string
  kind: JmsRowKind
  serverName: string
  jmsServerName: string
  destinationName: string | null
  destinationType: string | null
  state: string | null
  destinationsCurrentCount: number | null
  messagesCurrentCount: number | null
  messagesPendingCount: number | null
  messagesHighCount: number | null
  messagesReceivedCount: number | null
  bytesCurrentCount: number | null
  bytesPendingCount: number | null
  bytesHighCount: number | null
  consumersCurrentCount: number | null
  consumersHighCount: number | null
  consumersTotalCount: number | null
  consumptionPaused: boolean | null
  productionPaused: boolean | null
  insertionPaused: boolean | null
  consumptionPausedState: string | null
  productionPausedState: string | null
  insertionPausedState: string | null
  severity: JmsSeverity
}

export interface JmsTaskSummary {
  name: string
  state: string | null
  description: string | null
  beginTime: number | null
  endTime: number | null
  progress: string | null
}

export interface JmsMessageBrowseSnapshot {
  support: JmsMessageBrowseSupport
  messages: JmsBrowsedMessageRow[]
  cursorSize: number | null
  offset: number
  limit: number
  selector: string
  partialFailures: JmsPartialFailure[]
}

export interface JmsBrowsedMessageRow {
  id: string
  messageId: string | null
  correlationId: string | null
  type: string | null
  state: string | null
  deliveryMode: string | null
  priority: number | null
  timestamp: number | null
  expiration: number | null
  redelivered: boolean | null
  messageSize: number | null
  sequenceNumber: number | null
  handle: string | null
  destinationName: string | null
  consumerId: string | null
  xidString: string | null
  bodyIncluded: boolean | null
  properties: {
    count: number
    names: string[]
  }
  deleteCapable: boolean
}

export interface JmsMessageDetailRow extends JmsBrowsedMessageRow {
  messageXmlText: string | null
  bodyText: string | null
  bodyUnavailableReason: string | null
}

export interface JmsMessageDetailResult {
  message: JmsMessageDetailRow | null
}

export interface JmsMessageDeleteResult {
  requestedCount: number
  deletedCount: number
  failedCount: number
  staleCount: number
  stale: boolean
}

export interface JmsMessageProduceResult {
  accepted: boolean
  correlationId: string | null
  messageSize: number | null
  propertyCount: number | null
  priority: number | null
  deliveryMode: string | null
  ttlMillis: number | null
}

export const JMS_SERVER_FIELDS = [
  'name',
  'state',
  'messagesCurrentCount',
  'messagesPendingCount',
  'messagesHighCount',
  'messagesReceivedCount',
  'destinationsCurrentCount',
  'bytesCurrentCount',
  'bytesPendingCount',
  'bytesHighCount',
  'consumersCurrentCount',
  'consumptionPaused',
  'productionPaused',
  'insertionPaused',
  'consumptionPausedState',
  'productionPausedState',
  'insertionPausedState',
] as const

export const JMS_DESTINATION_FIELDS = [
  'name',
  'type',
  'destinationType',
  'state',
  'messagesCurrentCount',
  'messagesPendingCount',
  'messagesHighCount',
  'messagesReceivedCount',
  'bytesCurrentCount',
  'bytesPendingCount',
  'bytesHighCount',
  'consumersCurrentCount',
  'consumersHighCount',
  'consumersTotalCount',
  'consumptionPaused',
  'productionPaused',
  'insertionPaused',
  'consumptionPausedState',
  'productionPausedState',
  'insertionPausedState',
] as const

export const JMS_DESTINATION_DETAIL_FIELDS = [
  ...JMS_DESTINATION_FIELDS,
  'messagesDeletedCurrentCount',
  'messagesMovedCurrentCount',
  'bytesReceivedCount',
  'bytesThresholdTime',
  'messagesThresholdTime',
  'subscriptionMessagesLimit',
] as const

export const JMS_TASK_FIELDS = ['name', 'state', 'description', 'beginTime', 'endTime', 'progress'] as const
export const JMS_BROWSE_SELECTOR_SEARCH_PARAM = 'selector'
export const JMS_BROWSE_OFFSET_SEARCH_PARAM = 'offset'
export const JMS_BROWSE_LIMIT_SEARCH_PARAM = 'limit'
export const JMS_BROWSE_MAX_SELECTOR_LENGTH = 1_000
export const JMS_BROWSE_DEFAULT_OFFSET = 0
export const JMS_BROWSE_DEFAULT_LIMIT = 25
export const JMS_BROWSE_LIMIT_OPTIONS = [10, 25, 50] as const
export const JMS_PAUSE_DIMENSIONS = ['production', 'consumption', 'insertion'] as const

const JMS_PAUSE_STATE_KEYS = {
  production: 'productionPaused',
  consumption: 'consumptionPaused',
  insertion: 'insertionPaused',
} as const

const JMS_PAUSE_STATE_LABEL_KEYS = {
  production: 'productionPausedState',
  consumption: 'consumptionPausedState',
  insertion: 'insertionPausedState',
} as const

const JMS_PAUSE_LABELS = {
  production: 'Production',
  consumption: 'Consumption',
  insertion: 'Insertion',
} as const

export function jmsServersQueryParams() {
  return { fields: JMS_SERVER_FIELDS.join(','), links: 'none' as const }
}

export function jmsDestinationsQueryParams() {
  return { fields: JMS_DESTINATION_FIELDS.join(','), links: 'none' as const }
}

export function jmsDestinationDetailQueryParams() {
  return { fields: JMS_DESTINATION_DETAIL_FIELDS.join(','), links: 'none' as const }
}

export function jmsTasksQueryParams() {
  return { fields: JMS_TASK_FIELDS.join(','), links: 'none' as const }
}

export function jmsPauseDimensionLabel(dimension: JmsPauseDimension) {
  return JMS_PAUSE_LABELS[dimension]
}

export function jmsPauseOperationName(dimension: JmsPauseDimension, action: JmsPauseAction) {
  return `${action}${jmsPauseDimensionLabel(dimension)}` as const
}

export function jmsDestinationPauseOperationPath({
  version,
  serverName,
  jmsServerName,
  destinationName,
  dimension,
  action,
}: {
  version: string
  serverName: string
  jmsServerName: string
  destinationName: string
  dimension: JmsPauseDimension
  action: JmsPauseAction
}) {
  return `/management/weblogic/${encodeURIComponent(version)}/domainRuntime/serverRuntimes/${encodeURIComponent(serverName)}/JMSRuntime/JMSServers/${encodeURIComponent(jmsServerName)}/destinations/${encodeURIComponent(destinationName)}/${jmsPauseOperationName(dimension, action)}`
}

export function jmsDestinationPauseOperationAvailable(row: JmsDestinationRow, dimension: JmsPauseDimension) {
  if (row.kind !== 'destination' || !row.destinationName) return false
  return row[JMS_PAUSE_STATE_KEYS[dimension]] !== null
}

export function jmsPausedValue(row: JmsDestinationRow, dimension: JmsPauseDimension) {
  return row[JMS_PAUSE_STATE_KEYS[dimension]]
}

export function jmsPausedStateLabel(row: JmsDestinationRow, dimension: JmsPauseDimension) {
  return row[JMS_PAUSE_STATE_LABEL_KEYS[dimension]]
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

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readNonNegativeIntegerParam(value: string | null) {
  if (!value) return null
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function normalizeJmsBrowseUrlState(searchParams: URLSearchParams) {
  const selector = searchParams.get(JMS_BROWSE_SELECTOR_SEARCH_PARAM) ?? ''
  const offset = readNonNegativeIntegerParam(searchParams.get(JMS_BROWSE_OFFSET_SEARCH_PARAM)) ?? JMS_BROWSE_DEFAULT_OFFSET
  const requestedLimit = readNonNegativeIntegerParam(searchParams.get(JMS_BROWSE_LIMIT_SEARCH_PARAM))
  const limit =
    requestedLimit && JMS_BROWSE_LIMIT_OPTIONS.some((option) => option === requestedLimit)
      ? requestedLimit
      : JMS_BROWSE_DEFAULT_LIMIT

  return {
    selector: selector.length <= JMS_BROWSE_MAX_SELECTOR_LENGTH ? selector : '',
    offset,
    limit,
  }
}

export function serializeJmsBrowseUrlState(
  state: { selector?: string; offset?: number; limit?: number },
  previous: URLSearchParams = new URLSearchParams(),
) {
  const normalized = normalizeJmsBrowseUrlState(
    new URLSearchParams([
      [JMS_BROWSE_SELECTOR_SEARCH_PARAM, state.selector ?? ''],
      [JMS_BROWSE_OFFSET_SEARCH_PARAM, String(state.offset ?? JMS_BROWSE_DEFAULT_OFFSET)],
      [JMS_BROWSE_LIMIT_SEARCH_PARAM, String(state.limit ?? JMS_BROWSE_DEFAULT_LIMIT)],
    ]),
  )
  const next = new URLSearchParams(previous)
  if (normalized.selector) next.set(JMS_BROWSE_SELECTOR_SEARCH_PARAM, normalized.selector)
  else next.delete(JMS_BROWSE_SELECTOR_SEARCH_PARAM)
  if (normalized.offset > JMS_BROWSE_DEFAULT_OFFSET) next.set(JMS_BROWSE_OFFSET_SEARCH_PARAM, String(normalized.offset))
  else next.delete(JMS_BROWSE_OFFSET_SEARCH_PARAM)
  if (normalized.limit !== JMS_BROWSE_DEFAULT_LIMIT) next.set(JMS_BROWSE_LIMIT_SEARCH_PARAM, String(normalized.limit))
  else next.delete(JMS_BROWSE_LIMIT_SEARCH_PARAM)
  return next
}

function rowId(serverName: string, jmsServerName: string, destinationName: string | null) {
  return `${serverName}:${jmsServerName}:${destinationName ?? '__jmsServer'}`
}

export function normalizeJmsRuntimeRow({
  serverName,
  jmsServerName,
  item,
  destinationName,
}: {
  serverName: string
  jmsServerName: string
  item: unknown
  destinationName?: string | null
}): JmsDestinationRow | null {
  if (!isObject(item)) return null
  const name = destinationName === undefined ? readString(item.name) : destinationName
  if (destinationName !== null && !name) return null

  const row = {
    kind: name ? 'destination' : 'jmsServer',
    serverName,
    jmsServerName,
    destinationName: name,
    destinationType: readString(item.destinationType),
    state: readString(item.state),
    destinationsCurrentCount: readNumber(item.destinationsCurrentCount),
    messagesCurrentCount: readNumber(item.messagesCurrentCount),
    messagesPendingCount: readNumber(item.messagesPendingCount),
    messagesHighCount: readNumber(item.messagesHighCount),
    messagesReceivedCount: readNumber(item.messagesReceivedCount),
    bytesCurrentCount: readNumber(item.bytesCurrentCount),
    bytesPendingCount: readNumber(item.bytesPendingCount),
    bytesHighCount: readNumber(item.bytesHighCount),
    consumersCurrentCount: readNumber(item.consumersCurrentCount),
    consumersHighCount: readNumber(item.consumersHighCount),
    consumersTotalCount: readNumber(item.consumersTotalCount),
    consumptionPaused: readBoolean(item.consumptionPaused),
    productionPaused: readBoolean(item.productionPaused),
    insertionPaused: readBoolean(item.insertionPaused),
    consumptionPausedState: readString(item.consumptionPausedState),
    productionPausedState: readString(item.productionPausedState),
    insertionPausedState: readString(item.insertionPausedState),
  } satisfies Omit<JmsDestinationRow, 'id' | 'severity'>

  return {
    id: rowId(serverName, jmsServerName, name),
    ...row,
    severity: classifyDashboardJms(row),
  }
}

export function normalizeJmsTaskSummary(item: unknown): JmsTaskSummary | null {
  if (!isObject(item)) return null
  const name = readString(item.name)
  if (!name) return null
  return {
    name,
    state: readString(item.state),
    description: readString(item.description),
    beginTime: readNumber(item.beginTime),
    endTime: readNumber(item.endTime),
    progress: readString(item.progress),
  }
}

export function normalizeJmsBrowsedMessageRow(item: unknown, index = 0): JmsBrowsedMessageRow | null {
  if (!isObject(item)) return null
  const messageId = readString(item.messageId)
  const handle = readString(item.handle)
  const sequenceNumber = readNumber(item.sequenceNumber)
  const properties = isObject(item.properties) ? item.properties : {}
  const propertyNames = readStringArray(properties.names)
  const propertyCount = readNumber(properties.count) ?? propertyNames.length

  return {
    id: messageId ?? handle ?? `${sequenceNumber ?? index}`,
    messageId,
    correlationId: readString(item.correlationId),
    type: readString(item.type),
    state: readString(item.state),
    deliveryMode: readString(item.deliveryMode),
    priority: readNumber(item.priority),
    timestamp: readNumber(item.timestamp),
    expiration: readNumber(item.expiration),
    redelivered: readBoolean(item.redelivered),
    messageSize: readNumber(item.messageSize),
    sequenceNumber,
    handle,
    destinationName: readString(item.destinationName),
    consumerId: readString(item.consumerId),
    xidString: readString(item.xidString),
    bodyIncluded: readBoolean(item.bodyIncluded),
    properties: {
      count: propertyCount,
      names: propertyNames,
    },
    deleteCapable: readBoolean(item.deleteCapable) === true && !!messageId,
  }
}

export function normalizeJmsMessageBrowseSnapshot({
  input,
  serverName,
  jmsServerName,
  selector,
  offset,
  limit,
}: {
  input: unknown
  serverName: string
  jmsServerName: string
  selector: string
  offset: number
  limit: number
}): JmsMessageBrowseSnapshot {
  if (!isObject(input) || input.ok !== true || input.operation !== 'browse') {
    return unsupportedJmsMessageBrowseSnapshot(serverName, jmsServerName)
  }

  const messages = Array.isArray(input.messages)
    ? input.messages.flatMap((item, index) => {
        const row = normalizeJmsBrowsedMessageRow(item, index)
        return row ? [row] : []
      })
    : []

  const partialFailures = Array.isArray(input.partialFailures)
    ? input.partialFailures.flatMap((failure) => {
        if (!isObject(failure)) return []
        return [
          {
            serverName,
            jmsServerName,
            family: 'messages' as const,
            message: readString(failure.message) ?? 'JMS browse completed with a partial helper warning.',
          },
        ]
      })
    : []

  return {
    support: 'supported',
    messages,
    cursorSize: readNumber(input.cursorSize),
    offset: readNumber(input.offset) ?? offset,
    limit: readNumber(input.limit) ?? limit,
    selector,
    partialFailures,
  }
}

export function normalizeJmsMessageDetailResult(input: unknown): JmsMessageDetailResult {
  if (!isObject(input) || input.ok !== true || input.operation !== 'detail') {
    throw new Error('Unexpected JMS message detail response.')
  }

  const row = normalizeJmsBrowsedMessageRow(input.message)
  const message = isObject(input.message) && row
    ? {
        ...row,
        messageXmlText: readString(input.message.messageXmlText),
        bodyText: readString(input.message.bodyText),
        bodyUnavailableReason: readString(input.message.bodyUnavailableReason),
      }
    : null

  return { message }
}

export function normalizeJmsMessageDeleteResult(input: unknown): JmsMessageDeleteResult {
  if (!isObject(input) || input.ok !== true || input.operation !== 'delete') {
    throw new Error('Unexpected JMS delete response.')
  }
  const deletedCount = readNumber(input.deletedCount) ?? 0
  const failedCount = readNumber(input.failedCount) ?? 0
  const staleCount = readNumber(input.staleCount) ?? 0
  const requestedCount = readNumber(input.requestedCount) ?? Math.max(1, deletedCount + failedCount + staleCount)
  return {
    requestedCount,
    deletedCount,
    failedCount,
    staleCount,
    stale: readBoolean(input.stale) === true || (deletedCount === 0 && staleCount > 0 && failedCount === 0),
  }
}

export function normalizeJmsMessageProduceResult(input: unknown): JmsMessageProduceResult {
  if (!isObject(input) || input.ok !== true || input.operation !== 'produce') {
    throw new Error('Unexpected JMS produce response.')
  }
  return {
    accepted: readBoolean(input.accepted) === true,
    correlationId: readString(input.correlationId),
    messageSize: readNumber(input.messageSize),
    propertyCount: readNumber(input.propertyCount),
    priority: readNumber(input.priority),
    deliveryMode: readString(input.deliveryMode),
    ttlMillis: readNumber(input.ttlMillis),
  }
}

export function formatJmsMessageProduceFeedback(result: JmsMessageProduceResult) {
  const details = [
    result.correlationId ? `correlation ${result.correlationId}` : null,
    result.messageSize !== null ? `size ${result.messageSize.toLocaleString()}` : null,
    result.propertyCount !== null ? `properties ${result.propertyCount.toLocaleString()}` : null,
    result.priority !== null ? `priority ${result.priority.toLocaleString()}` : null,
    result.deliveryMode ? `delivery ${result.deliveryMode}` : null,
    result.ttlMillis !== null ? `TTL ${Math.floor(result.ttlMillis / 1000).toLocaleString()}s` : null,
  ].filter((detail): detail is string => !!detail)
  const prefix = result.accepted ? 'Message accepted' : 'Message send completed without an accepted flag'
  return details.length ? `${prefix}: ${details.join(' · ')}.` : `${prefix}.`
}

export function formatJmsMessageDeleteFeedback(result: JmsMessageDeleteResult) {
  const requested = result.requestedCount.toLocaleString()
  const deleted = result.deletedCount.toLocaleString()
  const failed = result.failedCount.toLocaleString()
  const stale = result.staleCount.toLocaleString()
  if (result.failedCount > 0) {
    return `Delete completed partially: ${deleted} of ${requested} deleted, ${failed} failed, ${stale} already gone.`
  }
  if (result.stale) return `Selected messages were already gone: ${stale || requested}.`
  if (result.staleCount > 0) {
    return `Deleted ${deleted} of ${requested} selected messages; ${stale} were already gone.`
  }
  return `Deleted ${deleted} selected message${result.deletedCount === 1 ? '' : 's'}.`
}

export function unsupportedJmsMessageBrowseSnapshot(
  serverName: string,
  jmsServerName: string,
  message = 'Message browsing requires the optional local JMX/T3 adapter on the Cockpit server.',
  details: string[] = [],
): JmsMessageBrowseSnapshot {
  return {
    support: 'unsupported',
    messages: [],
    cursorSize: null,
    offset: 0,
    limit: 25,
    selector: '',
    partialFailures: [
      {
        serverName,
        jmsServerName,
        family: 'messages',
        message,
        ...(details.length ? { details } : {}),
      },
    ],
  }
}
