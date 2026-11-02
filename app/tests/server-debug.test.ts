import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SERVER_DEBUG_GROUPS,
  normalizeServerDebug,
  serverDebugFlagLabel,
  serverDebugPatch,
  updateServerDebugFlags,
} from '../src/api/queries/server-debug.ts'
import { debugChangeSummary, debugFlagsEditable } from '../src/routes/server-debug-model.ts'

const creds = { profileId: 'p', name: 'lab', targetUrl: 'http://127.0.0.1:7001', username: 'weblogic', password: 'x', version: '14.1.2.0.0' as const }

test('debug snapshot keeps boolean debug attributes and says whether debug reaches the log', () => {
  const snapshot = normalizeServerDebug(
    'server1',
    { name: 'server1', debugJDBCSQL: true, debugSecurityAtn: false, debugScopes: [], identity: ['servers'] },
    { loggerSeverity: 'Info' },
  )
  assert.deepEqual(snapshot.flags, { debugJDBCSQL: true, debugSecurityAtn: false })
  assert.deepEqual(snapshot.enabled, ['debugJDBCSQL'])
  assert.equal(snapshot.debugReachesLog, false)
  assert.equal(normalizeServerDebug('s', {}, { loggerSeverity: 'Debug' }).debugReachesLog, true)
  assert.equal(normalizeServerDebug('s', {}, null).debugReachesLog, null)
})

test('debug changes only send reported attributes whose value changes', () => {
  const snapshot = normalizeServerDebug('server1', { debugJDBCSQL: true, debugSecurityAtn: false }, null)
  assert.deepEqual(serverDebugPatch(snapshot, { debugJDBCSQL: true, debugSecurityAtn: true, debugMadeUp: true }), { debugSecurityAtn: true })
  assert.equal(serverDebugFlagLabel('debugJDBCSQL'), 'SQL')
  assert.equal(serverDebugFlagLabel('debugJMSCDS'), 'JMSCDS')
  assert.equal(debugChangeSummary({ debugJDBCSQL: false }), 'SQL off')
})

test('curated debug flags have unique attribute names', () => {
  const attributes = SERVER_DEBUG_GROUPS.flatMap((group) => group.flags.map((flag) => flag.attribute))
  assert.equal(new Set(attributes).size, attributes.length)
  assert.ok(attributes.every((attribute) => /^debug[A-Z0-9]/.test(attribute)))
})

test('debug flags are not editable in demo read-only mode', () => {
  const snapshot = normalizeServerDebug('server1', { debugJDBCSQL: false }, null)
  assert.equal(debugFlagsEditable(snapshot), true)
  assert.equal(debugFlagsEditable(snapshot, { readOnlyDemoMode: true }), false)
  assert.equal(debugFlagsEditable(null), false)
})

test('applying debug flags posts the patch inside an edit session', async (t) => {
  const calls: Array<{ url: string; body: unknown }> = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
    return new Response('{}', { status: 200 })
  })
  const snapshot = normalizeServerDebug('server 1', { debugJDBCSQL: false }, null)
  await updateServerDebugFlags(creds, snapshot, { debugJDBCSQL: true })
  assert.deepEqual(
    calls.map((call) => call.url.replace('/api/wls/management/weblogic/14.1.2.0.0', '')),
    ['/edit/changeManager/startEdit', '/edit/servers/server%201/serverDebug', '/edit/changeManager/activate'],
  )
  assert.deepEqual(calls[1]?.body, { debugJDBCSQL: true })
  await assert.rejects(() => updateServerDebugFlags(creds, snapshot, { debugJDBCSQL: false }), /No debug flag changes/)
})
