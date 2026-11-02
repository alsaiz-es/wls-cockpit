import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ADVANCED_WEB_MODULE_FIELDS,
  BASIC_WEB_MODULE_FIELDS,
  buildDeploymentUrl,
  classifyProbeError,
  classifyProbeResponse,
  deploymentWebAccessEnabled,
  deploymentWebAccessQueryKey,
  deploymentWebModuleAdvancedMetadataEnabled,
  deploymentWebModuleAdvancedMetadataQueryKey,
  fallbackServerHttpUrl,
  fetchDeploymentWebAccessSnapshot,
  normalizeManagedServerHttpUrlFallback,
  normalizeContextRoot,
  normalizeServerHttpUrlResponse,
  normalizeWebModule,
  normalizeWebModuleAdvancedMetadata,
  probeDeploymentUrl,
  SERVER_RUNTIME_WEB_URL_FIELDS,
} from '../src/api/queries/deployment-web-modules.ts'

const creds = {
  profileId: 'default',
  name: 'Default domain',
  targetUrl: 'http://wls-admin.example.com:7001',
  username: 'admin',
  password: 'unit-test-pass',
  version: '14.1.2.0.0',
} as const

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (typeof input === 'object' && !(input instanceof URL) && 'method' in input) return input.method
  return init?.method ?? 'GET'
}

function installMockFetch(fetchImpl: typeof fetch): () => void {
  const originalFetch = globalThis.fetch
  const OriginalRequest = globalThis.Request

  class RelativeRequest extends OriginalRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      const normalizedInput =
        typeof input === 'string' && input.startsWith('/') ? `http://wls-cockpit.test${input}` : input
      super(normalizedInput, init)
    }
  }

  globalThis.Request = RelativeRequest
  globalThis.fetch = fetchImpl
  return () => {
    globalThis.fetch = originalFetch
    globalThis.Request = OriginalRequest
  }
}

test('normalizes context roots', () => {
  assert.equal(normalizeContextRoot('/orders'), '/orders')
  assert.equal(normalizeContextRoot('orders'), '/orders')
  assert.equal(normalizeContextRoot('/'), '/')
  assert.equal(normalizeContextRoot(''), null)
  assert.equal(normalizeContextRoot(null), null)
})

test('builds deployment URLs from sanitized server URL and context root', () => {
  assert.equal(buildDeploymentUrl('http://wls-admin.example.com:7001/', '/orders'), 'http://wls-admin.example.com:7001/orders')
  assert.equal(buildDeploymentUrl('http://user:secret@wls-admin.example.com:7001/base', 'orders'), 'http://wls-admin.example.com:7001/orders')
  assert.equal(buildDeploymentUrl('https://wls-admin.example.com:7002', '/'), 'https://wls-admin.example.com:7002/')
  assert.equal(buildDeploymentUrl('file:///tmp/app', '/orders'), null)
  assert.equal(buildDeploymentUrl(null, '/orders'), null)
})

test('normalizes server HTTP URL action responses', () => {
  assert.equal(normalizeServerHttpUrlResponse({ return: 'http://127.0.0.1:7001' }), 'http://127.0.0.1:7001')
  assert.equal(normalizeServerHttpUrlResponse('https://wls-admin.example.com:7002/'), 'https://wls-admin.example.com:7002')
  assert.equal(normalizeServerHttpUrlResponse({ return: 'file:///tmp/app' }), null)
  assert.equal(normalizeServerHttpUrlResponse({ value: 'http://wls-admin.example.com:7001' }), null)
})

test('falls back to sanitized active target URL for AdminServer and runtime default URL for managed servers', () => {
  assert.equal(
    fallbackServerHttpUrl({ targetUrl: 'http://user:secret@wls-admin.example.com:7001/console?x=1#top' }, 'AdminServer'),
    'http://wls-admin.example.com:7001',
  )
  assert.equal(fallbackServerHttpUrl({ targetUrl: 'http://wls-admin.example.com:7001' }, 'osb_server1'), null)
  assert.equal(fallbackServerHttpUrl({ targetUrl: 'file:///tmp/domain' }, 'AdminServer'), null)
  assert.equal(
    fallbackServerHttpUrl(
      { targetUrl: 'http://wls-admin.example.com:7001' },
      'osb_server1',
      { listenPortEnabled: true, defaultURL: 't3://127.0.0.1:7003' },
    ),
    'http://wls-admin.example.com:7003',
  )
})

test('normalizes managed server URL fallback conservatively', () => {
  assert.equal(
    normalizeManagedServerHttpUrlFallback(
      { targetUrl: 'http://wls-admin.example.com:7001' },
      { listenPortEnabled: true, defaultURL: 't3://127.0.0.1:7003' },
    ),
    'http://wls-admin.example.com:7003',
  )
  assert.equal(
    normalizeManagedServerHttpUrlFallback(
      { targetUrl: 'https://admin.example.com:7002' },
      { listenPortEnabled: true, defaultURL: 't3s://managed.example.com:7004/path?x=1#top' },
    ),
    'https://managed.example.com:7004',
  )
  assert.equal(
    normalizeManagedServerHttpUrlFallback(
      { targetUrl: 'http://wls-admin.example.com:7001' },
      { listenPortEnabled: false, defaultURL: 't3://127.0.0.1:7003' },
    ),
    null,
  )
  assert.equal(
    normalizeManagedServerHttpUrlFallback(
      { targetUrl: 'http://wls-admin.example.com:7001' },
      { listenPortEnabled: true, defaultURL: 'ldap://managed.example.com:7003' },
    ),
    null,
  )
})

test('deployment web access skips server URL lookup when no web modules exist', async () => {
  const calls: Array<{ url: string; method: string }> = []
  const restore = installMockFetch(async (input, init) => {
    const url = requestUrl(input)
    const method = requestMethod(input, init)
    calls.push({ url, method })
    if (url.includes('/componentRuntimes')) {
      return Response.json({ items: [{ type: 'EJBComponentRuntime', name: 'orders-ejb' }] })
    }
    throw new Error(`Unexpected request: ${method} ${url}`)
  })

  try {
    const snapshot = await fetchDeploymentWebAccessSnapshot(creds, 'osb_server1', 'OrdersApp')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.method, 'GET')
    assert.equal(calls[0]?.url.includes('/componentRuntimes'), true)
    assert.deepEqual(snapshot, {
      serverHttpUrl: null,
      webModules: [],
      partialFailures: [],
    })
  } finally {
    restore()
  }
})

test('deployment web access uses AdminServer target fallback when server URL lookup fails', async () => {
  const calls: Array<{ url: string; method: string }> = []
  const restore = installMockFetch(async (input, init) => {
    const url = requestUrl(input)
    const method = requestMethod(input, init)
    calls.push({ url, method })
    if (url.includes('/componentRuntimes')) {
      return Response.json({
        items: [
          {
            type: 'WebAppComponentRuntime',
            name: 'AdminServer_/servicebus',
            contextRoot: '/servicebus',
            deploymentState: 'ACTIVE',
            status: 'DEPLOYED',
          },
        ],
      })
    }
    if (url.includes('/getServerHttpURL')) {
      return Response.json({ title: 'Not Found' }, { status: 404, statusText: 'Not Found' })
    }
    throw new Error(`Unexpected request: ${method} ${url}`)
  })

  try {
    const snapshot = await fetchDeploymentWebAccessSnapshot(
      { ...creds, targetUrl: 'http://user:secret@wls-admin.example.com:7001/console?x=1#top' },
      'AdminServer',
      'servicebus',
    )
    assert.deepEqual(
      calls.map((call) => call.method),
      ['GET', 'POST'],
    )
    assert.equal(snapshot.serverHttpUrl, 'http://wls-admin.example.com:7001')
    assert.equal(snapshot.webModules[0]?.url, 'http://wls-admin.example.com:7001/servicebus')
    assert.deepEqual(snapshot.partialFailures, [])
  } finally {
    restore()
  }
})

test('deployment web access uses managed-server runtime default URL fallback when server URL lookup fails', async () => {
  const calls: Array<{ url: string; method: string }> = []
  const restore = installMockFetch(async (input, init) => {
    const url = requestUrl(input)
    const method = requestMethod(input, init)
    calls.push({ url, method })
    if (url.includes('/componentRuntimes')) {
      return Response.json({
        items: [
          {
            type: 'WebAppComponentRuntime',
            name: 'osb_server1_/web',
            contextRoot: '/web',
            deploymentState: 'ACTIVE',
            status: 'DEPLOYED',
          },
        ],
      })
    }
    if (url.includes('/getServerHttpURL')) {
      return Response.json({ title: 'Not Found' }, { status: 404, statusText: 'Not Found' })
    }
    if (url.includes('/serverRuntimes/osb_server1')) {
      return Response.json({ name: 'osb_server1', listenPortEnabled: true, defaultURL: 't3://127.0.0.1:7003' })
    }
    throw new Error(`Unexpected request: ${method} ${url}`)
  })

  try {
    const snapshot = await fetchDeploymentWebAccessSnapshot(creds, 'osb_server1', 'OrdersApp')
    assert.deepEqual(
      calls.map((call) => call.method),
      ['GET', 'POST', 'GET'],
    )
    assert.equal(snapshot.serverHttpUrl, 'http://wls-admin.example.com:7003')
    assert.equal(snapshot.webModules[0]?.url, 'http://wls-admin.example.com:7003/web')
    assert.deepEqual(snapshot.partialFailures, [])
  } finally {
    restore()
  }
})

test('deployment web access keeps managed-server URL failures visible when no fallback is safe', async () => {
  const restore = installMockFetch(async (input, init) => {
    const url = requestUrl(input)
    const method = requestMethod(input, init)
    if (url.includes('/componentRuntimes')) {
      return Response.json({
        items: [
          {
            type: 'WebAppComponentRuntime',
            name: 'osb_server1_/orders',
            contextRoot: '/orders',
            deploymentState: 'ACTIVE',
            status: 'DEPLOYED',
          },
        ],
      })
    }
    if (url.includes('/getServerHttpURL')) {
      return Response.json({ title: 'Not Found' }, { status: 404, statusText: 'Not Found' })
    }
    if (url.includes('/serverRuntimes/osb_server1')) {
      return Response.json({ name: 'osb_server1', listenPortEnabled: false, defaultURL: 't3://127.0.0.1:7003' })
    }
    throw new Error(`Unexpected request: ${method} ${url}`)
  })

  try {
    const snapshot = await fetchDeploymentWebAccessSnapshot(creds, 'osb_server1', 'OrdersApp')
    assert.equal(snapshot.serverHttpUrl, null)
    assert.equal(snapshot.webModules[0]?.url, null)
    assert.equal(snapshot.partialFailures.length, 1)
    assert.equal(snapshot.partialFailures[0]?.resource, 'server URL osb_server1')
    assert.match(snapshot.partialFailures[0]?.message ?? '', /HTTP 404 Not Found/)
  } finally {
    restore()
  }
})

test('web module field allow-lists split basic URL data from advanced metadata', () => {
  const basicFields = BASIC_WEB_MODULE_FIELDS.split(',')
  const advancedFields = ADVANCED_WEB_MODULE_FIELDS.split(',')
  const serverRuntimeFields = SERVER_RUNTIME_WEB_URL_FIELDS.split(',')

  assert.equal(
    ['name', 'type', 'componentName', 'moduleId', 'moduleURI', 'contextRoot', 'configuredContextRoot'].every((field) =>
      basicFields.includes(field),
    ),
    true,
  )
  assert.equal(basicFields.includes('sourceInfo'), false)
  assert.equal(basicFields.includes('sessionCookieName'), false)
  assert.equal(basicFields.includes('servletReloadCheckSecs'), false)
  assert.equal(advancedFields.includes('sourceInfo'), true)
  assert.equal(advancedFields.includes('sessionCookieName'), true)
  assert.equal(advancedFields.includes('servletReloadCheckSecs'), true)
  assert.equal(advancedFields.includes('servletSessionsMonitoringIds'), false)
  assert.equal(advancedFields.includes('contextRoot'), false)
  assert.deepEqual(serverRuntimeFields, ['name', 'defaultURL', 'listenPortEnabled'])
})

test('normalizes only basic WebAppComponentRuntime rows for first render', () => {
  assert.equal(normalizeWebModule({ type: 'ConnectorComponentRuntime', name: 'jms' }, 'http://wls-admin.example.com:7001'), null)

  const module = normalizeWebModule(
    {
      type: 'WebAppComponentRuntime',
      name: 'AdminServer_/demo',
      componentName: 'demo.war',
      moduleId: '/demo',
      moduleURI: 'demo.war',
      contextRoot: 'demo',
      configuredContextRoot: '/demo',
      deploymentState: 2,
      status: 'DEPLOYED',
      sourceInfo: 'demo.war',
      logFilename: '/tmp/demo.log',
      openSessionsCurrentCount: 3,
      openSessionsHighCount: 5,
      sessionsOpenedTotalCount: 8,
      sessionTimeoutSecs: 3600,
      sessionInvalidationIntervalSecs: 60,
      sessionCookieName: 'JSESSIONID',
      sessionCookiePath: '/',
      sessionCookieMaxAgeSecs: -1,
      sessionIDLength: 52,
      sessionMonitoringEnabled: false,
      servletReloadCheckSecs: -1,
      JSPPageCheckSecs: -1,
      JSPDebug: false,
      JSPKeepGenerated: false,
      JSPVerbose: false,
      filterDispatchedRequestsEnabled: false,
      indexDirectoryEnabled: false,
      singleThreadedServletPoolSize: 5,
      servletSessionsMonitoringIds: ['sensitive-session-id'],
    },
    'http://wls-admin.example.com:7001',
  )

  assert.deepEqual(module, {
    id: 'AdminServer_/demo',
    name: 'AdminServer_/demo',
    componentName: 'demo.war',
    moduleId: '/demo',
    moduleUri: 'demo.war',
    contextRoot: '/demo',
    configuredContextRoot: '/demo',
    deploymentState: 2,
    status: 'DEPLOYED',
    openSessionsCurrentCount: 3,
    openSessionsHighCount: 5,
    url: 'http://wls-admin.example.com:7001/demo',
  })
  assert.equal(Object.hasOwn(module ?? {}, 'sourceInfo'), false)
  assert.equal(Object.hasOwn(module ?? {}, 'sessionCookieName'), false)
  assert.equal(Object.hasOwn(module ?? {}, 'servletSessionsMonitoringIds'), false)
})

test('normalizes advanced WebAppComponentRuntime metadata separately', () => {
  assert.equal(normalizeWebModuleAdvancedMetadata({ type: 'ConnectorComponentRuntime', name: 'jms' }), null)

  const metadata = normalizeWebModuleAdvancedMetadata({
    type: 'WebAppComponentRuntime',
    name: 'AdminServer_/demo',
    componentName: 'demo.war',
    moduleId: '/demo',
    moduleURI: 'demo.war',
    contextRoot: 'demo',
    sourceInfo: 'demo.war',
    logFilename: '/tmp/demo.log',
    sessionsOpenedTotalCount: 8,
    sessionTimeoutSecs: 3600,
    sessionInvalidationIntervalSecs: 60,
    sessionCookieName: 'JSESSIONID',
    sessionCookiePath: '/',
    sessionCookieMaxAgeSecs: -1,
    sessionIDLength: 52,
    sessionMonitoringEnabled: false,
    servletReloadCheckSecs: -1,
    JSPPageCheckSecs: -1,
    JSPDebug: false,
    JSPKeepGenerated: false,
    JSPVerbose: false,
    filterDispatchedRequestsEnabled: false,
    indexDirectoryEnabled: false,
    singleThreadedServletPoolSize: 5,
    servletSessionsMonitoringIds: ['sensitive-session-id'],
  })

  assert.deepEqual(metadata, {
    id: 'AdminServer_/demo',
    name: 'AdminServer_/demo',
    sourceInfo: 'demo.war',
    logFilename: '/tmp/demo.log',
    sessionsOpenedTotalCount: 8,
    sessionTimeoutSecs: 3600,
    sessionInvalidationIntervalSecs: 60,
    sessionCookieName: 'JSESSIONID',
    sessionCookiePath: '/',
    sessionCookieMaxAgeSecs: -1,
    sessionIdLength: 52,
    sessionMonitoringEnabled: false,
    servletReloadCheckSecs: -1,
    jspPageCheckSecs: -1,
    jspDebug: false,
    jspKeepGenerated: false,
    jspVerbose: false,
    filterDispatchedRequestsEnabled: false,
    indexDirectoryEnabled: false,
    singleThreadedServletPoolSize: 5,
  })
  assert.equal(Object.hasOwn(metadata ?? {}, 'contextRoot'), false)
  assert.equal(Object.hasOwn(metadata ?? {}, 'servletSessionsMonitoringIds'), false)
})

test('classifies probe responses', () => {
  assert.deepEqual(classifyProbeResponse(new Response(null, { status: 204, statusText: 'No Content' }), 12), {
    status: 'success',
    statusCode: 204,
    statusText: 'No Content',
    latencyMs: 12,
    redirected: false,
    message: 'HTTP 204 No Content',
  })

  assert.equal(classifyProbeResponse(new Response(null, { status: 302, statusText: 'Found' }), 20).status, 'redirect')
  assert.equal(classifyProbeResponse(new Response(null, { status: 503, statusText: 'Unavailable' }), 30).status, 'http-error')
})

test('classifies probe errors', () => {
  assert.equal(classifyProbeError(new DOMException('aborted', 'AbortError'), 4000).status, 'timeout')
  assert.equal(classifyProbeError(new TypeError('Failed to fetch'), 35).status, 'blocked')
  assert.equal(classifyProbeError(new Error('socket hang up'), 40).status, 'network-error')
})

test('probeDeploymentUrl uses explicit GET with bounded timeout inputs', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const result = await probeDeploymentUrl('http://wls-admin.example.com:7001/demo', {
    now: (() => {
      let value = 0
      return () => {
        value += 25
        return value
      }
    })(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(null, { status: 200, statusText: 'OK' })
    },
  })

  assert.equal(result.status, 'success')
  assert.equal(result.latencyMs, 25)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'http://wls-admin.example.com:7001/demo')
  assert.equal(calls[0]?.init.method, 'GET')
  assert.equal(calls[0]?.init.credentials, 'omit')
  assert.equal(calls[0]?.init.mode, 'cors')
})

test('deployment web access identity is scoped to resolved application name', () => {
  const routeKey = deploymentWebAccessQueryKey(creds, 'server1', 'OrdersDeployment')
  const runtimeKey = deploymentWebAccessQueryKey(creds, 'server1', 'OrdersApp')
  const advancedKey = deploymentWebModuleAdvancedMetadataQueryKey(creds, 'server1', 'OrdersApp')

  assert.notDeepEqual(routeKey, runtimeKey)
  assert.equal(runtimeKey[2], 'server1')
  assert.equal(runtimeKey[3], 'OrdersApp')
  assert.notDeepEqual(runtimeKey, advancedKey)
  assert.equal(advancedKey[2], 'server1')
  assert.equal(advancedKey[3], 'OrdersApp')
})

test('deployment web access enablement requires credentials, server, and application identity', () => {
  assert.equal(deploymentWebAccessEnabled(creds, 'server1', 'OrdersApp'), true)
  assert.equal(deploymentWebAccessEnabled(null, 'server1', 'OrdersApp'), false)
  assert.equal(deploymentWebAccessEnabled(creds, null, 'OrdersApp'), false)
  assert.equal(deploymentWebAccessEnabled(creds, 'server1', null), false)
  assert.equal(deploymentWebModuleAdvancedMetadataEnabled(creds, 'server1', 'OrdersApp'), true)
  assert.equal(deploymentWebModuleAdvancedMetadataEnabled(null, 'server1', 'OrdersApp'), false)
  assert.equal(deploymentWebModuleAdvancedMetadataEnabled(creds, null, 'OrdersApp'), false)
  assert.equal(deploymentWebModuleAdvancedMetadataEnabled(creds, 'server1', null), false)
})
