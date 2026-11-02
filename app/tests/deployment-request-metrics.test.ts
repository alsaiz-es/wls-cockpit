import assert from 'node:assert/strict'
import test from 'node:test'
import type { WlsCredentials } from '../src/api/client.ts'
import { WLS_TARGET_HEADER } from '../src/api/proxy-target.ts'
import {
  DEPLOYMENT_REQUEST_EXECUTION_TOTAL_METRIC,
  DEPLOYMENT_REQUEST_INVOCATIONS_METRIC,
  DEPLOYMENT_REQUEST_METRIC_FAMILY,
  DEPLOYMENT_REQUEST_VISIBLE_SERVLET_LIMIT,
  deploymentRequestMetricsEnabled,
  deploymentRequestMetricsQueryKey,
  deploymentRequestServletResourceId,
  deriveIntervalAverageExecutionTime,
  deriveRequestRate,
  deriveServletIntervalMetrics,
  deriveWebModuleAggregate,
  fetchDeploymentRequestMetricsSnapshot,
  normalizeDeploymentRequestServlet,
  normalizeDeploymentRequestWebModule,
  projectDeploymentRequestMetricSamples,
  sortDeploymentRequestServlets,
} from '../src/api/queries/deployment-request-metrics.ts'
import {
  getMetricHistorySeries,
  metricHistoryScopeKey,
  recordMetricSample,
  recordMetricSamples,
  resetMetricHistory,
} from '../src/api/queries/metric-history.ts'

const creds: WlsCredentials = {
  profileId: 'lab',
  name: 'Lab',
  targetUrl: 'http://wls-admin.example.com:7001',
  username: 'admin',
  password: 'unit-test-pass',
  version: '12.2.1.4.0',
}

function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function installMockFetch(fetchImpl: typeof fetch): () => void {
  const originalFetch = globalThis.fetch
  const originalRequest = globalThis.Request
  globalThis.Request = class RelativeUrlRequest extends originalRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init)
    }
  } as typeof Request
  globalThis.fetch = fetchImpl
  return () => {
    globalThis.fetch = originalFetch
    globalThis.Request = originalRequest
  }
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]) {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

function fetchHeader(init: RequestInit | undefined, name: string) {
  if (!init?.headers) return null
  const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers)
  return headers.get(name)
}

test('deployment request metric query keys are scoped by credentials and route params', () => {
  assert.equal(deploymentRequestMetricsEnabled(creds, 'osb_server1', 'OrdersApp'), true)
  assert.equal(deploymentRequestMetricsEnabled(null, 'osb_server1', 'OrdersApp'), false)
  assert.deepEqual(deploymentRequestMetricsQueryKey(creds, 'osb_server1', 'OrdersApp').slice(0, 1), [
    'deployment-request-metrics',
  ])
})

test('normalizes web-module identity/session fields and servlet counters defensively', () => {
  const module = normalizeDeploymentRequestWebModule({
    type: 'WebAppComponentRuntime',
    name: 'osb_server1_/orders',
    componentName: 'orders.war',
    moduleId: '/orders',
    moduleURI: 'orders.war',
    contextRoot: 'orders',
    configuredContextRoot: '/orders',
    deploymentState: 2,
    status: 'DEPLOYED',
    openSessionsCurrentCount: 4,
    openSessionsHighCount: 9,
  })
  assert.ok(module)
  assert.equal(module.contextRoot, '/orders')
  assert.equal(module.openSessionsCurrentCount, 4)
  assert.deepEqual(module.servlets, [])

  const servlet = normalizeDeploymentRequestServlet({
    name: 'OrdersServlet',
    servletName: 'orders',
    servletPath: '/api/orders',
    URL: '/orders/api/orders',
    URLPatterns: ['/api/orders', ''],
    invocationTotalCount: 120,
    executionTimeAverage: 8,
    executionTimeHigh: 42,
    executionTimeLow: 1,
    executionTimeTotal: 960,
  })
  assert.ok(servlet)
  assert.equal(servlet.id, 'OrdersServlet')
  assert.deepEqual(servlet.urlPatterns, ['/api/orders'])
  assert.equal(servlet.executionTimeTotal, 960)

  assert.equal(normalizeDeploymentRequestWebModule({ type: 'EJBComponentRuntime', name: 'ejb' }), null)
  assert.equal(normalizeDeploymentRequestServlet({ invocationTotalCount: 1 }), null)
})

test('fetchDeploymentRequestMetricsSnapshot fetches per-web-module servlet collections with read-only requests', async () => {
  const calls: Array<{ url: string; method: string; headers: Headers; init?: RequestInit }> = []
  const restore = installMockFetch(async (input, init) => {
    const url = fetchInputUrl(input)
    calls.push({
      url,
      method: input instanceof Request ? input.method : (init?.method ?? 'GET'),
      headers: input instanceof Request ? input.headers : new Headers(init?.headers),
      init,
    })

    if (url.includes('/componentRuntimes?')) {
      return json({
        items: [
          {
            type: 'WebAppComponentRuntime',
            name: 'osb_server1_/orders',
            componentName: 'orders.war',
            moduleId: '/orders',
            contextRoot: '/orders',
            openSessionsCurrentCount: 1,
          },
          { type: 'EJBComponentRuntime', name: 'orders-ejb' },
        ],
      })
    }
    if (url.includes('/componentRuntimes/osb_server1_%2Forders/servlets?')) {
      return json({
        items: [
          {
            name: 'OrdersServlet',
            servletName: 'orders',
            invocationTotalCount: 5,
            executionTimeAverage: 7,
            executionTimeHigh: 20,
            executionTimeLow: 2,
            executionTimeTotal: 35,
          },
        ],
      })
    }
    throw new Error(`unexpected URL ${url}`)
  }) as typeof fetch

  try {
    const snapshot = await fetchDeploymentRequestMetricsSnapshot(creds, 'osb_server1', 'OrdersApp')
    assert.equal(snapshot.webModules.length, 1)
    assert.equal(snapshot.webModules[0]?.servlets.length, 1)
    assert.deepEqual(snapshot.partialFailures, [])
    assert.equal(calls.length, 2)
    assert.equal(calls.every((call) => call.method === 'GET'), true)
    assert.equal(calls.some((call) => call.url.includes('/servlets?')), true)
    assert.equal(calls.some((call) => /startEdit|activate|cancelEdit|threadStackDump/.test(call.url)), false)
    assert.equal(calls[0]?.headers.get(WLS_TARGET_HEADER) ?? fetchHeader(calls[0]?.init, WLS_TARGET_HEADER), creds.targetUrl)
  } finally {
    restore()
  }
})

test('servlet collection failures are partial data and keep module session metrics', async () => {
  const restore = installMockFetch(async (input) => {
    const url = fetchInputUrl(input)
    if (url.includes('/componentRuntimes?')) {
      return json({
        items: [
          {
            type: 'WebAppComponentRuntime',
            name: 'osb_server1_/orders',
            contextRoot: '/orders',
            openSessionsCurrentCount: 2,
          },
        ],
      })
    }
    if (url.includes('/servlets?')) return json({ error: 'missing' }, { status: 404, statusText: 'Not Found' })
    throw new Error(`unexpected URL ${url}`)
  }) as typeof fetch

  try {
    const snapshot = await fetchDeploymentRequestMetricsSnapshot(creds, 'osb_server1', 'OrdersApp')
    assert.equal(snapshot.webModules.length, 1)
    assert.equal(snapshot.webModules[0]?.openSessionsCurrentCount, 2)
    assert.equal(snapshot.webModules[0]?.servlets.length, 0)
    assert.match(snapshot.webModules[0]?.servletFailure ?? '', /HTTP 404/)
    assert.equal(snapshot.partialFailures.length, 1)
  } finally {
    restore()
  }
})

test('request rates and interval averages reject resets, duplicate timestamps, and gaps', () => {
  assert.equal(
    deriveRequestRate({
      family: 'deployment-request',
      resourceId: 'r',
      metric: 'm',
      latest: 20,
      previous: 10,
      delta: 10,
      direction: 'up',
      hasGap: false,
      samples: [
        { timestamp: 1000, value: 10, gapBefore: false },
        { timestamp: 6000, value: 20, gapBefore: false },
      ],
    }).value,
    2,
  )
  assert.equal(
    deriveRequestRate({
      family: 'deployment-request',
      resourceId: 'r',
      metric: 'm',
      latest: 2,
      previous: 10,
      delta: -8,
      direction: 'down',
      hasGap: false,
      samples: [
        { timestamp: 1000, value: 10, gapBefore: false },
        { timestamp: 6000, value: 2, gapBefore: false },
      ],
    }).value,
    null,
  )
  assert.equal(
    deriveRequestRate({
      family: 'deployment-request',
      resourceId: 'r',
      metric: 'm',
      latest: 20,
      previous: 10,
      delta: 10,
      direction: 'up',
      hasGap: true,
      samples: [
        { timestamp: 1000, value: 10, gapBefore: false },
        { timestamp: 6000, value: 20, gapBefore: true },
      ],
    }).value,
    null,
  )

  const executionSeries = {
    family: 'deployment-request',
    resourceId: 'r',
    metric: 'execution',
    latest: 150,
    previous: 100,
    delta: 50,
    direction: 'up' as const,
    hasGap: false,
    samples: [
      { timestamp: 1000, value: 100, gapBefore: false },
      { timestamp: 6000, value: 150, gapBefore: false },
    ],
  }
  const invocationSeries = {
    ...executionSeries,
    metric: 'invocations',
    latest: 15,
    previous: 10,
    delta: 5,
    samples: [
      { timestamp: 1000, value: 10, gapBefore: false },
      { timestamp: 6000, value: 15, gapBefore: false },
    ],
  }
  assert.equal(deriveIntervalAverageExecutionTime(executionSeries, invocationSeries), 10)
})

test('records servlet samples and derives web-module aggregates from servlet counters', () => {
  resetMetricHistory()
  const scope = metricHistoryScopeKey(creds)
  const module = normalizeDeploymentRequestWebModule({
    type: 'WebAppComponentRuntime',
    name: 'osb_server1_/orders',
    contextRoot: '/orders',
  })
  assert.ok(module)
  module.servlets = [
    {
      id: 'OrdersServlet',
      name: 'OrdersServlet',
      servletName: 'orders',
      servletPath: '/orders',
      contextPath: '/orders',
      url: '/orders',
      urlPatterns: ['/orders'],
      invocationTotalCount: 30,
      executionTimeAverage: 10,
      executionTimeHigh: 60,
      executionTimeLow: 2,
      executionTimeTotal: 300,
    },
    {
      id: 'HealthServlet',
      name: 'HealthServlet',
      servletName: 'health',
      servletPath: '/health',
      contextPath: '/orders',
      url: '/health',
      urlPatterns: ['/health'],
      invocationTotalCount: 10,
      executionTimeAverage: 5,
      executionTimeHigh: 12,
      executionTimeLow: 1,
      executionTimeTotal: 50,
    },
  ]
  const first = {
    serverName: 'osb_server1',
    applicationName: 'OrdersApp',
    partialFailures: [],
    webModules: [
      {
        ...module,
        servlets: module.servlets.map((servlet) => ({
          ...servlet,
          invocationTotalCount: servlet.servletName === 'orders' ? 10 : 5,
          executionTimeTotal: servlet.servletName === 'orders' ? 100 : 25,
        })),
      },
    ],
  }
  const second = {
    ...first,
    webModules: [module],
  }

  recordMetricSamples(scope, projectDeploymentRequestMetricSamples(first), 1000)
  recordMetricSamples(scope, projectDeploymentRequestMetricSamples(second), 6000)

  const aggregate = deriveWebModuleAggregate({
    module,
    scopeKey: scope,
    serverName: 'osb_server1',
    applicationName: 'OrdersApp',
  })
  assert.equal(aggregate.totalInvocations, 40)
  assert.equal(aggregate.intervalRequestRate, 5)
  assert.equal(aggregate.intervalAverageExecutionTime, 9)
  assert.equal(aggregate.lifetimeAverageExecutionTime, 8.75)
  assert.equal(aggregate.executionTimeHigh, 60)
  assert.equal(aggregate.executionTimeLow, 1)

  const servletMetrics = deriveServletIntervalMetrics({
    servlet: module.servlets[0]!,
    scopeKey: scope,
    serverName: 'osb_server1',
    applicationName: 'OrdersApp',
    moduleId: module.id,
  })
  assert.equal(servletMetrics.intervalRequestRate, 4)
  assert.equal(servletMetrics.intervalAverageExecutionTime, 10)

  const resourceId = deploymentRequestServletResourceId('osb_server1', 'OrdersApp', module.id, 'OrdersServlet')
  assert.equal(
    getMetricHistorySeries(scope, DEPLOYMENT_REQUEST_METRIC_FAMILY, resourceId, DEPLOYMENT_REQUEST_INVOCATIONS_METRIC)
      .samples.length,
    2,
  )
  assert.equal(
    getMetricHistorySeries(scope, DEPLOYMENT_REQUEST_METRIC_FAMILY, resourceId, DEPLOYMENT_REQUEST_EXECUTION_TOTAL_METRIC)
      .samples.length,
    2,
  )
})

test('servlet rows sort by interval RPS, total invocations, then name, and visible cap is bounded', () => {
  assert.equal(DEPLOYMENT_REQUEST_VISIBLE_SERVLET_LIMIT, 20)
  const rows = sortDeploymentRequestServlets([
    {
      servlet: { ...normalizeDeploymentRequestServlet({ name: 'b', invocationTotalCount: 10 })! },
      intervalRequestRate: null,
    },
    {
      servlet: { ...normalizeDeploymentRequestServlet({ name: 'a', invocationTotalCount: 20 })! },
      intervalRequestRate: null,
    },
    {
      servlet: { ...normalizeDeploymentRequestServlet({ name: 'c', invocationTotalCount: 1 })! },
      intervalRequestRate: 3,
    },
  ])
  assert.deepEqual(rows.map((row) => row.servlet.name), ['c', 'a', 'b'])
})

test('deployment request metrics never write browser storage', () => {
  resetMetricHistory()
  const originalLocalStorage = globalThis.localStorage
  const originalSessionStorage = globalThis.sessionStorage
  const localWrites: string[] = []
  const sessionWrites: string[] = []
  const storage = (writes: string[]) => ({
    get length() {
      return writes.length
    },
    clear() {
      writes.push('clear')
    },
    getItem() {
      return null
    },
    key() {
      return null
    },
    removeItem(key: string) {
      writes.push(`remove:${key}`)
    },
    setItem(key: string) {
      writes.push(`set:${key}`)
    },
  })

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage(localWrites),
  })
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage(sessionWrites),
  })

  try {
    const scope = metricHistoryScopeKey(creds)
    const resourceId = deploymentRequestServletResourceId('osb_server1', 'OrdersApp', 'module', 'servlet')
    recordMetricSample(scope, { family: DEPLOYMENT_REQUEST_METRIC_FAMILY, resourceId, metric: DEPLOYMENT_REQUEST_INVOCATIONS_METRIC, value: 1 }, 1000)
    assert.equal(globalThis.localStorage.length, 0)
    assert.equal(globalThis.sessionStorage.length, 0)
    assert.deepEqual(localWrites, [])
    assert.deepEqual(sessionWrites, [])
  } finally {
    if (originalLocalStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
    else {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      })
    }

    if (originalSessionStorage === undefined) Reflect.deleteProperty(globalThis, 'sessionStorage')
    else {
      Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: originalSessionStorage,
      })
    }
  }
})
