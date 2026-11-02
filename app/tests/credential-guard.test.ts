import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { CredentialGuard, credentialKey } from '../server/credential-guard.ts'
import { createCockpitServer } from '../server/http.ts'
import { CREDENTIALS_REJECTED_HEADER, SIGN_IN_HEADER } from '../src/api/credential-guard-contract.ts'
import { installCredentialRejectionWatch, onCredentialsRejected, responseRejectsCredentials } from '../src/api/credential-rejection.ts'
import { WLS_TARGET_HEADER } from '../src/api/proxy-target.ts'

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  return `http://127.0.0.1:${address.port}`
}

test('credential keys depend on the target and the Authorization header', () => {
  assert.equal(credentialKey('http://a:7001', null), null)
  assert.notEqual(credentialKey('http://a:7001', 'Basic x'), credentialKey('http://b:7001', 'Basic x'))
  assert.doesNotMatch(credentialKey('http://a:7001', 'Basic secret') ?? '', /secret/)
})

test('only one request probes stale credentials; a 401 refuses the rest until sign-in succeeds', async () => {
  let now = 0
  const guard = new CredentialGuard(() => now)
  const probe = await guard.admit('k')
  assert.equal(probe.ok, true)
  let waiterAdmitted: boolean | null = null
  const waiter = guard.admit('k').then((admission) => {
    waiterAdmitted = admission.ok
    return admission
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(waiterAdmitted, null)
  if (probe.ok) probe.settle(401)
  await waiter
  assert.equal(waiterAdmitted, false)
  assert.equal(guard.isRejected('k'), true)

  const signIn = await guard.admit('k', true)
  assert.equal(signIn.ok, true)
  if (signIn.ok) signIn.settle(200)
  const fresh = await guard.admit('k')
  assert.equal(fresh.ok, true)
  if (fresh.ok) fresh.settle(200)

  now += 60_000
  const stale = await guard.admit('k')
  assert.equal(stale.ok, true)
  let next = false
  void guard.admit('k').then(() => {
    next = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(next, false)
  if (stale.ok) stale.settle(200)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(next, true)
})

test('a probe without an answer stops holding requests back', async () => {
  const guard = new CredentialGuard(Date.now, 20)
  const probe = await guard.admit('k')
  assert.equal(probe.ok, true)
  const waiter = await guard.admit('k')
  assert.equal(waiter.ok, true)
})

test('a burst with a rejected password reaches WebLogic once', async (t) => {
  let upstreamCalls = 0
  let acceptPassword = false
  const upstream = createServer((req, res) => {
    upstreamCalls += 1
    setTimeout(() => {
      res.statusCode = acceptPassword ? 200 : 401
      res.setHeader('Content-Type', 'application/json')
      res.end('{}')
    }, 20)
  })
  t.after(() => upstream.close())
  const upstreamUrl = await listen(upstream)
  const cockpit = createCockpitServer({ targetUrl: upstreamUrl, defaultVersion: '14.1.2.0.0', credentialGuard: new CredentialGuard() })
  t.after(() => cockpit.close())
  const cockpitUrl = await listen(cockpit)
  const headers = { Authorization: 'Basic d2VibG9naWM6b2xk', [WLS_TARGET_HEADER]: upstreamUrl }
  const url = `${cockpitUrl}/api/wls/management/weblogic/14.1.2.0.0/domainRuntime/serverLifeCycleRuntimes`

  const burst = await Promise.all(Array.from({ length: 10 }, () => fetch(url, { headers })))
  assert.equal(upstreamCalls, 1)
  assert.ok(burst.every((response) => response.status === 401 && response.headers.get(CREDENTIALS_REJECTED_HEADER) === '1'))

  const signIn = await fetch(url, { headers: { ...headers, [SIGN_IN_HEADER]: '1' } })
  assert.equal(signIn.status, 401)
  assert.equal(signIn.headers.get(CREDENTIALS_REJECTED_HEADER), null)
  assert.equal(upstreamCalls, 2)

  acceptPassword = true
  assert.equal((await fetch(url, { headers: { ...headers, [SIGN_IN_HEADER]: '1' } })).status, 200)
  assert.equal((await fetch(url, { headers })).status, 200)
  assert.equal(upstreamCalls, 4)
})

test('the browser hears about rejected credentials from any fetch', async () => {
  const scope = { fetch: async () => new Response('{}', { status: 401, headers: { [CREDENTIALS_REJECTED_HEADER]: '1' } }) } as unknown as { fetch: typeof fetch }
  let heard = 0
  const stop = onCredentialsRejected(() => {
    heard += 1
  })
  installCredentialRejectionWatch(scope)
  await scope.fetch('/api/wls/x')
  stop()
  assert.equal(heard, 1)
  assert.equal(responseRejectsCredentials(new Response(null, { status: 401 })), false)
})
