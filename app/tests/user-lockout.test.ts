import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearUserLockout,
  normalizeUserLockoutRow,
  summarizeUserLockout,
  userLockoutPath,
} from '../src/api/queries/user-lockout.ts'

const creds = { profileId: 'p1', name: 'lab', targetUrl: 'http://127.0.0.1:7001', username: 'weblogic', password: 'secret', version: '14.1.2.0.0' as const }

test('user lockout reads the default realm lockout manager of one server', () => {
  assert.equal(
    userLockoutPath('14.1.2.0.0', 'server 1'),
    '/management/weblogic/14.1.2.0.0/domainRuntime/serverRuntimes/server%201/serverSecurityRuntime/defaultRealmRuntime/userLockoutManagerRuntime',
  )
})

test('user lockout rows keep counters and mark servers without data unavailable', () => {
  const row = normalizeUserLockoutRow('AdminServer', 'RUNNING', { lockedUsersCurrentCount: 2, userLockoutTotalCount: 5, invalidLoginAttemptsTotalCount: 'x' })
  assert.equal(row.available, true)
  assert.equal(row.lockedUsersCurrentCount, 2)
  assert.equal(row.userLockoutTotalCount, 5)
  assert.equal(row.invalidLoginAttemptsTotalCount, null)
  assert.equal(normalizeUserLockoutRow('server1', 'SHUTDOWN', null).available, false)
})

test('locked users are the highest per-server count, since cluster members share lockouts', () => {
  const rows = [
    normalizeUserLockoutRow('ms2', 'RUNNING', { lockedUsersCurrentCount: 1 }),
    normalizeUserLockoutRow('ms1', 'RUNNING', { lockedUsersCurrentCount: 1 }),
    normalizeUserLockoutRow('AdminServer', 'RUNNING', { lockedUsersCurrentCount: 0 }),
  ]
  const snapshot = summarizeUserLockout(rows, 1)
  assert.equal(snapshot.lockedUsersCurrentCount, 1)
  assert.deepEqual(snapshot.rows.map((row) => row.serverName), ['AdminServer', 'ms1', 'ms2'])
})

test('clearing a lockout posts the user name to every server and reports each result', async (t) => {
  const calls: Array<{ url: string; body: unknown; requestedBy: string | null; target: string | null }> = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    calls.push({
      url,
      body: JSON.parse(String(init.body)),
      requestedBy: headers.get('X-Requested-By'),
      target: headers.get('X-WLS-Cockpit-Target'),
    })
    if (url.includes('/ms1/')) return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 })
    return new Response(null, { status: 204 })
  })

  const results = await clearUserLockout(creds, '  integration ', ['AdminServer', 'ms1'])

  assert.deepEqual(calls.map((call) => call.body), [{ userName: 'integration' }, { userName: 'integration' }])
  assert.ok(calls.every((call) => call.url.endsWith('/userLockoutManagerRuntime/clearLockout') && call.requestedBy === 'wls-cockpit'))
  assert.ok(calls.every((call) => call.target === 'http://127.0.0.1:7001'))
  assert.deepEqual(results.map((result) => [result.serverName, result.ok]), [['AdminServer', true], ['ms1', false]])
  await assert.rejects(() => clearUserLockout(creds, '   ', ['AdminServer']), /user name/)
})
