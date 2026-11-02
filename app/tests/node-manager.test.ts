import assert from 'node:assert/strict'
import test from 'node:test'
import type { WlsCredentials } from '../src/api/client.ts'
import {
  assignNodeManagerServers,
  buildNodeManagerRows,
  createNodeManagerMachine,
  diffNodeManagerListenerConfig,
  enrichLifecycleFailureWithNodeManager,
  fetchNodeManagerSnapshot,
  formatNodeManagerEndpoint,
  formatNodeManagerLifecycleContext,
  isNodeManagerServerAssignable,
  listenerDraftFromRow,
  machineCreationChanges,
  nodeManagerAssignmentServerChoices,
  nodeManagerAssignmentBlockedReason,
  nodeManagerTone,
  normalizeNodeManagerConfig,
  normalizeNodeManagerLifecycleStates,
  normalizeNodeManagerMachines,
  normalizeNodeManagerRuntimes,
  normalizeNodeManagerServerRows,
  updateNodeManagerListener,
  validateMachineName,
  validateNodeManagerListenerDraft,
  type NodeManagerRow,
} from '../src/api/queries/node-manager.ts'

const creds: WlsCredentials = {
  profileId: 'lab',
  name: 'Lab',
  targetUrl: 'http://wls-admin.example.com:7001',
  username: 'operator',
  password: 'placeholder',
  version: '12.2.1.4.0',
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'content-type': 'application/json' },
  })
}

function nodeManagerRow(overrides: Partial<NodeManagerRow> = {}): NodeManagerRow {
  return {
    id: 'machine1',
    machineName: 'machine1',
    runtimeName: 'machine1',
    reachable: 'unreachable',
    runtimeType: 'NodeManagerRuntime',
    listenAddress: 'machine1.example.com',
    listenPort: 5556,
    nmType: 'SSL',
    socketCreateTimeoutMillis: 180000,
    serverNames: ['server1'],
    partialFailures: [],
    ...overrides,
  }
}

test('normalizes Node Manager runtime, configuration, machine, and server rows', () => {
  assert.deepEqual(normalizeNodeManagerRuntimes({
    items: [
      { name: 'machine1', type: 'NodeManagerRuntime', reachable: true },
      { name: '', reachable: false },
    ],
  }), [
    { name: 'machine1', type: 'NodeManagerRuntime', reachable: true },
  ])

  assert.deepEqual(normalizeNodeManagerConfig({
    name: 'machine1',
    listenAddress: 'machine1.example.com',
    listenPort: 5556,
    NMType: 'SSL',
    NMSocketCreateTimeoutInMillis: 180000,
  }, 'machine1'), {
    machineName: 'machine1',
    name: 'machine1',
    listenAddress: 'machine1.example.com',
    listenPort: 5556,
    nmType: 'SSL',
    socketCreateTimeoutMillis: 180000,
  })

  assert.deepEqual(normalizeNodeManagerMachines({ items: [{ name: 'machine1' }, { name: 'machine2' }] }), [
    'machine1',
    'machine2',
  ])
  assert.deepEqual(normalizeNodeManagerServerRows({
    items: [
      { name: 'server1', machine: ['machines', 'machine1'] },
      { name: 'AdminServer' },
      { machine: ['machines', 'machine2'] },
    ],
  }), [
    { serverName: 'server1', machineName: 'machine1', lifecycleState: null },
    { serverName: 'AdminServer', machineName: null, lifecycleState: null },
  ])
  const lifecycleStates = normalizeNodeManagerLifecycleStates({
    items: [
      { name: 'server1', state: 'running' },
      { name: 'server2', state: 'SHUTDOWN' },
    ],
  })
  assert.deepEqual([...lifecycleStates.entries()], [
    ['server1', 'RUNNING'],
    ['server2', 'SHUTDOWN'],
  ])
  assert.deepEqual(normalizeNodeManagerServerRows({
    items: [{ name: 'server1', machine: ['machines', 'machine1'] }],
  }, lifecycleStates), [
    { serverName: 'server1', machineName: 'machine1', lifecycleState: 'RUNNING' },
  ])
})

test('builds machine rows with reachability, endpoints, assigned servers, and partial failures', () => {
  const result = buildNodeManagerRows({
    machines: ['machine1'],
    runtimes: [
      { name: 'machine1', type: 'NodeManagerRuntime', reachable: false },
      { name: 'runtimeOnly', type: 'NodeManagerRuntime', reachable: null },
    ],
    configs: [
      {
        machineName: 'machine1',
        name: 'machine1',
        listenAddress: 'machine1.example.com',
        listenPort: 5556,
        nmType: 'SSL',
        socketCreateTimeoutMillis: 180000,
      },
    ],
    servers: [
      { serverName: 'server2', machineName: 'machine1' },
      { serverName: 'server1', machineName: 'machine1' },
      { serverName: 'unassigned', machineName: null },
    ],
    partialFailures: [
      { machineName: 'machine1', family: 'nodeManagerConfig', message: 'HTTP 503 Service Unavailable' },
    ],
  })

  assert.deepEqual(result.unassignedServers, ['unassigned'])
  assert.equal(result.rows.length, 2)
  assert.deepEqual(result.rows[0], nodeManagerRow({
    reachable: 'unreachable',
    serverNames: ['server1', 'server2'],
    partialFailures: [
      { machineName: 'machine1', family: 'nodeManagerConfig', message: 'HTTP 503 Service Unavailable' },
    ],
  }))
  assert.equal(result.rows[1]?.machineName, 'runtimeOnly')
  assert.equal(result.rows[1]?.reachable, 'unknown')
  assert.equal(nodeManagerTone(result.rows[0]!), 'negative')
  assert.equal(nodeManagerTone(result.rows[1]!), 'unknown')
  assert.equal(formatNodeManagerEndpoint(result.rows[0]!), 'machine1.example.com:5556')
})

test('formats lifecycle failure context without duplicating existing evidence', () => {
  const row = nodeManagerRow()
  const context = formatNodeManagerLifecycleContext(row)

  assert.equal(context, 'Node Manager machine1: unreachable · machine1.example.com:5556 · SSL')
  assert.equal(
    enrichLifecycleFailureWithNodeManager('Start server1: Node Manager connection timed out', row),
    'Start server1: Node Manager connection timed out (Node Manager machine1: unreachable · machine1.example.com:5556 · SSL)',
  )
  assert.equal(
    enrichLifecycleFailureWithNodeManager(`Start server1 failed (${context})`, row),
    `Start server1 failed (${context})`,
  )
  assert.equal(enrichLifecycleFailureWithNodeManager('Start server1 failed', null), 'Start server1 failed')
})

test('validates listener drafts and builds changed-field payloads', () => {
  assert.deepEqual(validateMachineName('  machine1  '), { ok: true, value: 'machine1', error: null })
  assert.equal(validateMachineName('bad/name').ok, false)

  const draft = listenerDraftFromRow(nodeManagerRow())
  assert.deepEqual(draft, {
    listenAddress: 'machine1.example.com',
    listenPort: '5556',
    nmType: 'SSL',
    socketCreateTimeoutMillis: '180000',
  })

  const validation = validateNodeManagerListenerDraft({
    listenAddress: ' machine2.example.com ',
    listenPort: '5557',
    nmType: 'ssl',
    socketCreateTimeoutMillis: '90000',
  })
  assert.equal(validation.ok, true)
  assert.deepEqual(validation.config, {
    listenAddress: 'machine2.example.com',
    listenPort: 5557,
    NMType: 'SSL',
    NMSocketCreateTimeoutInMillis: 90000,
  })

  const diff = diffNodeManagerListenerConfig(nodeManagerRow(), validation.config!)
  assert.deepEqual(diff.patch, {
    listenAddress: 'machine2.example.com',
    listenPort: 5557,
    NMSocketCreateTimeoutInMillis: 90000,
  })
  assert.deepEqual(diff.changes.map((change) => change.label), ['Listen address', 'Listen port', 'Socket timeout'])

  const invalid = validateNodeManagerListenerDraft({
    listenAddress: '',
    listenPort: '70000',
    nmType: 'bad',
    socketCreateTimeoutMillis: '-1',
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.config, null)
  assert.ok(invalid.errors.some((error) => error.includes('Listen port')))
  assert.ok(invalid.errors.some((error) => error.includes('Node Manager type')))
})

test('classifies server machine assignment eligibility', () => {
  assert.equal(isNodeManagerServerAssignable({ serverName: 'server1', machineName: 'machine1', lifecycleState: 'SHUTDOWN' }), true)
  assert.equal(isNodeManagerServerAssignable({ serverName: 'server1', machineName: 'machine1', lifecycleState: 'FAILED_NOT_RESTARTABLE' }), true)
  assert.equal(isNodeManagerServerAssignable({ serverName: 'server1', machineName: 'machine1', lifecycleState: 'RUNNING' }), false)
  assert.equal(isNodeManagerServerAssignable({ serverName: 'AdminServer', machineName: 'machine1', lifecycleState: 'SHUTDOWN' }), false)
  assert.deepEqual(nodeManagerAssignmentServerChoices([
    { serverName: 'AdminServer', machineName: 'machine1', lifecycleState: 'RUNNING' },
    { serverName: 'server1', machineName: 'machine1', lifecycleState: 'SHUTDOWN' },
  ]), [
    { serverName: 'server1', machineName: 'machine1', lifecycleState: 'SHUTDOWN' },
  ])
  assert.equal(
    nodeManagerAssignmentBlockedReason({ serverName: 'server1', machineName: 'machine1', lifecycleState: 'RUNNING' }),
    'Machine assignment is available only for stopped eligible managed servers.',
  )
})

test('fetch snapshot returns unsupported for missing Node Manager runtime collection', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 404, statusText: 'Not Found' })

  try {
    const snapshot = await fetchNodeManagerSnapshot(creds)
    assert.equal(snapshot.status, 'unsupported')
    assert.deepEqual(snapshot.rows, [])
    assert.match(snapshot.unsupportedReason ?? '', /HTTP 404/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetch snapshot keeps config failures as partial data', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/domainRuntime/nodeManagerRuntimes')) {
      return jsonResponse({ items: [{ name: 'machine1', type: 'NodeManagerRuntime', reachable: true }] })
    }
    if (url.includes('/edit/machines?')) {
      return jsonResponse({ items: [{ name: 'machine1' }, { name: 'machine2' }] })
    }
    if (url.includes('/edit/servers?')) {
      return jsonResponse({
        items: [
          { name: 'server1', machine: ['machines', 'machine1'] },
          { name: 'server2', machine: ['machines', 'machine2'] },
        ],
      })
    }
    if (url.includes('/domainRuntime/serverLifeCycleRuntimes')) {
      return jsonResponse({
        items: [
          { name: 'server1', state: 'RUNNING' },
          { name: 'server2', state: 'SHUTDOWN' },
        ],
      })
    }
    if (url.includes('/edit/machines/machine1/nodeManager')) {
      return jsonResponse({
        name: 'machine1',
        listenAddress: 'machine1.example.com',
        listenPort: 5556,
        NMType: 'SSL',
        NMSocketCreateTimeoutInMillis: 180000,
      })
    }
    if (url.includes('/edit/machines/machine2/nodeManager')) {
      return new Response(null, { status: 503, statusText: 'Service Unavailable' })
    }
    return new Response(null, { status: 500, statusText: 'Unexpected' })
  }

  try {
    const snapshot = await fetchNodeManagerSnapshot(creds)
    assert.equal(snapshot.status, 'supported')
    assert.deepEqual(snapshot.machines, ['machine1', 'machine2'])
    assert.equal(snapshot.rows.length, 2)
    assert.equal(snapshot.rows.find((row) => row.machineName === 'machine1')?.reachable, 'reachable')
    assert.equal(snapshot.servers.find((row) => row.serverName === 'server2')?.lifecycleState, 'SHUTDOWN')
    assert.deepEqual(snapshot.rows.find((row) => row.machineName === 'machine2')?.serverNames, ['server2'])
    assert.deepEqual(snapshot.partialFailures, [
      {
        machineName: 'machine2',
        family: 'nodeManagerConfig',
        message: 'Node Manager configuration machine2: HTTP 503 Service Unavailable',
      },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('listener update uses bounded edit transaction and changed fields only', async () => {
  const originalFetch = globalThis.fetch
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({
      method: init?.method ?? 'GET',
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    if (url.includes('/edit/changeManager/activate')) return new Response('', { status: 200 })
    return jsonResponse({})
  }

  try {
    const result = await updateNodeManagerListener(creds, {
      machineName: 'machine1',
      patch: { listenPort: 5557 },
      changes: [{ field: 'listenPort', label: 'Listen port', before: '5556', after: '5557' }],
    })
    assert.equal(result.action, 'listener')
    assert.deepEqual(calls.map((call) => call.url.replace(/^\/api\/wls/, '')), [
      '/management/weblogic/12.2.1.4.0/edit/changeManager/startEdit',
      '/management/weblogic/12.2.1.4.0/edit/machines/machine1/nodeManager',
      '/management/weblogic/12.2.1.4.0/edit/changeManager/activate',
    ])
    assert.deepEqual(calls[1]?.body, { listenPort: 5557 })
    assert.ok(calls.every((call) => call.method === 'POST'))
    // The local audit records who changed Node Manager, like any other mutation.
    assert.ok(calls.every((call) => call.headers['x-wls-cockpit-username'] === creds.username))
    assert.ok(calls.every((call) => call.headers['x-wls-cockpit-profile-id'] === creds.profileId))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('machine creation creates parent then configures Node Manager child', async () => {
  const originalFetch = globalThis.fetch
  const calls: { url: string; body: unknown }[] = []
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input).replace(/^\/api\/wls/, ''),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return jsonResponse({})
  }

  try {
    const listener = {
      listenAddress: 'machine3.example.com',
      listenPort: 5556,
      NMType: 'SSL' as const,
      NMSocketCreateTimeoutInMillis: 180000,
    }
    await createNodeManagerMachine(creds, {
      machineName: 'machine3',
      listener,
      changes: machineCreationChanges(listener),
    })
    assert.deepEqual(calls.map((call) => call.url), [
      '/management/weblogic/12.2.1.4.0/edit/changeManager/startEdit',
      '/management/weblogic/12.2.1.4.0/edit/machines',
      '/management/weblogic/12.2.1.4.0/edit/machines/machine3/nodeManager',
      '/management/weblogic/12.2.1.4.0/edit/changeManager/activate',
    ])
    assert.deepEqual(calls[1]?.body, { name: 'machine3', type: 'Machine' })
    assert.deepEqual(calls[2]?.body, listener)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('server assignment payload uses machine identity tuple and cancels on failure', async () => {
  const originalFetch = globalThis.fetch
  const calls: { url: string; body: unknown }[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input).replace(/^\/api\/wls/, '')
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    if (url.includes('/edit/servers/server1')) {
      return new Response(JSON.stringify({}), { status: 400, statusText: 'Bad Request' })
    }
    return jsonResponse({})
  }

  try {
    await assert.rejects(
      () => assignNodeManagerServers(creds, {
        assignments: [{ serverName: 'server1', fromMachineName: 'machine1', toMachineName: 'machine2' }],
      }),
      /HTTP 400/,
    )
    assert.deepEqual(calls.map((call) => call.url), [
      '/management/weblogic/12.2.1.4.0/edit/changeManager/startEdit',
      '/management/weblogic/12.2.1.4.0/edit/servers/server1',
      '/management/weblogic/12.2.1.4.0/edit/changeManager/cancelEdit',
    ])
    assert.deepEqual(calls[1]?.body, { machine: ['machines', 'machine2'] })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('server assignment rejects AdminServer before acquiring edit lock', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    return jsonResponse({})
  }

  try {
    await assert.rejects(
      () => assignNodeManagerServers(creds, {
        assignments: [{ serverName: 'AdminServer', fromMachineName: null, toMachineName: 'machine1' }],
      }),
      /AdminServer machine assignment is protected/,
    )
    assert.deepEqual(calls, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an unreachable Node Manager row says what the AdminServer was trying to reach', async () => {
  const { nodeManagerUnreachableHint } = await import('../src/api/queries/node-manager.ts')
  assert.match(
    nodeManagerUnreachableHint({ reachable: 'unreachable', listenAddress: 'wls-admin.example.com', listenPort: 5556, nmType: 'SSL' }) ?? '',
    /cannot reach Node Manager at wls-admin\.example\.com:5556 \(SSL\)/,
  )
  assert.equal(nodeManagerUnreachableHint({ reachable: 'reachable', listenAddress: null, listenPort: null, nmType: null }), null)
})
