import assert from 'node:assert/strict'
import test from 'node:test'
import type { WlsCredentials } from '../src/api/client.ts'
import {
  DIAGNOSTIC_SNAPSHOT_MAX_TEXT_BYTES,
  buildDiagnosticSnapshotManifest,
  createStoredZip,
  diagnosticSnapshotTargetLabel,
  redactDiagnosticSnapshotValue,
} from '../src/api/queries/diagnostic-snapshot-model.ts'
import { selectableThreadDumpServers } from '../src/components/diagnostic-snapshot-selection.ts'

const creds: WlsCredentials = {
  profileId: 'profile-a',
  name: 'Lab profile',
  targetUrl: 'http://admin:unit-test-pass@wls-admin.example.com:7001',
  username: 'admin',
  password: 'unit-test-pass',
  version: '12.2.1.4.0',
}

test('diagnostic snapshot target labels strip credentials', () => {
  assert.equal(diagnosticSnapshotTargetLabel(creds.targetUrl), 'wls-admin.example.com:7001')
  assert.equal(diagnosticSnapshotTargetLabel('not-a-url'), 'unknown')
})

test('diagnostic snapshot manifest uses sanitized target and redaction metadata', () => {
  const manifest = buildDiagnosticSnapshotManifest(
    creds,
    [
      { id: 'dashboard', file: 'runtime/dashboard.json', status: 'included' },
      { id: 'thread-dumps', file: null, status: 'skipped' },
    ],
    '2026-05-05T10:00:00.000Z',
  )

  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.capturedAt, '2026-05-05T10:00:00.000Z')
  assert.equal(manifest.target, 'wls-admin.example.com:7001')
  assert.equal(manifest.version, '12.2.1.4.0')
  assert.equal(manifest.profileId, 'profile-a')
  assert.equal(manifest.username, 'admin')
  assert.equal(manifest.sections.length, 2)
  assert.match(manifest.redaction.sensitiveFields, /password/)
  assert.equal(JSON.stringify(manifest).includes('unit-test-pass'), false)
})

test('diagnostic snapshot redaction removes secrets paths and payload-bearing fields', () => {
  const redacted = redactDiagnosticSnapshotValue({
    sourceServerName: 'AdminServer',
    password: 'unit-test-pass',
    credentialToken: 'abc',
    sourcePath: '/u01/oracle/domains/base_domain/apps/orders.war',
    notes: 'url=http://admin:unit-test-pass@wls-admin.example.com:7001 password=unit-test-pass /Users/alice/domain/config.xml',
    messageBody: 'secret message body',
    bytes: new Uint8Array([1, 2, 3]),
    nested: {
      cookie: 'JSESSIONID=abc',
      fileName: '/private/tmp/export.xml',
    },
  }) as Record<string, unknown>

  assert.equal(redacted.sourceServerName, 'AdminServer')
  assert.equal(redacted.password, '<redacted>')
  assert.equal(redacted.credentialToken, '<redacted>')
  assert.equal(redacted.sourcePath, '<path>')
  assert.equal(redacted.messageBody, '<omitted>')
  assert.equal(redacted.bytes, '<omitted>')
  assert.deepEqual(redacted.nested, { cookie: '<redacted>', fileName: '<path>' })
  assert.equal(JSON.stringify(redacted).includes('unit-test-pass'), false)
  assert.equal(JSON.stringify(redacted).includes('/Users/alice'), false)
  assert.match(String(redacted.notes), /password=<redacted>/)
})

test('diagnostic snapshot redaction bounds long strings', () => {
  const redacted = redactDiagnosticSnapshotValue('x'.repeat(DIAGNOSTIC_SNAPSHOT_MAX_TEXT_BYTES + 1024))
  assert.equal(typeof redacted, 'string')
  assert.ok(redacted.length < DIAGNOSTIC_SNAPSHOT_MAX_TEXT_BYTES + 1024)
  assert.match(redacted, /truncated by WLS Cockpit diagnostic snapshot/)
})

test('diagnostic snapshot ZIP stores manifest and sanitized payload without compression dependency', async () => {
  const blob = createStoredZip([
    { path: 'manifest.json', text: '{"target":"wls-admin.example.com:7001"}\n' },
    { path: 'runtime/dashboard.json', text: '{"password":"<redacted>","path":"<path>"}\n' },
  ])
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const text = new TextDecoder().decode(bytes)

  assert.equal(bytes[0], 0x50)
  assert.equal(bytes[1], 0x4b)
  assert.equal(blob.type, 'application/zip')
  assert.match(text, /manifest\.json/)
  assert.match(text, /runtime\/dashboard\.json/)
  assert.match(text, /wls-admin\.example\.com:7001/)
  assert.equal(text.includes('unit-test-pass'), false)
})

test('contextual diagnostic snapshot selects only requested running servers', () => {
  assert.deepEqual(
    Array.from(selectableThreadDumpServers(['AdminServer', 'osb_server1'], [' osb_server1 ', 'missing', ''])),
    ['osb_server1'],
  )
  assert.equal(selectableThreadDumpServers(['AdminServer'], undefined).size, 0)
})
