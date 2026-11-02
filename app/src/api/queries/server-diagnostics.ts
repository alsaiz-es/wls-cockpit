import { createClient12, createClient14, type WlsCredentials } from '../client.ts'
import { createWlsHttpError, withWlsRestTimeout } from '../wls-errors.ts'

export interface ServerThreadDump {
  serverName: string
  capturedAt: number
  text: string
  lineCount: number
  bytes: number
}

export interface ServerHeapDumpUnsupported {
  supported: false
  reason: string
  // What the operator can do instead.
  howTo: string
  evidence: string[]
}

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function normalizeThreadDumpPayload(
  data: unknown,
  serverName: string,
  capturedAt = Date.now(),
): ServerThreadDump {
  const text = isObject(data) && typeof data.threadStackDump === 'string' ? data.threadStackDump : ''
  if (text.trim().length === 0) {
    throw new Error(`Thread dump ${serverName}: empty threadStackDump payload`)
  }

  return {
    serverName,
    capturedAt,
    text,
    lineCount: text.split(/\r\n|\r|\n/).length,
    bytes: new TextEncoder().encode(text).byteLength,
  }
}

export function threadDumpFilename(serverName: string, capturedAt: number) {
  const safeServer = serverName.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'server'
  const timestamp = new Date(capturedAt).toISOString().replace(/[:.]/g, '-')
  return `wls-thread-dump-${safeServer}-${timestamp}.txt`
}

export function serverHeapDumpSupport(version: string): ServerHeapDumpUnsupported {
  return {
    supported: false,
    reason: `Cockpit cannot take heap dumps: the REST API of WebLogic ${version} has no operation that captures one and hands it back to the browser.`,
    howTo: 'On the server host, run jcmd <pid> GC.heap_dump /path/to/dump.hprof as the WebLogic OS user, or use Java Mission Control.',
    evidence: [
      'JVMRuntime exposes GET metadata/thread dump fields; no POST heap dump operation is present in the pinned REST contract.',
      'WLDF heap dump action beans are edit/configuration resources, not one-shot runtime capture endpoints.',
      'HotSpotDiagnosticMXBean dumpHeap writes server-side files and no safe browser-readable artifact retrieval is verified.',
    ],
  }
}

export function canOfferHeapDumpCapture({
  lifecycleState,
  readOnlyDemoMode,
  support,
}: {
  lifecycleState: string | null | undefined
  readOnlyDemoMode: boolean
  support: ServerHeapDumpUnsupported
}) {
  return lifecycleState === 'RUNNING' && !readOnlyDemoMode && support.supported
}

export function shouldShowHeapDumpUnsupported({
  lifecycleState,
  readOnlyDemoMode,
  support,
}: {
  lifecycleState: string | null | undefined
  readOnlyDemoMode: boolean
  support: ServerHeapDumpUnsupported
}) {
  return lifecycleState === 'RUNNING' && !readOnlyDemoMode && !support.supported
}

export async function fetchServerThreadDump(creds: WlsCredentials, serverName: string) {
  const client = clientFor(creds)
  const res = await withWlsRestTimeout(`Thread dump ${serverName}`, (signal) =>
    client.GET('/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JVMRuntime', {
      signal,
      params: {
        path: { version: creds.version, serverName },
        query: {
          fields: 'threadStackDump',
          links: 'none',
        },
      },
    }),
  )

  if (res.error) {
    throw createWlsHttpError(`Thread dump ${serverName}`, res.response, res.error)
  }

  return normalizeThreadDumpPayload(res.data, serverName)
}
