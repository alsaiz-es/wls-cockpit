import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { URL, fileURLToPath } from 'node:url'
import {
  WLS_TARGET_HEADER,
  WLS_TARGET_HEADER_LOWER,
  requireNormalizedWlsTarget,
  type NormalizedWlsTarget,
} from '../src/api/proxy-target.ts'
import type { WlsVersion } from '../src/api/wls-version.ts'
import {
  classifyActionAuditRequest,
  createAuditDraft,
  errorSummaryFromBody,
  parseActionAuditFilters,
  readActionAuditRecords,
  settleAuditDraft,
  writeActionAuditRecordSafely,
  AUDIT_PROFILE_ID_HEADER,
  AUDIT_PROFILE_NAME_HEADER,
  AUDIT_USERNAME_HEADER,
  AUDIT_VERSION_HEADER,
  type ActionAuditStoreOptions,
} from './action-audit.ts'
import { discoverJmsJmxConfig, type JmsJmxConfig } from './jms-jmx-config.ts'
import {
  helperBrowseRequest,
  helperDeleteRequest,
  helperDetailRequest,
  helperProduceRequest,
  readBasicAuthHeader,
  validateJmsBrowsePayload,
  validateJmsDeletePayload,
  validateJmsDetailPayload,
  validateJmsProducePayload,
  maskJmsPayloadForDemo,
  helperJndiRequest,
  validateJndiPayload,
} from './jms-jmx-contract.ts'
import { invokeJmsJmxHelper, jmsJmxErrorResponse } from './jms-jmx.ts'
import { CredentialGuard, credentialKey, defaultCredentialGuard } from './credential-guard.ts'
import { TabPresence, parseTabPresenceMessage } from './tab-presence.ts'
import { acceptTabSocket } from './tab-socket.ts'
import { TAB_PRESENCE_PATH } from '../src/api/tab-presence-contract.ts'
import { ALERT_RULES_PATH, alertRulesConfigToFileShape, validateAlertRulesConfig } from '../src/api/alert-rules.ts'
import { AlertRulesStore } from './alert-rules-store.ts'
import {
  CREDENTIALS_REJECTED_CODE,
  CREDENTIALS_REJECTED_HEADER,
  SIGN_IN_HEADER,
} from '../src/api/credential-guard-contract.ts'
import {
  DEPLOYMENT_UPLOAD_PATH,
  deploymentUploadUpstreamPath,
  multipartBodyStream,
  multipartEnvelope,
  validateDeploymentUploadRequest,
} from './deployment-upload.ts'
import {
  readConnectionProfileCatalog,
  writeConnectionProfileCatalog,
  type ConnectionProfileStoreOptions,
} from './connection-profile-store.ts'

const DEFAULT_DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const LOCAL_RESPONSE_HEADERS = new Set([
  // Keep upstream 401s visible to Cockpit without triggering the browser's
  // native Basic-auth credential dialog for the local proxy origin.
  'www-authenticate',
])
const LOCAL_ONLY_HEADERS = new Set([
  WLS_TARGET_HEADER_LOWER,
  SIGN_IN_HEADER.toLowerCase(),
  AUDIT_PROFILE_ID_HEADER,
  AUDIT_PROFILE_NAME_HEADER,
  AUDIT_USERNAME_HEADER,
  AUDIT_VERSION_HEADER,
])

export interface CockpitServerOptions {
  targetUrl?: string
  defaultVersion: WlsVersion
  readOnlyDemoMode?: boolean
  jmsJmxConfig?: JmsJmxConfig
  auditStore?: ActionAuditStoreOptions
  connectionProfileStore?: ConnectionProfileStoreOptions
  // Tests pass their own; otherwise every request shares one store over ~/.wls-cockpit/alerts.yaml.
  alertRulesStore?: AlertRulesStore
  distDir?: string
  // Set by the CLI so the browser can stop the local server; absent under the Vite dev server.
  onShutdownRequest?: () => void
  // Address the server listens on. Unless it is a non-loopback address, only requests whose Host
  // names loopback are served (DNS-rebinding guard).
  bindHost?: string
  // Tests pass their own; every request otherwise shares one guard, also under the Vite dev server.
  credentialGuard?: CredentialGuard
  // Stop (through onShutdownRequest) when the last browser tab closes; set by the double-click
  // launchers. See tab-presence.ts.
  exitWithLastTab?: boolean
  tabPresenceTiming?: { graceMs?: number; staleMs?: number }
}

function credentialGuardFor(options: CockpitServerOptions) {
  return options.credentialGuard ?? defaultCredentialGuard
}

function sendCredentialsRejected(req: IncomingMessage, res: ServerResponse) {
  if (hasRequestBody(req.method)) req.resume()
  res.setHeader(CREDENTIALS_REJECTED_HEADER, '1')
  sendJson(res, 401, {
    error: {
      code: CREDENTIALS_REJECTED_CODE,
      message: 'WebLogic rejected these credentials. Cockpit stopped sending them so the account is not locked out; sign in again.',
      retryable: false,
    },
  })
}

export const COCKPIT_APP_ID = 'wls-cockpit'
export const SHUTDOWN_PATH = '/__wls-cockpit/shutdown'
export { TAB_PRESENCE_PATH }
export const SHUTDOWN_HEADER = 'x-wls-cockpit-shutdown'
export const SHUTDOWN_HEADER_VALUE = 'confirm'

function headerValue(req: IncomingMessage, name: string) {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value
}

function sendJson(res: ServerResponse, statusCode: number, value: unknown) {
  const body = JSON.stringify(value)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function runtimeConfig(options: CockpitServerOptions) {
  const jmsJmxConfig = options.jmsJmxConfig ?? discoverJmsJmxConfig()
  return {
    app: COCKPIT_APP_ID,
    ...(options.targetUrl ? { defaultTargetUrl: options.targetUrl } : {}),
    defaultVersion: options.defaultVersion,
    readOnlyDemoMode: options.readOnlyDemoMode === true,
    jmsJmxAvailable: jmsJmxConfig.available,
    jmsJmxUnavailableReason: jmsJmxConfig.available ? undefined : jmsJmxConfig.reason,
    actionAuditAvailable: options.auditStore?.enabled !== false,
    connectionProfileCatalogAvailable: options.connectionProfileStore?.enabled !== false,
    shutdownAvailable: typeof options.onShutdownRequest === 'function',
    exitWithLastTab: exitsWithLastTab(options),
  }
}

function exitsWithLastTab(options: CockpitServerOptions) {
  return options.exitWithLastTab === true && typeof options.onShutdownRequest === 'function'
}

// Tab open, heartbeat and close reports. Close arrives as a navigator.sendBeacon text body.
async function handleTabPresenceRequest(req: IncomingMessage, res: ServerResponse, presence: TabPresence | null) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Tab presence requires POST.' })
    return
  }
  if (!presence) {
    req.resume()
    sendJson(res, 404, { error: 'This Cockpit does not stop with its last tab.' })
    return
  }
  const message = parseTabPresenceMessage((await requestBody(req, 1024)).toString('utf8'))
  if (!message) {
    sendJson(res, 400, { error: 'Invalid tab presence message.' })
    return
  }
  presence.record(message.id, message.event)
  res.statusCode = 204
  res.end()
}

function runtimeScript(options: CockpitServerOptions) {
  const payload = JSON.stringify(runtimeConfig(options)).replace(/</g, '\\u003c')
  return `<script>window.__WLS_COCKPIT_RUNTIME__=${payload};</script>`
}

function contentType(filePath: string) {
  switch (path.extname(filePath)) {
    case '.css':
      return 'text/css; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.woff2':
      return 'font/woff2'
    default:
      return 'application/octet-stream'
  }
}

function requestPath(req: IncomingMessage) {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    return '/'
  }
}

function staticPath(distDir: string, pathname: string) {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // Malformed percent-encoding is a bad request, not an upstream failure (it used to surface as 502).
    return null
  }
  const relative = decoded.replace(/^\/+/, '') || 'index.html'
  const resolved = path.resolve(distDir, relative)
  if (resolved !== distDir && !resolved.startsWith(`${distDir}${path.sep}`)) return null
  return resolved
}

async function serveIndex(res: ServerResponse, options: CockpitServerOptions) {
  const distDir = options.distDir ?? DEFAULT_DIST_DIR
  const html = await readFile(path.join(distDir, 'index.html'), 'utf8')
  const body = html.includes('</head>')
    ? html.replace('</head>', `${runtimeScript(options)}</head>`)
    : `${runtimeScript(options)}${html}`

  res.statusCode = 200
  res.setHeader('Content-Type', contentType('index.html'))
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, options: CockpitServerOptions) {
  const pathname = requestPath(req)
  if (pathname === '/__wls-cockpit/runtime-config') {
    sendJson(res, 200, runtimeConfig(options))
    return
  }

  const distDir = options.distDir ?? DEFAULT_DIST_DIR
  const filePath = staticPath(distDir, pathname)
  if (!filePath) {
    sendJson(res, 400, { error: 'Invalid static asset path.' })
    return
  }

  try {
    if (path.basename(filePath) === 'index.html' || !path.extname(filePath)) {
      await serveIndex(res, options)
      return
    }

    const body = await readFile(filePath)
    res.statusCode = 200
    res.setHeader('Content-Type', contentType(filePath))
    res.setHeader('Content-Length', body.byteLength)
    res.end(body)
  } catch {
    if (pathname.startsWith('/assets/')) {
      sendJson(res, 404, { error: 'Static asset not found.' })
      return
    }
    await serveIndex(res, options)
  }
}

export async function handleConnectionProfileCatalogRequest(req: IncomingMessage, res: ServerResponse, options: CockpitServerOptions) {
  const pathname = requestPath(req)
  if (pathname !== '/__wls-cockpit/connection-profiles') {
    sendJson(res, 404, { error: 'Connection profile catalog endpoint not found.' })
    return
  }

  if (req.method === 'GET') {
    sendJson(res, 200, { profiles: await readConnectionProfileCatalog(options.connectionProfileStore) })
    return
  }

  if (req.method !== 'PUT') {
    sendJson(res, 405, { error: 'Connection profile catalog requires GET or PUT.' })
    return
  }

  const parsedBody = await requestJson(req)
  if (!parsedBody || typeof parsedBody !== 'object' || !Array.isArray((parsedBody as { profiles?: unknown }).profiles)) {
    sendJson(res, 400, { error: 'Connection profile catalog body must contain a profiles array.' })
    return
  }

  const profiles = await writeConnectionProfileCatalog((parsedBody as { profiles: unknown[] }).profiles, options.connectionProfileStore)
  sendJson(res, 200, { profiles })
}

const sharedAlertRulesStore = new AlertRulesStore()

export async function handleAlertRulesRequest(req: IncomingMessage, res: ServerResponse, options: CockpitServerOptions) {
  if (requestPath(req) !== ALERT_RULES_PATH) {
    sendJson(res, 404, { error: 'Alert rules endpoint not found.' })
    return
  }
  const store = options.alertRulesStore ?? sharedAlertRulesStore
  if (req.method === 'GET') {
    sendJson(res, 200, await store.read())
    return
  }
  if (req.method !== 'PUT') {
    sendJson(res, 405, { error: 'Alert rules accept GET or PUT.' })
    return
  }
  // PUT is never a simple request, so other web pages cannot send it without a CORS preflight,
  // which this server does not answer.
  if (options.readOnlyDemoMode === true) {
    sendJson(res, 403, { error: 'Alert rules cannot be edited in read-only demo mode.' })
    return
  }
  const body = await requestJson(req)
  const revision = body && typeof body === 'object' ? (body as { revision?: unknown }).revision : undefined
  if (typeof revision !== 'string') {
    sendJson(res, 400, { error: 'The body must name the revision it edits.' })
    return
  }
  const { config, errors } = validateAlertRulesConfig(alertRulesConfigToFileShape((body as { config?: unknown }).config))
  if (errors.length > 0) {
    sendJson(res, 400, { error: 'The alert rules are not valid.', errors })
    return
  }
  const result = await store.write(revision, config)
  if (!result.ok) {
    sendJson(res, 409, { error: result.message, reason: result.reason, state: result.state })
    return
  }
  sendJson(res, 200, result.state)
}

function resolveProxyTarget(req: IncomingMessage, defaultTarget?: string): NormalizedWlsTarget {
  return requireNormalizedWlsTarget(headerValue(req, WLS_TARGET_HEADER) ?? defaultTarget)
}

function upstreamHeaders(req: IncomingMessage) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'host' || LOCAL_ONLY_HEADERS.has(lower)) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }
  return headers
}

// Cockpit sends JSON (configuration edits, JMS messages, actions); nothing legitimate comes close
// to these limits, and without them any local client could make the server buffer unbounded data.
export const MAX_PROXY_BODY_BYTES = 8 * 1024 * 1024
export const MAX_JSON_BODY_BYTES = 1024 * 1024

export class RequestBodyTooLargeError extends Error {
  readonly limit: number

  constructor(limit: number) {
    super(`Request body is larger than ${limit} bytes.`)
    this.name = 'RequestBodyTooLargeError'
    this.limit = limit
  }
}

async function requestBody(req: IncomingMessage, limit = MAX_PROXY_BODY_BYTES) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) throw new RequestBodyTooLargeError(limit)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buffer.byteLength
    if (size > limit) throw new RequestBodyTooLargeError(limit)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function requestJson(req: IncomingMessage) {
  const body = await requestBody(req, MAX_JSON_BODY_BYTES)
  if (body.byteLength === 0) return null
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

function hasRequestBody(method: string | undefined) {
  const normalized = method?.toUpperCase() ?? 'GET'
  return normalized !== 'GET' && normalized !== 'HEAD'
}

function parseAuditRequestBody(body: Buffer | undefined) {
  if (!body || body.byteLength === 0) return null
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return null
  }
}

async function writeAuditForResponse(
  options: CockpitServerOptions,
  draft: ReturnType<typeof createAuditDraft> | null,
  statusCode: number,
  body: Buffer | Uint8Array | string | null = null,
  statusText = '',
) {
  if (!draft) return
  const ok = statusCode >= 200 && statusCode < 400
  const record = settleAuditDraft(
    draft,
    ok ? 'success' : 'failure',
    statusCode,
    ok ? null : errorSummaryFromBody(body, `HTTP ${statusCode} ${statusText}`.trim()),
  )
  await writeActionAuditRecordSafely(record, options.auditStore)
}

async function writeAuditForError(
  options: CockpitServerOptions,
  draft: ReturnType<typeof createAuditDraft> | null,
  error: unknown,
) {
  if (!draft) return
  const message = error instanceof Error ? error.message : 'Request failed.'
  await writeActionAuditRecordSafely(settleAuditDraft(draft, 'failure', null, errorSummaryFromBody(null, message)), options.auditStore)
}

export async function proxyWlsRequest(req: IncomingMessage, res: ServerResponse, options: CockpitServerOptions) {
  const target = resolveProxyTarget(req, options.targetUrl)
  if (!target.ok) {
    sendJson(res, 400, { error: target.error })
    return
  }

  const credentials = credentialKey(target.targetUrl, headerValue(req, 'authorization'))
  const admission = await credentialGuardFor(options).admit(credentials, headerValue(req, SIGN_IN_HEADER) === '1')
  if (!admission.ok) {
    sendCredentialsRejected(req, res)
    return
  }

  const rawUrl = req.url ?? '/'
  const upstreamPath = rawUrl.replace(/^\/api\/wls(?=\/|$)/, '') || '/'
  const upstreamUrl = new URL(upstreamPath, target.targetUrl)
  let body: Buffer | undefined
  try {
    body = hasRequestBody(req.method) ? await requestBody(req) : undefined
  } catch (error) {
    admission.settle(null)
    throw error
  }
  const auditAction = classifyActionAuditRequest(req.method ?? 'GET', upstreamUrl.pathname, parseAuditRequestBody(body))
  const auditDraft = auditAction
    ? createAuditDraft({ req, method: req.method ?? 'GET', pathname: upstreamUrl.pathname, target, action: auditAction })
    : null
  let upstream: Response
  let upstreamBody: Buffer
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method ?? 'GET',
      headers: upstreamHeaders(req),
      body,
    })
    upstreamBody = Buffer.from(await upstream.arrayBuffer())
  } catch (error) {
    admission.settle(null)
    await writeAuditForError(options, auditDraft, error)
    throw error
  }
  admission.settle(upstream.status)

  res.statusCode = upstream.status
  if (upstream.status === 401 && headerValue(req, SIGN_IN_HEADER) !== '1') res.setHeader(CREDENTIALS_REJECTED_HEADER, '1')
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (!HOP_BY_HOP_HEADERS.has(lower) && !LOCAL_RESPONSE_HEADERS.has(lower)) res.setHeader(name, value)
  })
  res.setHeader('Content-Length', upstreamBody.byteLength)
  await writeAuditForResponse(options, auditDraft, upstream.status, upstreamBody, upstream.statusText)
  res.end(upstreamBody)
}

// Streams an archive from the browser to WebLogic as a multipart deployment (see
// deployment-upload.ts). Audited like the other deployment actions.
export async function handleDeploymentUploadRequest(req: IncomingMessage, res: ServerResponse, options: CockpitServerOptions) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== DEPLOYMENT_UPLOAD_PATH) {
    sendJson(res, 404, { error: 'Deployment endpoint not found.' })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Deployment upload requires POST.' })
    return
  }
  if (options.readOnlyDemoMode === true) {
    req.resume()
    sendJson(res, 403, { error: 'Deployment upload is disabled in demo read-only mode.' })
    return
  }
  const target = resolveProxyTarget(req, options.targetUrl)
  if (!target.ok) {
    req.resume()
    sendJson(res, 400, { error: target.error })
    return
  }
  const authorization = headerValue(req, 'authorization')
  if (!readBasicAuthHeader(authorization).ok) {
    req.resume()
    sendJson(res, 401, { error: 'WebLogic credentials are required.' })
    return
  }
  const upload = validateDeploymentUploadRequest(req, url.searchParams)
  if (!upload.ok) {
    req.resume()
    sendJson(res, upload.status, { error: upload.message })
    return
  }

  const admission = await credentialGuardFor(options).admit(credentialKey(target.targetUrl, authorization))
  if (!admission.ok) {
    sendCredentialsRejected(req, res)
    return
  }

  const { version, model, fileName, size } = upload.value
  const auditAction = classifyActionAuditRequest('POST', DEPLOYMENT_UPLOAD_PATH, model)
  const auditDraft = auditAction
    ? createAuditDraft({ req, method: 'POST', pathname: DEPLOYMENT_UPLOAD_PATH, target, action: auditAction })
    : null
  const { boundary, head, tail } = multipartEnvelope(model, fileName)
  let upstream: Response
  let upstreamBody: Buffer
  try {
    upstream = await fetch(new URL(deploymentUploadUpstreamPath(version), target.targetUrl), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: authorization ?? '',
        'X-Requested-By': 'wls-cockpit',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(head.byteLength + size + tail.byteLength),
      },
      body: multipartBodyStream(req, head, tail, size),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    upstreamBody = Buffer.from(await upstream.arrayBuffer())
  } catch (error) {
    admission.settle(null)
    await writeAuditForError(options, auditDraft, error)
    const message = error instanceof Error ? error.message : 'Deployment upload failed.'
    sendJson(res, 502, { error: message })
    return
  }
  admission.settle(upstream.status)

  res.statusCode = upstream.status
  if (upstream.status === 401) res.setHeader(CREDENTIALS_REJECTED_HEADER, '1')
  const contentType = upstream.headers.get('content-type')
  if (contentType) res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', upstreamBody.byteLength)
  await writeAuditForResponse(options, auditDraft, upstream.status, upstreamBody, upstream.statusText)
  res.end(upstreamBody)
}

// JNDI over T3 for releases whose REST API has no JNDI resource (12.2.1.4). Read-only, so it
// is not audited; it needs the same local WebLogic client as JMS message operations.
export async function handleJndiT3Request(req: IncomingMessage, res: ServerResponse, options: CockpitServerOptions) {
  if (requestPath(req) !== '/api/jndi/bindings') {
    sendJson(res, 404, { error: 'JNDI endpoint not found.' })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'JNDI listing requires POST.' })
    return
  }
  const target = resolveProxyTarget(req, options.targetUrl)
  if (!target.ok) {
    sendJson(res, 400, { error: target.error })
    return
  }
  const auth = readBasicAuthHeader(headerValue(req, 'authorization'))
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.message })
    return
  }
  if (credentialGuardFor(options).isRejected(credentialKey(target.targetUrl, headerValue(req, 'authorization')))) {
    sendCredentialsRejected(req, res)
    return
  }
  const payload = validateJndiPayload(await requestJson(req))
  if (!payload.ok) {
    sendJson(res, payload.status, { error: payload.message })
    return
  }
  const config = options.jmsJmxConfig ?? discoverJmsJmxConfig()
  if (!config.available) {
    sendJson(res, 503, {
      error: { code: 'JNDI_T3_UNAVAILABLE', message: config.reason ?? 'The local WebLogic client is not configured.', retryable: false },
    })
    return
  }
  try {
    const result = await invokeJmsJmxHelper(helperJndiRequest({ target, auth: auth.value, serverName: payload.value.serverName }), config)
    sendJson(res, 200, result)
  } catch (error) {
    const mapped = jmsJmxErrorResponse(error)
    sendJson(res, mapped.status, mapped.body)
  }
}

export async function handleJmsJmxRequest(req: IncomingMessage, res: ServerResponse, options: CockpitServerOptions) {
  const pathname = requestPath(req)
  const isBrowse = pathname === '/api/jms/messages'
  const isDetail = pathname === '/api/jms/messages/detail'
  const isDelete = pathname === '/api/jms/messages/delete'
  const isProduce = pathname === '/api/jms/messages/produce'

  if (!isBrowse && !isDetail && !isDelete && !isProduce) {
    sendJson(res, 404, { error: 'JMS endpoint not found.' })
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'JMS message operations require POST.' })
    return
  }

  const target = resolveProxyTarget(req, options.targetUrl)
  if (!target.ok) {
    sendJson(res, 400, { error: target.error })
    return
  }

  const auth = readBasicAuthHeader(headerValue(req, 'authorization'))
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.message })
    return
  }
  if (credentialGuardFor(options).isRejected(credentialKey(target.targetUrl, headerValue(req, 'authorization')))) {
    sendCredentialsRejected(req, res)
    return
  }

  if ((isDelete || isProduce) && options.readOnlyDemoMode === true) {
    sendJson(res, 403, {
      error: {
        code: isDelete ? 'JMS_DELETE_READ_ONLY' : 'JMS_PRODUCE_READ_ONLY',
        message: isDelete ? 'JMS message delete is disabled in demo read-only mode.' : 'JMS message production is disabled in demo read-only mode.',
        retryable: false,
      },
    })
    return
  }

  const parsedBody = await requestJson(req)
  if (parsedBody === undefined) {
    sendJson(res, 400, { error: 'JMS request body must be valid JSON.' })
    return
  }

  const auditAction = classifyActionAuditRequest(req.method, pathname, parsedBody)
  const auditDraft = auditAction ? createAuditDraft({ req, method: req.method, pathname, target, action: auditAction }) : null

  const config = options.jmsJmxConfig ?? discoverJmsJmxConfig()
  if (!config.available) {
    const body = {
      error: {
        code: 'JMS_JMX_UNAVAILABLE',
        message: config.reason ?? 'JMS JMX support is not configured.',
        retryable: false,
      },
    }
    sendJson(res, 503, body)
    await writeAuditForResponse(options, auditDraft, 503, JSON.stringify(body), 'Service Unavailable')
    return
  }

  try {
    if (isBrowse) {
      const payload = validateJmsBrowsePayload(parsedBody)
      if (!payload.ok) {
        sendJson(res, payload.status, { error: payload.message })
        return
      }
      const result = await invokeJmsJmxHelper(helperBrowseRequest({ target, auth: auth.value, payload: payload.value }), config)
      sendJson(res, 200, result)
      return
    }

    if (isDetail) {
      const payload = validateJmsDetailPayload(parsedBody)
      if (!payload.ok) {
        sendJson(res, payload.status, { error: payload.message })
        return
      }
      const result = await invokeJmsJmxHelper(helperDetailRequest({ target, auth: auth.value, payload: payload.value }), config)
      sendJson(res, 200, options.readOnlyDemoMode === true ? maskJmsPayloadForDemo(result) : result)
      return
    }

    if (isProduce) {
      const payload = validateJmsProducePayload(parsedBody)
      if (!payload.ok) {
        const body = { error: payload.message }
        sendJson(res, payload.status, body)
        await writeAuditForResponse(options, auditDraft, payload.status, JSON.stringify(body))
        return
      }
      const result = await invokeJmsJmxHelper(helperProduceRequest({ target, auth: auth.value, payload: payload.value }), config)
      sendJson(res, 200, result)
      await writeAuditForResponse(options, auditDraft, 200, JSON.stringify(result))
      return
    }

    const payload = validateJmsDeletePayload(parsedBody)
    if (!payload.ok) {
      const body = { error: payload.message }
      sendJson(res, payload.status, body)
      await writeAuditForResponse(options, auditDraft, payload.status, JSON.stringify(body))
      return
    }
    const result = await invokeJmsJmxHelper(helperDeleteRequest({ target, auth: auth.value, payload: payload.value }), config)
    sendJson(res, 200, result)
    await writeAuditForResponse(options, auditDraft, 200, JSON.stringify(result))
  } catch (error) {
    const mapped = jmsJmxErrorResponse(error)
    sendJson(res, mapped.status, mapped.body)
    await writeAuditForResponse(options, auditDraft, mapped.status, JSON.stringify(mapped.body))
  }
}

export async function handleActionAuditRequest(req: IncomingMessage, res: ServerResponse, options: CockpitServerOptions) {
  const pathname = requestPath(req)
  if (pathname !== '/api/audit/records') {
    sendJson(res, 404, { error: 'Audit endpoint not found.' })
    return
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Audit records require GET.' })
    return
  }

  const url = new URL(req.url ?? '/', 'http://localhost')
  const records = await readActionAuditRecords(options.auditStore, parseActionAuditFilters(url.searchParams))
  sendJson(res, 200, { records })
}

const LOOPBACK_HOST_NAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const LOOPBACK_BIND_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function requestHostHeader(req: IncomingMessage) {
  const host = headerValue(req, 'host')
  if (!host) return null
  try {
    const parsed = new URL(`http://${host}`)
    return { hostname: parsed.hostname, port: parsed.port || '80' }
  } catch {
    return null
  }
}

function hasLoopbackHostHeader(req: IncomingMessage) {
  const host = requestHostHeader(req)
  return !!host && LOOPBACK_HOST_NAMES.has(host.hostname) && host.port === String(req.socket.localPort)
}

// Bound to one non-loopback address, the page is opened at that address, so its Host names it.
function hasBindAddressHostHeader(req: IncomingMessage, bindHost: string | undefined) {
  const host = requestHostHeader(req)
  if (!host || !bindHost) return false
  const bound = bindHost.includes(':') && !bindHost.startsWith('[') ? `[${bindHost}]` : bindHost
  return host.hostname === bound.toLowerCase() && host.port === String(req.socket.localPort)
}

// A page on another site can rebind its own hostname to 127.0.0.1 and become same-origin with
// Cockpit; its requests still carry the foreign name in Host, so loopback binds reject them.
function isAllowedHost(req: IncomingMessage, options: CockpitServerOptions) {
  if (options.bindHost && !LOOPBACK_BIND_HOSTS.has(options.bindHost)) return true
  return hasLoopbackHostHeader(req)
}

// The shutdown request carries no credentials, so it must not be reachable from other sites:
// the custom header forces a CORS preflight this server never approves, and the Host check
// rejects DNS-rebinding requests (their Host names the foreign site), even when Cockpit listens
// on a non-loopback address.
function isLocalShutdownRequest(req: IncomingMessage, options: CockpitServerOptions) {
  return (
    headerValue(req, SHUTDOWN_HEADER) === SHUTDOWN_HEADER_VALUE &&
    (hasLoopbackHostHeader(req) || hasBindAddressHostHeader(req, options.bindHost))
  )
}

export function handleShutdownRequest(req: IncomingMessage, res: ServerResponse, options: CockpitServerOptions) {
  if (!options.onShutdownRequest) {
    sendJson(res, 404, { error: 'Shutdown is only available when Cockpit runs from the wls-cockpit CLI.' })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Shutdown requires POST.' })
    return
  }
  if (!isLocalShutdownRequest(req, options)) {
    sendJson(res, 403, { error: 'Shutdown is only accepted from the local Cockpit page.' })
    return
  }
  const onShutdownRequest = options.onShutdownRequest
  res.once('finish', () => onShutdownRequest())
  sendJson(res, 202, { stopping: true })
}

export function createCockpitServer(options: CockpitServerOptions): Server {
  const presence = exitsWithLastTab(options)
    ? new TabPresence({ onLastTabClosed: () => options.onShutdownRequest?.(), ...options.tabPresenceTiming })
    : null
  const tabSockets = new Set<Duplex>()
  const server = createServer((req, res) => {
    void (async () => {
      if (!isAllowedHost(req, options)) {
        sendJson(res, 403, { error: 'Cockpit only answers requests addressed to localhost or 127.0.0.1.' })
        return
      }
      if (requestPath(req) === TAB_PRESENCE_PATH) {
        await handleTabPresenceRequest(req, res, presence)
        return
      }
      if (req.url?.startsWith('/api/wls')) {
        await proxyWlsRequest(req, res, options)
        return
      }
      if (req.url?.startsWith('/api/jndi')) {
        await handleJndiT3Request(req, res, options)
        return
      }
      if (req.url?.startsWith('/api/jms')) {
        await handleJmsJmxRequest(req, res, options)
        return
      }
      if (req.url?.startsWith('/api/deployments')) {
        await handleDeploymentUploadRequest(req, res, options)
        return
      }
      if (req.url?.startsWith('/api/audit')) {
        await handleActionAuditRequest(req, res, options)
        return
      }
      if (requestPath(req) === ALERT_RULES_PATH) {
        await handleAlertRulesRequest(req, res, options)
        return
      }
      if (req.url?.startsWith('/__wls-cockpit/connection-profiles')) {
        await handleConnectionProfileCatalogRequest(req, res, options)
        return
      }
      if (requestPath(req) === SHUTDOWN_PATH) {
        handleShutdownRequest(req, res, options)
        return
      }
      await serveStatic(req, res, options)
    })().catch((error: unknown) => {
      if (error instanceof RequestBodyTooLargeError) {
        // Discard (not buffer) whatever the client is still sending, then close.
        req.resume()
        res.setHeader('Connection', 'close')
        sendJson(res, 413, { error: error.message })
        return
      }
      const message = error instanceof Error ? error.message : 'Unexpected server error.'
      sendJson(res, 502, { error: message })
    })
  })
  // Each tab's WebSocket (tab-socket.ts); without --exit-with-last-tab there is nothing to accept.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    if (!presence) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    acceptTabSocket(req, socket, presence, isAllowedHost(req, options), tabSockets)
  })
  server.on('close', () => {
    for (const socket of tabSockets) socket.destroy()
  })
  return server
}
