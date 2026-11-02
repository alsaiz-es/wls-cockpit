import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { classifyActionAuditRequest } from '../server/action-audit.ts'
import {
  deploymentArchiveFileName,
  multipartBodyStream,
  multipartEnvelope,
  parseDeploymentUploadModel,
} from '../server/deployment-upload.ts'
import { createCockpitServer } from '../server/http.ts'
import {
  DEPLOYMENT_FILE_NAME_HEADER,
  DEPLOYMENT_MODEL_HEADER,
  DEPLOYMENT_UPLOAD_PATH,
} from '../src/api/deployment-upload-contract.ts'
import { WLS_TARGET_HEADER } from '../src/api/proxy-target.ts'
import { deploymentNameFromFileName, deploymentUploadRequestInit } from '../src/api/queries/deployment-upload.ts'
import { normalizeActionAuditRecords } from '../src/api/queries/action-audit.ts'

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  return `http://127.0.0.1:${address.port}`
}

async function readAll(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function* chunks(...values: string[]) {
  for (const value of values) yield Buffer.from(value)
}

const model = { name: 'orders', targets: [{ identity: ['clusters', 'cluster1'] }] }

test('deployment model accepts server and cluster targets only', () => {
  assert.deepEqual(parseDeploymentUploadModel(JSON.stringify(model)), model)
  assert.equal(parseDeploymentUploadModel(JSON.stringify({ name: 'orders', targets: [] })), null)
  assert.equal(parseDeploymentUploadModel(JSON.stringify({ name: '../x', targets: model.targets })), null)
  assert.equal(parseDeploymentUploadModel(JSON.stringify({ name: 'orders', targets: [{ identity: ['machines', 'm1'] }] })), null)
  assert.equal(parseDeploymentUploadModel('not json'), null)
})

test('archive file names keep the base name and need a deployable extension', () => {
  assert.equal(deploymentArchiveFileName('C:\\builds\\orders.ear'), 'orders.ear')
  assert.equal(deploymentArchiveFileName('orders.WAR'), 'orders.WAR')
  assert.equal(deploymentArchiveFileName('orders.zip'), null)
  assert.equal(deploymentArchiveFileName('bad".war'), null)
  assert.equal(deploymentNameFromFileName('/tmp/orders-1.2.ear'), 'orders-1.2')
})

test('the multipart body frames the archive and rejects a size mismatch', async () => {
  const { head, tail } = multipartEnvelope({ name: 'orders', targets: [{ identity: ['servers', 'AdminServer'] }] }, 'orders.war', 'b0')
  const body = Buffer.from(await new Response(multipartBodyStream(chunks('PK-', 'archive'), head, tail, 10)).arrayBuffer()).toString()
  assert.match(body, /^--b0\r\nContent-Disposition: form-data; name="model"\r\n/)
  assert.match(body, /name="sourcePath"; filename="orders.war"\r\nContent-Type: application\/octet-stream\r\n\r\nPK-archive\r\n--b0--\r\n$/)
  await assert.rejects(new Response(multipartBodyStream(chunks('short'), head, tail, 10)).arrayBuffer(), /ended early/)
})

test('the browser sends the archive with the model and file name headers', () => {
  const creds = { profileId: 'p', name: 'lab', targetUrl: 'http://127.0.0.1:7001', username: 'weblogic', password: 'x', version: '14.1.2.0.0' as const }
  const file = Object.assign(new Blob(['PK']), { name: 'orders.war' })
  const init = deploymentUploadRequestInit(creds, 'orders', [{ kind: 'clusters', name: 'cluster1' }], file)
  const headers = new Headers(init.headers)
  assert.deepEqual(JSON.parse(decodeURIComponent(headers.get(DEPLOYMENT_MODEL_HEADER) ?? '')), model)
  assert.equal(headers.get(DEPLOYMENT_FILE_NAME_HEADER), 'orders.war')
  assert.equal(headers.get(WLS_TARGET_HEADER), 'http://127.0.0.1:7001')
  assert.equal(init.body, file)
})

test('uploads are audited as deployment actions', () => {
  assert.deepEqual(classifyActionAuditRequest('POST', DEPLOYMENT_UPLOAD_PATH, model), {
    family: 'deployment',
    action: 'upload',
    resource: { type: 'deployment', name: 'orders' },
  })
})

test('the local server streams the upload to WebLogic as multipart and audits it', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-upload-'))
  let seen: { url: string | undefined; contentType: string | undefined; length: string | undefined; requestedBy: unknown; body: string } | null = null
  const upstream = createServer(async (req, res) => {
    const body = await readAll(req)
    seen = {
      url: req.url,
      contentType: req.headers['content-type'],
      length: req.headers['content-length'],
      requestedBy: req.headers['x-requested-by'],
      body: body.toString(),
    }
    assert.equal(Number(req.headers['content-length']), body.byteLength)
    res.statusCode = 201
    res.setHeader('Content-Type', 'application/json')
    res.end('{}')
  })
  t.after(() => upstream.close())
  const upstreamUrl = await listen(upstream)
  const cockpit = createCockpitServer({ targetUrl: upstreamUrl, defaultVersion: '14.1.2.0.0', auditStore: { dataDir } })
  t.after(() => cockpit.close())
  const cockpitUrl = await listen(cockpit)

  const headers = {
    Authorization: 'Basic d2VibG9naWM6eA==',
    'Content-Type': 'application/octet-stream',
    [WLS_TARGET_HEADER]: upstreamUrl,
    [DEPLOYMENT_MODEL_HEADER]: encodeURIComponent(JSON.stringify(model)),
    [DEPLOYMENT_FILE_NAME_HEADER]: 'orders.war',
  }
  const response = await fetch(`${cockpitUrl}${DEPLOYMENT_UPLOAD_PATH}?version=14.1.2.0.0`, { method: 'POST', headers, body: 'PK-archive' })
  assert.equal(response.status, 201)
  assert.ok(seen)
  const upstreamSeen = seen as NonNullable<typeof seen>
  assert.equal(upstreamSeen.url, '/management/weblogic/14.1.2.0.0/edit/appDeployments')
  assert.match(upstreamSeen.contentType ?? '', /^multipart\/form-data; boundary=/)
  assert.equal(upstreamSeen.requestedBy, 'wls-cockpit')
  assert.match(upstreamSeen.body, /PK-archive/)

  const rejected = await fetch(`${cockpitUrl}${DEPLOYMENT_UPLOAD_PATH}?version=14.1.2.0.0`, {
    method: 'POST',
    headers: { ...headers, [DEPLOYMENT_FILE_NAME_HEADER]: 'orders.zip' },
    body: 'PK-archive',
  })
  assert.equal(rejected.status, 400)

  const audit = normalizeActionAuditRecords(await (await fetch(`${cockpitUrl}/api/audit/records`)).json())
  assert.deepEqual(audit.map((row) => [row.family, row.action, row.resource.name, row.status]), [['deployment', 'upload', 'orders', 'success']])
})

test('read-only demo mode refuses uploads on the server', async (t) => {
  const cockpit = createCockpitServer({ targetUrl: 'http://127.0.0.1:9', defaultVersion: '14.1.2.0.0', readOnlyDemoMode: true })
  t.after(() => cockpit.close())
  const cockpitUrl = await listen(cockpit)
  const response = await fetch(`${cockpitUrl}${DEPLOYMENT_UPLOAD_PATH}?version=14.1.2.0.0`, { method: 'POST', body: 'PK' })
  assert.equal(response.status, 403)
})
