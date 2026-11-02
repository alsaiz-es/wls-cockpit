// Reports this tab to the local server when Cockpit was started by double-click and stops with
// its last tab (server/tab-presence.ts): open on load and on return from the back-forward cache,
// a heartbeat while the tab lives, and close on pagehide.
import { TAB_PRESENCE_PATH } from './tab-presence-contract.ts'

export const TAB_HEARTBEAT_MS = 30_000

type PresenceEvent = 'open' | 'heartbeat' | 'close'

export interface TabPresenceEnvironment {
  fetch: typeof fetch
  sendBeacon: (url: string, data: string) => boolean
  addEventListener: (type: 'pagehide' | 'pageshow', listener: (event: PageTransitionEvent) => void) => void
  setInterval: (callback: () => void, ms: number) => unknown
  randomId: () => string
}

function browserEnvironment(): TabPresenceEnvironment {
  return {
    fetch: (...args) => fetch(...args),
    sendBeacon: (url, data) => navigator.sendBeacon(url, data),
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    randomId: () => crypto.randomUUID(),
  }
}

export function startTabPresence(environment: TabPresenceEnvironment = browserEnvironment()) {
  const id = environment.randomId()
  const body = (event: PresenceEvent) => JSON.stringify({ id, event })
  const send = (event: PresenceEvent) => {
    void environment
      .fetch(TAB_PRESENCE_PATH, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body(event), keepalive: true })
      .catch(() => undefined)
  }

  send('open')
  environment.setInterval(() => send('heartbeat'), TAB_HEARTBEAT_MS)
  environment.addEventListener('pagehide', () => {
    if (!environment.sendBeacon(TAB_PRESENCE_PATH, body('close'))) send('close')
  })
  environment.addEventListener('pageshow', (event) => {
    if (event.persisted) send('open')
  })
  return id
}
