import assert from 'node:assert/strict'
import test from 'node:test'
import type { WlsCredentials } from '../src/api/client.ts'
import {
  DOMAIN_CONFIG_SNAPSHOT_LIMIT,
  buildDomainConfigManifest,
  diffDomainConfigSnapshots,
  domainConfigSnapshotFilename,
  domainConfigTargetLabel,
  readStoredDomainConfigSnapshots,
  readStoredDomainConfigSnapshotsForScope,
  redactDomainConfigValue,
  writeStoredDomainConfigSnapshot,
  type DomainConfigSnapshot,
} from '../src/api/queries/domain-config-snapshots.ts'

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

class QuotaStorage extends MemoryStorage {
  failUntilLength: number
  constructor(failUntilLength: number) {
    super()
    this.failUntilLength = failUntilLength
  }
  setItem(key: string, value: string) {
    const parsed = JSON.parse(value) as { snapshots?: unknown[] }
    if ((parsed.snapshots?.length ?? 0) > this.failUntilLength) {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    }
    super.setItem(key, value)
  }
}

const creds: WlsCredentials = {
  profileId: 'profile-a',
  name: 'Lab',
  targetUrl: 'http://admin:unit-test-pass@wls-admin.example.com:7001',
  username: 'admin',
  password: 'unit-test-pass',
  version: '14.1.2.0.0',
}

function snapshot(
  id: string,
  resources: DomainConfigSnapshot['resources'],
  credentialOverrides: Partial<WlsCredentials> = {},
): DomainConfigSnapshot {
  const snapshotCreds = { ...creds, ...credentialOverrides }
  return {
    manifest: buildDomainConfigManifest(snapshotCreds, [{ family: 'servers', status: 'included', recordCount: resources.length }], id, `2026-05-05T10:00:0${id}.000Z`),
    resources,
  }
}

test('domain config target labels strip credentials', () => {
  assert.equal(domainConfigTargetLabel(creds.targetUrl), 'wls-admin.example.com:7001')
  assert.equal(domainConfigTargetLabel('invalid'), 'unknown')
})

test('domain config redaction removes secrets api keys and path fields', () => {
  const redacted = redactDomainConfigValue({
    name: 'DemoApp',
    sourcePath: '/u01/oracle/domains/base_domain/apps/demo.war',
    apiKey: 'abc',
    bearerToken: 'token',
    notes: 'password=unit-test-pass /Users/alice/domain/config.xml',
    nested: { credential: 'secret' },
  }) as Record<string, unknown>

  assert.equal(redacted.name, 'DemoApp')
  assert.equal(redacted.sourcePath, '<path>')
  assert.equal(redacted.apiKey, '<redacted>')
  assert.equal(redacted.bearerToken, '<redacted>')
  assert.deepEqual(redacted.nested, { credential: '<redacted>' })
  assert.equal(JSON.stringify(redacted).includes('unit-test-pass'), false)
  assert.equal(JSON.stringify(redacted).includes('/Users/alice'), false)
})

test('domain config manifest declares unsupported sensitive families', () => {
  const manifest = buildDomainConfigManifest(creds, [
    { family: 'servers', status: 'included', recordCount: 1 },
    { family: 'security-realms', status: 'unsupported', recordCount: 0, reason: 'review required' },
  ], 'snapshot-a', '2026-05-05T10:00:00.000Z')

  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.target, 'wls-admin.example.com:7001')
  assert.match(manifest.redaction.unsupportedFamilies, /security realms/i)
  assert.equal(JSON.stringify(manifest).includes('unit-test-pass'), false)
})

test('domain config diff reports added removed and changed resources', () => {
  const before = snapshot('1', [
    { family: 'servers', identity: 'AdminServer', data: { listenPort: 7001, sourcePath: '<path>' } },
    { family: 'deployments', identity: 'OldApp', data: { moduleType: 'war' } },
  ])
  const after = snapshot('2', [
    { family: 'servers', identity: 'AdminServer', data: { listenPort: 7003, sourcePath: '<path>' } },
    { family: 'dataSources', identity: 'NewDS', data: { targets: ['AdminServer'] } },
  ])

  const diff = diffDomainConfigSnapshots(before, after)

  assert.deepEqual(diff.resources.map((row) => `${row.family}:${row.identity}:${row.kind}`), [
    'dataSources:NewDS:added',
    'deployments:OldApp:removed',
    'servers:AdminServer:changed',
  ])
  assert.deepEqual(diff.resources.find((row) => row.identity === 'AdminServer')?.changes.map((change) => change.path), [
    'listenPort',
  ])
})

test('domain config local storage keeps newest bounded snapshots', () => {
  const storage = new MemoryStorage()
  for (let index = 0; index < DOMAIN_CONFIG_SNAPSHOT_LIMIT + 2; index += 1) {
    writeStoredDomainConfigSnapshot(snapshot(String(index), []), storage)
  }

  const stored = readStoredDomainConfigSnapshotsForScope(creds, storage)
  assert.equal(stored.length, DOMAIN_CONFIG_SNAPSHOT_LIMIT)
  assert.equal(stored[0]?.manifest.id, String(DOMAIN_CONFIG_SNAPSHOT_LIMIT + 1))
  assert.equal(stored.at(-1)?.manifest.id, '2')
})

test('domain config local storage filters snapshots by target profile and version scope', () => {
  const storage = new MemoryStorage()
  writeStoredDomainConfigSnapshot(snapshot('lab', []), storage)
  writeStoredDomainConfigSnapshot(snapshot('prod', [], { profileId: 'profile-prod', targetUrl: 'http://prod.example.com:7001' }), storage)
  writeStoredDomainConfigSnapshot(snapshot('old-version', [], { version: '12.2.1.4.0' }), storage)

  assert.deepEqual(readStoredDomainConfigSnapshots(storage).map((entry) => entry.manifest.id), [
    'old-version',
    'prod',
    'lab',
  ])
  assert.deepEqual(readStoredDomainConfigSnapshotsForScope(creds, storage).map((entry) => entry.manifest.id), ['lab'])
})

test('domain config local storage degrades retention when quota is exceeded', () => {
  const storage = new QuotaStorage(5)
  for (let index = 0; index < 12; index += 1) {
    writeStoredDomainConfigSnapshot(snapshot(String(index), []), storage)
  }

  const result = writeStoredDomainConfigSnapshot(snapshot('latest', []), storage)
  assert.equal(result.storageLimited, true)
  assert.equal(result.retainedScopeLimit, 5)
  assert.deepEqual(result.snapshots.map((entry) => entry.manifest.id), ['latest', '11', '10', '9', '8'])
})

test('domain config snapshot filenames are sanitized', () => {
  assert.match(domainConfigSnapshotFilename(snapshot('1', [])), /^wls-config-snapshot-wls-admin\.example\.com-7001-/)
})
