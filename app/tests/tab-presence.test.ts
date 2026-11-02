import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
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

function fakeBrowser() {
  const sent: string[] = []
  const beacons: string[] = []
  const listeners: Record<string, (event: PageTransitionEvent) => void> = {}
  const sockets: Array<{ url: string; closed: boolean; open: () => void; drop: () => void }> = []
  const timeouts: Array<{ callback: () => void; ms: number }> = []
  let heartbeat: (() => void) | null = null
  const environment = {
    fetch: (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).event)
      return new Response(null, { status: 204 })
    }) as typeof fetch,
    sendBeacon: (_url: string, data: string) => {
      beacons.push(JSON.parse(data).event)
      return true
    },
    addEventListener: (type: 'pagehide' | 'pageshow', listener: (event: PageTransitionEvent) => void) => {
      listeners[type] = listener
    },
    setInterval: (callback: () => void) => {
      heartbeat = callback
      return 1
    },
    setTimeout: (callback: () => void, ms: number) => {
      timeouts.push({ callback, ms })
      return 1
    },
    openSocket: (url: string, handlers: { onOpen: () => void; onDrop: () => void }) => {
      const socket = { url, closed: false, open: handlers.onOpen, drop: handlers.onDrop }
      sockets.push(socket)
      return { close: () => { socket.closed = true } }
    },
    socketUrl: (path: string) => `ws://127.0.0.1:8888${path}`,
    randomId: () => 'tab-aaaaaaaa',
  }
  return { environment, sent, beacons, listeners, sockets, timeouts, heartbeat: () => (heartbeat as (() => void) | null)?.() }
}

test('the browser keeps a socket open, reports open and heartbeats, and closes both on pagehide', () => {
  const browser = fakeBrowser()
  startTabPresence(browser.environment)
  assert.deepEqual(browser.sockets.map((socket) => socket.url), [`ws://127.0.0.1:8888${TAB_PRESENCE_PATH}?id=tab-aaaaaaaa`])
  browser.heartbeat()
  browser.listeners.pagehide?.({ persisted: false } as PageTransitionEvent)
  assert.equal(browser.sockets[0].closed, true)
  browser.listeners.pageshow?.({ persisted: true } as PageTransitionEvent)
  assert.deepEqual(browser.sent, ['open', 'heartbeat', 'open'])
  assert.deepEqual(browser.beacons, ['close'])
  assert.equal(browser.sockets.length, 2)
})

test('a socket that drops while the tab lives is opened again, backing off until it connects', () => {
  const browser = fakeBrowser()
  startTabPresence(browser.environment)
  browser.sockets[0].drop()
  browser.timeouts.shift()?.callback()
  browser.sockets[1].drop()
  assert.deepEqual(browser.timeouts.map((timeout) => timeout.ms), [2_000])
  browser.timeouts.shift()?.callback()
  browser.sockets[2].open()
  browser.sockets[2].drop()
  assert.deepEqual(browser.timeouts.map((timeout) => timeout.ms), [1_000])
  assert.equal(browser.sockets.length, 3)

  // After pagehide nothing reconnects.
  browser.listeners.pagehide?.({ persisted: false } as PageTransitionEvent)
  browser.timeouts.shift()?.callback()
  assert.equal(browser.sockets.length, 3)
})

test('an open connection keeps its tab: no stale sweep, and a stray close beacon is ignored', () => {
  const clock = fakeClock()
  let stopped = 0
  const presence = new TabPresence({ onLastTabClosed: () => { stopped += 1 }, graceMs: 10, staleMs: 100, ...clock })
  presence.connect('tab-aaaaaaaa')
  presence.connect('tab-aaaaaaaa')
  presence.record('tab-aaaaaaaa', 'close')
  clock.advance(1_000)
  assert.equal(presence.openTabs, 1)
  presence.disconnect('tab-aaaaaaaa')
  clock.advance(1_000)
  assert.equal(stopped, 0)
  presence.disconnect('tab-aaaaaaaa')
  assert.equal(presence.openTabs, 0)
  clock.advance(10)
  assert.equal(stopped, 1)
})

async function socketServer(t: { after: (fn: () => void) => void }, exitWithLastTab = true) {
  let stopped = 0
  const cockpit = createCockpitServer({
    defaultVersion: '14.1.2.0.0',
    onShutdownRequest: () => { stopped += 1 },
    exitWithLastTab,
    tabPresenceTiming: { graceMs: 30 },
  })
  t.after(() => cockpit.close())
  await new Promise<void>((resolve) => cockpit.listen(0, '127.0.0.1', resolve))
  const address = cockpit.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  return { port: address.port, stopped: () => stopped }
}

function rawHandshake(port: number, headers: Record<string, string>) {
  return new Promise<{ status: string; socket: import('node:net').Socket }>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [`GET ${TAB_PRESENCE_PATH}?id=tab-bbbbbbbb HTTP/1.1`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), '', '']
      socket.write(lines.join('\r\n'))
    })
    socket.once('data', (chunk) => resolve({ status: chunk.toString().split('\r\n')[0], socket }))
    socket.once('error', reject)
  })
}

const handshakeHeaders = (port: number, origin = `http://127.0.0.1:${port}`) => ({
  Host: `127.0.0.1:${port}`,
  Origin: origin,
  Upgrade: 'websocket',
  Connection: 'Upgrade',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version': '13',
})

test('closing the tab socket stops Cockpit, cleanly or by dropping the connection', async (t) => {
  const clean = await socketServer(t)
  const socket = new WebSocket(`ws://127.0.0.1:${clean.port}${TAB_PRESENCE_PATH}?id=tab-aaaaaaaa`)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(clean.stopped(), 0)
  socket.close()
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(clean.stopped(), 1)

  // A browser closing the tab may simply drop the TCP connection.
  const dropped = await socketServer(t)
  const raw = await rawHandshake(dropped.port, handshakeHeaders(dropped.port))
  assert.equal(raw.status, 'HTTP/1.1 101 Switching Protocols')
  raw.socket.destroy()
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(dropped.stopped(), 1)
})

test('the tab socket answers only this Cockpit, and only with the flag', async (t) => {
  const server = await socketServer(t)
  const foreign = await rawHandshake(server.port, handshakeHeaders(server.port, 'https://example.com'))
  assert.equal(foreign.status, 'HTTP/1.1 403 Forbidden')
  foreign.socket.destroy()

  const plain = await socketServer(t, false)
  const refused = await rawHandshake(plain.port, handshakeHeaders(plain.port))
  assert.equal(refused.status, 'HTTP/1.1 404 Not Found')
  refused.socket.destroy()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(server.stopped(), 0)
})
