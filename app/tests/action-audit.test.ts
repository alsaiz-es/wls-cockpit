import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  AUDIT_PROFILE_ID_HEADER,
  AUDIT_PROFILE_NAME_HEADER,
  AUDIT_USERNAME_HEADER,
  AUDIT_VERSION_HEADER,
  classifyActionAuditRequest,
  parseActionAuditFilters,
  readActionAuditRecords,
  sanitizeAuditValue,
  writeActionAuditRecord,
  writeActionAuditRecordSafely,
} from '../server/action-audit.ts'
import { createCockpitServer } from '../server/http.ts'
import { WLS_TARGET_HEADER } from '../src/api/proxy-target.ts'
import {
  actionAuditJsonl,
  normalizeActionAuditRecords,
  type ActionAuditRecord,
} from '../src/api/queries/action-audit.ts'

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  return `http://127.0.0.1:${address.port}`
}

function record(id: string): ActionAuditRecord {
  return {
    id,
    startedAt: `2026-05-05T10:00:0${id}.000Z`,
    settledAt: `2026-05-05T10:00:0${id}.100Z`,
    durationMs: 100,
    method: 'POST',
    path: '/management/weblogic/latest/domainRuntime/serverLifeCycleRuntimes/osb_server1/start',
    target: 'wls-admin.example.com:7001',
    profileId: 'lab',
    profileName: 'Lab',
    username: 'admin',
    version: '14.1.2.0.0',
    family: 'server',
    action: 'start',
    resource: { type: 'server', name: 'osb_server1' },
    status: 'success',
    httpStatus: 200,
    errorSummary: null,
  }
}

test('action audit classifies supported mutations but ignores POST read helpers', () => {
  assert.deepEqual(
    classifyActionAuditRequest('POST', '/management/weblogic/latest/domainRuntime/serverLifeCycleRuntimes/osb_server1/start'),
    {
      family: 'server',
      action: 'start',
      resource: { type: 'server', name: 'osb_server1' },
    },
  )
  assert.deepEqual(
    classifyActionAuditRequest(
      'POST',
      '/management/weblogic/latest/domainRuntime/serverRuntimes/ms1/JMSRuntime/JMSServers/jms1/destinations/Q/pauseProduction',
    ),
    {
      family: 'jms',
      action: 'pauseProduction',
      resource: { type: 'destination', name: 'Q', parent: 'ms1/jms1' },
    },
  )
  assert.deepEqual(
    classifyActionAuditRequest('POST', '/management/weblogic/14.1.2.0.0/edit/servers', { name: 'ms-new', password: 'unit-test-pass' }),
    {
      family: 'server',
      action: 'create',
      resource: { type: 'server', name: 'ms-new' },
    },
  )
  assert.deepEqual(
    classifyActionAuditRequest('POST', '/management/weblogic/14.1.2.0.0/edit/servers/ms1/networkAccessPoints', { name: 'https' }),
    {
      family: 'server',
      action: 'create-child',
      resource: { type: 'networkAccessPoint', name: 'https', parent: 'ms1' },
    },
  )
  assert.deepEqual(
    classifyActionAuditRequest('DELETE', '/management/weblogic/14.1.2.0.0/edit/clusters/cluster1'),
    {
      family: 'cluster',
      action: 'delete',
      resource: { type: 'cluster', name: 'cluster1' },
    },
  )
  assert.deepEqual(
    classifyActionAuditRequest('POST', '/management/weblogic/14.1.2.0.0/domainRuntime/deploymentManager/deploy', {
      name: 'orders',
      sourcePath: '/u01/apps/orders.war',
    }),
    { family: 'deployment', action: 'deploy', resource: { type: 'deployment', name: 'orders' } },
  )
  assert.deepEqual(
    classifyActionAuditRequest('DELETE', '/management/weblogic/14.1.2.0.0/edit/appDeployments/orders'),
    { family: 'deployment', action: 'undeploy', resource: { type: 'deployment', name: 'orders' } },
  )
  assert.deepEqual(
    classifyActionAuditRequest('POST', '/management/weblogic/14.1.2.0.0/edit/appDeployments/orders', { targets: [] }),
    { family: 'deployment', action: 'configure', resource: { type: 'deployment', name: 'orders' } },
  )
  assert.deepEqual(
    classifyActionAuditRequest('POST', '/management/weblogic/14.1.2.0.0/edit/machines/machine1/nodeManager', { listenPort: 5556 }),
    { family: 'other', action: 'configure', resource: { type: 'editPath', name: 'machines/machine1/nodeManager' } },
  )
  assert.deepEqual(
    classifyActionAuditRequest('DELETE', '/management/weblogic/14.1.2.0.0/edit/machines/machine1'),
    { family: 'other', action: 'delete', resource: { type: 'editPath', name: 'machines/machine1' } },
  )
  assert.equal(classifyActionAuditRequest('GET', '/management/weblogic/14.1.2.0.0/edit/machines'), null)
  assert.equal(classifyActionAuditRequest('POST', '/management/weblogic/latest/domainRuntime/getServerHttpURL'), null)
  assert.equal(classifyActionAuditRequest('POST', '/management/weblogic/latest/domainRuntime/WLDFDataAccessRuntimes/ServerLog/search'), null)
})

test('action audit sanitizer redacts secrets payloads and filesystem paths', () => {
  const sanitized = sanitizeAuditValue({
    password: 'unit-test-pass',
    body: 'secret JMS body',
    properties: { token: 'abc' },
    sourcePath: '/u01/domains/base_domain/app.ear',
    url: 'http://user:unit-test-pass@wls-admin.example.com:7001',
  })

  const text = JSON.stringify(sanitized)
  assert.doesNotMatch(text, /unit-test-pass|secret JMS body|\/u01|abc/)
  assert.match(text, /\[redacted\]|\[credentials\]/)
})

test('action audit JSONL store applies retention and filters', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-audit-'))
  const store = { dataDir, maxRecords: 2 }
  await writeActionAuditRecord(record('1'), store)
  await writeActionAuditRecord({ ...record('2'), family: 'jms', action: 'delete' }, store)
  await writeActionAuditRecord({ ...record('3'), status: 'failure', httpStatus: 500, errorSummary: 'failed' }, store)

  const rows = await readActionAuditRecords(store)
  assert.deepEqual(rows.map((row) => row.id), ['3', '2'])
  assert.deepEqual((await readActionAuditRecords(store, { family: 'jms' })).map((row) => row.id), ['2'])
  assert.deepEqual((await readActionAuditRecords(store, { status: 'failure' })).map((row) => row.id), ['3'])
})

test('concurrent audit writes during compaction lose no records', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-audit-race-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const store = { dataDir, maxRecords: 30 }

  // A batch lifecycle action writes one record per server at once. Before, every write
  // compacted through the same '<pid>.tmp' file and appends landing between the read and the
  // rename were lost, or the rename failed with ENOENT.
  const writes = await Promise.allSettled(
    Array.from({ length: 25 }, (_, index) => writeActionAuditRecord(record(String(index + 1)), store)),
  )
  assert.deepEqual(writes.filter((result) => result.status === 'rejected'), [])
  assert.equal((await readActionAuditRecords(store, { limit: 100 })).length, 25)

  await Promise.all(Array.from({ length: 20 }, (_, index) => writeActionAuditRecord(record(String(index + 26)), store)))
  const ids = (await readActionAuditRecords(store, { limit: 100 })).map((row) => Number(row.id)).sort((a, b) => a - b)
  assert.deepEqual(ids, Array.from({ length: 30 }, (_, index) => index + 16))
})

test('the audit log is readable only by its owner', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-audit-mode-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  await writeActionAuditRecord(record('1'), { dataDir, maxRecords: 1 })
  await writeActionAuditRecord(record('2'), { dataDir, maxRecords: 1 })
  const file = path.join(dataDir, 'action-audit.jsonl')
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.match(await readFile(file, 'utf8'), /"id":"2"/)
})

test('action audit write failure can be isolated from caller flow', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-audit-'))
  const directoryPath = path.join(dataDir, 'directory')
  await mkdir(directoryPath)

  assert.equal(await writeActionAuditRecordSafely(record('1'), { path: directoryPath }), false)
})

test('action audit route normalization drops malformed rows and exports JSONL', () => {
  const rows = normalizeActionAuditRecords({ records: [record('1'), { id: 'bad' }] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.resource.name, 'osb_server1')
  assert.match(actionAuditJsonl(rows), /"family":"server"/)
})

test('self-host proxy records sanitized mutation audit entries only for mutations', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-audit-'))
  let upstreamCalls = 0
  const upstream = createServer((req, res) => {
    upstreamCalls += 1
    res.setHeader('Content-Type', 'application/json')
    if (req.url?.includes('/start')) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: { message: 'failed password=unit-test-pass Basic abc123' } }))
      return
    }
    res.end(JSON.stringify({ ok: true }))
  })
  t.after(() => upstream.close())
  const upstreamUrl = await listen(upstream)

  const cockpit = createCockpitServer({
    targetUrl: upstreamUrl,
    defaultVersion: '14.1.2.0.0',
    auditStore: { dataDir },
  })
  t.after(() => cockpit.close())
  const cockpitUrl = await listen(cockpit)
  const headers = {
    Authorization: 'Basic abc123',
    'Content-Type': 'application/json',
    [WLS_TARGET_HEADER]: upstreamUrl,
    [AUDIT_PROFILE_ID_HEADER]: 'profile-a',
    [AUDIT_PROFILE_NAME_HEADER]: 'Lab',
    [AUDIT_USERNAME_HEADER]: 'admin',
    [AUDIT_VERSION_HEADER]: '14.1.2.0.0',
  }

  const mutation = await fetch(`${cockpitUrl}/api/wls/management/weblogic/latest/domainRuntime/serverLifeCycleRuntimes/osb_server1/start`, {
    method: 'POST',
    headers,
    body: '{}',
  })
  assert.equal(mutation.status, 500)

  const postRead = await fetch(`${cockpitUrl}/api/wls/management/weblogic/latest/domainRuntime/getServerHttpURL`, {
    method: 'POST',
    headers,
    body: '{}',
  })
  assert.equal(postRead.status, 200)

  const topology = await fetch(`${cockpitUrl}/api/wls/management/weblogic/14.1.2.0.0/edit/clusters`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'cluster-new', password: 'unit-test-pass', rootDirectory: '/secret/path' }),
  })
  assert.equal(topology.status, 200)

  const audit = await fetch(`${cockpitUrl}/api/audit/records`)
  const records = normalizeActionAuditRecords(await audit.json())
  assert.equal(upstreamCalls, 3)
  assert.equal(records.length, 2)
  assert.ok(records.some((row) => row.family === 'server' && row.status === 'failure'))
  assert.ok(records.some((row) => row.family === 'cluster' && row.action === 'create' && row.resource.name === 'cluster-new'))
  assert.equal(records[0]?.profileId, 'profile-a')
  assert.doesNotMatch(JSON.stringify(records), /unit-test-pass|Basic abc123/)
  assert.doesNotMatch(JSON.stringify(records), /secret\/path/)
})

test('force shutdown is audited like the other server lifecycle actions', () => {
  assert.deepEqual(
    classifyActionAuditRequest('POST', '/management/weblogic/14.1.2.0.0/domainRuntime/serverLifeCycleRuntimes/server1/forceShutdown'),
    { family: 'server', action: 'forceShutdown', resource: { type: 'server', name: 'server1' } },
  )
})

test('a trailing slash does not skip the audit of runtime actions', () => {
  assert.deepEqual(
    classifyActionAuditRequest('POST', '/management/weblogic/14.1.2.0.0/domainRuntime/serverLifeCycleRuntimes/server1/shutdown/'),
    { family: 'server', action: 'shutdown', resource: { type: 'server', name: 'server1' } },
  )
})

test('the audit filter accepts every family the Audit page offers, including other', () => {
  assert.equal(parseActionAuditFilters(new URLSearchParams('family=other')).family, 'other')
  assert.equal(parseActionAuditFilters(new URLSearchParams('family=jta')).family, 'jta')
  assert.equal(parseActionAuditFilters(new URLSearchParams('family=security')).family, 'security')
  assert.equal(parseActionAuditFilters(new URLSearchParams('family=bogus')).family, undefined)
})

test('clearing a user lockout is audited with the user and the server', () => {
  assert.deepEqual(
    classifyActionAuditRequest(
      'POST',
      '/api/wls/management/weblogic/14.1.2.0.0/domainRuntime/serverRuntimes/server1/serverSecurityRuntime/defaultRealmRuntime/userLockoutManagerRuntime/clearLockout',
      { userName: 'integration' },
    ),
    { family: 'security', action: 'clearLockout', resource: { type: 'user', name: 'integration', parent: 'server1' } },
  )
  assert.equal(
    classifyActionAuditRequest(
      'GET',
      '/api/wls/management/weblogic/14.1.2.0.0/domainRuntime/serverRuntimes/server1/serverSecurityRuntime/defaultRealmRuntime/userLockoutManagerRuntime',
    ),
    null,
  )
})
