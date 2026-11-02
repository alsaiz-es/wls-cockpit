import { useQuery } from '@tanstack/react-query'
import { createClient12, createClient14, wlsCredentialCacheKey, type WlsCredentials } from '../client.ts'
import { createWlsHttpError, normalizeWlsRestError, withWlsRestTimeout } from '../wls-errors.ts'
import { useAuth } from '../../auth/useAuth.ts'

export const BASIC_WEB_MODULE_FIELDS =
  'name,type,componentName,moduleId,moduleURI,contextRoot,configuredContextRoot,deploymentState,status,openSessionsCurrentCount,openSessionsHighCount'
export const ADVANCED_WEB_MODULE_FIELDS =
  'name,type,componentName,moduleId,moduleURI,sourceInfo,logFilename,sessionsOpenedTotalCount,sessionTimeoutSecs,sessionInvalidationIntervalSecs,sessionCookieName,sessionCookiePath,sessionCookieMaxAgeSecs,sessionIDLength,sessionMonitoringEnabled,servletReloadCheckSecs,JSPPageCheckSecs,JSPDebug,JSPKeepGenerated,JSPVerbose,filterDispatchedRequestsEnabled,indexDirectoryEnabled,singleThreadedServletPoolSize'
export const SERVER_RUNTIME_WEB_URL_FIELDS = 'name,defaultURL,listenPortEnabled'
const DEPLOYMENT_WEB_ACCESS_TIMEOUT_MS = 5_000
export const DEPLOYMENT_URL_PROBE_TIMEOUT_MS = 4_000

export type DeploymentUrlProbeStatus =
  | 'success'
  | 'redirect'
  | 'http-error'
  | 'timeout'
  | 'network-error'
  | 'blocked'

export interface DeploymentUrlProbeResult {
  status: DeploymentUrlProbeStatus
  statusCode: number | null
  statusText: string | null
  latencyMs: number
  redirected: boolean
  message: string
}

export interface DeploymentWebModule {
  id: string
  name: string
  componentName: string | null
  moduleId: string | null
  moduleUri: string | null
  contextRoot: string | null
  configuredContextRoot: string | null
  deploymentState: string | number | null
  status: string | null
  openSessionsCurrentCount: number | null
  openSessionsHighCount: number | null
  url: string | null
}

export interface DeploymentWebModuleAdvancedMetadata {
  id: string
  name: string
  sourceInfo: string | null
  logFilename: string | null
  sessionsOpenedTotalCount: number | null
  sessionTimeoutSecs: number | null
  sessionInvalidationIntervalSecs: number | null
  sessionCookieName: string | null
  sessionCookiePath: string | null
  sessionCookieMaxAgeSecs: number | null
  sessionIdLength: number | null
  sessionMonitoringEnabled: boolean | null
  servletReloadCheckSecs: number | null
  jspPageCheckSecs: number | null
  jspDebug: boolean | null
  jspKeepGenerated: boolean | null
  jspVerbose: boolean | null
  filterDispatchedRequestsEnabled: boolean | null
  indexDirectoryEnabled: boolean | null
  singleThreadedServletPoolSize: number | null
}

export interface DeploymentWebAccessSnapshot {
  serverHttpUrl: string | null
  webModules: DeploymentWebModule[]
  partialFailures: Array<{ resource: string; message: string }>
}

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readItems(data: unknown): unknown[] {
  return isObject(data) && Array.isArray(data.items) ? data.items : []
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export function normalizeContextRoot(value: unknown): string | null {
  const text = readString(value)
  if (!text) return null
  if (text === '/') return '/'
  return text.startsWith('/') ? text : `/${text}`
}

function sanitizeServerHttpUrl(value: unknown): string | null {
  const text = readString(value)
  if (!text) return null

  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.username = ''
    url.password = ''
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export function normalizeServerHttpUrlResponse(value: unknown): string | null {
  return sanitizeServerHttpUrl(isObject(value) ? value.return : value)
}

function isLoopbackHostname(hostname: string) {
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(hostname.toLowerCase())
}

export function normalizeManagedServerHttpUrlFallback(
  creds: Pick<WlsCredentials, 'targetUrl'>,
  serverRuntime: unknown,
): string | null {
  if (!isObject(serverRuntime) || serverRuntime.listenPortEnabled !== true) return null

  const defaultUrlText = readString(serverRuntime.defaultURL)
  if (!defaultUrlText) return null

  try {
    const defaultUrl = new URL(defaultUrlText)
    const protocol =
      defaultUrl.protocol === 'http:'
        ? 'http'
        : defaultUrl.protocol === 'https:'
          ? 'https'
          : defaultUrl.protocol === 't3:'
            ? 'http'
            : defaultUrl.protocol === 't3s:'
              ? 'https'
              : null
    if (!protocol || !defaultUrl.hostname) return null

    let hostname = defaultUrl.hostname
    if (isLoopbackHostname(defaultUrl.hostname)) {
      const targetUrl = new URL(creds.targetUrl)
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') return null
      hostname = targetUrl.hostname
    }

    const urlHost = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
    return sanitizeServerHttpUrl(`${protocol}://${urlHost}${defaultUrl.port ? `:${defaultUrl.port}` : ''}`)
  } catch {
    return null
  }
}

export function fallbackServerHttpUrl(
  creds: Pick<WlsCredentials, 'targetUrl'>,
  serverName: string,
  serverRuntime?: unknown,
): string | null {
  if (serverName === 'AdminServer') return sanitizeServerHttpUrl(creds.targetUrl)
  return normalizeManagedServerHttpUrlFallback(creds, serverRuntime)
}

export function buildDeploymentUrl(serverHttpUrl: string | null, contextRoot: string | null): string | null {
  if (!serverHttpUrl || !contextRoot) return null

  const sanitizedServerUrl = sanitizeServerHttpUrl(serverHttpUrl)
  if (!sanitizedServerUrl) return null

  const normalizedContextRoot = normalizeContextRoot(contextRoot)
  if (!normalizedContextRoot) return null
  if (normalizedContextRoot === '/') return `${sanitizedServerUrl}/`

  return `${sanitizedServerUrl}${normalizedContextRoot}`
}

export function normalizeWebModule(item: unknown, serverHttpUrl: string | null): DeploymentWebModule | null {
  if (!isObject(item) || item.type !== 'WebAppComponentRuntime') return null

  const name = readString(item.name) ?? readString(item.componentName) ?? readString(item.moduleId)
  if (!name) return null

  const contextRoot = normalizeContextRoot(item.contextRoot)
  const configuredContextRoot = normalizeContextRoot(item.configuredContextRoot)
  const moduleId = readString(item.moduleId)
  const moduleUri = readString(item.moduleURI)

  return {
    id: name,
    name,
    componentName: readString(item.componentName),
    moduleId,
    moduleUri,
    contextRoot,
    configuredContextRoot,
    deploymentState: readString(item.deploymentState) ?? readNumber(item.deploymentState),
    status: readString(item.status),
    openSessionsCurrentCount: readNumber(item.openSessionsCurrentCount),
    openSessionsHighCount: readNumber(item.openSessionsHighCount),
    url: buildDeploymentUrl(serverHttpUrl, contextRoot),
  }
}

export function normalizeWebModuleAdvancedMetadata(item: unknown): DeploymentWebModuleAdvancedMetadata | null {
  if (!isObject(item) || item.type !== 'WebAppComponentRuntime') return null

  const name = readString(item.name) ?? readString(item.componentName) ?? readString(item.moduleId)
  if (!name) return null

  return {
    id: name,
    name,
    sourceInfo: readString(item.sourceInfo),
    logFilename: readString(item.logFilename),
    sessionsOpenedTotalCount: readNumber(item.sessionsOpenedTotalCount),
    sessionTimeoutSecs: readNumber(item.sessionTimeoutSecs),
    sessionInvalidationIntervalSecs: readNumber(item.sessionInvalidationIntervalSecs),
    sessionCookieName: readString(item.sessionCookieName),
    sessionCookiePath: readString(item.sessionCookiePath),
    sessionCookieMaxAgeSecs: readNumber(item.sessionCookieMaxAgeSecs),
    sessionIdLength: readNumber(item.sessionIDLength),
    sessionMonitoringEnabled: readBoolean(item.sessionMonitoringEnabled),
    servletReloadCheckSecs: readNumber(item.servletReloadCheckSecs),
    jspPageCheckSecs: readNumber(item.JSPPageCheckSecs),
    jspDebug: readBoolean(item.JSPDebug),
    jspKeepGenerated: readBoolean(item.JSPKeepGenerated),
    jspVerbose: readBoolean(item.JSPVerbose),
    filterDispatchedRequestsEnabled: readBoolean(item.filterDispatchedRequestsEnabled),
    indexDirectoryEnabled: readBoolean(item.indexDirectoryEnabled),
    singleThreadedServletPoolSize: readNumber(item.singleThreadedServletPoolSize),
  }
}

export function deploymentWebAccessQueryKey(
  creds: WlsCredentials | null | undefined,
  serverName: string | null | undefined,
  applicationName: string | null | undefined,
) {
  return ['deployment-web-access', wlsCredentialCacheKey(creds), serverName ?? '', applicationName ?? ''] as const
}

export function deploymentWebAccessEnabled(
  creds: WlsCredentials | null | undefined,
  serverName: string | null | undefined,
  applicationName: string | null | undefined,
) {
  return !!creds && !!serverName && !!applicationName
}

export function deploymentWebModuleAdvancedMetadataQueryKey(
  creds: WlsCredentials | null | undefined,
  serverName: string | null | undefined,
  applicationName: string | null | undefined,
) {
  return ['deployment-web-module-advanced-metadata', wlsCredentialCacheKey(creds), serverName ?? '', applicationName ?? ''] as const
}

export function deploymentWebModuleAdvancedMetadataEnabled(
  creds: WlsCredentials | null | undefined,
  serverName: string | null | undefined,
  applicationName: string | null | undefined,
) {
  return !!creds && !!serverName && !!applicationName
}

async function fetchServerHttpUrl(creds: WlsCredentials, serverName: string) {
  const res = await withWlsRestTimeout(
    `Deployment server URL ${serverName}`,
    (signal) =>
      clientFor(creds).POST('/management/weblogic/{version}/domainRuntime/getServerHttpURL', {
        signal,
        params: { path: { version: creds.version }, header: { 'X-Requested-By': 'wls-cockpit' } },
        body: { serverName, admin: false },
      }),
    DEPLOYMENT_WEB_ACCESS_TIMEOUT_MS,
  )

  if (res.error) throw createWlsHttpError(`Deployment server URL ${serverName}`, res.response, res.error)
  return normalizeServerHttpUrlResponse(res.data)
}

async function fetchServerRuntimeUrlFallbackData(creds: WlsCredentials, serverName: string) {
  const res = await withWlsRestTimeout(
    `Deployment server runtime URL fallback ${serverName}`,
    (signal) =>
      clientFor(creds).GET('/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}', {
        signal,
        params: {
          path: { version: creds.version, serverName },
          query: {
            fields: SERVER_RUNTIME_WEB_URL_FIELDS,
            links: 'none',
          },
        },
      }),
    DEPLOYMENT_WEB_ACCESS_TIMEOUT_MS,
  )

  if (res.error) throw createWlsHttpError(`Deployment server runtime URL fallback ${serverName}`, res.response, res.error)
  return res.data
}

async function fetchFallbackServerHttpUrl(creds: WlsCredentials, serverName: string): Promise<string | null> {
  if (serverName === 'AdminServer') return fallbackServerHttpUrl(creds, serverName)

  try {
    const serverRuntime = await fetchServerRuntimeUrlFallbackData(creds, serverName)
    return fallbackServerHttpUrl(creds, serverName, serverRuntime)
  } catch {
    return null
  }
}

async function fetchBasicWebModuleItems(creds: WlsCredentials, serverName: string, applicationName: string) {
  const res = await withWlsRestTimeout(
    `Deployment web modules ${serverName}/${applicationName}`,
    (signal) =>
      clientFor(creds).GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/applicationRuntimes/{applicationName}/componentRuntimes',
        {
          signal,
          params: {
            path: { version: creds.version, serverName, applicationName },
            query: {
              fields: BASIC_WEB_MODULE_FIELDS,
              links: 'none',
            },
          },
        },
      ),
    DEPLOYMENT_WEB_ACCESS_TIMEOUT_MS,
  )

  if (res.error) throw createWlsHttpError(`Deployment web modules ${serverName}/${applicationName}`, res.response, res.error)
  return readItems(res.data)
}

async function fetchAdvancedWebModuleMetadataItems(creds: WlsCredentials, serverName: string, applicationName: string) {
  const res = await withWlsRestTimeout(
    `Deployment web module advanced metadata ${serverName}/${applicationName}`,
    (signal) =>
      clientFor(creds).GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/applicationRuntimes/{applicationName}/componentRuntimes',
        {
          signal,
          params: {
            path: { version: creds.version, serverName, applicationName },
            query: {
              fields: ADVANCED_WEB_MODULE_FIELDS,
              links: 'none',
            },
          },
        },
      ),
    DEPLOYMENT_WEB_ACCESS_TIMEOUT_MS,
  )

  if (res.error) {
    throw createWlsHttpError(`Deployment web module advanced metadata ${serverName}/${applicationName}`, res.response, res.error)
  }
  return readItems(res.data)
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error'
}

export async function fetchDeploymentWebAccessSnapshot(
  creds: WlsCredentials,
  serverName: string,
  applicationName: string,
): Promise<DeploymentWebAccessSnapshot> {
  let webModuleItems: unknown[]
  try {
    webModuleItems = await fetchBasicWebModuleItems(creds, serverName, applicationName)
  } catch (error) {
    return {
      serverHttpUrl: null,
      webModules: [],
      partialFailures: [
        { resource: `web modules ${serverName}/${applicationName}`, message: failureMessage(error) },
      ],
    }
  }

  const webModulesWithoutUrls = webModuleItems.flatMap((item) => {
    const module = normalizeWebModule(item, null)
    return module ? [module] : []
  })
  if (webModulesWithoutUrls.length === 0) {
    return {
      serverHttpUrl: null,
      webModules: [],
      partialFailures: [],
    }
  }

  let resolvedServerHttpUrl: string | null = null
  let serverUrlError: unknown = null
  try {
    resolvedServerHttpUrl = await fetchServerHttpUrl(creds, serverName)
  } catch (error) {
    serverUrlError = error
  }
  const fallbackUrl = resolvedServerHttpUrl ? null : await fetchFallbackServerHttpUrl(creds, serverName)
  const serverHttpUrl = resolvedServerHttpUrl ?? fallbackUrl
  const webModules = webModuleItems.flatMap((item) => {
    const module = normalizeWebModule(item, serverHttpUrl)
    return module ? [module] : []
  })
  const serverUrlFailure =
    serverHttpUrl
      ? []
      : serverUrlError
        ? [{ resource: `server URL ${serverName}`, message: failureMessage(serverUrlError) }]
        : [{ resource: `server URL ${serverName}`, message: 'No usable HTTP URL reported' }]

  return {
    serverHttpUrl,
    webModules,
    partialFailures: serverUrlFailure,
  }
}

export async function fetchDeploymentWebModuleAdvancedMetadata(
  creds: WlsCredentials,
  serverName: string,
  applicationName: string,
): Promise<DeploymentWebModuleAdvancedMetadata[]> {
  const items = await fetchAdvancedWebModuleMetadataItems(creds, serverName, applicationName)
  return items.flatMap((item) => {
    const metadata = normalizeWebModuleAdvancedMetadata(item)
    return metadata ? [metadata] : []
  })
}

export function classifyProbeResponse(response: Response, latencyMs: number): DeploymentUrlProbeResult {
  if (response.type === 'opaque') {
    return {
      status: 'blocked',
      statusCode: null,
      statusText: null,
      latencyMs,
      redirected: false,
      message: 'Response blocked by browser policy',
    }
  }

  const statusCode = response.status
  const statusText = response.statusText || null
  const redirected = response.redirected || (statusCode >= 300 && statusCode < 400)
  const status: DeploymentUrlProbeStatus = response.ok ? 'success' : redirected ? 'redirect' : 'http-error'

  return {
    status,
    statusCode,
    statusText,
    latencyMs,
    redirected,
    message: statusText ? `HTTP ${statusCode} ${statusText}` : `HTTP ${statusCode}`,
  }
}

export function classifyProbeError(error: unknown, latencyMs: number): DeploymentUrlProbeResult {
  const normalized = normalizeWlsRestError('Deployment URL test', error, DEPLOYMENT_URL_PROBE_TIMEOUT_MS)

  if (normalized.kind === 'timeout') {
    return {
      status: 'timeout',
      statusCode: null,
      statusText: null,
      latencyMs,
      redirected: false,
      message: normalized.message,
    }
  }

  const message = normalized.message.toLowerCase()
  const status: DeploymentUrlProbeStatus =
    error instanceof TypeError ||
    message.includes('cors') ||
    message.includes('mixed content') ||
    message.includes('blocked')
      ? 'blocked'
      : 'network-error'

  return {
    status,
    statusCode: null,
    statusText: null,
    latencyMs,
    redirected: false,
    message: status === 'blocked' ? 'Response blocked or hidden by browser policy' : normalized.message,
  }
}

export async function probeDeploymentUrl(
  url: string,
  options: {
    timeoutMs?: number
    fetchImpl?: typeof fetch
    now?: () => number
  } = {},
): Promise<DeploymentUrlProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEPLOYMENT_URL_PROBE_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? (() => performance.now())
  const controller = new AbortController()
  const start = now()
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    })
    return classifyProbeResponse(response, Math.round(now() - start))
  } catch (error) {
    return classifyProbeError(error, Math.round(now() - start))
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

export function useDeploymentWebAccess(serverName: string | null, applicationName: string | null) {
  const { creds } = useAuth()

  return useQuery({
    queryKey: deploymentWebAccessQueryKey(creds, serverName, applicationName),
    enabled: deploymentWebAccessEnabled(creds, serverName, applicationName),
    staleTime: 0,
    queryFn: async () => {
      if (!creds || !serverName || !applicationName) throw new Error('deployment web access query disabled')
      return fetchDeploymentWebAccessSnapshot(creds, serverName, applicationName)
    },
  })
}

export function useDeploymentWebModuleAdvancedMetadata(serverName: string | null, applicationName: string | null) {
  const { creds } = useAuth()

  return useQuery({
    queryKey: deploymentWebModuleAdvancedMetadataQueryKey(creds, serverName, applicationName),
    enabled: deploymentWebModuleAdvancedMetadataEnabled(creds, serverName, applicationName),
    staleTime: 0,
    queryFn: async () => {
      if (!creds || !serverName || !applicationName) throw new Error('deployment web module advanced query disabled')
      return fetchDeploymentWebModuleAdvancedMetadata(creds, serverName, applicationName)
    },
  })
}
