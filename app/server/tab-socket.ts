import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { TAB_PRESENCE_PATH } from '../src/api/tab-presence-contract.ts'
import { isTabId, type TabPresence } from './tab-presence.ts'

// The WebSocket each Cockpit tab keeps open (see tab-presence.ts). Nothing travels over it: the
// handshake registers the tab and the end of the connection unregisters it, which the browser
// does by itself when the tab closes. Only the handshake and the client's close frame are handled,
// so no WebSocket library is needed.
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const CLOSE_OPCODE = 0x8

function reject(socket: Duplex, status: string) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function headerValue(req: IncomingMessage, name: string) {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export function tabSocketAccept(key: string) {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64')
}

// hostAllowed comes from the same Host check as every other request. The Origin must be this
// Cockpit too, so another web page cannot keep Cockpit running by holding a socket open.
export function acceptTabSocket(
  req: IncomingMessage,
  socket: Duplex,
  presence: TabPresence,
  hostAllowed: boolean,
  sockets: Set<Duplex>,
) {
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
  } catch {
    reject(socket, '400 Bad Request')
    return
  }
  if (url.pathname !== TAB_PRESENCE_PATH) {
    reject(socket, '404 Not Found')
    return
  }
  const host = headerValue(req, 'host')
  const origin = headerValue(req, 'origin')
  if (!hostAllowed || (origin !== undefined && origin !== `http://${host}` && origin !== `https://${host}`)) {
    reject(socket, '403 Forbidden')
    return
  }
  const id = url.searchParams.get('id') ?? ''
  const key = headerValue(req, 'sec-websocket-key')
  if (
    !isTabId(id) ||
    !key ||
    headerValue(req, 'upgrade')?.toLowerCase() !== 'websocket' ||
    headerValue(req, 'sec-websocket-version') !== '13'
  ) {
    reject(socket, '400 Bad Request')
    return
  }

  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${tabSocketAccept(key)}\r\n\r\n`,
  )
  // Notices a peer that vanished without closing (a laptop that slept), and does not keep the
  // process alive on its own: the CLI exits when the server stops.
  ;(socket as Partial<Socket>).setKeepAlive?.(true, 30_000)
  ;(socket as Partial<Socket>).unref?.()
  sockets.add(socket)
  presence.connect(id)
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    sockets.delete(socket)
    presence.disconnect(id)
  }
  socket.on('close', end)
  // The HTTP server's sockets allow half-open connections: when the browser drops its side,
  // only 'end' arrives until this side closes too.
  socket.on('end', () => {
    end()
    socket.destroy()
  })
  socket.on('error', () => socket.destroy())
  socket.on('data', (chunk: Buffer) => {
    // A clean close from the browser: answer with a close frame and end the connection.
    if (chunk.length > 0 && (chunk[0] & 0x0f) === CLOSE_OPCODE) socket.end(Buffer.from([0x80 | CLOSE_OPCODE, 0x00]))
  })
}
