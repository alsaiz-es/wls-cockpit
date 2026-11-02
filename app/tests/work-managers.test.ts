import assert from 'node:assert/strict'
import test from 'node:test'
import type { WlsCredentials } from '../src/api/client.ts'
import {
  WORK_MANAGER_NESTED_CONCURRENCY_LIMIT,
  WORK_MANAGER_NESTED_DETAIL_LIMIT,
  WORK_MANAGER_POLL_INTERVAL_MS,
  deriveWorkManagerSeverity,
  fetchWorkManagerRuntimeSnapshot,
  normalizeThreadPoolRow,
  normalizeWorkManagerRow,
  selectNestedDetailCandidates,
  workManagersRouteForServer,
} from '../src/api/queries/work-managers.ts'
import {
  parseRuntimeTableUrlState,
  serializeRuntimeTableUrlState,
  type RuntimeTableUrlConfig,
} from '../src/routes/runtime-table-url-state.ts'

const creds: WlsCredentials = {
  profileId: 'local',
  name: 'Local',
  targetUrl: 'http://wls-admin.example.com:7001',
  username: 'admin',
  password: 'secret',
  version: '14.1.2.0.0',
}

function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

test('Work Manager severity thresholds are explicit and conservative', () => {
  assert.equal(deriveWorkManagerSeverity({ stuckThreadCount: 1 }), 'critical')
  assert.equal(deriveWorkManagerSeverity({ rejectedRequests: 1 }), 'critical')
  assert.equal(deriveWorkManagerSeverity({ queueLength: 10, sharedCapacityForWorkManagers: 10 }), 'critical')
  assert.equal(deriveWorkManagerSeverity({ executingRequests: 5, maxThreadsCount: 5 }), 'critical')
  assert.equal(deriveWorkManagerSeverity({ healthState: { state: 'failed' } }), 'critical')
  assert.equal(deriveWorkManagerSeverity({ queueLength: 9, sharedCapacityForWorkManagers: 10 }), 'warning')
  assert.equal(deriveWorkManagerSeverity({ executingRequests: 9, maxThreadsCount: 10 }), 'warning')
  assert.equal(deriveWorkManagerSeverity({ pendingRequests: 1 }), 'warning')
  assert.equal(deriveWorkManagerSeverity({ hoggingThreadCount: 1 }), 'warning')
  assert.equal(deriveWorkManagerSeverity({ currentWaitTime: 1 }), 'neutral')
  assert.equal(deriveWorkManagerSeverity({ currentWaitTime: 1_000 }), 'warning')
  assert.equal(deriveWorkManagerSeverity({ healthState: { state: 'warning' } }), 'warning')
  assert.equal(deriveWorkManagerSeverity({}), 'neutral')
  assert.equal(deriveWorkManagerSeverity({ maxThreadsCount: 10 }), 'neutral')
})

test('normalizers preserve unavailable counters and do not treat capacity count alone as pressure', () => {
  const threadPool = normalizeThreadPoolRow('AdminServer', {
    name: 'ThreadPoolRuntime',
    completedRequestCount: 10,
    executeThreadTotalCount: 12,
    executeThreadIdleCount: 8,
    sharedCapacityForWorkManagers: 100,
    queueLength: 0,
    stuckThreadCount: 0,
    hoggingThreadCount: 0,
    overloadRejectedRequestsCount: 0,
  })
  assert.ok(threadPool)
  assert.equal(threadPool.severity, 'neutral')
  assert.equal(threadPool.constraintLimit, 100)

  const workManager = normalizeWorkManagerRow('AdminServer', {
    name: 'wm.orders',
    completedRequests: 4,
    pendingRequests: 2,
    stuckThreadCount: 0,
    toString: 'should not leak',
  })
  assert.ok(workManager)
  assert.equal(workManager.severity, 'warning')
  assert.equal(Object.hasOwn(workManager, 'toString'), false)
})

test('nested detail candidates are capped to the highest-pressure Work Managers', () => {
  const rows = Array.from({ length: WORK_MANAGER_NESTED_DETAIL_LIMIT + 2 }, (_, index) => {
    const row = normalizeWorkManagerRow('AdminServer', {
      name: `wm-${index}`,
      pendingRequests: index,
      completedRequests: 0,
      stuckThreadCount: 0,
    })
    assert.ok(row)
    return row
  })
  const selected = selectNestedDetailCandidates(rows)

  assert.equal(selected.length, WORK_MANAGER_NESTED_DETAIL_LIMIT)
  assert.equal(selected[0].name, `wm-${WORK_MANAGER_NESTED_DETAIL_LIMIT + 1}`)
  assert.equal(selected.at(-1)?.name, 'wm-2')
})

test('server-detail Work Managers route uses URL-backed server filter', () => {
  assert.equal(workManagersRouteForServer('osb_server1'), '/work-managers?server=osb_server1')
  assert.equal(workManagersRouteForServer('Admin Server'), '/work-managers?server=Admin+Server')
})

test('Work Managers route uses conservative visible polling cadence', () => {
  assert.equal(WORK_MANAGER_POLL_INTERVAL_MS, 30_000)
})

test('Work Managers URL state preserves filters and sortable columns', () => {
  const config: RuntimeTableUrlConfig = {
    defaultSort: { columnId: 'pressure', direction: 'asc' },
    sortableColumns: ['pressure', 'server', 'family', 'name', 'severity', 'pending', 'rejected', 'completed', 'stuck', 'hogging', 'constraint'],
    filters: {
      server: { param: 'server', defaultValue: 'all', allowedValues: ['all', 'osb_server1'] },
      severity: { param: 'severity', defaultValue: 'all', allowedValues: ['all', 'critical', 'warning', 'neutral'] },
      family: { param: 'family', defaultValue: 'all', allowedValues: ['all', 'threadPool', 'workManager', 'executeQueue'] },
    },
  }

  const state = parseRuntimeTableUrlState(
    new URLSearchParams('q=osb&server=osb_server1&severity=warning&family=workManager&sort=pending&dir=desc'),
    config,
  )

  assert.deepEqual(state, {
    search: 'osb',
    filters: {
      server: 'osb_server1',
      severity: 'warning',
      family: 'workManager',
    },
    sort: { columnId: 'pending', direction: 'desc' },
  })

  assert.equal(serializeRuntimeTableUrlState(state, config).toString(), 'q=osb&server=osb_server1&severity=warning&family=workManager&sort=pending&dir=desc')
})

test('fetchWorkManagerRuntimeSnapshot caps nested fan-out and issues only read-only requests', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  let activeNestedCalls = 0
  let maxActiveNestedCalls = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    const url = String(input)

    if (url.includes('/domainRuntime/serverLifeCycleRuntimes?')) {
      return json({ items: [{ name: 'AdminServer', state: 'RUNNING' }] })
    }
    if (url.includes('/threadPoolRuntime?')) {
      return json({
        name: 'ThreadPoolRuntime',
        executeThreadTotalCount: 12,
        executeThreadIdleCount: 10,
        completedRequestCount: 100,
        queueLength: 0,
        pendingUserRequestCount: 0,
        sharedCapacityForWorkManagers: 100,
        hoggingThreadCount: 0,
        stuckThreadCount: 0,
        overloadRejectedRequestsCount: 0,
      })
    }
    if (url.includes('/workManagerRuntimes?')) {
      return json({
        items: Array.from({ length: WORK_MANAGER_NESTED_DETAIL_LIMIT + 1 }, (_, index) => ({
          name: `wm-${index}`,
          completedRequests: index,
          pendingRequests: index,
          stuckThreadCount: 0,
        })),
      })
    }
    if (url.includes('/executeQueueRuntimes?')) {
      return json({ items: [] })
    }
    // Releases without the search action fall back to per-Work Manager requests.
    if (url.endsWith('/domainRuntime/search')) return new Response('{}', { status: 404 })
    if (/\/workManagerRuntimes\/[^/?]+\/(?:capacityRuntime|maxThreadsConstraintRuntime|minThreadsConstraintRuntime|requestClassRuntime)\?/.test(url)) {
      activeNestedCalls += 1
      maxActiveNestedCalls = Math.max(maxActiveNestedCalls, activeNestedCalls)
      await new Promise((resolve) => setTimeout(resolve, 1))
      activeNestedCalls -= 1
      if (url.includes('/capacityRuntime?')) return json({ name: 'capacity', count: 50 })
      if (url.includes('/maxThreadsConstraintRuntime?')) return json({ name: 'max', count: 10, executingRequests: 1, deferredRequests: 0 })
      if (url.includes('/minThreadsConstraintRuntime?')) return json({ name: 'min', count: 1, executingRequests: 0, pendingRequests: 0, currentWaitTime: 0 })
      if (url.includes('/requestClassRuntime?')) return json({ name: 'fair', requestClassType: 'FAIR_SHARE', pendingRequestCount: 0 })
    }
    if (url.includes('/edit/selfTuning/workManagers?')) return json({ items: [{ name: 'wm-30', capacity: ['capacities', 'capacity'] }] })
    if (url.includes('/edit/selfTuning/capacities?')) return json({ items: [{ name: 'capacity', count: 50 }] })
    if (url.includes('/edit/selfTuning/')) return json({ items: [] })
    if (url.includes('/edit/servers/AdminServer/executeQueues?')) return json({ items: [] })
    throw new Error(`unexpected URL ${url}`)
  }) as typeof fetch

  try {
    const snapshot = await fetchWorkManagerRuntimeSnapshot(creds)
    const nestedCalls = calls.filter((call) => /\/workManagerRuntimes\/[^/?]+\/(?:capacityRuntime|maxThreadsConstraintRuntime|minThreadsConstraintRuntime|requestClassRuntime)\?/.test(String(call.input)))

    assert.equal(snapshot.nestedOverflowCount, 1)
    assert.equal(nestedCalls.length, 120)
    assert.ok(maxActiveNestedCalls <= WORK_MANAGER_NESTED_CONCURRENCY_LIMIT)
    assert.equal(snapshot.rows.some((row) => row.family === 'workManager' && row.nestedDetailSkipped), true)
    assert.equal(snapshot.rows.find((row) => row.name === 'wm-30')?.config?.capacityName, 'capacity')
    assert.equal(
      calls.every((call) => (call.init?.method ?? 'GET') === 'GET' || String(call.input).endsWith('/domainRuntime/search')),
      true,
    )
    assert.equal(calls.some((call) => String(call.input).includes('threadStackDump')), false)
    assert.equal(calls.some((call) => /startEdit|activate|cancelEdit|undo/.test(String(call.input))), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('missing optional nested runtime details stay local to the row', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/domainRuntime/serverLifeCycleRuntimes?')) return json({ items: [{ name: 'AdminServer', state: 'RUNNING' }] })
    if (url.includes('/threadPoolRuntime?')) return json({ name: 'ThreadPoolRuntime', executeThreadTotalCount: 1, stuckThreadCount: 0 })
    if (url.includes('/workManagerRuntimes?')) return json({ items: [{ name: 'wm.orders', pendingRequests: 0, stuckThreadCount: 0 }] })
    if (url.includes('/executeQueueRuntimes?')) return json({ items: [] })
    if (url.includes('/maxThreadsConstraintRuntime?')) return json({ error: 'missing' }, { status: 404, statusText: 'Not Found' })
    if (url.includes('/capacityRuntime?')) return json({ name: 'capacity', count: 50 })
    if (url.includes('/minThreadsConstraintRuntime?')) return json({ name: 'min', count: 1 })
    if (url.includes('/requestClassRuntime?')) return json({ name: 'fair' })
    if (url.includes('/edit/')) return json({ items: [] })
    throw new Error(`unexpected URL ${url}`)
  }) as typeof fetch

  try {
    const snapshot = await fetchWorkManagerRuntimeSnapshot(creds)
    const row = snapshot.rows.find((candidate) => candidate.name === 'wm.orders')

    assert.ok(row)
    assert.equal(row.nested.maxThreads?.unavailable, true)
    assert.equal(snapshot.partialFailures.some((failure) => failure.runtimeName === 'wm.orders' && failure.family === 'maxThreads'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('non-404 nested runtime failures remain partial data', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/domainRuntime/serverLifeCycleRuntimes?')) return json({ items: [{ name: 'AdminServer', state: 'RUNNING' }] })
    if (url.includes('/threadPoolRuntime?')) return json({ name: 'ThreadPoolRuntime', executeThreadTotalCount: 1, stuckThreadCount: 0 })
    if (url.includes('/workManagerRuntimes?')) return json({ items: [{ name: 'wm.orders', pendingRequests: 0, stuckThreadCount: 0 }] })
    if (url.includes('/executeQueueRuntimes?')) return json({ items: [] })
    if (url.includes('/maxThreadsConstraintRuntime?')) return json({ error: 'server error' }, { status: 500, statusText: 'Server Error' })
    if (url.includes('/capacityRuntime?')) return json({ name: 'capacity', count: 50 })
    if (url.includes('/minThreadsConstraintRuntime?')) return json({ name: 'min', count: 1 })
    if (url.includes('/requestClassRuntime?')) return json({ name: 'fair' })
    if (url.includes('/edit/')) return json({ items: [] })
    throw new Error(`unexpected URL ${url}`)
  }) as typeof fetch

  try {
    const snapshot = await fetchWorkManagerRuntimeSnapshot(creds)
    const row = snapshot.rows.find((candidate) => candidate.name === 'wm.orders')

    assert.ok(row)
    assert.equal(row.nested.maxThreads?.unavailable, true)
    assert.ok(snapshot.partialFailures.some((failure) => failure.runtimeName === 'wm.orders' && failure.family === 'maxThreads'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('snapshot skips self-tuning config when no Work Manager runtimes are present', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)

    if (url.includes('/domainRuntime/serverLifeCycleRuntimes?')) return json({ items: [{ name: 'AdminServer', state: 'RUNNING' }] })
    if (url.includes('/threadPoolRuntime?')) return json({ name: 'ThreadPoolRuntime', executeThreadTotalCount: 1, stuckThreadCount: 0 })
    if (url.includes('/workManagerRuntimes?')) return json({ items: [] })
    if (url.includes('/executeQueueRuntimes?')) return json({ items: [] })
    if (url.includes('/edit/servers/AdminServer/executeQueues?')) return json({ items: [] })
    throw new Error(`unexpected URL ${url}`)
  }) as typeof fetch

  try {
    const snapshot = await fetchWorkManagerRuntimeSnapshot(creds)

    assert.equal(snapshot.rows.some((row) => row.family === 'workManager'), false)
    assert.equal(calls.some((url) => url.includes('/edit/selfTuning/')), false)
    assert.equal(calls.some((url) => url.includes('/edit/servers/AdminServer/executeQueues?')), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('one search returns the Work Manager constraints that exist, without a request per child', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.includes('/domainRuntime/serverLifeCycleRuntimes?')) return json({ items: [{ name: 'AdminServer', state: 'RUNNING' }] })
    if (url.includes('/threadPoolRuntime?')) return json({ name: 'ThreadPoolRuntime', executeThreadTotalCount: 4, executeThreadIdleCount: 3 })
    if (url.includes('/workManagerRuntimes?')) return json({ items: [{ name: 'weblogic.kernel.System' }, { name: 'direct' }] })
    if (url.includes('/executeQueueRuntimes?')) return json({ items: [] })
    if (url.endsWith('/domainRuntime/search')) {
      return json({
        serverRuntimes: {
          items: [
            {
              name: 'AdminServer',
              workManagerRuntimes: {
                items: [
                  { name: 'weblogic.kernel.System', minThreadsConstraintRuntime: { name: 'min', count: 5 } },
                  { name: 'direct' },
                ],
              },
            },
          ],
        },
      })
    }
    if (url.includes('/edit/')) return json({ items: [] })
    throw new Error(`unexpected URL ${url}`)
  }) as typeof fetch

  try {
    const snapshot = await fetchWorkManagerRuntimeSnapshot(creds)
    const perChild = calls.filter((call) => /\/workManagerRuntimes\/[^/?]+\//.test(call))
    assert.deepEqual(perChild, [])
    const system = snapshot.rows.find((row) => row.name === 'weblogic.kernel.System')
    assert.equal(system?.nested.minThreads?.count, 5)
    assert.equal(system?.nested.maxThreads?.count ?? null, null)
    assert.equal(snapshot.partialFailures.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a millisecond wait for a thread is not a warning, and every warning says why', async () => {
  const { assessWorkManager } = await import('../src/api/queries/work-managers.ts')
  // WatchManagerEvents on an idle 12.2.1.4 AdminServer: min-threads constraint, last wait 1 ms.
  assert.deepEqual(assessWorkManager({ currentWaitTime: 1, executingRequests: 0, maxThreadsCount: 1 }), {
    severity: 'neutral',
    severityReasons: [],
  })
  assert.deepEqual(assessWorkManager({ currentWaitTime: 2_500 }), {
    severity: 'warning',
    severityReasons: ['last request waited 2500 ms for a thread'],
  })
  assert.deepEqual(assessWorkManager({ stuckThreadCount: 2, pendingRequests: 3 }), {
    severity: 'critical',
    severityReasons: ['2 stuck threads', '3 requests waiting'],
  })
})
