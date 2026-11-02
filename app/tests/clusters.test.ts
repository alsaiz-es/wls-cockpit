import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildClusterRows,
  fetchClusterSnapshot,
  normalizeClusterConfigs,
  normalizeClusterReplication,
  normalizeClusterRuntime,
} from '../src/api/queries/clusters.ts'
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

test('normalizes cluster config, runtime, and replication rows', () => {
  assert.deepEqual(
    normalizeClusterConfigs({
      items: [{
        name: 'cluster1',
        clusterAddress: 'cluster.example:7003',
        clusterMessagingMode: 'unicast',
        clusterType: 'none',
        servers: [
          { identity: ['servers', 'server1'] },
          { identity: ['servers', 'server2'] },
          { identity: ['machines', 'ignored'] },
        ],
      }],
    }),
    [{
      name: 'cluster1',
      clusterAddress: 'cluster.example:7003',
      clusterMessagingMode: 'unicast',
      clusterType: 'none',
      memberNames: ['server1', 'server2'],
    }],
  )

  assert.deepEqual(
    normalizeClusterRuntime({
      name: 'cluster1',
      healthState: { state: 'ok' },
      aliveServerCount: 1,
      serverNames: ['server1'],
      primaryCount: 3,
      secondaryCount: 2,
      detailedSecondariesDistribution: ['server2:2'],
      secondaryServerDetails: 'server2',
      activeSingletonServices: ['server1'],
    }, 'cluster1', 'server1'),
    {
      id: 'cluster1:runtime:server1',
      clusterName: 'cluster1',
      serverName: 'server1',
      healthState: 'ok',
      aliveServerCount: 1,
      serverNames: ['server1'],
      primaryCount: 3,
      secondaryCount: 2,
      detailedSecondariesDistribution: ['server2:2'],
      secondaryServerDetails: 'server2',
      activeSingletonServices: ['server1'],
    },
  )

  assert.deepEqual(
    normalizeClusterReplication({
      name: 'AsyncReplication',
      primaryCount: 1,
      secondaryCount: 0,
      sessionsWaitingForFlushCount: 4,
      lastSessionsFlushTime: 123,
    }, 'cluster1', 'server1', 'async'),
    {
      id: 'cluster1:replication:server1:async',
      clusterName: 'cluster1',
      serverName: 'server1',
      family: 'async',
      name: 'AsyncReplication',
      primaryCount: 1,
      secondaryCount: 0,
      detailedSecondariesDistribution: [],
      secondaryServerDetails: null,
      lastSessionsFlushTime: 123,
      sessionsWaitingForFlushCount: 4,
      remoteClusterReachable: null,
      activeServersInRemoteCluster: [],
      secondaryServerName: null,
      numberOfSessionsFlushedToTheDatabase: null,
      numberOfSessionsRetrievedFromTheDatabase: null,
    },
  )
})

test('buildClusterRows aggregates members and missing runtime data', () => {
  const clusters = buildClusterRows({
    configs: [{
      name: 'cluster1',
      clusterAddress: null,
      clusterMessagingMode: 'unicast',
      clusterType: 'none',
      memberNames: ['server1', 'server2'],
    }],
    servers: [
      {
        name: 'server1',
        state: 'RUNNING',
        healthState: 'ok',
        listenAddress: 'localhost',
        listenPort: 7003,
        heap: null,
        jvm: null,
        threads: null,
      },
      {
        name: 'server2',
        state: 'FAILED_NOT_RESTARTABLE',
        healthState: 'unknown',
        listenAddress: null,
        listenPort: null,
        heap: null,
        jvm: null,
        threads: null,
      },
    ],
    runtimes: [{
      id: 'cluster1:runtime:server1',
      clusterName: 'cluster1',
      serverName: 'server1',
      healthState: 'ok',
      aliveServerCount: 1,
      serverNames: ['server1'],
      primaryCount: 0,
      secondaryCount: 0,
      detailedSecondariesDistribution: [],
      secondaryServerDetails: null,
      activeSingletonServices: ['server1'],
    }],
    replications: [],
    partialFailures: [{
      clusterName: 'cluster1',
      serverName: 'server2',
      family: 'clusterRuntime',
      message: 'Server is FAILED_NOT_RESTARTABLE; cluster runtime is unavailable.',
    }],
  })

  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].name, 'cluster1')
  assert.equal(clusters[0].aliveServerCount, 1)
  assert.equal(clusters[0].healthState, 'unknown')
  assert.deepEqual(clusters[0].stateCounts, { RUNNING: 1, FAILED_NOT_RESTARTABLE: 1 })
  assert.deepEqual(clusters[0].runtimeServerNames, ['server1'])
  assert.equal(clusters[0].members[0].alive, true)
  assert.equal(clusters[0].members[1].alive, false)
  assert.equal(clusters[0].members[1].runtimeAvailable, false)
  assert.deepEqual(clusters[0].activeSingletonServices, ['server1'])
  assert.equal(clusters[0].partialFailures.length, 1)
})

test('fetchClusterSnapshot preserves configured members when optional runtime data is missing', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    const path = String(input)
    if (path.includes('/edit/clusters')) {
      return jsonResponse({
        items: [{
          name: 'cluster1',
          clusterMessagingMode: 'unicast',
          clusterType: 'none',
          servers: [{ identity: ['servers', 'server1'] }, { identity: ['servers', 'server2'] }],
        }],
      })
    }
    if (path.includes('/domainRuntime/serverLifeCycleRuntimes')) {
      return jsonResponse({
        items: [
          { name: 'server1', state: 'RUNNING' },
          { name: 'server2', state: 'SHUTDOWN' },
        ],
      })
    }
    if (path.includes('/domainRuntime/serverRuntimes/server1/clusterRuntime')) {
      return jsonResponse({
        name: 'cluster1',
        healthState: { state: 'ok' },
        aliveServerCount: 1,
        serverNames: ['server1'],
        primaryCount: 0,
        secondaryCount: 0,
        activeSingletonServices: ['server1'],
      })
    }
    if (path.includes('/domainRuntime/serverRuntimes/server1/asyncReplicationRuntime')) {
      return jsonResponse({ name: 'AsyncReplication', primaryCount: 0, secondaryCount: 0 })
    }
    if (path.includes('/domainRuntime/serverRuntimes/server1/MANReplicationRuntime')) {
      return jsonResponse({}, 404, 'Not Found')
    }
    if (path.includes('/domainRuntime/serverRuntimes/server1/WANReplicationRuntime')) {
      return jsonResponse({}, 404, 'Not Found')
    }
    if (path.includes('/domainRuntime/serverRuntimes/server1')) {
      return jsonResponse({}, 503, 'Service Unavailable')
    }
    throw new Error(`unexpected cluster path ${path}`)
  }) as typeof fetch

  try {
    const snapshot = await fetchClusterSnapshot(creds)

    assert.equal(snapshot.clusters.length, 1)
    assert.equal(snapshot.clusters[0].name, 'cluster1')
    assert.equal(snapshot.clusters[0].members.length, 2)
    assert.equal(snapshot.clusters[0].replicationRows.length, 1)
    assert.equal(snapshot.clusters[0].replicationRows[0].family, 'async')
    assert.equal(snapshot.clusters[0].partialFailures.length, 2)
    assert.ok(snapshot.clusters[0].partialFailures.some((failure) =>
      failure.serverName === 'server1' && failure.family === 'serverRuntime',
    ))
    assert.ok(snapshot.clusters[0].partialFailures.some((failure) =>
      failure.serverName === 'server2' && failure.family === 'clusterRuntime',
    ))
    assert.equal(calls[0].init?.headers instanceof Headers, false)
    assert.equal((calls[0].init?.headers as Record<string, string>)[WLS_TARGET_HEADER], creds.targetUrl)
  } finally {
    globalThis.fetch = originalFetch
  }
})
