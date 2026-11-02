import assert from 'node:assert/strict'
import test from 'node:test'
import {
  displayJndiPath,
  buildJndiTree,
  fetchJndiSnapshot,
  jndiEndpointPath,
  JNDI_MAX_ROWS,
  normalizeJndiBindings,
  normalizeJndiSnapshot,
  visibleJndiTreeNodes,
} from '../src/api/queries/jndi.ts'
import type { WlsCredentials } from '../src/api/client.ts'
import { isWlsRestError } from '../src/api/wls-errors.ts'

const creds: WlsCredentials = {
  profileId: 'local',
  name: 'Local',
  targetUrl: 'http://wls-admin.example.com:7001',
  username: 'admin',
  password: 'secret',
  version: '14.1.2.0.0',
}

test('JNDI endpoint path uses the verified server-scoped runtime endpoint', () => {
  assert.equal(
    jndiEndpointPath(creds, 'AdminServer'),
    '/management/weblogic/14.1.2.0.0/domainRuntime/JNDI/AdminServer?links=none',
  )
  assert.throws(() => jndiEndpointPath(creds, 'Admin/Server'), /unsupported path/)
  assert.throws(() => jndiEndpointPath(creds, 'Admin?Server'), /unsupported path/)
})

test('normalizes flat JNDI rows and drops arbitrary object values', () => {
  const rows = normalizeJndiBindings(
    {
      identity: ['JNDI', 'AdminServer'],
      jndi: [
        {
          context: 'jdbc',
          name: 'WLSCockpitDemoDS',
          class: 'weblogic.jdbc.common.internal.RmiDataSource',
          toString: 'jdbc:secret-endpoint',
          error: '',
        },
        { context: 'ignored' },
        null,
      ],
    },
    'AdminServer',
  )

  assert.deepEqual(rows, [
    {
      id: 'AdminServer:binding:jdbc/WLSCockpitDemoDS',
      serverName: 'AdminServer',
      context: 'jdbc',
      name: 'WLSCockpitDemoDS',
      path: 'jdbc/WLSCockpitDemoDS',
      className: 'weblogic.jdbc.common.internal.RmiDataSource',
      error: null,
      isContext: false,
    },
  ])
  assert.equal(Object.hasOwn(rows[0], 'toString'), false)
})

test('builds a context tree from dotted JNDI contexts', () => {
  const rows = normalizeJndiBindings(
    {
      jndi: [
        { context: 'jdbc', name: 'WLSCockpitDemoDS', class: 'javax.sql.DataSource' },
        { context: 'weblogic.jms', name: 'ConnectionFactory', class: 'javax.jms.ConnectionFactory' },
      ],
    },
    'AdminServer',
  )
  const tree = buildJndiTree(rows, 'AdminServer')

  assert.deepEqual(
    tree.map((node) => [node.kind, node.path, node.depth, node.childCount]),
    [
      ['context', 'jdbc', 0, 1],
      ['binding', 'jdbc/WLSCockpitDemoDS', 1, 0],
      ['context', 'weblogic', 0, 1],
      ['context', 'weblogic.jms', 1, 1],
      ['binding', 'weblogic.jms/ConnectionFactory', 2, 0],
    ],
  )
})

test('formats displayed JNDI paths with a consistent dotted separator', () => {
  assert.equal(displayJndiPath('weblogic.jms/ConnectionFactory'), 'weblogic/jms/ConnectionFactory')
  assert.equal(displayJndiPath('jdbc/WLSCockpitDemoDS'), 'jdbc/WLSCockpitDemoDS')
})

test('visible JNDI nodes honor expansion and include ancestors for search matches', () => {
  const snapshot = normalizeJndiSnapshot(
    {
      jndi: [
        { context: 'jdbc', name: 'WLSCockpitDemoDS', class: 'javax.sql.DataSource' },
        { context: 'weblogic.jms', name: 'ConnectionFactory', class: 'javax.jms.ConnectionFactory' },
      ],
    },
    'AdminServer',
  )

  assert.deepEqual(
    visibleJndiTreeNodes(snapshot.tree, new Set(), '').map((node) => node.path),
    ['jdbc', 'weblogic'],
  )
  assert.deepEqual(
    visibleJndiTreeNodes(snapshot.tree, new Set(['jdbc', 'weblogic', 'weblogic.jms']), '').map((node) => node.path),
    ['jdbc', 'jdbc/WLSCockpitDemoDS', 'weblogic', 'weblogic.jms', 'weblogic.jms/ConnectionFactory'],
  )
  assert.deepEqual(
    visibleJndiTreeNodes(snapshot.tree, new Set(), 'ConnectionFactory').map((node) => node.path),
    ['weblogic', 'weblogic.jms', 'weblogic.jms/ConnectionFactory'],
  )
})

test('JNDI snapshot caps oversized flat responses as partial data', () => {
  const snapshot = normalizeJndiSnapshot(
    {
      jndi: Array.from({ length: JNDI_MAX_ROWS + 1 }, (_, index) => ({
        context: 'jdbc',
        name: `Binding${index}`,
        class: 'java.lang.String',
      })),
    },
    'AdminServer',
  )

  assert.equal(snapshot.status, 'partial')
  assert.equal(snapshot.truncated, true)
  assert.equal(snapshot.rows.length, JNDI_MAX_ROWS)
  assert.match(snapshot.partialFailures[0].message, /capped at 2,000 bindings/)
})

test('fetchJndiSnapshot maps verified endpoint 404 to unsupported state', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    return new Response('{}', { status: 404, statusText: 'Not Found' })
  }) as typeof fetch

  try {
    const snapshot = await fetchJndiSnapshot(creds, 'AdminServer')

    assert.equal(snapshot.status, 'unsupported')
    assert.equal(snapshot.rows.length, 0)
    assert.match(snapshot.unsupportedReason ?? '', /unavailable/)
    assert.equal(snapshot.partialFailures.length, 0)
    assert.equal(calls.length, 1)
    assert.equal(String(calls[0].input), '/api/wls/management/weblogic/14.1.2.0.0/domainRuntime/JNDI/AdminServer?links=none')
    assert.equal(calls[0].init?.headers instanceof Headers, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchJndiSnapshot propagates non-404 HTTP failures as WlsRestError', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('{}', { status: 503, statusText: 'Service Unavailable' })) as typeof fetch

  try {
    await assert.rejects(
      () => fetchJndiSnapshot(creds, 'AdminServer'),
      (error: unknown) => {
        assert.equal(isWlsRestError(error), true)
        if (!isWlsRestError(error)) return false
        assert.equal(error.kind, 'http')
        assert.equal(error.status, 503)
        assert.match(error.message, /HTTP 503 Service Unavailable/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchJndiSnapshot maps aborted requests to timeout errors', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }) as typeof fetch

  try {
    await assert.rejects(
      () => fetchJndiSnapshot(creds, 'AdminServer'),
      (error: unknown) => {
        assert.equal(isWlsRestError(error), true)
        if (!isWlsRestError(error)) return false
        assert.equal(error.kind, 'timeout')
        assert.match(error.message, /timed out/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('JNDI on 12.2.1.4 is reported as unsupported without asking WebLogic', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  try {
    const snapshot = await fetchJndiSnapshot({ ...creds, version: '12.2.1.4.0' }, 'AdminServer', { t3HelperAvailable: false })
    assert.equal(snapshot.status, 'unsupported')
    assert.match(snapshot.unsupportedReason ?? '', /from 14\.1\.x; this domain runs 12\.2\.1\.4/)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('JNDI on 12.2.1.4 is read over T3 when the local WebLogic client is configured', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(
      JSON.stringify({ ok: true, operation: 'jndi', jndi: [{ name: 'OrdersDS', context: 'jdbc', class: 'weblogic.jdbc.common.internal.RmiDataSource' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  try {
    const snapshot = await fetchJndiSnapshot({ ...creds, version: '12.2.1.4.0' }, 'osb_server1', { t3HelperAvailable: true })
    assert.deepEqual(calls.map((call) => call.url), ['/api/jndi/bindings'])
    assert.deepEqual(calls[0]?.body, { serverName: 'osb_server1' })
    assert.equal(snapshot.status, 'available')
    assert.equal(snapshot.rows[0]?.path, 'jdbc/OrdersDS')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a tree the T3 helper capped or could not finish in time is reported as partial', () => {
  const jndi = [{ name: 'OrdersDS', context: 'jdbc', class: 'weblogic.jdbc.common.internal.RmiDataSource' }]
  const capped = normalizeJndiSnapshot({ ok: true, truncated: true, truncatedReason: 'bindings', jndi }, 'osb_server1')
  assert.equal(capped.truncated, true)
  assert.equal(capped.status, 'partial')
  assert.match(capped.partialFailures[0].message, /capped at 2,000 bindings/)

  const late = normalizeJndiSnapshot({ ok: true, truncated: true, truncatedReason: 'time', jndi }, 'osb_server1')
  assert.equal(late.status, 'partial')
  assert.match(late.partialFailures[0].message, /time limit/)

  const complete = normalizeJndiSnapshot({ ok: true, truncated: false, jndi }, 'osb_server1')
  assert.equal(complete.status, 'available')
  assert.deepEqual(complete.partialFailures, [])
})
