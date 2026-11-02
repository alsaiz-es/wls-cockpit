// Reports this tab to the local server when Cockpit was started by double-click and stops with
// its last tab (server/tab-presence.ts). The tab keeps a WebSocket open while it lives; the
// browser closes it with the tab, which is what the server relies on. Open, heartbeat and a close
// beacon on pagehide are still sent as a fallback for a socket that cannot be opened.
import { TAB_PRESENCE_PATH } from './tab-presence-contract.ts'

export const TAB_HEARTBEAT_MS = 30_000
// A socket that drops while the tab lives (the laptop slept, the network stack reset) is opened
// again, quickly first and then less often, well inside the server's grace period.
export const TAB_SOCKET_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 60_000]

type PresenceEvent = 'open' | 'heartbeat' | 'close'

export interface TabPresenceSocket {
  close: () => void
}

export interface TabPresenceEnvironment {
  fetch: typeof fetch
  sendBeacon: (url: string, data: string) => boolean
  addEventListener: (type: 'pagehide' | 'pageshow', listener: (event: PageTransitionEvent) => void) => void
  setInterval: (callback: () => void, ms: number) => unknown
  setTimeout: (callback: () => void, ms: number) => unknown
  // Opens the presence socket; onDrop runs when it closes or fails without us closing it.
  openSocket: (url: string, handlers: { onOpen: () => void; onDrop: () => void }) => TabPresenceSocket
  socketUrl: (path: string) => string
  randomId: () => string
}

function browserEnvironment(): TabPresenceEnvironment {
  return {
    fetch: (...args) => fetch(...args),
    sendBeacon: (url, data) => navigator.sendBeacon(url, data),
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    openSocket: (url, { onOpen, onDrop }) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', onOpen)
      socket.addEventListener('close', onDrop)
      return {
        close: () => {
          socket.removeEventListener('close', onDrop)
          socket.close()
        },
      }
    },
    socketUrl: (path) => `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${path}`,
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

  const socketUrl = environment.socketUrl(`${TAB_PRESENCE_PATH}?id=${encodeURIComponent(id)}`)
  let socket: TabPresenceSocket | null = null
  let hidden = false
  let retries = 0
  const openSocket = () => {
    socket = environment.openSocket(socketUrl, {
      onOpen: () => {
        retries = 0
      },
      onDrop: () => {
        socket = null
        if (hidden) return
        const delay = TAB_SOCKET_RETRY_MS[Math.min(retries, TAB_SOCKET_RETRY_MS.length - 1)]
        retries += 1
        environment.setTimeout(() => {
          if (!hidden && !socket) openSocket()
        }, delay)
      },
    })
  }
  const closeSocket = () => {
    socket?.close()
    socket = null
  }

  send('open')
  openSocket()
  environment.setInterval(() => send('heartbeat'), TAB_HEARTBEAT_MS)
  environment.addEventListener('pagehide', () => {
    hidden = true
    closeSocket()
    if (!environment.sendBeacon(TAB_PRESENCE_PATH, body('close'))) send('close')
  })
  environment.addEventListener('pageshow', (event) => {
    if (!event.persisted) return
    hidden = false
    retries = 0
    send('open')
    if (!socket) openSocket()
  })
  return id
}
