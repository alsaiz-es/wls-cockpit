import assert from 'node:assert/strict'
import test from 'node:test'
import type { WlsCredentials } from '../src/api/client.ts'
import type { ClusterRow } from '../src/api/queries/clusters.ts'
import type { ServerRuntimeRow } from '../src/api/queries/server-runtimes.ts'
import type { TopologyConfiguredResource } from '../src/api/queries/topology-configuration.ts'
import { topologyEndpointById } from '../src/api/queries/topology-configuration-catalog.ts'
import {
  buildClusterDeleteIntent,
  buildConfigEditDraft,
  buildServerDeleteIntent,
  buildTopologySectionEditIntent,
  clusterDeleteBlockedReason,
  createClusterIntent,
  createServerIntent,
  initialCreateClusterForm,
  initialCreateServerForm,
  serverDeleteBlockedReason,
  validateCreateClusterForm,
  validateCreateServerForm,
} from '../src/routes/topology-configuration-route-model.ts'

const creds: WlsCredentials = {
  profileId: 'lab',
  name: 'Lab',
  targetUrl: 'http://wls-admin.example.com:7001',
  username: 'operator',
  password: 'placeholder',
  version: '14.1.2.0.0',
}

function configuredResource(kind: 'cluster' | 'server', name: string, root: Record<string, unknown> = {}): TopologyConfiguredResource {
  return {
    kind,
    name,
    root: { name, ...root },
    sections: [],
    partialFailures: [],
  }
}

function serverRow(name: string, state: ServerRuntimeRow['state']): ServerRuntimeRow {
  return {
    name,
    state,
    healthState: 'ok',
    listenAddress: null,
    listenPort: null,
    heap: null,
    jvm: null,
    threads: null,
  }
}

function clusterRow(name: string, configuredMemberNames: string[] = []): ClusterRow {
  return {
    id: name,
    name,
    clusterAddress: null,
    clusterMessagingMode: null,
    clusterType: null,
    configuredMemberNames,
    runtimeServerNames: [],
    aliveServerCount: null,
    healthState: 'ok',
    stateCounts: {},
    primaryCount: null,
    secondaryCount: null,
    activeSingletonServices: [],
    members: [],
    runtimeRows: [],
    replicationRows: [],
    partialFailures: [],
  }
}

test('server create route model validates protected names, references, ports, and loading state', () => {
  const form = {
    ...initialCreateServerForm(),
    name: 'AdminServer',
    listenPort: '70000',
    clusterMode: 'existing' as const,
    clusterName: 'missing',
    machineName: 'ghost',
  }

  const result = validateCreateServerForm(form, {
    configurationLoaded: false,
    serverNames: ['AdminServer'],
    clusterNames: ['cluster1'],
    machineNames: ['machine1'],
    machinesAvailable: true,
  })

  assert.equal(result.valid, false)
  assert.equal(result.errors.name, 'AdminServer is protected.')
  assert.equal(result.errors.listenPort, 'Listen port must be an integer from 1 to 65535.')
  assert.equal(result.errors.clusterName, 'Select a current cluster.')
  assert.equal(result.errors.machineName, 'Select a current machine.')
  assert.equal(result.errors.configuration, 'Server configuration discovery is still loading.')
})

test('server create route model stages cluster creation before server creation without lifecycle start', () => {
  const form = {
    ...initialCreateServerForm(),
    name: 'ms2',
    listenAddress: '127.0.0.1',
    listenPort: '7005',
    notes: 'created by smoke',
    clusterMode: 'new' as const,
    newClusterName: 'cluster2',
    machineName: 'machine1',
  }

  const validation = validateCreateServerForm(form, {
    configurationLoaded: true,
    serverNames: ['AdminServer'],
    clusterNames: [],
    machineNames: ['machine1'],
    machinesAvailable: true,
  })
  const intent = createServerIntent(creds, form)

  assert.equal(validation.valid, true)
  assert.equal(intent.detail, 'Create managed server ms2')
  assert.equal(intent.subject, 'ms2 | cluster cluster2 | machine machine1')
  assert.deepEqual(intent.steps.map((step) => step.path), [
    '/management/weblogic/14.1.2.0.0/edit/clusters',
    '/management/weblogic/14.1.2.0.0/edit/servers',
  ])
  assert.deepEqual(intent.steps[1]?.body, {
    name: 'ms2',
    listenAddress: '127.0.0.1',
    listenPort: 7005,
    notes: 'created by smoke',
    cluster: ['clusters', 'cluster2'],
    machine: ['machines', 'machine1'],
  })
})

test('server edit and delete route model returns field errors, changed payloads, and destructive guards', () => {
  const endpoint = topologyEndpointById('server.root', '14.1.2.0.0')
  assert.ok(endpoint)
  const data = { name: 'ms1', listenPort: 7003, listenPortEnabled: true }
  const draft = buildConfigEditDraft(endpoint, data)
  draft.values.listenPort = '7004'

  const changed = buildTopologySectionEditIntent({ resourceName: 'ms1', endpoint, data, values: draft.values })
  assert.deepEqual(changed.errors, {})
  assert.deepEqual(changed.intent?.payload, { listenPort: 7004 })
  assert.deepEqual(changed.intent?.changedFields, ['listen Port'])

  const invalidDraft = buildConfigEditDraft(endpoint, data)
  invalidDraft.values.listenPort = 'not-a-port'
  const invalid = buildTopologySectionEditIntent({ resourceName: 'ms1', endpoint, data, values: invalidDraft.values })
  assert.equal(invalid.intent, null)
  assert.match(invalid.errors.listenPort ?? '', /integer/)

  const unchanged = buildTopologySectionEditIntent({
    resourceName: 'ms1',
    endpoint,
    data,
    values: buildConfigEditDraft(endpoint, data).values,
  })
  assert.equal(unchanged.intent, null)
  assert.equal(unchanged.errors.__form, 'No changed editable fields.')

  const resource = configuredResource('server', 'ms1', {
    cluster: ['clusters', 'cluster1'],
    machine: ['machines', 'machine1'],
  })
  assert.equal(serverDeleteBlockedReason('AdminServer', serverRow('AdminServer', 'SHUTDOWN'), resource), 'AdminServer is protected.')
  assert.equal(serverDeleteBlockedReason('ms1', serverRow('ms1', 'RUNNING'), resource), 'Stop ms1 before deleting it.')
  assert.equal(serverDeleteBlockedReason('ms1', serverRow('ms1', 'SHUTDOWN'), resource), null)

  const deleteIntent = buildServerDeleteIntent('ms1', resource)
  assert.equal(deleteIntent.detail, 'Delete managed server ms1')
  assert.deepEqual(deleteIntent.changedFields, ['Dependencies: cluster cluster1, machine machine1'])
})

test('section edit keeps hidden path fields when they are left blank', () => {
  const endpoint = topologyEndpointById('server.startup', '14.1.2.0.0')
  assert.ok(endpoint)
  const data = {
    name: 'ms1',
    javaVendor: 'Oracle',
    javaHome: '/opt/jdk',
    classPath: '/opt/lib/a.jar',
    MWHome: '/opt/fmw',
    rootDirectory: '/domains/base',
  }
  const draft = buildConfigEditDraft(endpoint, data)
  assert.equal(draft.values.javaHome, '')
  draft.values.javaVendor = 'Other'

  const vendorOnly = buildTopologySectionEditIntent({ resourceName: 'ms1', endpoint, data, values: draft.values })
  assert.deepEqual(vendorOnly.errors, {})
  assert.deepEqual(vendorOnly.intent?.payload, { javaVendor: 'Other' })

  draft.values.javaHome = '/opt/jdk21'
  const withPath = buildTopologySectionEditIntent({ resourceName: 'ms1', endpoint, data, values: draft.values })
  assert.deepEqual(withPath.intent?.payload, { javaVendor: 'Other', javaHome: '/opt/jdk21' })
})

test('cluster create route model validates duplicate names and frontend ports', () => {
  const form = {
    ...initialCreateClusterForm(),
    name: 'cluster1',
    frontendHTTPPort: '0',
    frontendHTTPSPort: 'not-a-port',
  }

  const result = validateCreateClusterForm(form, {
    configurationLoaded: false,
    clusterNames: ['cluster1'],
  })

  assert.equal(result.valid, false)
  assert.equal(result.errors.name, 'Cluster name already exists.')
  assert.equal(result.errors.frontendHTTPPort, 'Frontend HTTP port must be an integer from 1 to 65535.')
  assert.equal(result.errors.frontendHTTPSPort, 'Frontend HTTPS port must be an integer from 1 to 65535.')
  assert.equal(result.errors.configuration, 'Cluster configuration discovery is still loading.')
})

test('cluster create, edit, and delete route model builds sanitized confirmation payloads and guards members', () => {
  const form = {
    ...initialCreateClusterForm(),
    name: 'cluster2',
    clusterAddress: 'cluster2.example.com',
    clusterMessagingMode: 'unicast',
    frontendHTTPPort: '7101',
    notes: 'created by smoke',
  }
  const validation = validateCreateClusterForm(form, {
    configurationLoaded: true,
    clusterNames: ['cluster1'],
  })
  const createIntent = createClusterIntent(form)

  assert.equal(validation.valid, true)
  assert.equal(createIntent.detail, 'Create cluster cluster2')
  assert.equal(createIntent.subject, 'cluster2 | address cluster2.example.com | messaging unicast')
  assert.deepEqual(createIntent.input, {
    clusterAddress: 'cluster2.example.com',
    clusterMessagingMode: 'unicast',
    frontendHTTPPort: 7101,
    notes: 'created by smoke',
  })

  const endpoint = topologyEndpointById('cluster.root', '14.1.2.0.0')
  assert.ok(endpoint)
  const data = { name: 'cluster2', clusterAddress: 'old.example.com' }
  const draft = buildConfigEditDraft(endpoint, data)
  draft.values.clusterAddress = 'cluster2.example.com'
  const edit = buildTopologySectionEditIntent({ resourceName: 'cluster2', endpoint, data, values: draft.values })
  assert.deepEqual(edit.intent?.payload, { clusterAddress: 'cluster2.example.com' })
  assert.deepEqual(edit.intent?.changedFields, ['cluster Address'])

  assert.match(
    clusterDeleteBlockedReason(clusterRow('cluster2', ['ms1']), configuredResource('cluster', 'cluster2')),
    /Remove 1 configured server member/,
  )
  assert.match(
    clusterDeleteBlockedReason(clusterRow('cluster2'), configuredResource('cluster', 'cluster2', { servers: [['servers', 'ms1']] })),
    /Remove 1 configured server member/,
  )
  const cleanResource = configuredResource('cluster', 'cluster2', { dynamicServers: ['dynamicServers', 'dyn1'] })
  assert.equal(clusterDeleteBlockedReason(clusterRow('cluster2'), cleanResource), null)

  const deleteIntent = buildClusterDeleteIntent(clusterRow('cluster2'), cleanResource)
  assert.equal(deleteIntent.detail, 'Delete cluster cluster2')
  assert.deepEqual(deleteIntent.changedFields, ['Dynamic servers: dyn1'])
})
