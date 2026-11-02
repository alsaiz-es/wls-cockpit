import assert from 'node:assert/strict'
import test from 'node:test'
import { wlsCredentialCacheKey, type WlsCredentials } from '../src/api/client.ts'
import {
  WLS_TARGET_HEADER,
  normalizeWlsTarget,
  requireNormalizedWlsTarget,
} from '../src/api/proxy-target.ts'
import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  CONNECTION_PROFILES_STORAGE_KEY,
  LEGACY_CREDENTIAL_STORAGE_KEY,
  activeConnectionFromProfile,
  clearActiveConnectionSession,
  createConnectionProfile,
  listConnectionProfiles,
  persistConnectionProfileCatalog,
  readActiveConnectionSession,
  seedDefaultConnectionProfile,
  syncConnectionProfileCatalog,
  updateConnectionProfile,
  writeActiveConnectionSession,
  type ConnectionProfile,
  type StorageArea,
} from '../src/auth/connection-profiles.ts'

class MemoryStorage implements StorageArea {
  values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }
}

function sampleProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'profile-a',
    name: 'Lab domain',
    targetUrl: 'http://wls-admin.example.com:7001',
    version: '14.1.2.0.0',
    username: 'admin',
    ...overrides,
  }
}

function sampleCreds(overrides: Partial<WlsCredentials> = {}): WlsCredentials {
  return {
    profileId: 'profile-a',
    name: 'Lab domain',
    targetUrl: 'http://wls-admin.example.com:7001',
    username: 'admin',
    password: 'secret-pass',
    version: '14.1.2.0.0',
    ...overrides,
  }
}

test('normalizes origin targets and rejects unsafe proxy targets', () => {
  assert.deepEqual(normalizeWlsTarget('http://wls-admin.example.com:7001'), {
    ok: true,
    targetUrl: 'http://wls-admin.example.com:7001',
    host: 'wls-admin.example.com',
    port: 7001,
    protocol: 'http:',
  })
  assert.deepEqual(normalizeWlsTarget('https://wls-admin.example.com'), {
    ok: true,
    targetUrl: 'https://wls-admin.example.com',
    host: 'wls-admin.example.com',
    port: 443,
    protocol: 'https:',
  })
  assert.equal(normalizeWlsTarget('ftp://wls-admin.example.com').ok, false)
  assert.equal(normalizeWlsTarget('http://user:pass@wls-admin.example.com:7001').ok, false)
  assert.equal(normalizeWlsTarget('http://wls-admin.example.com:7001/console').ok, false)
  assert.equal(normalizeWlsTarget('http://wls-admin.example.com:7001?x=1').ok, false)
  assert.equal(normalizeWlsTarget('http://wls-admin.example.com:7001#top').ok, false)
})

test('proxy routing requires already-normalized active target metadata', () => {
  assert.equal(WLS_TARGET_HEADER, 'X-WLS-Cockpit-Target')
  assert.equal(requireNormalizedWlsTarget('http://wls-admin.example.com:7001').ok, true)
  assert.equal(requireNormalizedWlsTarget('http://wls-admin.example.com:7001/').ok, false)
})

test('profile catalog persists normalized profiles without passwords', () => {
  const storage = new MemoryStorage()
  const result = createConnectionProfile(
    {
      name: 'Lab domain',
      targetUrl: 'http://wls-admin.example.com:7001/',
      version: '14.1.2.0.0',
      username: 'admin',
    },
    storage,
  )

  assert.equal(result.ok, true)
  const profiles = listConnectionProfiles(storage)
  assert.equal(profiles.length, 1)
  assert.equal(profiles[0].targetUrl, 'http://wls-admin.example.com:7001')

  const raw = storage.getItem(CONNECTION_PROFILES_STORAGE_KEY) ?? ''
  assert.doesNotMatch(raw, /password/i)
  assert.doesNotMatch(raw, /secret-pass/)
})

test('profile catalog supports updates and explicit default seed', () => {
  const storage = new MemoryStorage()
  const seeded = seedDefaultConnectionProfile('http://localhost:7001/', '12.2.1.4.0', storage)
  assert.equal(seeded.length, 1)
  assert.equal(seeded[0].targetUrl, 'http://localhost:7001')
  assert.equal(seeded[0].version, '12.2.1.4.0')

  const updated = updateConnectionProfile(
    seeded[0].id,
    {
      name: 'Updated lab',
      targetUrl: 'https://wls-admin.example.com',
      version: '14.1.2.0.0',
      username: '',
    },
    storage,
  )
  assert.equal(updated.ok, true)
  const profiles = listConnectionProfiles(storage)
  assert.equal(profiles[0].name, 'Updated lab')
  assert.equal(profiles[0].targetUrl, 'https://wls-admin.example.com')
  assert.equal(profiles[0].username, undefined)
})

test('profile catalog remains empty without explicit default target', () => {
  const storage = new MemoryStorage()
  const seeded = seedDefaultConnectionProfile(undefined, '12.2.1.4.0', storage)
  assert.deepEqual(seeded, [])
  assert.deepEqual(listConnectionProfiles(storage), [])
})

test('profile catalog sync merges self-host catalog across browser origins', async () => {
  const storage = new MemoryStorage()
  const requests: Array<{ method: string; body: string }> = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    const method = init?.method ?? 'GET'
    requests.push({ method, body: typeof init?.body === 'string' ? init.body : '' })
    if (method === 'GET') {
      return new Response(
        JSON.stringify({
          profiles: [
            {
              id: 'profile-a',
              name: 'Remote lab',
              targetUrl: 'http://wls-admin.example.com:7001',
              version: '14.1.2.0.0',
              username: 'admin',
              password: 'must-not-load',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(init?.body ?? JSON.stringify({ profiles: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const synced = await syncConnectionProfileCatalog(undefined, '14.1.2.0.0', {
    serverCatalogAvailable: true,
    storage,
    fetchImpl,
  })

  assert.equal(synced.length, 1)
  assert.equal(synced[0].targetUrl, 'http://wls-admin.example.com:7001')
  assert.doesNotMatch(storage.getItem(CONNECTION_PROFILES_STORAGE_KEY) ?? '', /must-not-load|password/i)
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'PUT'])
})

test('profile catalog persistence writes local fallback and self-host catalog without passwords', async () => {
  const storage = new MemoryStorage()
  let putBody = ''
  const fetchImpl: typeof fetch = async (_input, init) => {
    putBody = typeof init?.body === 'string' ? init.body : ''
    return new Response(putBody, { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  await persistConnectionProfileCatalog([sampleProfile()], {
    serverCatalogAvailable: true,
    storage,
    fetchImpl,
  })

  assert.match(storage.getItem(CONNECTION_PROFILES_STORAGE_KEY) ?? '', /Remote|Lab domain|wls-admin/)
  assert.match(putBody, /wls-admin\.example\.com/)
  assert.doesNotMatch(putBody, /secret-pass|password/i)
})

test('active session persists password only in session storage', () => {
  const localStorage = new MemoryStorage()
  const sessionStorage = new MemoryStorage()
  const profile = sampleProfile()

  createConnectionProfile(profile, localStorage)
  const active = activeConnectionFromProfile({ profile, username: 'admin', password: 'secret-pass' })
  assert.equal(active.ok, true)
  if (!active.ok) throw new Error('expected active connection')

  writeActiveConnectionSession(active.value, sessionStorage)
  assert.match(sessionStorage.getItem(ACTIVE_CONNECTION_STORAGE_KEY) ?? '', /secret-pass/)
  assert.doesNotMatch(localStorage.getItem(CONNECTION_PROFILES_STORAGE_KEY) ?? '', /secret-pass/)

  const restored = readActiveConnectionSession(sessionStorage)
  assert.deepEqual(restored, active.value)
  clearActiveConnectionSession(sessionStorage)
  assert.equal(readActiveConnectionSession(sessionStorage), null)
})

test('legacy credential session is discarded instead of replayed against the current target', () => {
  const storage = new MemoryStorage()
  storage.setItem(
    LEGACY_CREDENTIAL_STORAGE_KEY,
    JSON.stringify({ username: 'admin', password: 'secret-pass', version: '12.2.1.4.0' }),
  )

  // The blob never recorded which domain the password was for; the server may now be started
  // with a different --target, so restoring it would send domain A's password to domain B.
  assert.equal(readActiveConnectionSession(storage), null)
  assert.equal(storage.getItem(LEGACY_CREDENTIAL_STORAGE_KEY), null)
})

test('query cache keys separate same credentials on different domains', () => {
  const first = wlsCredentialCacheKey(sampleCreds({ profileId: 'profile-a', targetUrl: 'http://one.example.com:7001' }))
  const second = wlsCredentialCacheKey(sampleCreds({ profileId: 'profile-b', targetUrl: 'http://two.example.com:7001' }))

  assert.notEqual(first, second)
  assert.doesNotMatch(first, /secret-pass/)
  assert.doesNotMatch(second, /secret-pass/)
})
