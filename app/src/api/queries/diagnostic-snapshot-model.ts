import type { WlsCredentials } from '../client.ts'

export const DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION = 1
export const DIAGNOSTIC_SNAPSHOT_MAX_TEXT_BYTES = 256 * 1024
export const DIAGNOSTIC_SNAPSHOT_MAX_LOG_SOURCES = 4

const SENSITIVE_KEY_PATTERN = /password|passphrase|credential|secret|token|authorization|cookie|privatekey|keystore|truststore/i
const PATH_KEY_PATTERN = /path|sourcePath|sourceFile|staging|upload|absolute|directory|dir|fileName$/i
const PAYLOAD_KEY_PATTERN = /body|payload|xml|bytes|heapdump|threadstackdump/i

export interface DiagnosticSnapshotManifestSection {
  id: string
  file: string | null
  status: 'included' | 'failed' | 'skipped'
  recordCount?: number
  error?: string
}

export interface DiagnosticSnapshotManifest {
  schemaVersion: number
  capturedAt: string
  target: string
  version: string
  profileId: string
  profileName: string
  username: string
  sections: DiagnosticSnapshotManifestSection[]
  redaction: {
    sensitiveFields: string
    filesystemPaths: string
    payloadFields: string
    maxTextBytes: number
  }
}

export interface DiagnosticSnapshotOptions {
  includeThreadDumps?: boolean
  threadDumpServers?: string[]
}

export interface DiagnosticSnapshotBundle {
  filename: string
  manifest: DiagnosticSnapshotManifest
  blob: Blob
}

export interface DiagnosticSnapshotFile {
  path: string
  text: string
}

export function diagnosticSnapshotTargetLabel(targetUrl: string) {
  try {
    const url = new URL(targetUrl)
    return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    return 'unknown'
  }
}

export function buildDiagnosticSnapshotManifest(
  creds: WlsCredentials,
  sections: DiagnosticSnapshotManifestSection[],
  capturedAt = new Date().toISOString(),
): DiagnosticSnapshotManifest {
  return {
    schemaVersion: DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION,
    capturedAt,
    target: diagnosticSnapshotTargetLabel(creds.targetUrl),
    version: creds.version,
    profileId: creds.profileId,
    profileName: creds.name,
    username: creds.username,
    sections,
    redaction: {
      sensitiveFields: 'password/credential/secret/token/authorization/cookie fields are redacted',
      filesystemPaths: 'known filesystem path fields and path-like string fragments are redacted',
      payloadFields: 'body/payload/xml/bytes/heapdump/threadStackDump fields are omitted or bounded',
      maxTextBytes: DIAGNOSTIC_SNAPSHOT_MAX_TEXT_BYTES,
    },
  }
}

export function safeDiagnosticSnapshotFilePart(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'snapshot'
}

export function truncateDiagnosticSnapshotText(value: string, maxBytes = DIAGNOSTIC_SNAPSHOT_MAX_TEXT_BYTES) {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maxBytes) return value
  return `${new TextDecoder().decode(encoded.slice(0, maxBytes))}\n[truncated by WLS Cockpit diagnostic snapshot]\n`
}

export function redactDiagnosticSnapshotString(value: string) {
  return value
    .replace(/https?:\/\/[^@\s/]+:[^@\s/]+@/gi, 'https://<credentials>@')
    .replace(/\b(password|credential|authorization|secret|token)=([^&\s]+)/gi, '$1=<redacted>')
    .replace(/(?:\/(?:Users|home|u01|oracle|domains|private|var|tmp|opt|app|weblogic)[^\s"',;)]*)/gi, '<path>')
    .replace(/[A-Za-z]:\\[^\s"',;)]+/g, '<path>')
}

export function redactDiagnosticSnapshotValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '<redacted>'
  if (PAYLOAD_KEY_PATTERN.test(key)) return '<omitted>'
  if (PATH_KEY_PATTERN.test(key)) {
    if (typeof value === 'string') return redactDiagnosticSnapshotString(value).replace(/^.+$/, '<path>')
    if (Array.isArray(value)) return value.map(() => '<path>')
  }

  if (typeof value === 'string') return truncateDiagnosticSnapshotText(redactDiagnosticSnapshotString(value))
  if (typeof value !== 'object' || value === null) return value
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([entryKey, entryValue]) => [
        String(entryKey),
        redactDiagnosticSnapshotValue(entryValue, String(entryKey)),
      ]),
    )
  }
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticSnapshotValue(item, key))

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactDiagnosticSnapshotValue(entryValue, entryKey),
    ]),
  )
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  bytes.forEach((byte) => {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  })
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

function writeUint16(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff)
}

function writeUint32(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

export function createStoredZip(files: DiagnosticSnapshotFile[]) {
  const encoder = new TextEncoder()
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0
  const { time, day } = dosDateTime()

  files.forEach((file) => {
    const name = encoder.encode(file.path)
    const data = encoder.encode(file.text)
    const crc = crc32(data)
    const local: number[] = []

    writeUint32(local, 0x04034b50)
    writeUint16(local, 20)
    writeUint16(local, 0x0800)
    writeUint16(local, 0)
    writeUint16(local, time)
    writeUint16(local, day)
    writeUint32(local, crc)
    writeUint32(local, data.byteLength)
    writeUint32(local, data.byteLength)
    writeUint16(local, name.byteLength)
    writeUint16(local, 0)
    const localHeader = new Uint8Array([...local, ...name])
    localParts.push(localHeader, data)

    const central: number[] = []
    writeUint32(central, 0x02014b50)
    writeUint16(central, 20)
    writeUint16(central, 20)
    writeUint16(central, 0x0800)
    writeUint16(central, 0)
    writeUint16(central, time)
    writeUint16(central, day)
    writeUint32(central, crc)
    writeUint32(central, data.byteLength)
    writeUint32(central, data.byteLength)
    writeUint16(central, name.byteLength)
    writeUint16(central, 0)
    writeUint16(central, 0)
    writeUint16(central, 0)
    writeUint16(central, 0)
    writeUint32(central, 0)
    writeUint32(central, offset)
    centralParts.push(new Uint8Array([...central, ...name]))

    offset += localHeader.byteLength + data.byteLength
  })

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0)
  const end: number[] = []
  writeUint32(end, 0x06054b50)
  writeUint16(end, 0)
  writeUint16(end, 0)
  writeUint16(end, files.length)
  writeUint16(end, files.length)
  writeUint32(end, centralSize)
  writeUint32(end, offset)
  writeUint16(end, 0)

  const parts = [...localParts, ...centralParts, new Uint8Array(end)].map((part) => new Uint8Array(part))
  return new Blob(parts, { type: 'application/zip' })
}
