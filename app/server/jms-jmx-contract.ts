import type { NormalizedWlsTarget } from '../src/api/proxy-target.ts'

export const JMS_JMX_DEFAULT_LIMIT = 25
export const JMS_JMX_MAX_LIMIT = 50
export const JMS_JMX_MAX_SELECTOR_LENGTH = 1_000
export const JMS_JMX_MAX_MESSAGE_ID_LENGTH = 512
export const JMS_JMX_MAX_DELETE_MESSAGE_IDS = 50
export const JMS_JMX_MAX_BODY_LENGTH = 32_768
export const JMS_JMX_MAX_CORRELATION_ID_LENGTH = 256
export const JMS_JMX_MAX_PROPERTY_COUNT = 20
export const JMS_JMX_MAX_PROPERTY_NAME_LENGTH = 128
export const JMS_JMX_MAX_PROPERTY_VALUE_LENGTH = 1_024

export interface JmsJmxDestinationIdentity {
  serverName: string
  jmsServerName: string
  destinationName: string
}

export interface JmsJmxBrowsePayload extends JmsJmxDestinationIdentity {
  selector: string
  offset: number
  limit: number
}

export interface JmsJmxDeletePayload extends JmsJmxDestinationIdentity {
  messageIds: string[]
}

export interface JmsJmxDetailPayload extends JmsJmxDestinationIdentity {
  messageId: string
}

export interface JmsJmxProducePayload extends JmsJmxDestinationIdentity {
  destinationType: string
  body: string
  correlationId: string
  properties: Record<string, string>
  priority: number
  deliveryMode: 'NON_PERSISTENT' | 'PERSISTENT'
  ttlMillis: number
}

export interface JmsJmxAuth {
  username: string
  password: string
}

export interface JndiHelperRequest {
  operation: 'jndi'
  targetUrl: string
  username: string
  password: string
  serverName: string
}

export interface JmsJmxHelperRequest {
  operation: 'browse' | 'detail' | 'delete' | 'produce'
  targetUrl: string
  username: string
  password: string
  serverName: string
  jmsServerName: string
  destinationName: string
  destinationType?: string
  selector?: string
  offset?: number
  limit?: number
  messageId?: string
  messageIds?: string[]
  body?: string
  correlationId?: string
  properties?: Record<string, string>
  priority?: number
  deliveryMode?: 'NON_PERSISTENT' | 'PERSISTENT'
  ttlMillis?: number
}

export type JmsJmxValidationResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequiredString(input: Record<string, unknown>, key: string, maxLength = 256) {
  const value = input[key]
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const trimmed = value.trim()
  return trimmed.length <= maxLength ? trimmed : null
}

function readOptionalSelector(input: Record<string, unknown>) {
  const value = input.selector
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return null
  return value.length <= JMS_JMX_MAX_SELECTOR_LENGTH ? value : null
}

function readOffset(input: Record<string, unknown>) {
  const value = input.offset
  if (value === undefined || value === null) return 0
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function readLimit(input: Record<string, unknown>) {
  const value = input.limit
  if (value === undefined || value === null) return JMS_JMX_DEFAULT_LIMIT
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value >= 1 && value <= JMS_JMX_MAX_LIMIT ? value : null
}

function readBody(input: Record<string, unknown>) {
  const value = input.body
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && value.length <= JMS_JMX_MAX_BODY_LENGTH ? value : null
}

function readOptionalString(input: Record<string, unknown>, key: string, maxLength: number) {
  const value = input[key]
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length <= maxLength ? trimmed : null
}

function readPriority(input: Record<string, unknown>) {
  const value = input.priority
  if (value === undefined || value === null) return 4
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9 ? value : null
}

function readDeliveryMode(input: Record<string, unknown>) {
  const value = input.deliveryMode
  if (value === undefined || value === null || value === '') return 'NON_PERSISTENT'
  return value === 'NON_PERSISTENT' || value === 'PERSISTENT' ? value : null
}

function readTtlMillis(input: Record<string, unknown>) {
  const value = input.ttlMillis
  if (value === undefined || value === null) return 0
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 86_400_000 ? value : null
}

function readStringProperties(input: Record<string, unknown>) {
  const value = input.properties
  if (value === undefined || value === null) return {}
  if (!isObject(value)) return null
  const entries = Object.entries(value)
  if (entries.length > JMS_JMX_MAX_PROPERTY_COUNT) return null
  const properties: Record<string, string> = {}
  for (const [name, propertyValue] of entries) {
    const trimmedName = name.trim()
    if (!trimmedName || trimmedName.length > JMS_JMX_MAX_PROPERTY_NAME_LENGTH) return null
    if (!/^[A-Za-z_][A-Za-z0-9_.$-]*$/.test(trimmedName)) return null
    if (typeof propertyValue !== 'string' || propertyValue.length > JMS_JMX_MAX_PROPERTY_VALUE_LENGTH) return null
    properties[trimmedName] = propertyValue
  }
  return properties
}

function readDestinationIdentity(input: Record<string, unknown>): JmsJmxDestinationIdentity | null {
  const serverName = readRequiredString(input, 'serverName')
  const jmsServerName = readRequiredString(input, 'jmsServerName')
  const destinationName = readRequiredString(input, 'destinationName', 512)
  if (!serverName || !jmsServerName || !destinationName) return null
  return { serverName, jmsServerName, destinationName }
}

function readMessageIds(input: Record<string, unknown>) {
  const single = readRequiredString(input, 'messageId', JMS_JMX_MAX_MESSAGE_ID_LENGTH)
  const value = input.messageIds
  if (value === undefined || value === null) return single ? [single] : null
  if (!Array.isArray(value) || value.length < 1 || value.length > JMS_JMX_MAX_DELETE_MESSAGE_IDS) return null

  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') return null
    const trimmed = item.trim()
    if (!trimmed || trimmed.length > JMS_JMX_MAX_MESSAGE_ID_LENGTH || seen.has(trimmed)) return null
    seen.add(trimmed)
    ids.push(trimmed)
  }
  return ids
}

function readQueueDestinationType(input: Record<string, unknown>) {
  const value = input.destinationType
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const trimmed = value.trim()
  return trimmed.toLowerCase().includes('queue') ? trimmed : null
}

export function validateJmsBrowsePayload(input: unknown): JmsJmxValidationResult<JmsJmxBrowsePayload> {
  if (!isObject(input)) return { ok: false, status: 400, message: 'JMS browse request body must be a JSON object.' }

  const identity = readDestinationIdentity(input)
  if (!identity) return { ok: false, status: 400, message: 'JMS browse requires serverName, jmsServerName, and destinationName.' }

  const selector = readOptionalSelector(input)
  if (selector === null) return { ok: false, status: 400, message: 'JMS browse selector must be a bounded string.' }

  const offset = readOffset(input)
  if (offset === null) return { ok: false, status: 400, message: 'JMS browse offset must be a non-negative integer.' }

  const limit = readLimit(input)
  if (limit === null) return { ok: false, status: 400, message: `JMS browse limit must be between 1 and ${JMS_JMX_MAX_LIMIT}.` }

  return { ok: true, value: { ...identity, selector, offset, limit } }
}

export function validateJmsDeletePayload(input: unknown): JmsJmxValidationResult<JmsJmxDeletePayload> {
  if (!isObject(input)) return { ok: false, status: 400, message: 'JMS delete request body must be a JSON object.' }
  if ('selector' in input) return { ok: false, status: 400, message: 'JMS delete only accepts selected message ids, not selectors.' }

  const identity = readDestinationIdentity(input)
  if (!identity) return { ok: false, status: 400, message: 'JMS delete requires serverName, jmsServerName, and destinationName.' }

  const messageIds = readMessageIds(input)
  if (!messageIds) {
    return {
      ok: false,
      status: 400,
      message: `JMS delete requires between 1 and ${JMS_JMX_MAX_DELETE_MESSAGE_IDS} bounded selected message ids.`,
    }
  }

  return { ok: true, value: { ...identity, messageIds } }
}

export function validateJmsDetailPayload(input: unknown): JmsJmxValidationResult<JmsJmxDetailPayload> {
  if (!isObject(input)) return { ok: false, status: 400, message: 'JMS message detail request body must be a JSON object.' }
  if ('selector' in input) return { ok: false, status: 400, message: 'JMS message detail only accepts one messageId, not selectors.' }

  const identity = readDestinationIdentity(input)
  if (!identity) return { ok: false, status: 400, message: 'JMS message detail requires serverName, jmsServerName, and destinationName.' }

  const messageId = readRequiredString(input, 'messageId', JMS_JMX_MAX_MESSAGE_ID_LENGTH)
  if (!messageId) return { ok: false, status: 400, message: 'JMS message detail requires one bounded messageId.' }

  return { ok: true, value: { ...identity, messageId } }
}

export function validateJmsProducePayload(input: unknown): JmsJmxValidationResult<JmsJmxProducePayload> {
  if (!isObject(input)) return { ok: false, status: 400, message: 'JMS produce request body must be a JSON object.' }
  if ('selector' in input || 'messageId' in input) return { ok: false, status: 400, message: 'JMS produce accepts body/options only, not selectors or message ids.' }

  const identity = readDestinationIdentity(input)
  if (!identity) return { ok: false, status: 400, message: 'JMS produce requires serverName, jmsServerName, and destinationName.' }

  const destinationType = readQueueDestinationType(input)
  if (!destinationType) return { ok: false, status: 400, message: 'JMS produce is only available for verified queue destinations.' }

  const body = readBody(input)
  if (body === null) return { ok: false, status: 400, message: `JMS produce body must be non-empty and at most ${JMS_JMX_MAX_BODY_LENGTH} characters.` }

  const correlationId = readOptionalString(input, 'correlationId', JMS_JMX_MAX_CORRELATION_ID_LENGTH)
  if (correlationId === null) return { ok: false, status: 400, message: 'JMS produce correlation id must be a bounded string.' }

  const properties = readStringProperties(input)
  if (properties === null) return { ok: false, status: 400, message: 'JMS produce properties must be bounded string key/value pairs.' }

  const priority = readPriority(input)
  if (priority === null) return { ok: false, status: 400, message: 'JMS produce priority must be an integer between 0 and 9.' }

  const deliveryMode = readDeliveryMode(input)
  if (deliveryMode === null) return { ok: false, status: 400, message: 'JMS produce delivery mode must be NON_PERSISTENT or PERSISTENT.' }

  const ttlMillis = readTtlMillis(input)
  if (ttlMillis === null) return { ok: false, status: 400, message: 'JMS produce TTL must be between 0 and 86400000 milliseconds.' }

  return { ok: true, value: { ...identity, destinationType, body, correlationId, properties, priority, deliveryMode, ttlMillis } }
}

export function readBasicAuthHeader(value: string | undefined): JmsJmxValidationResult<JmsJmxAuth> {
  if (!value?.startsWith('Basic ')) return { ok: false, status: 401, message: 'Basic authentication is required.' }

  let decoded: string
  try {
    decoded = Buffer.from(value.slice('Basic '.length), 'base64').toString('utf8')
  } catch {
    return { ok: false, status: 401, message: 'Basic authentication is invalid.' }
  }

  const separator = decoded.indexOf(':')
  const username = separator >= 0 ? decoded.slice(0, separator) : ''
  const password = separator >= 0 ? decoded.slice(separator + 1) : ''
  if (!username || !password) return { ok: false, status: 401, message: 'Basic authentication is invalid.' }
  return { ok: true, value: { username, password } }
}

export function buildExactMessageIdSelector(messageId: string) {
  return `JMSMessageID = '${messageId.replaceAll("'", "''")}'`
}

// The normalized target is a URL origin, which drops default ports (http://host instead of
// http://host:80). The helper builds a t3/t3s URL from it and needs the port spelled out.
export function helperTargetUrl(target: Extract<NormalizedWlsTarget, { ok: true }>) {
  return `${target.protocol}//${target.host}:${target.port}`
}

export function helperBrowseRequest({
  target,
  auth,
  payload,
}: {
  target: Extract<NormalizedWlsTarget, { ok: true }>
  auth: JmsJmxAuth
  payload: JmsJmxBrowsePayload
}): JmsJmxHelperRequest {
  return {
    operation: 'browse',
    targetUrl: helperTargetUrl(target),
    username: auth.username,
    password: auth.password,
    serverName: payload.serverName,
    jmsServerName: payload.jmsServerName,
    destinationName: payload.destinationName,
    selector: payload.selector,
    offset: payload.offset,
    limit: payload.limit,
  }
}

export function helperDeleteRequest({
  target,
  auth,
  payload,
}: {
  target: Extract<NormalizedWlsTarget, { ok: true }>
  auth: JmsJmxAuth
  payload: JmsJmxDeletePayload
}): JmsJmxHelperRequest {
  return {
    operation: 'delete',
    targetUrl: helperTargetUrl(target),
    username: auth.username,
    password: auth.password,
    serverName: payload.serverName,
    jmsServerName: payload.jmsServerName,
    destinationName: payload.destinationName,
    messageIds: payload.messageIds,
  }
}

export function helperDetailRequest({
  target,
  auth,
  payload,
}: {
  target: Extract<NormalizedWlsTarget, { ok: true }>
  auth: JmsJmxAuth
  payload: JmsJmxDetailPayload
}): JmsJmxHelperRequest {
  return {
    operation: 'detail',
    targetUrl: helperTargetUrl(target),
    username: auth.username,
    password: auth.password,
    serverName: payload.serverName,
    jmsServerName: payload.jmsServerName,
    destinationName: payload.destinationName,
    messageId: payload.messageId,
  }
}

export function helperProduceRequest({
  target,
  auth,
  payload,
}: {
  target: Extract<NormalizedWlsTarget, { ok: true }>
  auth: JmsJmxAuth
  payload: JmsJmxProducePayload
}): JmsJmxHelperRequest {
  return {
    operation: 'produce',
    targetUrl: helperTargetUrl(target),
    username: auth.username,
    password: auth.password,
    serverName: payload.serverName,
    jmsServerName: payload.jmsServerName,
    destinationName: payload.destinationName,
    destinationType: payload.destinationType,
    body: payload.body,
    correlationId: payload.correlationId,
    properties: payload.properties,
    priority: payload.priority,
    deliveryMode: payload.deliveryMode,
    ttlMillis: payload.ttlMillis,
  }
}

export const JMS_DEMO_BODY_HIDDEN_REASON = 'Message bodies are hidden in read-only demo mode.'

// Read-only demo mode is meant for screen sharing: message payloads are business data, so the
// server drops them before they reach the browser instead of relying on the UI to hide them.
export function maskJmsPayloadForDemo(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result
  const record = result as Record<string, unknown>
  const message = record.message
  if (typeof message !== 'object' || message === null) return result
  return {
    ...record,
    message: {
      ...(message as Record<string, unknown>),
      bodyText: null,
      messageXmlText: null,
      bodyUnavailableReason: JMS_DEMO_BODY_HIDDEN_REASON,
    },
  }
}

const JNDI_SERVER_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

// The server name ends up in a JMX ObjectName pattern, so only WebLogic's own name characters pass.
export function validateJndiPayload(input: unknown): JmsJmxValidationResult<{ serverName: string }> {
  const serverName = typeof input === 'object' && input !== null ? (input as { serverName?: unknown }).serverName : undefined
  if (typeof serverName !== 'string' || !JNDI_SERVER_NAME_PATTERN.test(serverName)) {
    return { ok: false, status: 400, message: 'serverName must be a WebLogic server name.' }
  }
  return { ok: true, value: { serverName } }
}

export function helperJndiRequest({
  target,
  auth,
  serverName,
}: {
  target: Extract<NormalizedWlsTarget, { ok: true }>
  auth: JmsJmxAuth
  serverName: string
}): JndiHelperRequest {
  return {
    operation: 'jndi',
    targetUrl: helperTargetUrl(target),
    username: auth.username,
    password: auth.password,
    serverName,
  }
}
