import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { parseCliArgs } from '../server/cli.ts'
import { createCockpitServer } from '../server/http.ts'
import { TabPresence, parseTabPresenceMessage } from '../server/tab-presence.ts'
import { startTabPresence } from '../src/api/tab-presence.ts'
import { TAB_PRESENCE_PATH } from '../src/api/tab-presence-contract.ts'

function fakeClock() {
  let now = 0
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = []
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      const timer = { at: now + ms, callback, cancelled: false }
      timers.push(timer)
      return { cancel: () => { timer.cancelled = true } }
    },
    // Fires due timers in time order, including ones scheduled by earlier callbacks.
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = timers.filter((timer) => !timer.cancelled && timer.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        due.cancelled = true
        due.callback()
      }
      now = target
    },
  }
}

test('tab presence messages need a tab id and a known event', () => {
  assert.deepEqual(parseTabPresenceMessage('{"id":"abcdef12-3456","event":"open"}'), { id: 'abcdef12-3456', event: 'open' })
  assert.equal(parseTabPresenceMessage('{"id":"x","event":"open"}'), null)
  assert.equal(parseTabPresenceMessage('{"id":"abcdef12-3456","event":"quit"}'), null)
  assert.equal(parseTabPresenceMessage('nope'), null)
})

test('Cockpit stops once the last tab closes and the grace period passes', () => {
  const clock = fakeClock()
  let stopped = 0
  const presence = new TabPresence({ onLastTabClosed: () => { stopped += 1 }, graceMs: 10_000, staleMs: 600_000, ...clock })
  presence.record('tab-aaaaaaaa', 'open')
  presence.record('tab-bbbbbbbb', 'open')
  presence.record('tab-aaaaaaaa', 'close')
  clock.advance(20_000)
  assert.equal(stopped, 0)
  presence.record('tab-bbbbbbbb', 'close')
  clock.advance(5_000)
  presence.record('tab-cccccccc', 'open')
  clock.advance(20_000)
  assert.equal(stopped, 0, 'a reload within the grace period keeps Cockpit running')
  presence.record('tab-cccccccc', 'close')
  clock.advance(10_000)
  assert.equal(stopped, 1)
})

test('tabs that stop sending heartbeats count as closed', () => {
  const clock = fakeClock()
  let stopped = 0
  const presence = new TabPresence({ onLastTabClosed: () => { stopped += 1 }, graceMs: 10_000, staleMs: 600_000, ...clock })
  presence.record('tab-aaaaaaaa', 'open')
  for (let minute = 0; minute < 20; minute += 1) {
    clock.advance(60_000)
    presence.record('tab-aaaaaaaa', 'heartbeat')
  }
  assert.equal(stopped, 0, 'a background tab beating once a minute stays open')
  clock.advance(600_000 + 150_000 + 10_000)
  assert.equal(stopped, 1)
})

test('nothing stops Cockpit before the first tab connects', () => {
  const clock = fakeClock()
  let stopped = 0
  const presence = new TabPresence({ onLastTabClosed: () => { stopped += 1 }, ...clock })
  presence.record('tab-aaaaaaaa', 'close')
  clock.advance(3_600_000)
  assert.equal(stopped, 0)
})

test('the CLI flag and the server endpoint stop Cockpit with its last tab', async (t) => {
  const parsed = parseCliArgs(['--exit-with-last-tab'], {})
  assert.ok(parsed.ok && parsed.value.exitWithLastTab)
  const plain = parseCliArgs([], {})
  assert.ok(plain.ok && !plain.value.exitWithLastTab)

  let stopped = 0
  const cockpit = createCockpitServer({
    defaultVersion: '14.1.2.0.0',
    onShutdownRequest: () => { stopped += 1 },
    exitWithLastTab: true,
    tabPresenceTiming: { graceMs: 30 },
  })
  t.after(() => cockpit.close())
  await new Promise<void>((resolve) => cockpit.listen(0, '127.0.0.1', resolve))
  const address = cockpit.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  const url = `http://127.0.0.1:${address.port}${TAB_PRESENCE_PATH}`

  const config = await (await fetch(`http://127.0.0.1:${address.port}/__wls-cockpit/runtime-config`)).json()
  assert.equal(config.exitWithLastTab, true)
  assert.equal((await fetch(url, { method: 'POST', body: '{"id":"tab-aaaaaaaa","event":"open"}' })).status, 204)
  assert.equal((await fetch(url, { method: 'POST', body: '{"id":"tab-aaaaaaaa","event":"close"}' })).status, 204)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(stopped, 1)
})

test('without the flag the endpoint is off and the browser is not asked to report', async (t) => {
  const cockpit = createCockpitServer({ defaultVersion: '14.1.2.0.0', onShutdownRequest: () => undefined })
  t.after(() => cockpit.close())
  const listener = createServer()
  listener.close()
  await new Promise<void>((resolve) => cockpit.listen(0, '127.0.0.1', resolve))
  const address = cockpit.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  const base = `http://127.0.0.1:${address.port}`
  assert.equal((await (await fetch(`${base}/__wls-cockpit/runtime-config`)).json()).exitWithLastTab, false)
  assert.equal((await fetch(`${base}${TAB_PRESENCE_PATH}`, { method: 'POST', body: '{"id":"tab-aaaaaaaa","event":"open"}' })).status, 404)
})

test('the browser reports open, heartbeats and a close beacon on pagehide', () => {
  const sent: string[] = []
  const beacons: string[] = []
  const listeners: Record<string, (event: PageTransitionEvent) => void> = {}
  let heartbeat: (() => void) | null = null
  startTabPresence({
    fetch: (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).event)
      return new Response(null, { status: 204 })
    }) as typeof fetch,
    sendBeacon: (_url, data) => {
      beacons.push(JSON.parse(data).event)
      return true
    },
    addEventListener: (type, listener) => {
      listeners[type] = listener
    },
    setInterval: (callback) => {
      heartbeat = callback
      return 1
    },
    randomId: () => 'tab-aaaaaaaa',
  })
  ;(heartbeat as (() => void) | null)?.()
  listeners.pagehide?.({ persisted: false } as PageTransitionEvent)
  listeners.pageshow?.({ persisted: true } as PageTransitionEvent)
  assert.deepEqual(sent, ['open', 'heartbeat', 'open'])
  assert.deepEqual(beacons, ['close'])
})
