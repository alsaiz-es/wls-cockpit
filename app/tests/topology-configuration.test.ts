import assert from 'node:assert/strict'
import test from 'node:test'
import type { WlsCredentials } from '../src/api/client.ts'
import {
  TOPOLOGY_CONFIGURATION_REQUESTED_BY,
  clusterReference,
  createTopologyChildStep,
  createTopologyResourceStep,
  deleteTopologyChildStep,
  deleteTopologyResourceStep,
  fetchTopologyConfigurationSnapshot,
  machineReference,
  readTopologyReferenceNames,
  runTopologyEditTransaction,
  sanitizeTopologyPayloadForFeedback,
  serverReference,
  topologyEndpointCollectionPath,
  topologyEndpointPath,
  topologyEndpointQuery,
  topologyMutationPayload,
  topologyReferenceList,
  updateTopologyChildStep,
  updateTopologyResourceStep,
  automaticMigratableTargetName,
  deleteServerSteps,
} from '../src/api/queries/topology-configuration.ts'
import {
  topologyEndpointById,
  topologyEndpointsFor,
  topologySectionsFor,
} from '../src/api/queries/topology-configuration-catalog.ts'

const creds12: WlsCredentials = {
  profileId: 'lab',
  name: 'Lab',
  targetUrl: 'http://wls-admin.example.com:7001',
  username: 'operator',
  password: 'placeholder',
  version: '12.2.1.4.0',
}

const creds14: WlsCredentials = {
  ...creds12,
  version: '14.1.2.0.0',
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'content-type': 'application/json' },
  })
}

test('topology catalog groups server and cluster fields by console section with version availability', () => {
  const server14Fields = topologyEndpointsFor('server', '14.1.2.0.0').flatMap((endpoint) => endpoint.fields)
  const server12Fields = topologyEndpointsFor('server', '12.2.1.4.0').flatMap((endpoint) => endpoint.fields)
  const cluster14Fields = topologyEndpointsFor('cluster', '14.1.2.0.0').flatMap((endpoint) => endpoint.fields)
  const cluster12Fields = topologyEndpointsFor('cluster', '12.2.1.4.0').flatMap((endpoint) => endpoint.fields)

  assert.ok(topologySectionsFor('server', '14.1.2.0.0').some((section) => section.id === 'network-channels'))
  assert.ok(topologySectionsFor('cluster', '14.1.2.0.0').some((section) => section.id === 'dynamic-servers'))
  assert.ok(server14Fields.some((field) => field.jsonProperty === 'virtualThreadEnableOption'))
  assert.equal(server12Fields.some((field) => field.jsonProperty === 'virtualThreadEnableOption'), false)
  assert.ok(server12Fields.some((field) => field.jsonProperty === 'buzzEnabled'))
  assert.equal(server14Fields.some((field) => field.jsonProperty === 'buzzEnabled'), false)
  assert.ok(cluster14Fields.some((field) => field.jsonProperty === 'autoMigrationTableCreationPolicy'))
  assert.equal(cluster12Fields.some((field) => field.jsonProperty === 'autoMigrationTableCreationPolicy'), false)
})

test('topology catalog marks sensitive values and mutation support explicitly', () => {
  const startup = topologyEndpointById('server.startup', '14.1.2.0.0')
  assert.ok(startup)
  const password = startup.fields.find((field) => field.jsonProperty === 'password')
  const argumentsField = startup.fields.find((field) => field.jsonProperty === 'arguments')
  assert.equal(password?.writeSupport, 'write-only')
  assert.equal(password?.sensitive, true)
  assert.equal(argumentsField?.sensitivity, 'startup-argument')

  const ssl = topologyEndpointById('server.ssl', '14.1.2.0.0')
  const encrypted = ssl?.fields.find((field) => field.jsonProperty === 'serverPrivateKeyPassPhraseEncrypted')
  assert.equal(encrypted?.writeSupport, 'read-only')
  assert.equal(encrypted?.sensitivity, 'encrypted')

  assert.deepEqual(
    sanitizeTopologyPayloadForFeedback('server.startup', '14.1.2.0.0', {
      arguments: '-Dsecret=value',
      password: 'unit-test-pass',
      javaVendor: 'Oracle',
    }),
    {
      arguments: '[redacted]',
      password: '[redacted]',
      javaVendor: 'Oracle',
    },
  )
})

test('topology query manifests stay bounded and link-free', () => {
  const endpoint = topologyEndpointById('server.networkAccessPoints', '14.1.2.0.0')
  assert.ok(endpoint)
  assert.equal(
    topologyEndpointCollectionPath('14.1.2.0.0', endpoint, 'ms 1'),
    '/management/weblogic/14.1.2.0.0/edit/servers/ms%201/networkAccessPoints',
  )
  assert.equal(
    topologyEndpointPath('14.1.2.0.0', endpoint, { resourceName: 'ms 1', childName: 'https channel' }),
    '/management/weblogic/14.1.2.0.0/edit/servers/ms%201/networkAccessPoints/https%20channel',
  )
  const query = topologyEndpointQuery(endpoint)
  assert.equal(query.links, 'none')
  assert.match(query.fields, /\bname\b/)
  assert.match(query.fields, /\blistenPort\b/)
  assert.doesNotMatch(query.fields, /\bthreadStackDump\b/)
})

test('topology discovery preserves resources when child sections fail', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/edit/servers?')) return jsonResponse({ items: [{ name: 'server1' }] })
    if (url.includes('/edit/clusters?')) return jsonResponse({ items: [{ name: 'cluster1' }] })
    if (url.includes('/edit/servers/server1?')) {
      return jsonResponse({ name: 'server1', listenPort: 7003, machine: ['machines', 'machine1'] })
    }
    if (url.includes('/edit/clusters/cluster1?')) {
      return jsonResponse({ name: 'cluster1', clusterAddress: 'cluster.example.com' })
    }
    if (url.includes('/edit/servers/server1/networkAccessPoints')) {
      return new Response(null, { status: 503, statusText: 'Service Unavailable' })
    }
    return jsonResponse({ name: 'child' })
  }

  try {
    const snapshot = await fetchTopologyConfigurationSnapshot(creds14)
    assert.deepEqual(snapshot.servers.map((server) => server.name), ['server1'])
    assert.deepEqual(snapshot.clusters.map((cluster) => cluster.name), ['cluster1'])
    assert.equal(snapshot.servers[0]?.root.listenPort, 7003)
    assert.ok(snapshot.partialFailures.some((failure) =>
      failure.resourceKind === 'server' &&
      failure.endpointId === 'server.networkAccessPoints' &&
      /HTTP 503/.test(failure.message),
    ))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('topology mutation payloads reject non-catalog fields and preserve references', () => {
  assert.deepEqual(serverReference('ms1'), ['servers', 'ms1'])
  assert.deepEqual(clusterReference('cluster1'), ['clusters', 'cluster1'])
  assert.deepEqual(machineReference('machine1'), ['machines', 'machine1'])
  assert.deepEqual(topologyReferenceList([serverReference('ms1')]), [['servers', 'ms1']])
  assert.deepEqual(readTopologyReferenceNames([{ identity: ['servers', 'ms1'] }], 'servers'), ['ms1'])

  assert.deepEqual(
    topologyMutationPayload('server.root', '14.1.2.0.0', {
      listenPort: 7003,
      listenPortEnabled: false,
    }, 'update'),
    {
      listenPort: 7003,
      listenPortEnabled: false,
    },
  )
  assert.throws(
    () => topologyMutationPayload('server.root', '14.1.2.0.0', { password: 'bad' }, 'update'),
    /Unsupported topology field/,
  )
})

test('topology edit helpers build allow-listed transaction steps with requested-by header', async () => {
  const createServer = createTopologyResourceStep(creds14, 'server', 'ms1', {
    listenPort: 7003,
    cluster: clusterReference('cluster1'),
    machine: machineReference('machine1'),
  })
  const updateServer = updateTopologyResourceStep(creds14, 'server', 'ms1', { listenPortEnabled: false })
  const deleteServer = deleteTopologyResourceStep(creds14, 'server', 'ms1')
  const updateSsl = updateTopologyChildStep(creds14, 'server.ssl', 'ms1', { enabled: true, listenPort: 7004 })
  const createChannel = createTopologyChildStep(creds14, 'server.networkAccessPoints', 'ms1', 'https', {
    protocol: 'https',
    listenPort: 7443,
  })
  const updateChannel = updateTopologyChildStep(creds14, 'server.networkAccessPoints', 'ms1', { enabled: false }, 'https')
  const deleteChannel = deleteTopologyChildStep(creds14, 'server.networkAccessPoints', 'ms1', 'https')

  assert.equal(createServer.path, '/management/weblogic/14.1.2.0.0/edit/servers')
  assert.deepEqual(createServer.body, {
    name: 'ms1',
    listenPort: 7003,
    cluster: ['clusters', 'cluster1'],
    machine: ['machines', 'machine1'],
  })
  assert.equal(updateServer.path, '/management/weblogic/14.1.2.0.0/edit/servers/ms1')
  assert.equal(deleteServer.path, '/management/weblogic/14.1.2.0.0/edit/servers/ms1')
  assert.equal(deleteServer.method, 'DELETE')
  assert.deepEqual(updateSsl.body, { enabled: true, listenPort: 7004 })
  assert.equal(createChannel.path, '/management/weblogic/14.1.2.0.0/edit/servers/ms1/networkAccessPoints')
  assert.equal(updateChannel.path, '/management/weblogic/14.1.2.0.0/edit/servers/ms1/networkAccessPoints/https')
  assert.deepEqual(updateChannel.body, { enabled: false })
  assert.equal(deleteChannel.path, '/management/weblogic/14.1.2.0.0/edit/servers/ms1/networkAccessPoints/https')
  assert.equal(deleteChannel.method, 'DELETE')

  const originalFetch = globalThis.fetch
  const calls: { url: string; method: string; requestedBy: string | null; body: unknown }[] = []
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(input).replace(/^\/api\/wls/, ''),
      method: init?.method ?? 'GET',
      requestedBy: headers.get('X-Requested-By'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return jsonResponse({})
  }

  try {
    await runTopologyEditTransaction(creds14, 'Create server ms1', [createServer, updateSsl])
    assert.deepEqual(calls.map((call) => call.url), [
      '/management/weblogic/14.1.2.0.0/edit/changeManager/startEdit',
      '/management/weblogic/14.1.2.0.0/edit/servers',
      '/management/weblogic/14.1.2.0.0/edit/servers/ms1/SSL',
      '/management/weblogic/14.1.2.0.0/edit/changeManager/activate',
    ])
    assert.ok(calls.every((call) => call.method === 'POST'))
    assert.ok(calls.every((call) => call.requestedBy === TOPOLOGY_CONFIGURATION_REQUESTED_BY))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('topology transaction cancels edit session on mutation failure', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input).replace(/^\/api\/wls/, '')
    calls.push(url)
    if (url.includes('/edit/servers/ms1')) {
      return new Response(JSON.stringify({}), { status: 400, statusText: 'Bad Request' })
    }
    return jsonResponse({})
  }

  try {
    await assert.rejects(
      () => runTopologyEditTransaction(creds12, 'Update server ms1', [
        updateTopologyResourceStep(creds12, 'server', 'ms1', { listenPort: 7004 }),
      ]),
      /HTTP 400/,
    )
    assert.deepEqual(calls, [
      '/management/weblogic/12.2.1.4.0/edit/changeManager/startEdit',
      '/management/weblogic/12.2.1.4.0/edit/servers/ms1',
      '/management/weblogic/12.2.1.4.0/edit/changeManager/cancelEdit',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('deleting a clustered server also deletes the migratable target WebLogic created for it', () => {
  assert.equal(automaticMigratableTargetName('server1'), 'server1 (migratable)')
  const steps = deleteServerSteps(creds14, 'server1', ['server1 (migratable)', 'jmsTarget'])
  assert.deepEqual(steps.map((step) => [step.method, step.path]), [
    ['DELETE', '/management/weblogic/14.1.2.0.0/edit/migratableTargets/server1%20(migratable)'],
    ['DELETE', '/management/weblogic/14.1.2.0.0/edit/servers/server1'],
  ])
})

test('a server outside a cluster, or a migratable target an operator created, is left to WebLogic', () => {
  const steps = deleteServerSteps(creds12, 'standalone', ['jmsTarget', 'server1 (migratable)'])
  assert.deepEqual(steps.map((step) => step.path), ['/management/weblogic/12.2.1.4.0/edit/servers/standalone'])
})
