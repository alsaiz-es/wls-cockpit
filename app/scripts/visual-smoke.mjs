import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(__dirname, '..')
const ARTIFACT_DIR = resolve(APP_ROOT, 'test-results/visual')
const APP_URL = process.env.WLS_SMOKE_APP_URL ?? 'http://localhost:5173'
const CDP_PORT = Number(process.env.CDP_PORT ?? '9223')
const CDP_URL = process.env.CDP_URL ?? `http://127.0.0.1:${CDP_PORT}`
const CHROME_PATH =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CHROME_USER_DATA_DIR =
  process.env.CHROME_USER_DATA_DIR ?? '/tmp/wls-cockpit-visual-smoke-chrome'
const WLS_PROXY_TIMEOUT_MS = 10_000
const WLS_RESTORE_TIMEOUT_MS = 180_000
const DEFAULT_WLS_TARGET_URL = 'http://localhost:7001'
const DEFAULT_WLS_VERSION = process.env.VITE_WLS_DEFAULT_VERSION ?? '14.1.2.0.0'
const CHECK_FILTER = new Set(
  (process.env.WLS_SMOKE_CHECKS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
)
const DEFAULT_SMOKE_PROFILE = 'readonly'
const WLS_SMOKE_PROFILE = process.env.WLS_SMOKE_PROFILE ?? DEFAULT_SMOKE_PROFILE
const SUPPORTED_SMOKE_PROFILES = ['readonly', 'lifecycle', 'jms-mutation', 'topology-config']
const JMS_MUTATION_DESTINATION_HINT = process.env.WLS_SMOKE_JMS_DESTINATION_HINT ?? 'WlsCockpitProbeQueue'
// A binding the AdminServer of the lab domain holds; the default is the demo data source.
const JNDI_SMOKE_BINDING = process.env.WLS_SMOKE_JNDI_BINDING ?? 'jdbc/WLSCockpitDemoDS'
const SAFE_REST_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const MUTATING_REST_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const ACTIVE_CONNECTION_STORAGE_KEY = 'wls-cockpit:active-connection:v1'
const LEGACY_CREDENTIALS_STORAGE_KEY = 'wls-cockpit:creds'
const THEME_MODE_STORAGE_KEY = 'wls-cockpit:theme-mode:v1'
const WLS_TARGET_HEADER = 'X-WLS-Cockpit-Target'
let activeSmokeCheck = null

function shouldEnableDemoReadOnly() {
  if (['1', 'true', 'yes', 'on'].includes((process.env.WLS_SMOKE_DEMO_READ_ONLY ?? '').trim().toLowerCase())) return true
  return CHECK_FILTER.has('demo-readonly-live')
}

function normalizeTargetOrigin(value, label) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be an absolute http(s) origin.`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http or https.`)
  }
  if (!parsed.hostname) {
    throw new Error(`${label} must include a hostname.`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not include embedded credentials.`)
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an origin without path, query, or fragment.`)
  }

  return parsed.origin
}

function defaultProfileId(targetUrl) {
  let hash = 2166136261
  for (let index = 0; index < targetUrl.length; index += 1) {
    hash ^= targetUrl.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `default-${(hash >>> 0).toString(36)}`
}

const WLS_TARGET_URL = normalizeTargetOrigin(
  process.env.WLS_SMOKE_TARGET ?? process.env.VITE_WLS_TARGET ?? DEFAULT_WLS_TARGET_URL,
  'WLS_SMOKE_TARGET/VITE_WLS_TARGET',
)
const SMOKE_PROFILE_ID = process.env.WLS_SMOKE_PROFILE_ID ?? defaultProfileId(WLS_TARGET_URL)
const SMOKE_PROFILE_NAME = process.env.WLS_SMOKE_PROFILE_NAME ?? 'Default domain'

const credentials = {
  username: process.env.WLS_SMOKE_USERNAME ?? 'weblogic',
  password: process.env.WLS_SMOKE_PASSWORD,
  version: process.env.WLS_SMOKE_VERSION ?? DEFAULT_WLS_VERSION,
}

const fixtureChecks = [
  {
    name: 'dashboard-fixture-healthy',
    path: '/dashboard?fixture=healthy',
    expected: ['HEALTHY', 'No active issues', 'Server Pressure', 'PENDING', 'HOGGING', 'STUCK', 'JMS Pressure', '0 anomalies'],
    hrefs: ['/servers/AdminServer', '/logs/AdminServer'],
  },
  {
    name: 'dashboard-fixture-warning',
    path: '/dashboard?fixture=warning',
    expected: ['WARNING', 'OrdersDS', 'OrdersQueue', 'JMS OrdersQueue', 'Issue Queue', 'Server Pressure', 'HOGGING', 'JMS MSG', 'JMS Pressure'],
    hrefs: ['/data-sources/AdminServer/OrdersDS', '/jms/AdminServer/DemoJMSServer/OrdersQueue', '/servers/AdminServer', '/logs/AdminServer'],
  },
  {
    name: 'dashboard-fixture-critical',
    path: '/dashboard?fixture=critical',
    expected: ['CRITICAL', 'server1', 'FAILED_NOT_RESTARTABLE', 'Servers'],
    hrefs: ['/servers/server1', '/data-sources/AdminServer/OrdersDS'],
  },
  {
    name: 'dashboard-fixture-partial',
    path: '/dashboard?fixture=partial',
    expected: ['Partial data:', 'logs: HTTP 404 Not Found', 'AFFECTED RESOURCE'],
  },
  {
    name: 'server-metrics-fixture-active',
    path: '/servers/AdminServer?tab=metrics&metricsFixture=active',
    expected: ['AdminServer', 'Metric Capture', 'active', 'Process CPU', 'Heap Utilization', 'Threads', 'JDBC Pools', 'OrdersDS', 'JMS Destinations', 'OrdersQueue'],
    forbidden: ['Coming soon', 'Request failed', 'Server not found'],
  },
  {
    name: 'server-metrics-fixture-stopped',
    path: '/servers/AdminServer?tab=metrics&metricsFixture=stopped',
    expected: ['AdminServer', 'Metric Capture', 'stopped', 'CSV', 'JSON', 'Process CPU', 'OrdersDS', 'OrdersQueue'],
    forbidden: ['Coming soon', 'Request failed', 'Server not found'],
  },
  {
    name: 'server-metrics-fixture-unavailable',
    path: '/servers/AdminServer?tab=metrics&metricsFixture=unavailable',
    expected: ['AdminServer', 'Metric Capture', 'active', 'Process CPU', 'Unavailable', 'No captured JDBC resources', 'No captured JMS resources'],
    forbidden: ['Coming soon', 'Request failed', 'Server not found'],
  },
  {
    name: 'server-metrics-fixture-gap',
    path: '/servers/AdminServer?tab=metrics&metricsFixture=gap',
    expected: ['AdminServer', 'Metric Capture', 'active', 'GAPS', 'gap', 'Process CPU', 'OrdersDS', '2 omitted', 'OrdersQueue', '1 omitted'],
    forbidden: ['Coming soon', 'Request failed', 'Server not found'],
  },
]

const liveChecks = [
  {
    name: 'dashboard-live',
    path: '/dashboard',
    expected: ['Dashboard', 'Domain health overview.', 'Server Pressure', 'PENDING', 'HOGGING', 'STUCK', 'JMS', 'JMS Pressure', 'Issue Queue'],
    forbidden: ['Coming soon', 'Unable to build domain snapshot.', 'Request failed'],
  },
  {
    name: 'servers-live',
    path: '/servers',
    expected: ['Servers', 'Domain server runtimes.', 'AdminServer', 'STATE', 'HEALTH'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'server-details-live',
    path: '/servers/AdminServer',
    expected: ['AdminServer', 'Single server runtime snapshot.', 'Overview', 'Metrics', 'LIFECYCLE', 'HEALTH', 'LISTEN', 'JVM Runtime', 'JAVA', 'Node Manager', 'Lifecycle Tasks', 'Thread dump'],
    forbidden: ['Coming soon', 'Request failed', 'Server not found'],
  },
  {
    name: 'clusters-live',
    path: '/clusters',
    expected: ['Clusters', 'Cluster membership', 'CLUSTER', 'MEMBERS', 'ALIVE'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'node-manager-live',
    path: '/node-manager',
    expected: ['Node Manager', 'Machine reachability', 'MACHINE', 'STATUS', 'LISTEN'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'deployments-live',
    path: '/deployments',
    expected: ['Deployments', 'Applications and deployment state.', 'Deploy', 'INSTANCES', 'TARGETS', 'WLSCockpitDemoApp', 'AdminServer', 'EXTERNAL'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'deployment-details-live',
    path: '/deployments/AdminServer/WLSCockpitDemoApp',
    expected: ['WLSCockpitDemoApp', 'Single application runtime snapshot.', 'STATUS', 'SCOPE', 'EXTERNAL', 'CONFIGURED TARGETS', 'Request Metrics', 'Configuration', 'SOURCE PATH', 'Web Modules', 'SOURCE', 'SESSION', 'COOKIE', 'RELOAD/JSP', 'FLAGS'],
    forbidden: ['Coming soon', 'Request failed', 'Deployment not found'],
  },
  {
    name: 'data-sources-live',
    path: '/data-sources',
    expected: ['Data Sources', 'JDBC pool status and connectivity.', 'Create', 'TARGETS', 'JNDI', 'MAX', 'CREATED', 'WLSCockpitDemoDS', 'AdminServer', 'RUNNING'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'data-source-details-live',
    path: '/data-sources/AdminServer/WLSCockpitDemoDS',
    expected: ['WLSCockpitDemoDS', 'Single JDBC datasource runtime snapshot.', 'STATUS', 'RUNTIME', 'HEALTHY', 'Active connections over configured max.', 'MAX CAPACITY', 'CREATED', 'Availability Counters', 'AVAILABLE', 'UNAVAILABLE', 'RESERVE REQUESTS', 'Database Runtime', 'DB PRODUCT', 'RUNTIME DRIVER', 'Statement Cache', 'CURRENT SIZE', 'MISSES', 'Configuration', 'CONFIGURED TARGETS', 'GLOBAL TX', 'KEEP AFTER GLOBAL TX'],
    forbidden: ['Coming soon', 'Request failed', 'Datasource not found'],
  },
  {
    name: 'jms-live',
    path: '/jms',
    expected: ['JMS', 'Read-only JMS servers', 'DESTINATION', 'JMS SERVER', 'MESSAGES', 'PENDING', 'CONSUMERS'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'jta-live',
    path: '/jta',
    expected: ['JTA', 'Per-server transaction counters', 'AdminServer', 'SERVER', 'SERVICE', 'ACTIVE', 'COMMITTED', 'HEURISTICS'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'security-live',
    path: '/security',
    expected: ['Security', 'User lockout per server', 'AdminServer', 'LOCKED NOW', 'INVALID LOGINS'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'logs-live',
    path: '/logs',
    expected: [
      'Logs',
      'Server log runtime signals.',
      'AdminServer',
      'OPEN',
      'AVAILABLE',
      'ARCHIVES',
      'SERVER LOG UPDATED',
    ],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'log-details-live',
    path: '/logs/AdminServer',
    expected: [
      'AdminServer',
      'Single server log runtime snapshot.',
      'Live Tail',
      'Read-only tail of the selected WLDF archive',
      'Maximize',
      'SERVER',
      'Runtime Signals',
      'Archives',
      'Data Access Metadata',
      'Archive Runtime Counters',
    ],
    forbidden: ['Coming soon', 'Request failed', 'Log runtime not found'],
  },
]

const compatChecks = [
  {
    name: 'compat-dashboard-live',
    path: '/dashboard',
    expected: ['Dashboard', 'Domain health overview.', 'Servers', 'Server Pressure', 'JMS', 'Logs'],
    forbidden: ['Coming soon', 'Unable to build domain snapshot.', 'Request failed'],
  },
  {
    name: 'compat-servers-live',
    path: '/servers',
    expected: ['Servers', 'Domain server runtimes.', 'AdminServer', 'STATE', 'HEALTH'],
    forbidden: ['Coming soon', 'Request failed'],
    assertFailedNotRestartableStart: true,
  },
  {
    name: 'compat-server-details-admin',
    path: '/servers/AdminServer',
    expected: ['AdminServer', 'Single server runtime snapshot.', 'LIFECYCLE', 'HEALTH', 'LISTEN', 'JVM Runtime', 'Node Manager'],
    forbidden: ['Coming soon', 'Request failed', 'Server not found'],
  },
  {
    name: 'compat-clusters-live',
    path: '/clusters',
    expected: ['Clusters', 'Cluster membership', 'CLUSTER', 'MEMBERS', 'ALIVE'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'compat-node-manager-live',
    path: '/node-manager',
    expected: ['Node Manager', 'Machine reachability', 'MACHINE', 'STATUS', 'LISTEN'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'compat-deployments-live',
    path: '/deployments',
    expected: ['Deployments', 'Applications and deployment state.', 'INSTANCES', 'TARGETS'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'compat-data-sources-live',
    path: '/data-sources',
    expected: ['Data Sources', 'JDBC pool status and connectivity.', 'TARGETS', 'JNDI'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'compat-jms-live',
    path: '/jms',
    expected: ['JMS', 'Read-only JMS servers', 'DESTINATION', 'JMS SERVER', 'MESSAGES'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'compat-logs-live',
    path: '/logs',
    expected: ['Logs', 'Server log runtime signals.', 'AdminServer', 'OPEN', 'AVAILABLE'],
    forbidden: ['Coming soon', 'Request failed'],
  },
  {
    name: 'compat-log-details-admin',
    path: '/logs/AdminServer',
    expected: [
      'AdminServer',
      'Single server log runtime snapshot.',
      'Live Tail',
      'Maximize',
      'SERVER',
      'Runtime Signals',
      'Data Access Metadata',
      'Archive Runtime Counters',
    ],
    forbidden: ['Coming soon', 'Request failed', 'Log runtime not found'],
  },
]

const urlStateChecks = [
  {
    name: 'servers-url-state-return',
    path: '/servers?q=AdminServer&state=RUNNING&sort=state&dir=desc',
    expected: ['Servers', 'Domain server runtimes.', 'AdminServer', 'RUNNING'],
    forbidden: ['Coming soon', 'Request failed'],
    detailHref: '/servers/AdminServer',
    detailExpected: ['AdminServer', 'Single server runtime snapshot.', 'LIFECYCLE', 'Lifecycle Tasks'],
  },
  {
    name: 'deployments-url-state-return',
    path: '/deployments?q=WLSCockpitDemoApp&server=AdminServer&internal=1&sort=name&dir=desc',
    expected: ['Deployments', 'Applications and deployment state.', 'INSTANCES', 'WLSCockpitDemoApp', 'AdminServer', 'EXTERNAL'],
    forbidden: ['Coming soon', 'Request failed'],
    detailHref: '/deployments/AdminServer/WLSCockpitDemoApp',
    detailExpected: ['WLSCockpitDemoApp', 'Single application runtime snapshot.', 'STATUS', 'EXTERNAL', 'SOURCE PATH'],
  },
  {
    name: 'data-sources-url-state-return',
    path: '/data-sources?q=WLSCockpitDemoDS&server=AdminServer&sort=name&dir=desc',
    expected: ['Data Sources', 'JDBC pool status and connectivity.', 'WLSCockpitDemoDS', 'AdminServer'],
    forbidden: ['Coming soon', 'Request failed'],
    detailHref: '/data-sources/AdminServer/WLSCockpitDemoDS',
    detailExpected: ['WLSCockpitDemoDS', 'Single JDBC datasource runtime snapshot.', 'STATUS'],
  },
  {
    name: 'logs-url-state-return',
    path: '/logs?q=AdminServer&server=AdminServer&sort=server&dir=desc',
    expected: ['Logs', 'Server log runtime signals.', 'AdminServer', 'OPEN', 'AVAILABLE'],
    forbidden: ['Coming soon', 'Request failed'],
    detailHref: '/logs/AdminServer',
    detailExpected: ['AdminServer', 'Single server log runtime snapshot.', 'Live Tail', 'Maximize', 'Runtime Signals', 'Data Access Metadata'],
  },
]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchJson(url, init) {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`)
  return res.json()
}

function authHeader(creds) {
  return `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`
}

export function sanitizeSmokeProxyPath(value) {
  let path = String(value)
  try {
    const url = new URL(path)
    path = `${url.pathname}${url.search}`
  } catch {
    // Already a path.
  }

  return path.replace(/^\/api\/wls/, '') || '/'
}

function operationRuleMatches(rule, method, path) {
  const normalizedMethod = method.toUpperCase()
  const sanitizedPath = sanitizeSmokeProxyPath(path)
  if (rule.method && rule.method.toUpperCase() !== normalizedMethod) return false
  return (rule.includes ?? []).every((fragment) => sanitizedPath.includes(fragment))
}

function unsupportedDestructivePath(path) {
  const sanitizedPath = sanitizeSmokeProxyPath(path)
  if (sanitizedPath.includes('/edit/')) return 'edit-tree'
  if (sanitizedPath.includes('/domainRuntime/deploymentManager/deploy')) return 'deploy'
  if (sanitizedPath.toLowerCase().includes('/undeploy')) return 'undeploy'
  if (/\/JTARuntime\/force(Commit|Rollback)\b/.test(sanitizedPath)) return 'JTA recovery'
  if (sanitizedPath.toLowerCase().includes('nodemanager')) return 'Node Manager'
  if (sanitizedPath.toLowerCase().includes('wlst')) return 'WLST'
  if (sanitizedPath.toLowerCase().includes('filesystem')) return 'filesystem'
  return null
}

export function auditSmokeRequest({ profile, check, method = 'GET', path }) {
  const normalizedMethod = method.toUpperCase()
  const sanitizedPath = sanitizeSmokeProxyPath(path)
  if (SAFE_REST_METHODS.has(normalizedMethod)) return

  const activeCheckName = check?.name ?? 'unknown'
  const allowedMutation = (check?.mutations ?? []).some((rule) =>
    operationRuleMatches(rule, normalizedMethod, sanitizedPath),
  )
  const unsupported = unsupportedDestructivePath(sanitizedPath)
  if (unsupported && MUTATING_REST_METHODS.has(normalizedMethod) && !allowedMutation) {
    throw new Error(
      `Smoke REST audit blocked ${unsupported} request in ${activeCheckName}: ${normalizedMethod} ${sanitizedPath}`,
    )
  }

  if (profile === 'readonly') {
    const allowedReadAction = (check?.readActions ?? []).some((rule) =>
      operationRuleMatches(rule, normalizedMethod, sanitizedPath),
    )
    if (allowedReadAction) return
    throw new Error(
      `Smoke REST audit blocked undeclared read-only request in ${activeCheckName}: ${normalizedMethod} ${sanitizedPath}`,
    )
  }

  if (profile === 'lifecycle') {
    const allowedReadAction = (check?.readActions ?? []).some((rule) =>
      operationRuleMatches(rule, normalizedMethod, sanitizedPath),
    )
    if (allowedMutation || allowedReadAction) return
    throw new Error(
      `Smoke REST audit blocked undeclared lifecycle request in ${activeCheckName}: ${normalizedMethod} ${sanitizedPath}`,
    )
  }

  if (profile === 'jms-mutation') {
    const allowedMutation = (check?.mutations ?? []).some((rule) =>
      operationRuleMatches(rule, normalizedMethod, sanitizedPath),
    )
    const allowedReadAction = (check?.readActions ?? []).some((rule) =>
      operationRuleMatches(rule, normalizedMethod, sanitizedPath),
    )
    if (allowedMutation || allowedReadAction) return
    throw new Error(
      `Smoke REST audit blocked undeclared JMS mutation request in ${activeCheckName}: ${normalizedMethod} ${sanitizedPath}`,
    )
  }

  if (profile === 'topology-config') {
    const allowedReadAction = (check?.readActions ?? []).some((rule) =>
      operationRuleMatches(rule, normalizedMethod, sanitizedPath),
    )
    if (allowedMutation || allowedReadAction) return
    throw new Error(
      `Smoke REST audit blocked undeclared topology configuration request in ${activeCheckName}: ${normalizedMethod} ${sanitizedPath}`,
    )
  }

  throw new Error(`Unsupported smoke profile ${profile}`)
}

function auditHelperWlsRequest(path, init) {
  if (!activeSmokeCheck) return
  auditSmokeRequest({
    profile: activeSmokeCheck.profile,
    check: activeSmokeCheck,
    method: init.method ?? 'GET',
    path,
  })
}

async function fetchWlsProxy(path, creds, init = {}, timeoutMs = WLS_PROXY_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const url = new URL(`/api/wls${path}`, APP_URL)
  auditHelperWlsRequest(path, init)

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: authHeader(creds),
        [WLS_TARGET_HEADER]: WLS_TARGET_URL,
        'X-Requested-By': 'wls-cockpit',
        ...init.headers,
      },
    })
    if (!res.ok) throw new Error(`WLS proxy ${init.method ?? 'GET'} ${path}: ${res.status} ${res.statusText}`)
    if (res.status === 204) return null
    const text = await res.text()
    return text ? JSON.parse(text) : null
  } finally {
    clearTimeout(timer)
  }
}

function lifecyclePath(creds, serverName, suffix = '') {
  const encodedServerName = encodeURIComponent(serverName)
  return `/management/weblogic/${creds.version}/domainRuntime/serverLifeCycleRuntimes/${encodedServerName}${suffix}`
}

function changeManagerPath(creds, suffix = '') {
  return `/management/weblogic/${creds.version}/edit/changeManager${suffix}`
}

function editCollectionPath(creds, collectionName) {
  return `/management/weblogic/${creds.version}/edit/${collectionName}`
}

function editResourcePath(creds, collectionName, resourceName) {
  return `${editCollectionPath(creds, collectionName)}/${encodeURIComponent(resourceName)}`
}

async function fetchServerLifecycleState(creds, serverName) {
  const data = await fetchWlsProxy(`${lifecyclePath(creds, serverName)}?fields=name,state&links=none`, creds)
  return typeof data?.state === 'string' ? data.state : 'UNKNOWN'
}

function items(data) {
  return Array.isArray(data?.items) ? data.items : []
}

async function firstJmsDestination(creds) {
  const servers = items(
    await fetchWlsProxy(
      `/management/weblogic/${creds.version}/domainRuntime/serverRuntimes?fields=name,state&links=none`,
      creds,
    ),
  ).filter((server) => ['RUNNING', 'ADMIN', 'STANDBY'].includes(server?.state))

  for (const server of servers) {
    if (typeof server?.name !== 'string') continue
    const jmsServers = items(
      await fetchWlsProxy(
        `/management/weblogic/${creds.version}/domainRuntime/serverRuntimes/${encodeURIComponent(server.name)}/JMSRuntime/JMSServers?fields=name,destinationsCurrentCount&links=none`,
        creds,
      ).catch(() => null),
    )

    for (const jmsServer of jmsServers) {
      if (typeof jmsServer?.name !== 'string') continue
      const destinations = items(
        await fetchWlsProxy(
          `/management/weblogic/${creds.version}/domainRuntime/serverRuntimes/${encodeURIComponent(server.name)}/JMSRuntime/JMSServers/${encodeURIComponent(jmsServer.name)}/destinations?fields=name,destinationType,messagesCurrentCount,messagesPendingCount,consumersCurrentCount&links=none`,
          creds,
        ).catch(() => null),
      )
      const destination = destinations.find((candidate) => typeof candidate?.name === 'string')
      if (destination) {
        return {
          serverName: server.name,
          jmsServerName: jmsServer.name,
          destinationName: destination.name,
          destinationType: typeof destination.destinationType === 'string' ? destination.destinationType : null,
        }
      }
    }
  }

  return null
}

async function preparedJmsQueue(creds) {
  const hint = JMS_MUTATION_DESTINATION_HINT.trim()
  if (!hint) throw new Error('WLS_SMOKE_JMS_DESTINATION_HINT must identify the prepared disposable JMS queue.')

  const servers = items(
    await fetchWlsProxy(
      `/management/weblogic/${creds.version}/domainRuntime/serverRuntimes?fields=name,state&links=none`,
      creds,
    ),
  ).filter((server) => ['RUNNING', 'ADMIN', 'STANDBY'].includes(server?.state))

  for (const server of servers) {
    if (typeof server?.name !== 'string') continue
    const jmsServers = items(
      await fetchWlsProxy(
        `/management/weblogic/${creds.version}/domainRuntime/serverRuntimes/${encodeURIComponent(server.name)}/JMSRuntime/JMSServers?fields=name,destinationsCurrentCount&links=none`,
        creds,
      ).catch(() => null),
    )

    for (const jmsServer of jmsServers) {
      if (typeof jmsServer?.name !== 'string') continue
      const destinations = items(
        await fetchWlsProxy(
          `/management/weblogic/${creds.version}/domainRuntime/serverRuntimes/${encodeURIComponent(server.name)}/JMSRuntime/JMSServers/${encodeURIComponent(jmsServer.name)}/destinations?fields=name,destinationType,messagesCurrentCount,messagesPendingCount,consumersCurrentCount,productionPaused&links=none`,
          creds,
        ).catch(() => null),
      )
      const destination = destinations.find((candidate) => {
        if (typeof candidate?.name !== 'string') return false
        const type = typeof candidate.destinationType === 'string' ? candidate.destinationType.toLowerCase() : ''
        return candidate.name.includes(hint) && type.includes('queue')
      })
      if (destination) {
        return {
          serverName: server.name,
          jmsServerName: jmsServer.name,
          destinationName: destination.name,
          destinationType: typeof destination.destinationType === 'string' ? destination.destinationType : null,
          productionPaused: destination.productionPaused === true,
        }
      }
    }
  }

  throw new Error(`Prepared JMS queue matching WLS_SMOKE_JMS_DESTINATION_HINT=${hint} was not found; no message was sent.`)
}

function jmsDestinationPath(creds, destination, suffix = '') {
  return (
    `/management/weblogic/${creds.version}/domainRuntime/serverRuntimes/${encodeURIComponent(destination.serverName)}` +
    `/JMSRuntime/JMSServers/${encodeURIComponent(destination.jmsServerName)}` +
    `/destinations/${encodeURIComponent(destination.destinationName)}${suffix}`
  )
}

async function postJmsDestinationOperation(creds, destination, operation) {
  return fetchWlsProxy(jmsDestinationPath(creds, destination, `/${operation}`), creds, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
}

async function postServerLifecycle(creds, serverName, action, body = {}) {
  return fetchWlsProxy(lifecyclePath(creds, serverName, `/${action}`), creds, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function waitForServerLifecycleState(creds, serverName, states, timeoutMs = WLS_RESTORE_TIMEOUT_MS) {
  let lastState = null
  return waitFor(async () => {
    lastState = await fetchServerLifecycleState(creds, serverName).catch((error) => {
      lastState = error instanceof Error ? error.message : String(error)
      return null
    })
    return states.includes(lastState) ? lastState : null
  }, timeoutMs).catch((error) => {
    throw new Error(`Timed out waiting for ${serverName} lifecycle state ${states.join('/')} via REST. Last=${lastState ?? error.message}`)
  })
}

async function restoreServerShutdownViaRest(creds, serverName) {
  let state = await fetchServerLifecycleState(creds, serverName)
  if (state === 'SHUTDOWN') return state

  if (state === 'SHUTTING_DOWN') {
    return waitForServerLifecycleState(creds, serverName, ['SHUTDOWN'])
  }

  if (['STARTING', 'SUSPENDING', 'RESUMING'].includes(state)) {
    state = await waitForServerLifecycleState(creds, serverName, [
      'RUNNING',
      'ADMIN',
      'STANDBY',
      'SUSPENDED',
      'SHUTDOWN',
    ])
    if (state === 'SHUTDOWN') return state
  }

  if (['SUSPENDED', 'ADMIN', 'STANDBY'].includes(state)) {
    await postServerLifecycle(creds, serverName, 'resume').catch(() => undefined)
    state = await waitForServerLifecycleState(creds, serverName, ['RUNNING', 'SHUTDOWN'])
    if (state === 'SHUTDOWN') return state
  }

  await postServerLifecycle(creds, serverName, 'shutdown', { timeout: 0, ignoreSessions: false }).catch(() => undefined)
  return waitForServerLifecycleState(creds, serverName, ['SHUTDOWN'])
}

async function isCdpReady() {
  try {
    await fetchJson(`${CDP_URL}/json/version`)
    return true
  } catch {
    return false
  }
}

async function launchChromeIfNeeded() {
  if (await isCdpReady()) return null

  const child = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CHROME_USER_DATA_DIR}`,
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await isCdpReady()) return child
    await sleep(250)
  }

  child.kill()
  throw new Error(`Chrome DevTools endpoint did not start at ${CDP_URL}`)
}

async function newTarget() {
  return fetchJson(`${CDP_URL}/json/new?about:blank`, { method: 'PUT' })
}

function createCdpSession(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  const events = []

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    } else if (message.method) {
      events.push(message)
    }
  })

  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  function send(method, params = {}) {
    const id = ++seq
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, 15_000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(`${method}: ${message.error.message}`))
        else resolve(message.result)
      })
    })
  }

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }

  return {
    events,
    close: () => ws.close(),
    opened,
    send,
    evaluate,
  }
}

async function closeCdpPage(session) {
  await Promise.race([
    session.send('Page.close'),
    sleep(1_000),
  ]).catch(() => undefined)
}

async function waitFor(predicate, timeoutMs = 45_000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeoutMs) {
    last = await predicate()
    if (last) return last
    await sleep(300)
  }
  throw new Error(`Timed out waiting for smoke condition. Last=${JSON.stringify(last)}`)
}

async function setCredentials(session, creds) {
  const activeConnection = {
    profileId: SMOKE_PROFILE_ID,
    name: SMOKE_PROFILE_NAME,
    targetUrl: WLS_TARGET_URL,
    username: creds.username,
    password: creds.password,
    version: creds.version,
  }

  await session.evaluate(`
    sessionStorage.setItem(${JSON.stringify(ACTIVE_CONNECTION_STORAGE_KEY)}, JSON.stringify(${JSON.stringify(activeConnection)}));
    sessionStorage.setItem(${JSON.stringify(LEGACY_CREDENTIALS_STORAGE_KEY)}, JSON.stringify(${JSON.stringify(creds)}));
    true;
  `)
}

async function navigate(session, path, creds) {
  await session.send('Page.navigate', { url: `${APP_URL}${path}` })
  await waitFor(() => session.evaluate('document.readyState !== "loading"'))
  await setCredentials(session, creds)
  await session.evaluate(`location.href = ${JSON.stringify(path)}; true;`)
  await waitFor(() => session.evaluate('document.readyState !== "loading"'))
}

async function installDemoReadOnlyRuntime(session) {
  const source = `
    window.__WLS_COCKPIT_RUNTIME__ = {
      ...(window.__WLS_COCKPIT_RUNTIME__ || {}),
      readOnlyDemoMode: true
    };
  `
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source,
  })
  await session.evaluate(source)
}

async function installEditSessionStatusMock(session, status) {
  const source = `
    {
      const mockedStatus = ${JSON.stringify(status)};
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input && input.url;
        if (String(url || '').includes('/api/wls') && String(url || '').includes('/edit/changeManager')) {
          return Promise.resolve(new Response(JSON.stringify(mockedStatus), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }));
        }
        return originalFetch(input, init);
      };
    }
  `
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source,
  })
  await session.evaluate(source)
}

async function screenshot(session, name) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const result = await session.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  })
  const path = resolve(ARTIFACT_DIR, `${name}.png`)
  await writeFile(path, Buffer.from(result.data, 'base64'))
  return path
}

export function failedNotRestartableStartAffordanceIssues(rows) {
  return rows
    .filter((row) => row.text.includes('FAILED_NOT_RESTARTABLE') && !row.text.includes('AdminServer'))
    .flatMap((row) => {
      const startButton = row.buttons.find((button) => button.text.includes('Start'))
      if (!startButton) return [`${row.text}: Start action missing`]
      if (startButton.disabled) return [`${row.text}: Start action disabled`]
      return []
    })
}

async function assertFailedNotRestartableStartAffordance(session, checkName) {
  const rows = await session.evaluate(`
    [...document.querySelectorAll('tbody tr')].map((row) => ({
      text: row.innerText,
      buttons: [...row.querySelectorAll('button')].map((button) => ({
        text: button.innerText.trim(),
        disabled: button.disabled
      }))
    }));
  `)
  const issues = failedNotRestartableStartAffordanceIssues(rows)
  if (issues.length > 0) {
    throw new Error(`${checkName}: failed-not-restartable start affordance invalid: ${issues.join(' | ')}`)
  }
}

async function confirmDestructiveDialog(session) {
  return confirmDialogButton(session, 'destructive action', 'Confirm')
}

async function confirmDialogButton(session, name, label) {
  let lastResult = null
  try {
    return await waitFor(async () => {
      lastResult = await session.evaluate(`
        (() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return { ok: false, reason: 'dialog-missing', text: null };
          const label = ${JSON.stringify(label)};
          const button = [...dialog.querySelectorAll('button')].find((candidate) =>
            candidate.innerText.trim().startsWith(label)
          );
          if (!button) return { ok: false, reason: 'button-missing', text: dialog.innerText };
          if (button.disabled) return { ok: false, reason: 'button-disabled', text: dialog.innerText };
          button.click();
          return { ok: true, reason: null, text: dialog.innerText };
        })();
      `)
      return lastResult?.ok ? lastResult.text : null
    })
  } catch {
    throw new Error(
      `Unable to confirm ${name}: ${lastResult?.reason ?? 'unknown'} dialog=${
        JSON.stringify(lastResult?.text) ?? '-'
      }`,
    )
  }
}

async function serverRowText(session, serverName) {
  return session.evaluate(`
    (() => {
      const serverName = ${JSON.stringify(serverName)};
      const rows = [...document.querySelectorAll('tbody tr')];
      const row = rows.find((candidate) => candidate.innerText.includes(serverName));
      return row ? row.innerText : null;
    })();
  `)
}

async function waitForServerRow(session, serverName, timeoutMs = 45_000) {
  return waitFor(() => serverRowText(session, serverName), timeoutMs)
}

async function waitForServerState(session, serverName, state, timeoutMs = 180_000) {
  return waitFor(async () => {
    const body = await session.evaluate('document.body.innerText')
    if (body.includes('Lifecycle action failed')) {
      throw new Error(body.split('\n').filter(Boolean).slice(0, 24).join(' | '))
    }

    const text = await serverRowText(session, serverName)
    return text?.includes(state) ? text : null
  }, timeoutMs)
}

async function waitForServerAnyState(session, serverName, states, timeoutMs = 180_000) {
  return waitFor(async () => {
    const body = await session.evaluate('document.body.innerText')
    if (body.includes('Lifecycle action failed')) {
      throw new Error(body.split('\n').filter(Boolean).slice(0, 24).join(' | '))
    }

    const text = await serverRowText(session, serverName)
    return states.some((state) => text?.includes(state)) ? text : null
  }, timeoutMs)
}

async function clickServerLifecycleAction(session, serverName, label) {
  let lastResult = null
  try {
    return await waitFor(async () => {
      lastResult = await session.evaluate(`
        (() => {
          const serverName = ${JSON.stringify(serverName)};
          const label = ${JSON.stringify(label)};
          const rows = [...document.querySelectorAll('tbody tr')];
          const row = rows.find((candidate) => candidate.innerText.includes(serverName));
          if (!row) return { ok: false, reason: 'row-missing', rowText: null };

          const button = [...row.querySelectorAll('button')].find((candidate) =>
            candidate.innerText.trim().includes(label)
          );
          if (!button) return { ok: false, reason: 'button-missing', rowText: row.innerText };
          if (button.disabled) return { ok: false, reason: 'button-disabled', rowText: row.innerText };

          button.click();
          return { ok: true, reason: null, rowText: row.innerText };
        })();
      `)

      if (!lastResult?.ok) return null
      if (label === 'Shutdown' || label === 'Suspend') await confirmDestructiveDialog(session)
      return lastResult.rowText
    })
  } catch {
    throw new Error(
      `Unable to click ${label} for ${serverName}: ${lastResult?.reason ?? 'unknown'} row=${
        JSON.stringify(lastResult?.rowText) ?? '-'
      }`,
    )
  }
}

async function promoteServerToRunning(session, serverName) {
  const row = await serverRowText(session, serverName)
  if (row?.includes('RUNNING')) return row
  if (row?.includes('ADMIN') || row?.includes('STANDBY') || row?.includes('SUSPENDED')) {
    await clickServerLifecycleAction(session, serverName, 'Resume')
    return waitForServerState(session, serverName, 'RUNNING')
  }
  return row
}

async function deploymentRowText(session, applicationName, targetName) {
  return session.evaluate(`
    (() => {
      const applicationName = ${JSON.stringify(applicationName)};
      const targetName = ${JSON.stringify(targetName)};
      const rows = [...document.querySelectorAll('tbody tr')];
      const row = rows.find((candidate) =>
        candidate.innerText.includes(applicationName) &&
        candidate.innerText.includes(targetName) &&
        !/\\binstances\\b/i.test(candidate.innerText)
      );
      return row ? row.innerText : null;
    })();
  `)
}

function deploymentRowIsActive(text) {
  return /\bACTIVE\b|\bACTIVATED\b|\bACTIVE_ADMIN\b/.test(text.toUpperCase())
}

function deploymentPendingLabel(label) {
  if (label === 'Start') return 'Starting…'
  if (label === 'Stop') return 'Stopping…'
  if (label === 'Redeploy') return 'Redeploying…'
  return `${label}ing…`
}

async function waitForDeploymentRow(session, applicationName, targetName, timeoutMs = 45_000) {
  return waitFor(() => deploymentRowText(session, applicationName, targetName), timeoutMs)
}

async function waitForDeploymentActive(session, applicationName, targetName, timeoutMs = 180_000) {
  return waitFor(async () => {
    const body = await session.evaluate('document.body.innerText')
    if (body.includes('Deployment action failed')) {
      throw new Error(body.split('\n').filter(Boolean).slice(0, 24).join(' | '))
    }

    const text = await deploymentRowText(session, applicationName, targetName)
    return text && deploymentRowIsActive(text) ? text : null
  }, timeoutMs)
}

async function waitForDeploymentNonActive(session, applicationName, targetName, timeoutMs = 180_000) {
  return waitFor(async () => {
    const body = await session.evaluate('document.body.innerText')
    if (body.includes('Deployment action failed')) {
      throw new Error(body.split('\n').filter(Boolean).slice(0, 24).join(' | '))
    }

    const text = await deploymentRowText(session, applicationName, targetName)
    return text && !deploymentRowIsActive(text) ? text : null
  }, timeoutMs)
}

async function waitForDeploymentActionIdle(session, applicationName, targetName, label, timeoutMs = 45_000) {
  const pendingLabel = deploymentPendingLabel(label)
  return waitFor(async () => {
    const body = await session.evaluate('document.body.innerText')
    if (body.includes('Deployment action failed')) {
      throw new Error(body.split('\n').filter(Boolean).slice(0, 24).join(' | '))
    }

    const text = await deploymentRowText(session, applicationName, targetName)
    return text && !text.includes(pendingLabel) ? text : null
  }, timeoutMs)
}

async function waitForDeploymentActionAccepted(session, applicationName, label, timeoutMs = 45_000) {
  return waitFor(async () => {
    const body = await session.evaluate('document.body.innerText')
    if (body.includes('Deployment action failed')) {
      throw new Error(body.split('\n').filter(Boolean).slice(0, 24).join(' | '))
    }

    return body.includes('Deployment progress accepted') && body.includes(`${label} ${applicationName}`) ? body : null
  }, timeoutMs)
}

async function clickDeploymentLifecycleAction(session, applicationName, targetName, label) {
  let lastResult = null
  try {
    return await waitFor(async () => {
      lastResult = await session.evaluate(`
        (() => {
          const applicationName = ${JSON.stringify(applicationName)};
          const targetName = ${JSON.stringify(targetName)};
          const label = ${JSON.stringify(label)};
          const rows = [...document.querySelectorAll('tbody tr')];
          const row = rows.find((candidate) =>
            candidate.innerText.includes(applicationName) &&
            candidate.innerText.includes(targetName) &&
            !/\\binstances\\b/i.test(candidate.innerText)
          );
          if (!row) return { ok: false, reason: 'row-missing', rowText: null };

          const button = [...row.querySelectorAll('button')].find((candidate) =>
            candidate.innerText.trim().includes(label)
          );
          if (!button) return { ok: false, reason: 'button-missing', rowText: row.innerText };
          if (button.disabled) return { ok: false, reason: 'button-disabled', rowText: row.innerText };

          button.click();
          return { ok: true, reason: null, rowText: row.innerText };
        })();
      `)

      if (!lastResult?.ok) return null
      if (label === 'Stop' || label === 'Undeploy') await confirmDestructiveDialog(session)
      return lastResult.rowText
    })
  } catch {
    throw new Error(
      `Unable to click ${label} for ${applicationName} on ${targetName}: ${lastResult?.reason ?? 'unknown'} row=${
        JSON.stringify(lastResult?.rowText) ?? '-'
      }`,
    )
  }
}

async function dataSourceRowText(session, dataSourceName, serverName) {
  return session.evaluate(`
    (() => {
      const dataSourceName = ${JSON.stringify(dataSourceName)};
      const serverName = ${JSON.stringify(serverName)};
      const rows = [...document.querySelectorAll('tbody tr')];
      const row = rows.find((candidate) =>
        candidate.innerText.includes(dataSourceName) && candidate.innerText.includes(serverName)
      );
      return row ? row.innerText : null;
    })();
  `)
}

function dataSourceRowIsRunning(text) {
  return /\bRUNNING\b/i.test(text)
}

function dataSourceRowIsSuspended(text) {
  return /\bSUSPENDED\b/i.test(text)
}

async function waitForDataSourceRow(session, dataSourceName, serverName, timeoutMs = 45_000) {
  return waitFor(() => dataSourceRowText(session, dataSourceName, serverName), timeoutMs)
}

async function waitForDataSourceRunning(session, dataSourceName, serverName, timeoutMs = 180_000) {
  return waitFor(async () => {
    const body = await session.evaluate('document.body.innerText')
    if (body.includes('Datasource action failed')) {
      throw new Error(body.split('\n').filter(Boolean).slice(0, 24).join(' | '))
    }

    const text = await dataSourceRowText(session, dataSourceName, serverName)
    return text && dataSourceRowIsRunning(text) ? text : null
  }, timeoutMs)
}

async function waitForDataSourceSuspended(session, dataSourceName, serverName, timeoutMs = 180_000) {
  return waitFor(async () => {
    const body = await session.evaluate('document.body.innerText')
    if (body.includes('Datasource action failed')) {
      throw new Error(body.split('\n').filter(Boolean).slice(0, 24).join(' | '))
    }

    const text = await dataSourceRowText(session, dataSourceName, serverName)
    return text && dataSourceRowIsSuspended(text) ? text : null
  }, timeoutMs)
}

async function waitForDataSourceActionCompleted(session, timeoutMs = 45_000) {
  return waitFor(async () => {
    const body = await session.evaluate('document.body.innerText')
    if (body.includes('Datasource action failed')) {
      throw new Error(body.split('\n').filter(Boolean).slice(0, 24).join(' | '))
    }
    return body.includes('Datasource action completed') ? body : null
  }, timeoutMs)
}

async function clickDataSourceLifecycleAction(session, dataSourceName, serverName, label) {
  let lastResult = null
  try {
    return await waitFor(async () => {
      lastResult = await session.evaluate(`
        (() => {
          const dataSourceName = ${JSON.stringify(dataSourceName)};
          const serverName = ${JSON.stringify(serverName)};
          const label = ${JSON.stringify(label)};
          const rows = [...document.querySelectorAll('tbody tr')];
          const row = rows.find((candidate) =>
            candidate.innerText.includes(dataSourceName) && candidate.innerText.includes(serverName)
          );
          if (!row) return { ok: false, reason: 'row-missing', rowText: null };

          const button = [...row.querySelectorAll('button')].find((candidate) =>
            candidate.innerText.trim().includes(label)
          );
          if (!button) return { ok: false, reason: 'button-missing', rowText: row.innerText };
          if (button.disabled) return { ok: false, reason: 'button-disabled', rowText: row.innerText };

          button.click();
          return { ok: true, reason: null, rowText: row.innerText };
        })();
      `)

      if (!lastResult?.ok) return null
      if (label === 'Suspend' || label === 'Reset' || label === 'Delete') await confirmDestructiveDialog(session)
      return lastResult.rowText
    })
  } catch {
    throw new Error(
      `Unable to click ${label} for ${dataSourceName} on ${serverName}: ${lastResult?.reason ?? 'unknown'} row=${
        JSON.stringify(lastResult?.rowText) ?? '-'
      }`,
    )
  }
}

async function restoreServerShutdown(session, serverName) {
  const row = await serverRowText(session, serverName).catch(() => null)
  if (!row || row.includes('SHUTDOWN')) return

  if (row.includes('SUSPENDING')) {
    await waitForServerState(session, serverName, 'SUSPENDED')
  }

  if (row.includes('RESUMING')) {
    await waitForServerState(session, serverName, 'RUNNING')
  }

  if (row.includes('SHUTTING_DOWN')) {
    await waitForServerState(session, serverName, 'SHUTDOWN')
    return
  }

  if (row.includes('STARTING')) {
    await waitForServerAnyState(session, serverName, ['RUNNING', 'ADMIN', 'STANDBY'])
  }

  const current = await serverRowText(session, serverName)
  if (current?.includes('SUSPENDED') || current?.includes('ADMIN') || current?.includes('STANDBY')) {
    await promoteServerToRunning(session, serverName)
  }

  const shutdownCandidate = await serverRowText(session, serverName)
  if (shutdownCandidate?.includes('RUNNING')) {
    await clickServerLifecycleAction(session, serverName, 'Shutdown')
    await waitForServerState(session, serverName, 'SHUTDOWN')
  } else if (shutdownCandidate?.includes('SHUTDOWN')) {
    return
  }
}

async function restoreDeploymentActive(session, applicationName, targetName) {
  const row = await deploymentRowText(session, applicationName, targetName).catch(() => null)
  if (!row || deploymentRowIsActive(row)) return

  if (row.includes('Starting…')) {
    await waitForDeploymentActive(session, applicationName, targetName)
    return
  }

  await clickDeploymentLifecycleAction(session, applicationName, targetName, 'Start')
  await waitForDeploymentActive(session, applicationName, targetName)
}

async function restoreDataSourceRunning(session, dataSourceName, serverName) {
  const row = await dataSourceRowText(session, dataSourceName, serverName).catch(() => null)
  if (!row || dataSourceRowIsRunning(row)) return

  await clickDataSourceLifecycleAction(session, dataSourceName, serverName, 'Resume')
  await waitForDataSourceRunning(session, dataSourceName, serverName)
}

function assertText(name, text, expected, forbidden = []) {
  const missing = expected.filter((needle) => !text.includes(needle))
  const presentForbidden = forbidden.filter((needle) => text.includes(needle))
  if (missing.length || presentForbidden.length) {
    throw new Error(
      `${name} failed text assertions. Missing=${missing.join(', ') || '-'} Forbidden=${
        presentForbidden.join(', ') || '-'
      }`,
    )
  }
}

async function assertHrefs(session, name, hrefs = []) {
  if (hrefs.length === 0) return
  const found = await session.evaluate(`
    [...document.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href')).filter(Boolean)
  `)
  const missing = hrefs.filter((href) => !found.includes(href))
  if (missing.length) {
    throw new Error(`${name} failed href assertions. Missing=${missing.join(', ')} Found=${found.join(', ')}`)
  }
}

function searchParamEntries(path) {
  const params = new URL(path, APP_URL).searchParams
  return [...params.keys()].sort().map((key) => [key, params.getAll(key)])
}

function formatParamEntries(entries) {
  return entries.map(([key, values]) => `${key}=${values.join(',')}`).join('&')
}

function paramEntriesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function routeStateComparison(session, expectedPath) {
  const expected = new URL(expectedPath, APP_URL)
  const actual = await session.evaluate(`
    ({ pathname: window.location.pathname, search: window.location.search });
  `)
  const actualUrl = new URL(`${actual.pathname}${actual.search}`, APP_URL)
  const expectedParams = searchParamEntries(expectedPath)
  const actualParams = searchParamEntries(`${actualUrl.pathname}${actualUrl.search}`)

  return {
    ok: actualUrl.pathname === expected.pathname && paramEntriesEqual(actualParams, expectedParams),
    expectedPathname: expected.pathname,
    actualPathname: actualUrl.pathname,
    expectedParams,
    actualParams,
  }
}

function routeStateError(name, comparison) {
  if (!comparison) return `${name} route assertion failed before route state could be read`
  if (comparison.actualPathname !== comparison.expectedPathname) {
    return `${name} route assertion failed. Expected path=${comparison.expectedPathname} Actual=${comparison.actualPathname}`
  }
  return `${name} search assertion failed. Expected=${formatParamEntries(
    comparison.expectedParams,
  )} Actual=${formatParamEntries(comparison.actualParams)}`
}

async function assertRouteState(session, name, expectedPath) {
  const comparison = await routeStateComparison(session, expectedPath)
  if (!comparison.ok) {
    throw new Error(routeStateError(name, comparison))
  }
}

async function waitForRouteState(session, name, expectedPath) {
  let lastComparison = null
  try {
    return await waitFor(async () => {
      lastComparison = await routeStateComparison(session, expectedPath)
      return lastComparison.ok ? true : null
    })
  } catch {
    throw new Error(routeStateError(name, lastComparison))
  }
}

async function waitForExpectedText(session, name, expected, forbidden = []) {
  let lastBody = ''
  const text = await waitFor(async () => {
    lastBody = await session.evaluate('document.body.innerText')
    return expected.every((needle) => lastBody.includes(needle)) ? lastBody : null
  }).catch((error) => {
    const sample = lastBody.split('\n').filter(Boolean).slice(0, 24).join(' | ')
    const missing = expected.filter((needle) => !lastBody.includes(needle))
    throw new Error(`${name}: ${error.message}. Missing=${missing.join(', ') || '-'}. Body=${sample}`)
  })
  assertText(name, text, expected, forbidden)
  return text
}

async function waitForAnyExpectedText(session, name, expected, anyExpected, forbidden = []) {
  let lastBody = ''
  const text = await waitFor(async () => {
    lastBody = await session.evaluate('document.body.innerText')
    const hasBase = expected.every((needle) => lastBody.includes(needle))
    const hasAny = anyExpected.some((needle) => lastBody.includes(needle))
    return hasBase && hasAny ? lastBody : null
  }).catch((error) => {
    const sample = lastBody.split('\n').filter(Boolean).slice(0, 24).join(' | ')
    const missing = expected.filter((needle) => !lastBody.includes(needle))
    const anyFound = anyExpected.filter((needle) => lastBody.includes(needle))
    throw new Error(
      `${name}: ${error.message}. Missing=${missing.join(', ') || '-'} AnyFound=${anyFound.join(', ') || '-'} AnyExpected=${anyExpected.join(', ') || '-'}. Body=${sample}`,
    )
  })
  assertText(name, text, expected, forbidden)
  return text
}

async function clickRouteLink(session, name, href) {
  let lastResult = null
  try {
    return await waitFor(async () => {
      lastResult = await session.evaluate(`
        (() => {
          const expected = new URL(${JSON.stringify(href)}, window.location.origin);
          const expectedParams = [...expected.searchParams.keys()].sort().map((key) => [
            key,
            expected.searchParams.getAll(key),
          ]);
          const sameParams = (url) => {
            const actualParams = [...url.searchParams.keys()].sort().map((key) => [
              key,
              url.searchParams.getAll(key),
            ]);
            return JSON.stringify(actualParams) === JSON.stringify(expectedParams);
          };
          const link = [...document.querySelectorAll('a')].find((anchor) => {
            const url = new URL(anchor.href, window.location.origin);
            return url.pathname === expected.pathname && sameParams(url);
          });
          if (!link) {
            return {
              ok: false,
              reason: 'link-missing',
              hrefs: [...document.querySelectorAll('a')]
                .map((anchor) => new URL(anchor.href, window.location.origin).pathname + new URL(anchor.href, window.location.origin).search)
                .filter(Boolean),
            };
          }
          link.click();
          return { ok: true, reason: null, hrefs: [] };
        })();
      `)
      return lastResult?.ok ? true : null
    })
  } catch {
    throw new Error(
      `${name} unable to click link ${href}: ${lastResult?.reason ?? 'unknown'} hrefs=${
        JSON.stringify(lastResult?.hrefs) ?? '-'
      }`,
    )
  }
}

async function clickButtonContaining(session, name, label) {
  let lastResult = null
  try {
    return await waitFor(async () => {
      lastResult = await session.evaluate(`
        (() => {
          const label = ${JSON.stringify(label)};
          const button = [...document.querySelectorAll('button')].find((candidate) =>
            candidate.innerText.trim().includes(label)
          );
          if (!button) return { ok: false, reason: 'button-missing', body: document.body.innerText };
          if (button.disabled) return { ok: false, reason: 'button-disabled', body: document.body.innerText };
          button.click();
          return { ok: true, reason: null, body: document.body.innerText };
        })();
      `)
      return lastResult?.ok ? true : null
    })
  } catch {
    throw new Error(
      `${name} unable to click button ${label}: ${lastResult?.reason ?? 'unknown'} body=${
        JSON.stringify(lastResult?.body?.split('\\n').filter(Boolean).slice(0, 24)) ?? '-'
      }`,
    )
  }
}

async function pushSpaRoute(session, name, path) {
  await session.evaluate(`
    (() => {
      const path = ${JSON.stringify(path)};
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
      return true;
    })();
  `)
  await waitForRouteState(session, name, path)
}

async function installDownloadCapture(session) {
  await session.evaluate(`
    (() => {
      window.__wlsCockpitCapturedDownloads = [];
      if (window.__wlsCockpitDownloadCaptureInstalled) return true;
      window.__wlsCockpitDownloadCaptureInstalled = true;
      const originalCreateObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        if (blob && typeof blob.text === 'function') {
          blob.text().then((text) => {
            window.__wlsCockpitCapturedDownloads.push(text);
          });
        }
        return originalCreateObjectURL(blob);
      };
      return true;
    })();
  `)
}

async function capturedDownloads(session) {
  return session.evaluate('window.__wlsCockpitCapturedDownloads ?? []')
}

const themeCoverageRoutes = liveChecks.filter((check) =>
  ['dashboard-live', 'servers-live', 'clusters-live', 'deployments-live', 'data-sources-live', 'logs-live'].includes(check.name),
)

async function resetThemePreference(session) {
  await session.evaluate(`
    localStorage.removeItem(${JSON.stringify(THEME_MODE_STORAGE_KEY)});
    true;
  `)
}

async function themeState(session, selectedMode) {
  return session.evaluate(`
    (() => {
      const button = document.querySelector(${JSON.stringify(`button[data-theme-mode="${selectedMode}"]`)});
      return {
        hasDarkClass: document.documentElement.classList.contains('dark'),
        datasetMode: document.documentElement.dataset.themeMode || null,
        storedMode: localStorage.getItem(${JSON.stringify(THEME_MODE_STORAGE_KEY)}),
        selectedPressed: button ? button.getAttribute('aria-pressed') : null,
        colorScheme: document.documentElement.style.colorScheme || null
      };
    })();
  `)
}

async function assertThemeState(session, selectedMode, resolvedMode) {
  let lastState = null
  try {
    return await waitFor(async () => {
      lastState = await themeState(session, selectedMode)
      const expectedDarkClass = resolvedMode === 'dark'
      if (lastState.hasDarkClass !== expectedDarkClass) return null
      if (lastState.datasetMode !== selectedMode) return null
      if (lastState.storedMode !== selectedMode) return null
      if (lastState.selectedPressed !== 'true') return null
      if (lastState.colorScheme !== resolvedMode) return null
      return lastState
    })
  } catch {
    throw new Error(
      `Theme state mismatch for selected=${selectedMode} resolved=${resolvedMode}: ${JSON.stringify(lastState)}`,
    )
  }
}

async function selectThemeMode(session, mode) {
  let lastResult = null
  try {
    await waitFor(async () => {
      lastResult = await session.evaluate(`
        (() => {
          const button = document.querySelector(${JSON.stringify(`button[data-theme-mode="${mode}"]`)});
          if (!button) {
            return {
              ok: false,
              reason: 'button-missing',
              modes: [...document.querySelectorAll('[data-theme-mode]')].map((node) => node.getAttribute('data-theme-mode'))
            };
          }
          button.click();
          return { ok: true, reason: null };
        })();
      `)
      return lastResult?.ok ? true : null
    })
  } catch {
    throw new Error(
      `Unable to select theme mode ${mode}: ${lastResult?.reason ?? 'unknown'} modes=${
        JSON.stringify(lastResult?.modes) ?? '-'
      }`,
    )
  }
}

async function openQuickJumpForTheme(session, mode) {
  await clickButtonContaining(session, `theme-mode-quick-jump-${mode}`, 'Jump')
  await waitFor(() =>
    session.evaluate(`
      (() => {
        const dialog = document.querySelector('[role="dialog"][aria-label="Quick jump"]');
        return dialog && dialog.textContent.includes('Dashboard') && dialog.textContent.includes('Servers');
      })();
    `),
  )
  const screenshotPath = await screenshot(session, `theme-mode-quick-jump-${mode}`)
  await session.evaluate(`
    const close = document.querySelector('button[aria-label="Close quick jump"]');
    close?.click();
    true;
  `)
  return screenshotPath
}

async function openDataSourceFormForTheme(session, mode) {
  await clickButtonContaining(session, `theme-mode-data-source-form-${mode}`, 'Create')
  const text = await waitForExpectedText(
    session,
    `theme-mode-data-source-form-${mode}`,
    ['JDBC URL', 'DRIVER PRESET', 'STATEMENT CACHE', 'Create'],
    ['Request failed'],
  )
  const screenshotPath = await screenshot(session, `theme-mode-data-source-form-${mode}`)
  await clickButtonContaining(session, `theme-mode-data-source-form-${mode}-cancel`, 'Cancel')
  return {
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runThemeModeCoverageSmoke(session, creds) {
  const results = []
  for (const mode of ['dark', 'light']) {
    for (const [index, check] of themeCoverageRoutes.entries()) {
      await navigate(session, check.path, creds)
      if (mode === 'dark' && index === 0) {
        await resetThemePreference(session)
        await navigate(session, check.path, creds)
      }

      const resolvedMode = mode
      const text = await waitForExpectedText(
        session,
        `theme-mode-${check.name}-${mode}`,
        check.expected,
        check.forbidden,
      )
      if (mode === 'light' && index === 0) {
        await selectThemeMode(session, mode)
      }
      await assertThemeState(session, mode, resolvedMode)
      const screenshotPath = await screenshot(session, `theme-mode-${check.name}-${mode}`)
      results.push({
        name: `theme-mode-${check.name}-${mode}`,
        path: check.path,
        mode,
        screenshot: screenshotPath,
        textSample: text.split('\n').filter(Boolean).slice(0, 16),
      })

      if (check.name === 'dashboard-live') {
        results.push({
          name: `theme-mode-quick-jump-${mode}`,
          path: check.path,
          mode,
          screenshot: await openQuickJumpForTheme(session, mode),
        })
      }

      if (check.name === 'data-sources-live') {
        results.push({
          name: `theme-mode-data-source-form-${mode}`,
          path: check.path,
          mode,
          ...(await openDataSourceFormForTheme(session, mode)),
        })
      }
    }
  }

  return {
    name: 'theme-mode-coverage-live',
    path: themeCoverageRoutes.map((check) => check.path).join(','),
    results,
  }
}

function failedNetworkResponses(events) {
  return events
    .filter((event) => {
      if (event.method !== 'Network.responseReceived' || event.params.response.status < 500) return false

      const { status, url } = event.params.response
      if (!url.includes('/api/wls/')) return false
      const server1DetailDuringLifecycle =
        status === 504 &&
        url.includes('/domainRuntime/serverRuntimes/server1/') &&
        (url.includes('/threadPoolRuntime') || url.includes('/JVMRuntime'))

      return !server1DetailDuringLifecycle
    })
    .map((event) => `${event.params.response.status} ${event.params.response.url}`)
}

function formatConsoleArg(arg) {
  if ('value' in arg) {
    if (typeof arg.value === 'string') return arg.value
    return JSON.stringify(arg.value)
  }
  return arg.description ?? arg.unserializableValue ?? arg.type
}

function browserConsoleIssues(events) {
  return events
    .filter((event) => {
      if (event.method !== 'Runtime.consoleAPICalled') return false
      return ['error', 'warning', 'assert'].includes(event.params.type)
    })
    .map((event) => {
      const message = event.params.args.map(formatConsoleArg).filter(Boolean).join(' ')
      return `${event.params.type}: ${message || 'console message without text'}`
    })
}

async function runDeploymentLifecycleSmoke(session, creds) {
  const applicationName = 'WLSCockpitDemoApp'
  const targetName = 'AdminServer'
  await navigate(session, '/deployments', creds)
  const initialRow = await waitForDeploymentRow(session, applicationName, targetName)

  try {
    if (!deploymentRowIsActive(initialRow)) {
      await clickDeploymentLifecycleAction(session, applicationName, targetName, 'Start')
      await waitForDeploymentActive(session, applicationName, targetName)
    }

    await clickDeploymentLifecycleAction(session, applicationName, targetName, 'Stop')
    const stoppedRow = await waitForDeploymentNonActive(session, applicationName, targetName)

    await clickDeploymentLifecycleAction(session, applicationName, targetName, 'Start')
    const restoredRow = await waitForDeploymentActive(session, applicationName, targetName)

    await clickDeploymentLifecycleAction(session, applicationName, targetName, 'Redeploy')
    await waitForDeploymentActionAccepted(session, applicationName, 'Redeploy')
    await waitForDeploymentActionIdle(session, applicationName, targetName, 'Redeploy')
    const redeployedRow = await waitForDeploymentActive(session, applicationName, targetName)

    const screenshotPath = await screenshot(session, 'deployments-lifecycle-restored')

    return {
      name: 'deployments-lifecycle',
      path: '/deployments',
      screenshot: screenshotPath,
      textSample: [stoppedRow, restoredRow, redeployedRow],
    }
  } finally {
    await restoreDeploymentActive(session, applicationName, targetName).catch((error) => {
      console.error(`Unable to restore ${applicationName} on ${targetName} to ACTIVE: ${error.message}`)
    })
  }
}

async function runDeploymentUrlSmoke(session, creds) {
  await navigate(session, '/deployments/AdminServer/WLSCockpitDemoApp', creds)
  await waitForExpectedText(
    session,
    'deployment-url-test-live',
    ['WLSCockpitDemoApp', 'Single application runtime snapshot.', 'Web Modules', 'SOURCE', 'SESSION', 'COOKIE', 'RELOAD/JSP', 'FLAGS', 'Test URL'],
    ['Coming soon', 'Request failed', 'Deployment not found'],
  )
  await clickButtonContaining(session, 'deployment-url-test-live', 'Test URL')
  const text = await waitFor(async () => {
    const body = await session.evaluate('document.body.innerText')
    return /\b(OK|REDIRECT|HTTP ERROR|TIMEOUT|BLOCKED|NETWORK)\b/.test(body) ? body : null
  })
  assertText('deployment-url-test-live', text, ['Web Modules', 'SOURCE', 'SESSION', 'COOKIE', 'RELOAD/JSP', 'FLAGS', 'Test URL'])
  const screenshotPath = await screenshot(session, 'deployment-url-test-live')

  return {
    name: 'deployment-url-test-live',
    path: '/deployments/AdminServer/WLSCockpitDemoApp',
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runDeploymentRequestMetricsSmoke(session, creds) {
  const path = process.env.WLS_SMOKE_DEPLOYMENT_METRICS_PATH ?? '/deployments/AdminServer/WLSCockpitDemoApp'
  await navigate(session, path, creds)
  const text = await waitForAnyExpectedText(
    session,
    'deployment-request-metrics-live',
    ['Request Metrics'],
    ['OPEN SESSIONS', 'INVOCATIONS', 'No servlet request counters were reported', 'No web request metrics were reported'],
    ['Coming soon', 'Request failed', 'Deployment not found'],
  )
  const mutationControls = await session.evaluate(`
    Array.from(document.querySelectorAll('button,a'))
      .map((node) => (node.textContent || '').trim())
      .filter((text) => /^(Start|Stop|Redeploy|Suspend|Resume|Edit|Delete|Save|Activate|Cancel|Thread dump|Heap dump|Test Pool)$/i.test(text))
  `)
  if (mutationControls.length) {
    throw new Error(`deployment-request-metrics-live: unexpected mutation controls: ${mutationControls.join(', ')}`)
  }
  const screenshotPath = await screenshot(session, 'deployment-request-metrics-live')
  return {
    name: 'deployment-request-metrics-live',
    path,
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runDeploymentMatrixSmoke(session, creds) {
  await navigate(session, '/deployments', creds)
  await waitForAnyExpectedText(
    session,
    'deployment-targeting-matrix-live-list',
    ['Deployments', 'Applications and deployment state.', 'INSTANCES'],
    ['EXTERNAL', 'INTERNAL', 'READ-ONLY', 'No application runtimes reported by running servers.'],
    ['Coming soon', 'Request failed'],
  )
  await clickButtonContaining(session, 'deployment-targeting-matrix-live', 'Matrix')
  const text = await waitForAnyExpectedText(
    session,
    'deployment-targeting-matrix-live',
    ['Deployments', 'DEPLOYMENT', 'DRIFT', 'EDIT'],
    ['CONFIG', 'RUNTIME', 'MISSING', 'No deployment matrix rows match the current filters.'],
    ['Coming soon', 'Request failed'],
  )
  const screenshotPath = await screenshot(session, 'deployment-targeting-matrix-live')
  return {
    name: 'deployment-targeting-matrix-live',
    path: '/deployments',
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runWorkManagersSmoke(session, creds) {
  await navigate(session, '/work-managers', creds)
  const text = await waitForAnyExpectedText(
    session,
    'work-managers-live',
    ['Work Managers', 'Runtime pressure', 'STATUS', 'SERVER', 'FAMILY', 'PENDING', 'REJECTED', 'CONSTRAINT'],
    ['work manager', 'thread pool', 'execute queue', 'No Work Manager runtimes reported by available servers.'],
    ['Coming soon', 'Request failed'],
  )
  const mutationControls = await session.evaluate(`
    Array.from(document.querySelectorAll('button,a'))
      .map((node) => (node.textContent || '').trim())
      .filter((text) => /^(Start|Shutdown|Suspend|Resume|Edit|Delete|Save|Activate|Cancel|Thread dump|Heap dump)$/i.test(text))
  `)
  if (mutationControls.length) {
    throw new Error(`work-managers-live: unexpected mutation controls: ${mutationControls.join(', ')}`)
  }
  const screenshotPath = await screenshot(session, 'work-managers-live')
  return {
    name: 'work-managers-live',
    path: '/work-managers',
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runNodeManagerConfigEditorSmoke(session, creds) {
  await navigate(session, '/node-manager', creds)
  await waitForExpectedText(
    session,
    'node-manager-config-editor-live-list',
    ['Node Manager', 'Machine reachability', 'MACHINE', 'STATUS', 'LISTEN', 'Create machine', 'Assign servers'],
    ['Coming soon', 'Request failed'],
  )
  await clickButtonContaining(session, 'node-manager-config-editor-live-create', 'Create machine')
  await waitForExpectedText(
    session,
    'node-manager-config-editor-live-create-form',
    ['CREATE MACHINE', 'MACHINE', 'LISTEN ADDRESS', 'LISTEN PORT', 'TYPE', 'SOCKET TIMEOUT', 'Save'],
    ['Request failed'],
  )
  await clickButtonContaining(session, 'node-manager-config-editor-live-create-cancel', 'Cancel')
  await clickButtonContaining(session, 'node-manager-config-editor-live-assignment', 'Assign servers')
  const text = await waitForExpectedText(
    session,
    'node-manager-config-editor-live-assignment-form',
    ['SERVER MACHINE ASSIGNMENT', 'Only stopped eligible managed servers', 'SERVER', 'LIFECYCLE', 'MACHINE', 'Save assignments'],
    ['Request failed'],
  )
  const screenshotPath = await screenshot(session, 'node-manager-config-editor-live')
  return {
    name: 'node-manager-config-editor-live',
    path: '/node-manager',
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runDataSourceLifecycleSmoke(session, creds) {
  const dataSourceName = 'WLSCockpitDemoDS'
  const serverName = 'AdminServer'
  await navigate(session, '/data-sources', creds)
  const initialRow = await waitForDataSourceRow(session, dataSourceName, serverName)

  try {
    if (!dataSourceRowIsRunning(initialRow)) {
      await clickDataSourceLifecycleAction(session, dataSourceName, serverName, 'Resume')
      await waitForDataSourceRunning(session, dataSourceName, serverName)
    }

    await clickDataSourceLifecycleAction(session, dataSourceName, serverName, 'Test')
    await waitForDataSourceActionCompleted(session)

    await clickDataSourceLifecycleAction(session, dataSourceName, serverName, 'Suspend')
    const suspendedRow = await waitForDataSourceSuspended(session, dataSourceName, serverName)

    await clickDataSourceLifecycleAction(session, dataSourceName, serverName, 'Resume')
    const restoredRow = await waitForDataSourceRunning(session, dataSourceName, serverName)
    let pageText = await session.evaluate('document.body.innerText')
    assertText('data-sources-config-affordances', pageText, ['Create', 'TARGETS', 'JNDI', 'Edit', 'Targets', 'Delete'])
    await clickButtonContaining(session, 'data-sources-create-affordance', 'Create')
    pageText = await waitForExpectedText(
      session,
      'data-sources-create-form-affordances',
      [
        'DRIVER PRESET',
        'URL MODE',
        'Oracle Thin',
        'Manual URL',
        'CAPACITY',
        'VALIDATION',
        'STATEMENT CACHE',
        'LIFECYCLE AND RETRY',
        'TRANSACTIONS',
      ],
      ['Request failed'],
    )
    const screenshotPath = await screenshot(session, 'data-sources-lifecycle-restored')

    return {
      name: 'data-sources-lifecycle',
      path: '/data-sources',
      screenshot: screenshotPath,
      textSample: [suspendedRow, restoredRow, ...pageText.split('\n').filter(Boolean).slice(0, 8)],
    }
  } finally {
    await restoreDataSourceRunning(session, dataSourceName, serverName).catch((error) => {
      console.error(`Unable to restore ${dataSourceName} on ${serverName} to RUNNING: ${error.message}`)
    })
  }
}

async function runLifecycleSmoke(session, creds) {
  const serverName = 'server1'
  try {
    await navigate(session, '/servers', creds)
    const initialRow = await waitForServerRow(session, serverName)

    if (initialRow.includes('SUSPENDED') || initialRow.includes('ADMIN') || initialRow.includes('STANDBY')) {
      await promoteServerToRunning(session, serverName)
      await clickServerLifecycleAction(session, serverName, 'Shutdown')
      await waitForServerState(session, serverName, 'SHUTDOWN')
    } else if (initialRow.includes('RUNNING')) {
      await clickServerLifecycleAction(session, serverName, 'Shutdown')
      await waitForServerState(session, serverName, 'SHUTDOWN')
    } else if (initialRow.includes('STARTING')) {
      await waitForServerAnyState(session, serverName, ['RUNNING', 'ADMIN', 'STANDBY'])
      await promoteServerToRunning(session, serverName)
      await clickServerLifecycleAction(session, serverName, 'Shutdown')
      await waitForServerState(session, serverName, 'SHUTDOWN')
    } else if (!initialRow.includes('SHUTDOWN')) {
      throw new Error(`server1 is not in a lifecycle state supported by this smoke: ${JSON.stringify(initialRow)}`)
    }

    await clickServerLifecycleAction(session, serverName, 'Start')
    await waitForServerAnyState(session, serverName, ['RUNNING', 'ADMIN', 'STANDBY'])
    const runningRow = await promoteServerToRunning(session, serverName)

    await clickServerLifecycleAction(session, serverName, 'Suspend')
    const suspendedRow = await waitForServerAnyState(session, serverName, ['SUSPENDED', 'ADMIN', 'STANDBY'])

    await clickServerLifecycleAction(session, serverName, 'Resume')
    const resumedRow = await waitForServerState(session, serverName, 'RUNNING')

    await clickServerLifecycleAction(session, serverName, 'Shutdown')
    const restoredRow = await waitForServerState(session, serverName, 'SHUTDOWN')
    const screenshotPath = await screenshot(session, 'servers-lifecycle-restored')

    return {
      name: 'servers-lifecycle',
      path: '/servers',
      screenshot: screenshotPath,
      textSample: [runningRow, suspendedRow, resumedRow, restoredRow],
    }
  } finally {
    let uiRestoreFailed = false
    await restoreServerShutdown(session, serverName).catch((error) => {
      uiRestoreFailed = true
      console.error(`Unable to restore ${serverName} to SHUTDOWN through UI: ${error.message}`)
    })
    await restoreServerShutdownViaRest(creds, serverName).catch((error) => {
      const prefix = uiRestoreFailed ? 'REST fallback also failed' : 'REST restore check failed'
      console.error(`${prefix} for ${serverName}: ${error.message}`)
      throw error
    })
  }
}

async function runServerThreadDumpSmoke(session, creds) {
  await navigate(session, '/servers/AdminServer', creds)
  await waitForExpectedText(
    session,
    'server-thread-dump-live',
    ['AdminServer', 'Single server runtime snapshot.', 'Thread dump'],
    ['Coming soon', 'Request failed', 'Server not found'],
  )
  await clickButtonContaining(session, 'server-thread-dump-live', 'Thread dump')
  const text = await waitForExpectedText(
    session,
    'server-thread-dump-live',
    ['Thread Dump', 'Copy', 'Download', 'Clear'],
    ['Unable to capture thread dump'],
  )
  const screenshotPath = await screenshot(session, 'server-thread-dump-live')

  return {
    name: 'server-thread-dump-live',
    path: '/servers/AdminServer',
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runServerMetricsSmoke(session, creds) {
  const path = '/servers/AdminServer?tab=metrics'
  await navigate(session, path, creds)
  await waitForExpectedText(
    session,
    'server-metrics-live',
    ['AdminServer', 'Metric Capture', 'Start', 'Process CPU', 'Heap Utilization', 'Threads', 'JDBC Pools', 'JMS Destinations'],
    ['Coming soon', 'Request failed', 'Server not found'],
  )

  await installDownloadCapture(session)
  await clickButtonContaining(session, 'server-metrics-live-start', 'Start')
  await waitFor(async () => {
    const body = await session.evaluate('document.body.innerText')
    return /Status\s+active/i.test(body) && /Samples\s+[1-9][0-9]*/i.test(body) ? body : null
  }, 30_000)

  await pushSpaRoute(session, 'server-metrics-live-away', '/dashboard')
  await waitForExpectedText(
    session,
    'server-metrics-live-dashboard',
    ['Dashboard', 'Domain health overview.'],
    ['Coming soon', 'Request failed'],
  )
  await pushSpaRoute(session, 'server-metrics-live-return', path)
  const returnedText = await waitForExpectedText(
    session,
    'server-metrics-live-returned',
    ['AdminServer', 'Metric Capture', 'active', 'Process CPU', 'SAMPLES'],
    ['Coming soon', 'Request failed', 'Server not found'],
  )

  await clickButtonContaining(session, 'server-metrics-live-stop', 'Stop')
  await waitForExpectedText(
    session,
    'server-metrics-live-stopped',
    ['Metric Capture', 'stopped', 'CSV', 'JSON'],
    ['Request failed'],
  )
  await clickButtonContaining(session, 'server-metrics-live-export-csv', 'CSV')
  await clickButtonContaining(session, 'server-metrics-live-export-json', 'JSON')
  const downloads = await waitFor(async () => {
    const values = await capturedDownloads(session)
    return values.length >= 2 ? values : null
  })
  const leaked = downloads.filter((text) => text.includes(creds.password) || text.includes(`${creds.username}@`))
  if (leaked.length) throw new Error('server-metrics-live: export metadata leaked credentials')
  const screenshotPath = await screenshot(session, 'server-metrics-live')

  return {
    name: 'server-metrics-live',
    path,
    screenshot: screenshotPath,
    textSample: returnedText.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runJmsDestinationSmoke(session, creds) {
  await navigate(session, '/jms', creds)
  await waitForExpectedText(
    session,
    'jms-destination-live-list',
    ['JMS', 'Read-only JMS servers', 'DESTINATION', 'JMS SERVER', 'MESSAGES'],
    ['Coming soon', 'Request failed'],
  )

  const destination = await firstJmsDestination(creds)
  if (!destination) {
    const screenshotPath = await screenshot(session, 'jms-destination-live-empty')
    return {
      name: 'jms-destination-live',
      path: '/jms',
      screenshot: screenshotPath,
      textSample: ['No JMS destinations reported by running servers.'],
    }
  }

  const path = `/jms/${encodeURIComponent(destination.serverName)}/${encodeURIComponent(destination.jmsServerName)}/${encodeURIComponent(destination.destinationName)}`
  await navigate(session, path, creds)
  const text = await waitForAnyExpectedText(
    session,
    'jms-destination-live-detail',
    [
      destination.destinationName,
      'Single JMS destination runtime snapshot.',
      'MESSAGES',
      'PENDING',
      'CONSUMERS',
      'Pause State',
      'Message Management Tasks',
      'Messages',
    ],
    ['UNSUPPORTED', 'No messages matched the current browse window.', 'MESSAGE ID'],
    ['Coming soon', 'Request failed', 'JMS destination not found'],
  )
  const detailText = text.includes('MESSAGE ID')
    ? await (async () => {
        await clickButtonContaining(session, 'jms-destination-live-message-view', 'View')
        return waitForExpectedText(
          session,
          'jms-destination-live-message-detail',
          ['Message Detail', 'Copy Body', 'Copy XML'],
          ['Request failed'],
        )
      })()
    : text
  const screenshotPath = await screenshot(session, 'jms-destination-live')

  return {
    name: 'jms-destination-live',
    path,
    screenshot: screenshotPath,
    textSample: detailText.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runJmsMessageRoundtripSmoke(session, creds) {
  const destination = await preparedJmsQueue(creds)
  const path = `/jms/${encodeURIComponent(destination.serverName)}/${encodeURIComponent(destination.jmsServerName)}/${encodeURIComponent(destination.destinationName)}`
  const correlationId = `wls-cockpit-smoke-${Date.now().toString(36)}`
  const body = `Synthetic WLS Cockpit smoke message ${correlationId}`
  const selector = `JMSCorrelationID = '${correlationId}'`

  await navigate(session, path, creds)
  await waitForExpectedText(
    session,
    'jms-message-roundtrip-detail',
    [
      destination.destinationName,
      'Single JMS destination runtime snapshot.',
      'Produce Message',
      'Messages',
    ],
    ['Coming soon', 'Request failed', 'JMS destination not found', 'UNAVAILABLE'],
  )
  if (destination.productionPaused) {
    throw new Error('Prepared JMS queue has production paused; refusing to run mutating message smoke.')
  }
  let pausedBySmoke = false
  try {
    await postJmsDestinationOperation(creds, destination, 'pauseProduction')
    pausedBySmoke = true
    await postJmsDestinationOperation(creds, destination, 'resumeProduction')
    pausedBySmoke = false
  } catch (error) {
    if (pausedBySmoke) {
      await postJmsDestinationOperation(creds, destination, 'resumeProduction').catch((restoreError) => {
        console.error(`Unable to resume prepared JMS queue after pause smoke: ${restoreError.message}`)
      })
    }
    throw error
  }

  await clickButtonContaining(session, 'jms-message-roundtrip-produce-open', 'Produce')
  await waitFor(async () => {
    const result = await session.evaluate(`
      (() => {
        const body = document.body.innerText;
        if (body.includes('UNAVAILABLE') || body.includes('Production is paused')) return { ok: false, body };
        const bodyField = [...document.querySelectorAll('textarea')].find((candidate) =>
          candidate.getAttribute('placeholder') === 'Text message body'
        );
        const correlationField = [...document.querySelectorAll('input')].find((candidate) =>
          candidate.getAttribute('placeholder') === 'Correlation ID'
        );
        const sendButton = [...document.querySelectorAll('button')].find((candidate) =>
          candidate.innerText.trim().includes('Send')
        );
        return { ok: !!bodyField && !!correlationField && !!sendButton && !sendButton.disabled, body };
      })();
    `)
    if (result?.body?.includes('UNAVAILABLE') || result?.body?.includes('Production is paused')) {
      throw new Error('JMS produce form unavailable for prepared queue.')
    }
    return result?.ok ? true : null
  })
  await session.evaluate(`
    (() => {
      const body = ${JSON.stringify(body)};
      const correlationId = ${JSON.stringify(correlationId)};
      const bodyField = [...document.querySelectorAll('textarea')].find((candidate) =>
        candidate.getAttribute('placeholder') === 'Text message body'
      );
      if (!bodyField) throw new Error('JMS produce body field not found');
      const textAreaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      textAreaSetter.call(bodyField, body);
      bodyField.dispatchEvent(new Event('input', { bubbles: true }));

      const correlationField = [...document.querySelectorAll('input')].find((candidate) =>
        candidate.getAttribute('placeholder') === 'Correlation ID'
      );
      if (!correlationField) throw new Error('JMS produce correlation field not found');
      const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      inputSetter.call(correlationField, correlationId);
      correlationField.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })();
  `)
  await clickButtonContaining(session, 'jms-message-roundtrip-send-open-confirm', 'Send')
  await confirmDialogButton(session, 'JMS message send', 'Send')
  await waitForExpectedText(
    session,
    'jms-message-roundtrip-sent',
    ['Message accepted'],
    ['Unable to produce JMS message', 'Request failed'],
  )

  await session.evaluate(`
    (() => {
      const selector = ${JSON.stringify(selector)};
      const selectorField = [...document.querySelectorAll('input')].find((candidate) =>
        candidate.getAttribute('placeholder') === 'JMS selector'
      );
      if (!selectorField) throw new Error('JMS selector field not found');
      selectorField.value = selector;
      selectorField.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })();
  `)
  await clickButtonContaining(session, 'jms-message-roundtrip-apply-selector', 'Apply')
  await waitForExpectedText(
    session,
    'jms-message-roundtrip-row',
    ['MESSAGE ID', correlationId],
    ['No messages matched the current browse window.', 'Request failed'],
  )

  await clickButtonContaining(session, 'jms-message-roundtrip-view', 'View')
  await waitForExpectedText(
    session,
    'jms-message-roundtrip-viewed',
    ['Message Detail', 'Copy Body', body],
    ['Unable to load JMS message detail.', 'Request failed'],
  )
  await clickButtonContaining(session, 'jms-message-roundtrip-close-detail', 'Close')
  await waitFor(async () => {
    const text = await session.evaluate('document.body.innerText')
    return text.includes(body) ? null : text
  })

  await waitFor(async () => {
    const clicked = await session.evaluate(`
      (() => {
        const button = [...document.querySelectorAll('tbody button')].find((candidate) =>
          candidate.innerText.trim() === 'Delete' && !candidate.disabled
        );
        if (!button) return false;
        button.click();
        return true;
      })();
    `)
    return clicked ? true : null
  })
  await confirmDialogButton(session, 'JMS message delete', 'Delete')
  await waitForAnyExpectedText(
    session,
    'jms-message-roundtrip-deleted',
    [],
    ['Deleted 1 selected message', 'Selected messages were already gone'],
    ['Request failed', body],
  )

  return {
    name: 'jms-message-roundtrip',
    path: '/jms/<prepared-server>/<prepared-jms-server>/<prepared-queue>',
    screenshot: null,
    textSample: [
      `Prepared queue hint: ${JMS_MUTATION_DESTINATION_HINT}`,
      'Produced one synthetic text message.',
      'Loaded message body on demand.',
      'Deleted the selected synthetic message.',
    ],
  }
}

async function runJmsUrlStateSmoke(session, creds) {
  await navigate(session, '/jms', creds)
  await waitForExpectedText(
    session,
    'jms-url-state-return-list',
    ['JMS', 'Read-only JMS servers', 'DESTINATION', 'JMS SERVER', 'MESSAGES'],
    ['Coming soon', 'Request failed'],
  )

  const destination = await firstJmsDestination(creds)
  if (!destination) {
    const screenshotPath = await screenshot(session, 'jms-url-state-return-empty')
    return {
      name: 'jms-url-state-return',
      path: '/jms',
      screenshot: screenshotPath,
      textSample: ['No JMS destinations reported by running servers.'],
    }
  }

  const path =
    `/jms?q=${encodeURIComponent(destination.destinationName)}` +
    `&server=${encodeURIComponent(destination.serverName)}` +
    `&jmsServer=${encodeURIComponent(destination.jmsServerName)}` +
    '&sort=destination&dir=desc'
  const detailPath = `/jms/${encodeURIComponent(destination.serverName)}/${encodeURIComponent(destination.jmsServerName)}/${encodeURIComponent(destination.destinationName)}`
  await navigate(session, path, creds)
  await assertRouteState(session, 'jms-url-state-return', path)
  await waitForExpectedText(
    session,
    'jms-url-state-return',
    ['JMS', 'Read-only JMS servers', destination.destinationName, destination.serverName, destination.jmsServerName],
    ['Coming soon', 'Request failed'],
  )
  await clickRouteLink(session, 'jms-url-state-return', detailPath)
  await waitForRouteState(session, 'jms-url-state-return-detail', detailPath)
  await waitForExpectedText(
    session,
    'jms-url-state-return-detail',
    [destination.destinationName, 'Single JMS destination runtime snapshot.', 'MESSAGES', 'PENDING', 'CONSUMERS'],
    ['Coming soon', 'Request failed', 'JMS destination not found'],
  )
  await clickRouteLink(session, 'jms-url-state-return-back', path)
  await waitForRouteState(session, 'jms-url-state-return-back', path)
  const text = await waitForExpectedText(
    session,
    'jms-url-state-return-returned',
    ['JMS', destination.destinationName, destination.serverName, destination.jmsServerName],
    ['Coming soon', 'Request failed'],
  )
  const screenshotPath = await screenshot(session, 'jms-url-state-return')

  return {
    name: 'jms-url-state-return',
    path,
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runJndiSafeBindingSmoke(session, creds) {
  await navigate(session, '/jndi', creds)
  let text = await waitForExpectedText(
    session,
    'jndi-safe-binding-live-list',
    ['JNDI', 'Read-only server-scoped JNDI bindings', 'AdminServer', 'Binding Metadata'],
    ['Coming soon', 'Request failed'],
  )
  if (text.includes('Verified JNDI tree lookup is unavailable')) {
    const screenshotPath = await screenshot(session, 'jndi-safe-binding-live-unsupported')
    return {
      name: 'jndi-safe-binding-live',
      path: '/jndi',
      screenshot: screenshotPath,
      textSample: text.split('\n').filter(Boolean).slice(0, 16),
    }
  }

  await session.evaluate(`
    (() => {
      const select = document.querySelector('select[aria-label="Select WebLogic server"]');
      if (!select) throw new Error('JNDI server selector not found');
      select.value = 'AdminServer';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })();
  `)
  text = await waitForExpectedText(
    session,
    'jndi-safe-binding-live-admin',
    ['JNDI', 'AdminServer', 'jdbc'],
    ['Coming soon', 'Request failed'],
  )
  if (text.includes('Verified JNDI tree lookup is unavailable')) {
    const screenshotPath = await screenshot(session, 'jndi-safe-binding-live-unsupported-admin')
    return {
      name: 'jndi-safe-binding-live',
      path: '/jndi',
      screenshot: screenshotPath,
      textSample: text.split('\n').filter(Boolean).slice(0, 16),
    }
  }
  const bindingLeaf = JNDI_SMOKE_BINDING.split('/').pop()
  const bindingRoot = JNDI_SMOKE_BINDING.split('/')[0]
  await clickButtonContaining(session, 'jndi-safe-binding-live-expand', 'Expand')
  await waitForExpectedText(
    session,
    'jndi-safe-binding-live-expanded',
    process.env.WLS_SMOKE_JNDI_BINDING
      ? ['JNDI', bindingRoot, bindingLeaf]
      : ['JNDI', 'jdbc', 'jms', 'WLSCockpitDemoDS', 'WLSCockpitDemoQueue'],
    ['Coming soon', 'Request failed'],
  )
  await session.evaluate(`
    (() => {
      const leaf = ${JSON.stringify(bindingLeaf)};
      const button = [...document.querySelectorAll('button')].find((candidate) =>
        candidate.innerText.trim().includes(leaf)
      );
      if (!button) throw new Error('JNDI safe binding row not found');
      button.click();
      return true;
    })();
  `)
  text = await waitForExpectedText(
    session,
    'jndi-safe-binding-live-detail',
    ['Binding Metadata', 'AdminServer', JNDI_SMOKE_BINDING, bindingLeaf],
    ['Coming soon', 'Request failed'],
  )
  const screenshotPath = await screenshot(session, 'jndi-safe-binding-live')

  return {
    name: 'jndi-safe-binding-live',
    path: '/jndi',
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runLogArchiveTailSelectionSmoke(session, creds) {
  const path = '/logs/AdminServer'
  await navigate(session, path, creds)
  await waitForExpectedText(
    session,
    'log-archive-tail-selection-live',
    ['AdminServer', 'Live Tail', 'Maximize', 'SERVER', 'Archives', 'Data Access Metadata'],
    ['Coming soon', 'Request failed', 'Log runtime not found'],
  )
  await clickButtonContaining(session, 'log-archive-tail-selection-live-maximize', 'Maximize')
  await waitForExpectedText(
    session,
    'log-archive-tail-selection-live-maximized',
    ['Live Tail', 'Restore'],
    ['Coming soon', 'Request failed', 'Log runtime not found'],
  )
  await clickButtonContaining(session, 'log-archive-tail-selection-live-restore', 'Restore')
  await waitForExpectedText(
    session,
    'log-archive-tail-selection-live-restored',
    ['Live Tail', 'Maximize'],
    ['Coming soon', 'Request failed', 'Log runtime not found'],
  )

  const archiveState = await waitFor(() =>
    session.evaluate(`
      (() => {
        const select = document.querySelector('select[aria-label="Live Tail archive"]');
        if (!select) return null;
        const options = [...select.options].map((option) => option.value).filter(Boolean);
        return { value: select.value, options };
      })();
    `),
  )
  const targetArchive =
    archiveState.options.find((name) => name.includes('JMSMessageLog')) ??
    archiveState.options.find((name) => name === 'DomainLog') ??
    archiveState.options.find((name) => name !== archiveState.value && name !== 'ServerLog') ??
    null

  if (!targetArchive) {
    const screenshotPath = await screenshot(session, 'log-archive-tail-selection-live-single')
    return {
      name: 'log-archive-tail-selection-live',
      path,
      screenshot: screenshotPath,
      textSample: [`Only selectable archive: ${archiveState.value || archiveState.options.join(', ') || '-'}`],
    }
  }

  await session.evaluate(`
    (() => {
      const select = document.querySelector('select[aria-label="Live Tail archive"]');
      select.value = ${JSON.stringify(targetArchive)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })();
  `)
  await waitFor(async () => {
    const selected = await session.evaluate(`
      (() => {
        const select = document.querySelector('select[aria-label="Live Tail archive"]');
        return select ? select.value : null;
      })();
    `)
    if (selected !== targetArchive) return null
    const body = await session.evaluate('document.body.innerText')
    if (body.includes('Request failed')) throw new Error(body.split('\n').filter(Boolean).slice(0, 24).join(' | '))
    return body.includes(targetArchive) ? body : null
  })
  const text = await waitForAnyExpectedText(
    session,
    'log-archive-tail-selection-live-selected',
    ['Live Tail', targetArchive],
    ['No records returned for the bounded tail window', 'ID', 'RECORD'],
    ['Coming soon', 'Request failed', 'Log runtime not found'],
  )
  const screenshotPath = await screenshot(session, 'log-archive-tail-selection-live')

  return {
    name: 'log-archive-tail-selection-live',
    path,
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runMultiServerLogTailSmoke(session, creds) {
  const path = '/logs'
  await navigate(session, path, creds)
  await waitForExpectedText(
    session,
    'multiserver-log-tail-live',
    ['Logs', 'Global Tail', 'Select one or more sources', 'ServerLog', 'SERVER LOG UPDATED'],
    ['Coming soon', 'Request failed'],
  )

  const selected = await waitFor(() =>
    session.evaluate(`
      (() => {
        const inputs = [...document.querySelectorAll('section input[type="checkbox"]')];
        if (inputs.length === 0) return null;
        const serverLogInputs = inputs.filter((input) => {
          const label = input.closest('label');
          return label && label.innerText.includes('ServerLog');
        });
        const candidates = (serverLogInputs.length >= 2 ? serverLogInputs : inputs).slice(0, 2);
        if (candidates.length === 0) return null;
        candidates.forEach((input) => {
          if (!input.checked && !input.disabled) input.click();
        });
        return candidates.length;
      })();
    `),
  )

  const text = await waitForAnyExpectedText(
    session,
    'multiserver-log-tail-live-selected',
    ['Global Tail', 'Sources', `${selected} / 6`, 'ServerLog'],
    ['No retained records from selected sources.', 'Polling selected sources...', 'records'],
    ['Coming soon', 'Request failed'],
  )
  const screenshotPath = await screenshot(session, 'multiserver-log-tail-live')

  return {
    name: 'multiserver-log-tail-live',
    path,
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runDiagnosticSnapshotSmoke(session, creds) {
  const path = '/dashboard'
  await navigate(session, path, creds)
  await waitForExpectedText(
    session,
    'diagnostic-snapshot-live',
    ['Dashboard', 'Domain health overview.', 'Snapshot'],
    ['Coming soon', 'Request failed'],
  )

  await installDownloadCapture(session)
  await clickButtonContaining(session, 'diagnostic-snapshot-live-open', 'Snapshot')
  await waitForExpectedText(
    session,
    'diagnostic-snapshot-live-dialog',
    ['Diagnostic snapshot', 'INCLUDED SECTIONS', 'Bounded recent server logs', 'Export ZIP'],
    ['Request failed'],
  )
  await clickButtonContaining(session, 'diagnostic-snapshot-live-export', 'Export ZIP')
  const downloads = await waitFor(async () => {
    const values = await capturedDownloads(session)
    if (values.length >= 1) return values
    const body = await session.evaluate('document.body.innerText')
    if (body.includes('Unable to generate diagnostic snapshot')) {
      throw new Error(body.split('\n').filter(Boolean).slice(0, 24).join(' | '))
    }
    return null
  }, 120_000)
  const artifact = downloads.at(-1) ?? ''
  const leaked = [creds.password, `${creds.username}@`].filter((value) => value && artifact.includes(value))
  if (leaked.length) throw new Error('diagnostic-snapshot-live: ZIP artifact leaked credentials')
  if (!artifact.includes('manifest.json') || !artifact.includes('runtime/dashboard.json')) {
    throw new Error('diagnostic-snapshot-live: ZIP artifact did not include manifest and dashboard runtime JSON')
  }
  const text = await waitForExpectedText(
    session,
    'diagnostic-snapshot-live-exported',
    ['Diagnostic snapshot', 'Downloaded', 'manifest sections'],
    ['Unable to generate diagnostic snapshot'],
  )
  const screenshotPath = await screenshot(session, 'diagnostic-snapshot-live')

  return {
    name: 'diagnostic-snapshot-live',
    path,
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runDomainConfigSnapshotsSmoke(session, creds) {
  const path = '/config-snapshots'
  await navigate(session, path, creds)
  await waitForExpectedText(
    session,
    'domain-config-snapshots-live',
    ['Config Snapshots', 'Stored snapshots', 'Diff', 'Capture'],
    ['Coming soon', 'Request failed'],
  )

  await clickButtonContaining(session, 'domain-config-snapshots-live-capture', 'Capture')
  const text = await waitForExpectedText(
    session,
    'domain-config-snapshots-live-captured',
    ['Config Snapshots', 'Stored snapshots', 'servers', 'clusters', 'dataSources', 'deployments', 'jms', 'JSON'],
    ['Unable to capture domain configuration snapshot'],
  )
  await installDownloadCapture(session)
  await clickButtonContaining(session, 'domain-config-snapshots-live-download', 'JSON')
  const downloads = await waitFor(async () => {
    const values = await capturedDownloads(session)
    return values.length >= 1 ? values : null
  })
  const artifact = downloads.at(-1) ?? ''
  const leaked = [creds.password, `${creds.username}@`].filter((value) => value && artifact.includes(value))
  if (leaked.length) throw new Error('domain-config-snapshots-live: JSON artifact leaked credentials')
  const snapshot = JSON.parse(artifact)
  const sections = new Map((snapshot?.manifest?.sections ?? []).map((section) => [section.family, section]))
  for (const family of ['servers', 'clusters', 'dataSources', 'deployments', 'jms']) {
    const section = sections.get(family)
    if (!section || section.status !== 'included' || section.recordCount <= 0) {
      throw new Error(`domain-config-snapshots-live: expected included non-empty ${family} section`)
    }
  }
  const screenshotPath = await screenshot(session, 'domain-config-snapshots-live')

  return {
    name: 'domain-config-snapshots-live',
    path,
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function visibleButtonTexts(session) {
  return session.evaluate(`
    [...document.querySelectorAll('button')]
      .filter((button) => button.offsetParent !== null)
      .map((button) => button.innerText.trim().replace(/\\s+/g, ' '))
      .filter(Boolean)
  `)
}

async function assertNoButtons(session, checkName, labels) {
  const buttons = await visibleButtonTexts(session)
  const present = labels.filter((label) => buttons.includes(label))
  if (present.length) {
    throw new Error(`${checkName}: unexpected demo read-only buttons present: ${present.join(', ')}`)
  }
}

async function runDemoReadOnlySmoke(session, creds) {
  await navigate(session, '/servers', creds)
  await waitForExpectedText(
    session,
    'demo-readonly-live-servers',
    ['DEMO READ-ONLY', 'Servers', 'Domain server runtimes.', 'AdminServer'],
    ['Coming soon', 'Request failed'],
  )
  await assertNoButtons(session, 'demo-readonly-live-servers', ['Start', 'Shutdown', 'Suspend', 'Resume', 'Create server'])

  await navigate(session, '/servers/AdminServer?tab=configuration', creds)
  await waitForExpectedText(
    session,
    'demo-readonly-live-server-detail',
    ['DEMO READ-ONLY', 'AdminServer', 'Configuration'],
    ['Coming soon', 'Request failed', 'Server not found'],
  )
  await assertNoButtons(session, 'demo-readonly-live-server-detail', ['Thread dump', 'Edit', 'New', 'Delete', 'Delete server'])

  await navigate(session, '/clusters', creds)
  await waitForExpectedText(
    session,
    'demo-readonly-live-clusters',
    ['DEMO READ-ONLY', 'Clusters', 'Cluster membership'],
    ['Coming soon', 'Request failed'],
  )
  await assertNoButtons(session, 'demo-readonly-live-clusters', ['Create cluster'])

  await navigate(session, '/deployments', creds)
  await waitForExpectedText(
    session,
    'demo-readonly-live-deployments',
    ['DEMO READ-ONLY', 'Deployments', 'Applications and deployment state.'],
    ['Coming soon', 'Request failed'],
  )
  await assertNoButtons(session, 'demo-readonly-live-deployments', [
    'Deploy',
    'Start',
    'Stop',
    'Redeploy',
    'Targets',
    'Undeploy',
  ])

  await navigate(session, '/data-sources', creds)
  const text = await waitForExpectedText(
    session,
    'demo-readonly-live-data-sources',
    ['DEMO READ-ONLY', 'Data Sources', 'JDBC pool status and connectivity.'],
    ['Coming soon', 'Request failed'],
  )
  await assertNoButtons(session, 'demo-readonly-live-data-sources', [
    'Create',
    'Test',
    'Suspend',
    'Resume',
    'Shrink',
    'Reset',
    'Clear cache',
    'Edit',
    'Targets',
    'Delete',
  ])

  const screenshotPath = await screenshot(session, 'demo-readonly-live')
  return {
    name: 'demo-readonly-live',
    path: '/servers,/servers/AdminServer,/deployments,/data-sources',
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runEditSessionReadOnlyStatusSmoke(session, creds) {
  await installDemoReadOnlyRuntime(session)
  await installEditSessionStatusMock(session, {
    locked: true,
    lockOwner: creds.username,
    hasChanges: true,
    mergeNeeded: false,
    editSession: 'default',
  })
  await navigate(session, '/dashboard', creds)
  const text = await waitForExpectedText(
    session,
    'edit-session-readonly-status',
    ['DEMO READ-ONLY', 'PENDING CHANGES', creds.username, 'pending changes'],
    ['Edit-session status unavailable', 'Edit status error'],
  )
  await assertNoButtons(session, 'edit-session-readonly-status', ['Activate', 'Cancel'])
  const screenshotPath = await screenshot(session, 'edit-session-readonly-status')
  return {
    name: 'edit-session-readonly-status',
    path: '/dashboard',
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runTopologyConfigurationPreflightSmoke(session, creds) {
  const { serverName, clusterName } = topologyDisposableNames()
  await assertTopologyDisposableNamesAvailable(creds, { serverName, clusterName }, 'topology-config-disposable-preflight')

  await navigate(session, '/clusters', creds)
  const text = await waitForExpectedText(
    session,
    'topology-config-disposable-preflight',
    ['Clusters', 'Cluster membership'],
    ['Coming soon', 'Request failed'],
  )
  const screenshotPath = await screenshot(session, 'topology-config-disposable-preflight')
  return {
    name: 'topology-config-disposable-preflight',
    path: '/clusters',
    screenshot: screenshotPath,
    textSample: [
      `disposable server=${serverName}`,
      `disposable cluster=${clusterName}`,
      ...text.split('\n').filter(Boolean).slice(0, 14),
    ],
  }
}

function topologyDisposableNames() {
  return {
    serverName: process.env.WLS_SMOKE_TOPOLOGY_SERVER_NAME ?? 'WLSCockpitSmokeServer',
    clusterName: process.env.WLS_SMOKE_TOPOLOGY_CLUSTER_NAME ?? 'WLSCockpitSmokeCluster',
  }
}

async function topologyCollectionNames(creds, collectionName) {
  const data = await fetchWlsProxy(`${editCollectionPath(creds, collectionName)}?fields=name&links=none`, creds)
  return Array.isArray(data?.items) ? data.items.map((item) => item?.name).filter(Boolean) : []
}

async function assertTopologyDisposableNamesAvailable(creds, { serverName, clusterName }, checkName) {
  const [servers, clusters] = await Promise.all([
    topologyCollectionNames(creds, 'servers'),
    topologyCollectionNames(creds, 'clusters'),
  ])
  const conflicts = [
    servers.includes(serverName) ? `server ${serverName}` : null,
    clusters.includes(clusterName) ? `cluster ${clusterName}` : null,
  ].filter(Boolean)
  if (conflicts.length) {
    throw new Error(`${checkName}: disposable names already exist: ${conflicts.join(', ')}`)
  }
}

async function topologyEditRequest(creds, method, path, body) {
  return fetchWlsProxy(path, creds, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, WLS_RESTORE_TIMEOUT_MS)
}

async function runTopologyEditSmokeTransaction(creds, label, steps) {
  await topologyEditRequest(creds, 'POST', changeManagerPath(creds, '/startEdit'), {})
  try {
    for (const step of steps) {
      await topologyEditRequest(creds, step.method, step.path, step.body)
    }
    await topologyEditRequest(creds, 'POST', changeManagerPath(creds, '/activate'), {})
  } catch (error) {
    await topologyEditRequest(creds, 'POST', changeManagerPath(creds, '/cancelEdit'), {}).catch(() => undefined)
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function topologyResourceExists(creds, collectionName, resourceName) {
  return (await topologyCollectionNames(creds, collectionName)).includes(resourceName)
}

async function deleteTopologyResourceIfPresent(creds, collectionName, resourceName) {
  if (!await topologyResourceExists(creds, collectionName, resourceName)) return false
  await runTopologyEditSmokeTransaction(creds, `delete ${collectionName}/${resourceName}`, [
    { method: 'DELETE', path: editResourcePath(creds, collectionName, resourceName) },
  ])
  return true
}

async function runTopologyConfigurationDisposableMutationSmoke(session, creds) {
  const { serverName, clusterName } = topologyDisposableNames()
  const checkName = 'topology-config-disposable-mutations'
  const cleanup = []
  let result = null

  await assertTopologyDisposableNamesAvailable(creds, { serverName, clusterName }, checkName)

  try {
    await runTopologyEditSmokeTransaction(creds, 'create disposable topology resources', [
      {
        method: 'POST',
        path: editCollectionPath(creds, 'clusters'),
        body: {
          name: clusterName,
          clusterAddress: `${clusterName}.invalid`,
          notes: 'WLS Cockpit disposable smoke cluster',
        },
      },
      {
        method: 'POST',
        path: editCollectionPath(creds, 'servers'),
        body: {
          name: serverName,
          cluster: ['clusters', clusterName],
          notes: 'WLS Cockpit disposable smoke server',
        },
      },
    ])

    await navigate(session, '/clusters', creds)
    const text = await waitForExpectedText(
      session,
      checkName,
      ['Clusters', clusterName],
      ['Coming soon', 'Request failed'],
    )
    const screenshotPath = await screenshot(session, checkName)
    result = {
      name: checkName,
      path: '/clusters',
      screenshot: screenshotPath,
      textSample: [
        `created server=${serverName}`,
        `created cluster=${clusterName}`,
        ...text.split('\n').filter(Boolean).slice(0, 14),
      ],
    }
  } finally {
    if (await deleteTopologyResourceIfPresent(creds, 'servers', serverName)) cleanup.push(`deleted server=${serverName}`)
    if (await deleteTopologyResourceIfPresent(creds, 'clusters', clusterName)) cleanup.push(`deleted cluster=${clusterName}`)
  }

  return {
    ...result,
    textSample: [
      ...(result?.textSample ?? []),
      ...cleanup,
    ],
  }
}

async function runEditSessionDisposableSmoke(session, creds) {
  const startPath = changeManagerPath(creds, '/startEdit')
  const cancelPath = changeManagerPath(creds, '/cancelEdit')
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }

  try {
    await fetchWlsProxy(startPath, creds, request)
    await navigate(session, '/dashboard', creds)
    const text = await waitForExpectedText(
      session,
      'edit-session-disposable',
      ['EDIT LOCK', creds.username, 'no pending changes', 'Cancel'],
      ['Edit-session status unavailable', 'Edit status error'],
    )
    await clickButtonContaining(session, 'edit-session-disposable', 'Cancel')
    await confirmDialogButton(session, 'edit-session-disposable', 'Cancel session')
    await waitFor(async () => {
      const body = await session.evaluate('document.body.innerText')
      return !body.includes('EDIT LOCK') && !body.includes('PENDING CHANGES') ? true : null
    })
    const settledStatus = await fetchWlsProxy(`${changeManagerPath(creds)}?links=none&fields=locked`, creds)
    if (settledStatus?.locked) throw new Error('edit-session-disposable: edit lock remained active after cancel')
    const screenshotPath = await screenshot(session, 'edit-session-disposable')
    return {
      name: 'edit-session-disposable',
      path: '/dashboard',
      screenshot: screenshotPath,
      textSample: text.split('\n').filter(Boolean).slice(0, 16),
    }
  } finally {
    await fetchWlsProxy(cancelPath, creds, request).catch(() => undefined)
  }
}

function readAction(method, includes) {
  return { method, includes }
}

function mutation(method, includes) {
  return { method, includes }
}

export const SMOKE_CHECK_REGISTRY = [
  ...fixtureChecks.map((check) => ({
    name: check.name,
    profile: 'readonly',
    mode: 'route',
    run: (session, creds) => runCheck(session, check, creds),
  })),
  ...liveChecks.map((check) => ({
    name: check.name,
    profile: 'readonly',
    mode: 'route',
    readActions:
      check.name === 'log-details-live'
        ? [readAction('POST', ['/WLDFDataAccessRuntimes/', '/search'])]
        : check.name === 'deployment-details-live'
          ? [readAction('POST', ['/domainRuntime/getServerHttpURL'])]
        : [],
    run: (session, creds) => runCheck(session, check, creds),
  })),
  ...compatChecks.map((check) => ({
    name: check.name,
    profile: 'readonly',
    mode: 'compat',
    assertFailedNotRestartableStart: check.assertFailedNotRestartableStart,
    readActions:
      check.name === 'compat-log-details-admin'
        ? [readAction('POST', ['/WLDFDataAccessRuntimes/', '/search'])]
        : [],
    run: (session, creds) => runCheck(session, check, creds),
  })),
  ...urlStateChecks.map((check) => ({
    name: check.name,
    profile: 'readonly',
    mode: 'url-state',
    readActions:
      check.name === 'logs-url-state-return'
        ? [readAction('POST', ['/WLDFDataAccessRuntimes/', '/search'])]
        : check.name === 'deployments-url-state-return'
          ? [readAction('POST', ['/domainRuntime/getServerHttpURL'])]
        : [],
    run: (session, creds) => runUrlStateCheck(session, check, creds),
  })),
  {
    name: 'server-thread-dump-live',
    profile: 'readonly',
    mode: 'helper',
    run: runServerThreadDumpSmoke,
  },
  {
    name: 'server-metrics-live',
    profile: 'readonly',
    mode: 'helper',
    defaultEnabled: false,
    run: runServerMetricsSmoke,
  },
  {
    name: 'jms-destination-live',
    profile: 'readonly',
    mode: 'helper',
    defaultEnabled: false,
    run: runJmsDestinationSmoke,
  },
  {
    name: 'jms-url-state-return',
    profile: 'readonly',
    mode: 'url-state',
    defaultEnabled: false,
    run: runJmsUrlStateSmoke,
  },
  {
    name: 'jndi-safe-binding-live',
    profile: 'readonly',
    mode: 'helper',
    defaultEnabled: false,
    run: runJndiSafeBindingSmoke,
  },
  {
    name: 'log-archive-tail-selection-live',
    profile: 'readonly',
    mode: 'helper',
    defaultEnabled: false,
    readActions: [readAction('POST', ['/WLDFDataAccessRuntimes/', '/search'])],
    run: runLogArchiveTailSelectionSmoke,
  },
  {
    name: 'multiserver-log-tail-live',
    profile: 'readonly',
    mode: 'helper',
    defaultEnabled: false,
    readActions: [readAction('POST', ['/WLDFDataAccessRuntimes/', '/search'])],
    run: runMultiServerLogTailSmoke,
  },
  {
    name: 'diagnostic-snapshot-live',
    profile: 'readonly',
    mode: 'helper',
    defaultEnabled: false,
    readActions: [readAction('POST', ['/WLDFDataAccessRuntimes/', '/search'])],
    run: runDiagnosticSnapshotSmoke,
  },
  {
    name: 'domain-config-snapshots-live',
    profile: 'readonly',
    mode: 'helper',
    defaultEnabled: false,
    run: runDomainConfigSnapshotsSmoke,
  },
  {
    name: 'deployment-url-test-live',
    profile: 'readonly',
    mode: 'helper',
    readActions: [readAction('POST', ['/domainRuntime/getServerHttpURL'])],
    run: runDeploymentUrlSmoke,
  },
  {
    name: 'deployment-request-metrics-live',
    profile: 'readonly',
    mode: 'helper',
    defaultEnabled: false,
    readActions: [readAction('POST', ['/domainRuntime/getServerHttpURL'])],
    run: runDeploymentRequestMetricsSmoke,
  },
  {
    name: 'deployment-targeting-matrix-live',
    profile: 'readonly',
    mode: 'helper',
    run: runDeploymentMatrixSmoke,
  },
  {
    name: 'work-managers-live',
    profile: 'readonly',
    mode: 'helper',
    // Work Manager constraints are read with one domainRuntime search (a POST that reads).
    readActions: [readAction('POST', ['/domainRuntime/search'])],
    run: runWorkManagersSmoke,
  },
  {
    name: 'theme-mode-coverage-live',
    profile: 'readonly',
    mode: 'helper',
    defaultEnabled: false,
    run: runThemeModeCoverageSmoke,
  },
  {
    name: 'node-manager-config-editor-live',
    profile: 'readonly',
    mode: 'helper',
    defaultEnabled: false,
    run: runNodeManagerConfigEditorSmoke,
  },
  {
    name: 'topology-server-config-readonly',
    profile: 'readonly',
    mode: 'route',
    defaultEnabled: false,
    run: (session, creds) => runCheck(session, {
      name: 'topology-server-config-readonly',
      path: '/servers/AdminServer?tab=configuration',
      expected: ['AdminServer', 'Configuration', 'Identity and Listen', 'MODE', 'KIND'],
      forbidden: ['Coming soon', 'Request failed', 'Server not found'],
    }, creds),
  },
  {
    name: 'topology-clusters-config-readonly',
    profile: 'readonly',
    mode: 'route',
    defaultEnabled: false,
    run: (session, creds) => runCheck(session, {
      name: 'topology-clusters-config-readonly',
      path: '/clusters',
      expected: ['Clusters', 'Cluster membership', 'Create cluster', 'CLUSTER', 'MEMBERS'],
      forbidden: ['Coming soon', 'Request failed'],
    }, creds),
  },
  {
    name: 'demo-readonly-live',
    profile: 'readonly',
    mode: 'helper',
    defaultEnabled: false,
    run: runDemoReadOnlySmoke,
  },
  {
    name: 'edit-session-readonly-status',
    profile: 'readonly',
    mode: 'helper',
    defaultEnabled: false,
    run: runEditSessionReadOnlyStatusSmoke,
  },
  {
    name: 'servers-lifecycle',
    profile: 'lifecycle',
    mode: 'helper',
    mutations: [
      mutation('POST', ['/domainRuntime/serverLifeCycleRuntimes/', '/start']),
      mutation('POST', ['/domainRuntime/serverLifeCycleRuntimes/', '/shutdown']),
      mutation('POST', ['/domainRuntime/serverLifeCycleRuntimes/', '/suspend']),
      mutation('POST', ['/domainRuntime/serverLifeCycleRuntimes/', '/resume']),
    ],
    run: runLifecycleSmoke,
  },
  {
    name: 'jms-message-roundtrip',
    profile: 'jms-mutation',
    mode: 'helper',
    defaultEnabled: false,
    mutations: [
      mutation('POST', ['/api/jms/messages/produce']),
      mutation('POST', ['/api/jms/messages/delete']),
      mutation('POST', ['/JMSRuntime/JMSServers/', '/destinations/', '/pauseConsumption']),
      mutation('POST', ['/JMSRuntime/JMSServers/', '/destinations/', '/pauseInsertion']),
      mutation('POST', ['/JMSRuntime/JMSServers/', '/destinations/', '/pauseProduction']),
      mutation('POST', ['/JMSRuntime/JMSServers/', '/destinations/', '/resumeConsumption']),
      mutation('POST', ['/JMSRuntime/JMSServers/', '/destinations/', '/resumeInsertion']),
      mutation('POST', ['/JMSRuntime/JMSServers/', '/destinations/', '/resumeProduction']),
    ],
    run: runJmsMessageRoundtripSmoke,
  },
  {
    name: 'deployments-lifecycle',
    profile: 'lifecycle',
    mode: 'helper',
    mutations: [
      mutation('POST', ['/domainRuntime/deploymentManager/appDeploymentRuntimes/', '/start']),
      mutation('POST', ['/domainRuntime/deploymentManager/appDeploymentRuntimes/', '/stop']),
      mutation('POST', ['/domainRuntime/deploymentManager/appDeploymentRuntimes/', '/redeploy']),
    ],
    run: runDeploymentLifecycleSmoke,
  },
  {
    name: 'data-sources-lifecycle',
    profile: 'lifecycle',
    mode: 'helper',
    mutations: [
      mutation('POST', ['/JDBCDataSourceRuntimeMBeans/', '/testPool']),
      mutation('POST', ['/JDBCDataSourceRuntimeMBeans/', '/suspend']),
      mutation('POST', ['/JDBCDataSourceRuntimeMBeans/', '/resume']),
    ],
    run: runDataSourceLifecycleSmoke,
  },
  {
    name: 'edit-session-disposable',
    profile: 'lifecycle',
    mode: 'helper',
    defaultEnabled: false,
    mutations: [
      mutation('POST', ['/edit/changeManager/startEdit']),
      mutation('POST', ['/edit/changeManager/cancelEdit']),
    ],
    run: runEditSessionDisposableSmoke,
  },
  {
    name: 'topology-config-disposable-preflight',
    profile: 'topology-config',
    mode: 'helper',
    defaultEnabled: false,
    readActions: [
      readAction('GET', ['/edit/servers']),
      readAction('GET', ['/edit/clusters']),
    ],
    run: runTopologyConfigurationPreflightSmoke,
  },
  {
    name: 'topology-config-disposable-mutations',
    profile: 'topology-config',
    mode: 'helper',
    defaultEnabled: false,
    readActions: [
      readAction('GET', ['/edit/servers']),
      readAction('GET', ['/edit/clusters']),
    ],
    mutations: [
      mutation('POST', ['/edit/changeManager/startEdit']),
      mutation('POST', ['/edit/changeManager/activate']),
      mutation('POST', ['/edit/changeManager/cancelEdit']),
      mutation('POST', ['/edit/servers']),
      mutation('POST', ['/edit/clusters']),
      mutation('DELETE', ['/edit/servers/']),
      mutation('DELETE', ['/edit/clusters/']),
    ],
    run: runTopologyConfigurationDisposableMutationSmoke,
  },
]

function normalizedCheckFilter(checkFilter) {
  if (checkFilter instanceof Set) return checkFilter
  return new Set(
    String(checkFilter ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
}

export function selectSmokeChecks({
  profile = DEFAULT_SMOKE_PROFILE,
  checkFilter = '',
  registry = SMOKE_CHECK_REGISTRY,
} = {}) {
  if (!SUPPORTED_SMOKE_PROFILES.includes(profile)) {
    throw new Error(`Unsupported WLS_SMOKE_PROFILE=${profile}. Supported profiles: ${SUPPORTED_SMOKE_PROFILES.join(', ')}`)
  }

  const filter = normalizedCheckFilter(checkFilter)
  const byName = new Map(registry.map((check) => [check.name, check]))
  const unknown = [...filter].filter((name) => !byName.has(name))
  if (unknown.length) throw new Error(`Unknown WLS_SMOKE_CHECKS: ${unknown.join(', ')}`)

  const incompatible = [...filter]
    .map((name) => byName.get(name))
    .filter((check) => check && check.profile !== profile)
  if (incompatible.length) {
    throw new Error(
      incompatible
        .map((check) => `${check.name} belongs to WLS_SMOKE_PROFILE=${check.profile}, not ${profile}`)
        .join('; '),
    )
  }

  const checks = registry.filter(
    (check) => check.profile === profile && (filter.size === 0 ? check.defaultEnabled !== false : filter.has(check.name)),
  )
  if (checks.length === 0) {
    throw new Error(`No visual smoke checks matched WLS_SMOKE_PROFILE=${profile} WLS_SMOKE_CHECKS=${[...filter].join(',') || '-'}`)
  }

  return {
    profile,
    checks,
    skipped: registry.filter((check) => !checks.includes(check)).map((check) => check.name),
  }
}

function auditCdpWlsRequests(events, startIndex, check) {
  events.slice(startIndex).forEach((event) => {
    if (event.method !== 'Network.requestWillBeSent') return
    const request = event.params.request
    const url = request?.url ?? ''
    const isWlsRequest = url.includes('/api/wls')
    const isAuditedJmsMutation = url.includes('/api/jms/messages/produce') || url.includes('/api/jms/messages/delete')
    if (!isWlsRequest && !isAuditedJmsMutation) return
    auditSmokeRequest({
      profile: check.profile,
      check,
      method: request.method,
      path: request.url,
    })
  })
}

async function runRegisteredCheck(session, check, creds) {
  const eventStartIndex = session.events.length
  activeSmokeCheck = check
  try {
    const result = await check.run(session, creds)
    auditCdpWlsRequests(session.events, eventStartIndex, check)
    return result
  } finally {
    activeSmokeCheck = null
  }
}

async function runCheck(session, check, creds) {
  await navigate(session, check.path, creds)
  const text = await waitForExpectedText(session, check.name, check.expected, check.forbidden)
  if (check.assertFailedNotRestartableStart) {
    await assertFailedNotRestartableStartAffordance(session, check.name)
  }
  await assertHrefs(session, check.name, check.hrefs)
  const screenshotPath = await screenshot(session, check.name)
  return {
    name: check.name,
    path: check.path,
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function runUrlStateCheck(session, check, creds) {
  await navigate(session, check.path, creds)
  await assertRouteState(session, check.name, check.path)
  await waitForExpectedText(session, check.name, check.expected, check.forbidden)
  await clickRouteLink(session, check.name, check.detailHref)
  await waitForRouteState(session, `${check.name}-detail`, check.detailHref)
  await waitForExpectedText(session, `${check.name}-detail`, check.detailExpected, check.forbidden)
  await clickRouteLink(session, `${check.name}-return`, check.path)
  await waitForRouteState(session, `${check.name}-return`, check.path)
  const text = await waitForExpectedText(session, `${check.name}-returned`, check.expected, check.forbidden)
  const screenshotPath = await screenshot(session, check.name)

  return {
    name: check.name,
    path: check.path,
    screenshot: screenshotPath,
    textSample: text.split('\n').filter(Boolean).slice(0, 16),
  }
}

async function main() {
  const selection = selectSmokeChecks({
    profile: WLS_SMOKE_PROFILE,
    checkFilter: CHECK_FILTER,
  })

  if (!credentials.password) {
    throw new Error('Set WLS_SMOKE_PASSWORD to run visual smoke against the lab VM.')
  }

  await mkdir(ARTIFACT_DIR, { recursive: true })
  const chrome = await launchChromeIfNeeded()
  const target = await newTarget()
  const session = createCdpSession(target.webSocketDebuggerUrl)
  await session.opened

  try {
    await session.send('Page.enable')
    await session.send('Runtime.enable')
    await session.send('Network.enable')
    if (shouldEnableDemoReadOnly()) await installDemoReadOnlyRuntime(session)

    const results = []
    for (const check of selection.checks) {
      results.push(await runRegisteredCheck(session, check, credentials))
    }

    const failedRequests = failedNetworkResponses(session.events)
    if (failedRequests.length) throw new Error(`Unexpected 5xx responses: ${failedRequests.join('; ')}`)
    const consoleIssues = browserConsoleIssues(session.events)
    if (consoleIssues.length) {
      throw new Error(`Unexpected browser console issues: ${consoleIssues.join('; ')}`)
    }

    const summary = {
      ok: true,
      appUrl: APP_URL,
      profile: selection.profile,
      selectedChecks: selection.checks.map((check) => check.name),
      skippedChecks: selection.skipped,
      artifactDir: ARTIFACT_DIR,
      results,
      failedRequests,
      consoleIssues,
    }
    await writeFile(resolve(ARTIFACT_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    await closeCdpPage(session)
    session.close()
    if (chrome) chrome.kill()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    },
  )
}
