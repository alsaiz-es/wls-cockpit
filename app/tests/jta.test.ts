import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fetchJtaSnapshot,
  jtaRecoveryActionAvailable,
  jtaRecoveryActionPath,
  jtaRecoveryUnavailableReason,
  jtaResourceQueryParams,
  jtaRuntimeQueryParams,
  normalizeJtaRecoveryRows,
  normalizeJtaResourceRows,
  normalizeJtaServerRow,
  normalizeJtaTransactionNameRows,
} from '../src/api/queries/jta.ts'
import type { WlsCredentials } from '../src/api/client.ts'
import { WLS_TARGET_HEADER } from '../src/api/proxy-target.ts'

const creds: WlsCredentials = {
  profileId: 'local',
  name: 'Local',
  targetUrl: 'http://wls-admin.example.com:7001',
  username: 'admin',
  password: 'secret',
  version: '14.1.2.0.0',
}

function jsonResponse(body: unknown, status = 200, statusText = 'OK') {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('JTA query parameters use bounded fields and links=none', () => {
  assert.equal(jtaRuntimeQueryParams().links, 'none')
  assert.match(jtaRuntimeQueryParams().fields, /transactionServiceState/)
  assert.match(jtaRuntimeQueryParams().fields, /registeredResourceNames/)
  assert.equal(jtaResourceQueryParams().links, 'none')
  assert.match(jtaResourceQueryParams().fields, /transactionHeuristicMixedTotalCount/)
})

test('normalizes JTA server severity from runtime counters', () => {
  const healthy = normalizeJtaServerRow({
    serverName: 'AdminServer',
    lifecycleState: 'RUNNING',
    runtime: {
      healthState: { state: 'ok' },
      transactionServiceState: 'RUNNING',
      activeTransactionsTotalCount: 0,
      transactionTotalCount: 12,
      transactionCommittedTotalCount: 10,
      transactionRolledBackTotalCount: 2,
      transactionRolledBackTimeoutTotalCount: 0,
      transactionAbandonedTotalCount: 0,
      transactionHeuristicsTotalCount: 0,
      registeredResourceNames: ['jdbc/DemoDS'],
      registeredNonXAResourceNames: [],
    },
  })
  assert.equal(healthy.available, true)
  assert.equal(healthy.severity, 'healthy')
  assert.equal(healthy.registeredResourceCount, 1)

  const active = normalizeJtaServerRow({
    serverName: 'AdminServer',
    lifecycleState: 'RUNNING',
    runtime: { healthState: { state: 'ok' }, activeTransactionsTotalCount: 1 },
  })
  assert.equal(active.severity, 'warning')

  const critical = normalizeJtaServerRow({
    serverName: 'AdminServer',
    lifecycleState: 'RUNNING',
    runtime: {
      healthState: { state: 'ok' },
      transactionHeuristicsTotalCount: 1,
      transactionAbandonedTotalCount: 0,
    },
  })
  assert.equal(critical.severity, 'critical')

  const unavailable = normalizeJtaServerRow({
    serverName: 'server1',
    lifecycleState: 'SHUTDOWN',
    runtime: null,
  })
  assert.equal(unavailable.available, false)
  assert.equal(unavailable.severity, 'unknown')
  assert.equal(unavailable.transactionTotalCount, null)
})

test('normalizes JTA resource, recovery, and transaction-name rows', () => {
  assert.deepEqual(
    normalizeJtaResourceRows({
      items: [
        {
          name: 'DemoDS',
          resourceName: 'jdbc/DemoDS',
          healthState: { state: 'ok' },
          transactionTotalCount: 4,
          transactionCommittedTotalCount: 3,
          transactionRolledBackTotalCount: 1,
          transactionHeuristicsTotalCount: 0,
          transactionHeuristicMixedTotalCount: 0,
        },
        { resourceName: 'ignored-without-name' },
      ],
    }, 'AdminServer'),
    [
      {
        id: 'AdminServer:resource:jdbc/DemoDS',
        serverName: 'AdminServer',
        name: 'DemoDS',
        resourceName: 'jdbc/DemoDS',
        healthState: 'ok',
        transactionTotalCount: 4,
        transactionCommittedTotalCount: 3,
        transactionRolledBackTotalCount: 1,
        transactionHeuristicsTotalCount: 0,
        transactionHeuristicCommitTotalCount: null,
        transactionHeuristicRollbackTotalCount: null,
        transactionHeuristicHazardTotalCount: null,
        transactionHeuristicMixedTotalCount: 0,
      },
    ],
  )

  assert.deepEqual(
    normalizeJtaRecoveryRows({
      items: [
        {
          name: 'AdminServer',
          active: true,
          initialRecoveredTransactionTotalCount: 2,
          recoveredTransactionCompletionPercent: 100,
        },
      ],
    }, 'AdminServer'),
    [
      {
        id: 'AdminServer:recovery:AdminServer',
        serverName: 'AdminServer',
        name: 'AdminServer',
        active: true,
        initialRecoveredTransactionTotalCount: 2,
        recoveredTransactionCompletionPercent: 100,
        initialRecoveredUnloggedTransactionTotalCount: null,
        recoveredUnloggedTransactionCompletionPercent: null,
      },
    ],
  )

  assert.deepEqual(
    normalizeJtaTransactionNameRows({
      items: [
        {
          name: 'weblogic.transaction',
          transactionName: 'OrderSubmit',
          transactionTotalCount: 3,
          transactionCommittedTotalCount: 2,
          transactionRolledBackTotalCount: 1,
          secondsActiveTotalCount: 7,
        },
      ],
    }, 'AdminServer'),
    [
      {
        id: 'AdminServer:transactionName:OrderSubmit',
        serverName: 'AdminServer',
        name: 'weblogic.transaction',
        transactionName: 'OrderSubmit',
        transactionTotalCount: 3,
        transactionCommittedTotalCount: 2,
        transactionRolledBackTotalCount: 1,
        transactionHeuristicsTotalCount: null,
        transactionAbandonedTotalCount: null,
        secondsActiveTotalCount: 7,
      },
    ],
  )
})

test('fetchJtaSnapshot preserves runtime rows when a child JTA collection fails', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    const path = String(input)
    if (path.includes('/domainRuntime/serverLifeCycleRuntimes')) {
      return jsonResponse({
        items: [
          { name: 'AdminServer', state: 'RUNNING' },
          { name: 'server1', state: 'SHUTDOWN' },
        ],
      })
    }
    if (path.includes('/JTARuntime?')) {
      return jsonResponse({
        healthState: { state: 'ok' },
        transactionServiceState: 'RUNNING',
        activeTransactionsTotalCount: 0,
        transactionTotalCount: 5,
        transactionCommittedTotalCount: 5,
        registeredResourceNames: ['jdbc/DemoDS'],
      })
    }
    if (path.includes('/transactionResourceRuntimeMBeans')) {
      return jsonResponse({ items: [{ name: 'DemoDS', resourceName: 'jdbc/DemoDS' }] })
    }
    if (path.includes('/recoveryRuntimeMBeans')) {
      return jsonResponse({}, 503, 'Service Unavailable')
    }
    if (path.includes('/transactionNameRuntimeMBeans')) {
      return jsonResponse({ items: [] })
    }
    throw new Error(`unexpected JTA path ${path}`)
  }) as typeof fetch

  try {
    const snapshot = await fetchJtaSnapshot(creds)

    // The stopped server keeps a row in its state instead of disappearing from the page.
    assert.equal(snapshot.servers.length, 2)
    const stopped = snapshot.servers.find((server) => server.serverName === 'server1')
    assert.equal(stopped?.available, false)
    snapshot.servers.sort((a, b) => (a.serverName === 'AdminServer' ? -1 : b.serverName === 'AdminServer' ? 1 : 0))
    assert.equal(snapshot.servers[0].serverName, 'AdminServer')
    assert.equal(snapshot.servers[0].available, true)
    assert.equal(snapshot.servers[0].transactionTotalCount, 5)
    assert.equal(snapshot.servers[0].resources.length, 1)
    assert.deepEqual(snapshot.partialFailures.map((failure) => failure.family), ['recovery'])
    assert.match(snapshot.partialFailures[0].message, /HTTP 503 Service Unavailable/)
    assert.equal(calls[0].init?.headers instanceof Headers, false)
    assert.equal((calls[0].init?.headers as Record<string, string>)[WLS_TARGET_HEADER], creds.targetUrl)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchJtaSnapshot keeps an unavailable row when the root JTA runtime fails', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input)
    calls.push(path)
    if (path.includes('/domainRuntime/serverLifeCycleRuntimes')) {
      return jsonResponse({ items: [{ name: 'AdminServer', state: 'RUNNING' }] })
    }
    if (path.includes('/JTARuntime?')) {
      return jsonResponse({}, 503, 'Service Unavailable')
    }
    throw new Error(`unexpected JTA path ${path}`)
  }) as typeof fetch

  try {
    const snapshot = await fetchJtaSnapshot(creds)

    assert.equal(snapshot.servers.length, 1)
    assert.equal(snapshot.servers[0].serverName, 'AdminServer')
    assert.equal(snapshot.servers[0].available, false)
    assert.equal(snapshot.servers[0].severity, 'unknown')
    assert.equal(snapshot.servers[0].transactionTotalCount, null)
    assert.deepEqual(snapshot.partialFailures.map((failure) => failure.family), ['runtime'])
    assert.match(snapshot.partialFailures[0].message, /HTTP 503 Service Unavailable/)
    assert.equal(calls.some((path) => path.includes('/transactionResourceRuntimeMBeans')), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('JTA recovery helpers expose paths but keep actions unavailable without verified rows', () => {
  assert.equal(
    jtaRecoveryActionPath(creds, 'AdminServer', 'forceCommit'),
    '/management/weblogic/14.1.2.0.0/domainRuntime/serverRuntimes/AdminServer/JTARuntime/forceCommit',
  )

  const row = normalizeJtaServerRow({
    serverName: 'AdminServer',
    lifecycleState: 'RUNNING',
    runtime: { healthState: { state: 'ok' }, transactionServiceState: 'RUNNING' },
  })

  assert.equal(jtaRecoveryActionAvailable(row), false)
  assert.match(jtaRecoveryUnavailableReason(row) ?? '', /no bounded transaction row source/)
})
