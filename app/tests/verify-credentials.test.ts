import assert from 'node:assert/strict'
import test from 'node:test'
import type { WlsCredentials } from '../src/api/client.ts'
import { verifyWlsCredentials } from '../src/api/verify-credentials.ts'

const creds: WlsCredentials = {
  profileId: 'p1',
  name: 'Lab',
  targetUrl: 'http://wls-admin.example.com:7001',
  username: 'weblogic',
  password: 'unit-test-pass',
  version: '12.2.1.4.0',
}

function respond(status: number) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> })
    return new Response('{}', { status })
  }) as typeof fetch
  return { fetcher, calls }
}

test('credential check reads one bounded domainRuntime resource through the proxy', async () => {
  const { fetcher, calls } = respond(200)
  assert.deepEqual(await verifyWlsCredentials(creds, fetcher), { ok: true })
  assert.equal(calls[0].url, '/api/wls/management/weblogic/12.2.1.4.0/domainRuntime?fields=name&links=none')
  assert.match(calls[0].headers.Authorization, /^Basic /)
  assert.equal(calls[0].headers['X-WLS-Cockpit-Target'], 'http://wls-admin.example.com:7001')
})

test('credential check reports rejected credentials and unreachable servers apart', async () => {
  const unauthorized = await verifyWlsCredentials(creds, respond(401).fetcher)
  assert.equal(unauthorized.ok, false)
  if (!unauthorized.ok) assert.equal(unauthorized.reason, 'unauthorized')

  // 403 is a valid login without the role to read the domain runtime, not a wrong password.
  const forbidden = await verifyWlsCredentials(creds, respond(403).fetcher)
  assert.equal(forbidden.ok, false)
  if (!forbidden.ok) {
    assert.equal(forbidden.reason, 'unauthorized')
    assert.match(forbidden.message, /may not read the domain runtime/)
  }

  const notFound = await verifyWlsCredentials(creds, respond(404).fetcher)
  assert.equal(notFound.ok, false)
  if (!notFound.ok) {
    assert.equal(notFound.reason, 'unreachable')
    assert.match(notFound.message, /HTTP 404/)
  }

  const down = await verifyWlsCredentials(creds, (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch)
  assert.equal(down.ok, false)
  if (!down.ok) assert.equal(down.reason, 'unreachable')
})

test('a 502 from the local proxy is reported as an unreachable AdminServer, not as its reply', async () => {
  for (const status of [502, 504]) {
    const check = await verifyWlsCredentials(creds, respond(status).fetcher)
    assert.equal(check.ok, false)
    if (!check.ok) {
      assert.equal(check.reason, 'unreachable')
      assert.match(check.message, /^Could not reach http:\/\/wls-admin\.example\.com:7001\. /)
      assert.doesNotMatch(check.message, /answered HTTP/)
    }
  }
})
