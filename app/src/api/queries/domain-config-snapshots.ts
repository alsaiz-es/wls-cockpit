import { createClient12, createClient14, type WlsCredentials } from '../client.ts'
import { createWlsHttpError, withWlsRestTimeout } from '../wls-errors.ts'

export const DOMAIN_CONFIG_SNAPSHOT_SCHEMA_VERSION = 1
export const DOMAIN_CONFIG_SNAPSHOT_STORAGE_KEY = 'wls-cockpit:domain-config-snapshots:v1'
export const DOMAIN_CONFIG_SNAPSHOT_LIMIT = 20
const DOMAIN_CONFIG_SNAPSHOT_SCOPE_LIMIT_ATTEMPTS = [20, 10, 5, 1] as const
const DOMAIN_CONFIG_SNAPSHOT_CAPTURE_TIMEOUT_MS = 45_000

export type DomainConfigFamily = 'servers' | 'clusters' | 'dataSources' | 'deployments' | 'jms'
export type DomainConfigDiffKind = 'added' | 'removed' | 'changed'

export interface DomainConfigResource {
  family: DomainConfigFamily
  identity: string
  data: unknown
}

export interface DomainConfigSnapshotSection {
  family: DomainConfigFamily | string
  status: 'included' | 'failed' | 'unsupported'
  recordCount: number
  error?: string
  reason?: string
}

export interface DomainConfigSnapshotManifest {
  schemaVersion: number
  id: string
  capturedAt: string
  target: string
  version: string
  profileId: string
  profileName: string
  username: string
  sections: DomainConfigSnapshotSection[]
  redaction: {
    sensitiveFields: string
    filesystemPaths: string
    unsupportedFamilies: string
  }
}

export interface DomainConfigSnapshot {
  manifest: DomainConfigSnapshotManifest
  resources: DomainConfigResource[]
}

export interface DomainConfigDiffField {
  path: string
  before: unknown
  after: unknown
}

export interface DomainConfigDiffResource {
  family: DomainConfigFamily
  identity: string
  kind: DomainConfigDiffKind
  changes: DomainConfigDiffField[]
}

export interface DomainConfigDiff {
  beforeId: string
  afterId: string
  resources: DomainConfigDiffResource[]
}

export interface DomainConfigSnapshotWriteResult {
  snapshots: DomainConfigSnapshot[]
  storageLimited: boolean
  retainedScopeLimit: number
}

interface StoredSnapshotEnvelope {
  snapshots: DomainConfigSnapshot[]
}

export interface StorageArea {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const SENSITIVE_KEY_PATTERN =
  /password|passphrase|credential|secret|token|authorization|cookie|privatekey|keystore|truststore|apikey|api_key|apiKey|bearer/i
const PATH_KEY_PATTERN = /^(?:.*Path|sourceFile|staging|upload|absolute|directory|dir|fileName)$/i

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readItems(data: unknown): unknown[] {
  return isObject(data) && Array.isArray(data.items) ? data.items : []
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error'
}

export function domainConfigTargetLabel(targetUrl: string) {
  try {
    const url = new URL(targetUrl)
    return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    return 'unknown'
  }
}

function snapshotId() {
  return `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function domainConfigSnapshotScopeKey(value: Pick<DomainConfigSnapshotManifest, 'profileId' | 'target' | 'version'>) {
  return `${value.profileId}\0${value.target}\0${value.version}`
}

export function domainConfigSnapshotScopeKeyForCredentials(creds: WlsCredentials) {
  return domainConfigSnapshotScopeKey({
    profileId: creds.profileId,
    target: domainConfigTargetLabel(creds.targetUrl),
    version: creds.version,
  })
}

export function domainConfigSnapshotInScope(snapshot: DomainConfigSnapshot, scopeKey: string) {
  return domainConfigSnapshotScopeKey(snapshot.manifest) === scopeKey
}

function redactString(value: string) {
  return value
    .replace(/https?:\/\/[^@\s/]+:[^@\s/]+@/gi, 'https://<credentials>@')
    .replace(/\b(password|credential|authorization|secret|token|apikey|api_key|bearer)=([^&\s]+)/gi, '$1=<redacted>')
    .replace(/(?:\/(?:Users|home|u01|oracle|domains|private|var|tmp|opt|app|weblogic)[^\s"',;)]*)/gi, '<path>')
    .replace(/[A-Za-z]:\\[^\s"',;)]+/g, '<path>')
}

export function redactDomainConfigValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '<redacted>'
  if (PATH_KEY_PATTERN.test(key)) {
    if (typeof value === 'string') return '<path>'
    if (Array.isArray(value)) return value.map(() => '<path>')
  }
  if (typeof value === 'string') return redactString(value)
  if (typeof value !== 'object' || value === null) return value
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([entryKey, entryValue]) => [
        String(entryKey),
        redactDomainConfigValue(entryValue, String(entryKey)),
      ]),
    )
  }
  if (Array.isArray(value)) return value.map((item) => redactDomainConfigValue(item, key))
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactDomainConfigValue(entryValue, entryKey),
    ]),
  )
}

async function fetchEditCollection(creds: WlsCredentials, operation: string, path: string, fields: string) {
  const res = await withWlsRestTimeout(operation, (signal) =>
    clientFor(creds).GET(path as never, {
      signal,
      params: {
        path: { version: creds.version },
        query: { fields, links: 'none' },
      },
    } as never),
  )
  const result = res as { error?: unknown; response: Response; data?: unknown }
  if (result.error) throw createWlsHttpError(operation, result.response, result.error)
  return readItems(result.data)
}

async function serverResources(creds: WlsCredentials): Promise<DomainConfigResource[]> {
  const items = await fetchEditCollection(
    creds,
    'Server configuration snapshot',
    '/management/weblogic/{version}/edit/servers',
    'name,cluster,machine,listenAddress,listenPort,listenPortEnabled,administrationPort,administrationPortEnabled,SSL',
  )
  return items.flatMap((item) => {
    const name = isObject(item) ? readString(item.name) : null
    return name ? [{ family: 'servers', identity: name, data: redactDomainConfigValue(item) }] : []
  })
}

async function clusterResources(creds: WlsCredentials): Promise<DomainConfigResource[]> {
  const items = await fetchEditCollection(
    creds,
    'Cluster configuration snapshot',
    '/management/weblogic/{version}/edit/clusters',
    'name,clusterAddress,clusterMessagingMode,clusterType,servers',
  )
  return items.flatMap((item) => {
    const name = isObject(item) ? readString(item.name) : null
    return name ? [{ family: 'clusters', identity: name, data: redactDomainConfigValue(item) }] : []
  })
}

async function dataSourceResources(creds: WlsCredentials): Promise<DomainConfigResource[]> {
  const items = await fetchEditCollection(
    creds,
    'JDBC configuration snapshot',
    '/management/weblogic/{version}/edit/JDBCSystemResources',
    'name,targets',
  )
  return items.flatMap((item) => {
    const name = isObject(item) ? readString(item.name) : null
    return name ? [{ family: 'dataSources', identity: name, data: redactDomainConfigValue(item) }] : []
  })
}

async function deploymentResources(creds: WlsCredentials): Promise<DomainConfigResource[]> {
  const items = await fetchEditCollection(
    creds,
    'Deployment configuration snapshot',
    '/management/weblogic/{version}/edit/appDeployments',
    'name,applicationName,moduleType,deploymentOrder,targets,sourcePath,planPath,securityDDModel,stagingMode',
  )
  return items.flatMap((item) => {
    const name = isObject(item) ? readString(item.name) : null
    return name ? [{ family: 'deployments', identity: name, data: redactDomainConfigValue(item) }] : []
  })
}

async function jmsResources(creds: WlsCredentials): Promise<DomainConfigResource[]> {
  const items = await fetchEditCollection(
    creds,
    'JMS configuration snapshot',
    '/management/weblogic/{version}/edit/JMSSystemResources',
    'name,targets',
  )
  return items.flatMap((item) => {
    const name = isObject(item) ? readString(item.name) : null
    return name ? [{ family: 'jms', identity: name, data: redactDomainConfigValue(item) }] : []
  })
}

const familyCollectors: Record<DomainConfigFamily, (creds: WlsCredentials) => Promise<DomainConfigResource[]>> = {
  servers: serverResources,
  clusters: clusterResources,
  dataSources: dataSourceResources,
  deployments: deploymentResources,
  jms: jmsResources,
}

export function buildDomainConfigManifest(
  creds: WlsCredentials,
  sections: DomainConfigSnapshotSection[],
  id = snapshotId(),
  capturedAt = new Date().toISOString(),
): DomainConfigSnapshotManifest {
  return {
    schemaVersion: DOMAIN_CONFIG_SNAPSHOT_SCHEMA_VERSION,
    id,
    capturedAt,
    target: domainConfigTargetLabel(creds.targetUrl),
    version: creds.version,
    profileId: creds.profileId,
    profileName: creds.name,
    username: creds.username,
    sections,
    redaction: {
      sensitiveFields: 'password/credential/secret/token/api key/authorization fields are redacted',
      filesystemPaths: 'known path fields and path-like string fragments are redacted',
      unsupportedFamilies: 'security realms, SSL keystore internals, WLDF watch actions, and payload-like resources are omitted in v1',
    },
  }
}

export async function captureDomainConfigSnapshot(creds: WlsCredentials): Promise<DomainConfigSnapshot> {
  const capture = Promise.allSettled(
    (Object.keys(familyCollectors) as DomainConfigFamily[]).map(async (family) => ({
      family,
      resources: await familyCollectors[family](creds),
    })),
  )
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = globalThis.setTimeout(
      () => reject(new Error('Domain config snapshot timed out after 45s')),
      DOMAIN_CONFIG_SNAPSHOT_CAPTURE_TIMEOUT_MS,
    )
  })
  const outcomes = await Promise.race([capture, timeout]).finally(() => {
    if (timeoutId) globalThis.clearTimeout(timeoutId)
  })
  const resources = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value.resources : []))
  const sections: DomainConfigSnapshotSection[] = outcomes.map((outcome, index) => {
    const family = (Object.keys(familyCollectors) as DomainConfigFamily[])[index] ?? 'unknown'
    if (outcome.status === 'fulfilled') {
      return { family, status: 'included', recordCount: outcome.value.resources.length }
    }
    return { family, status: 'failed', recordCount: 0, error: errorMessage(outcome.reason) }
  })
  sections.push({
    family: 'security-realms',
    status: 'unsupported',
    recordCount: 0,
    reason: 'Security realm data requires separate sensitivity review.',
  })
  sections.push({
    family: 'wldf-watches',
    status: 'unsupported',
    recordCount: 0,
    reason: 'WLDF watch management is outside v1 snapshot scope.',
  })

  return {
    manifest: buildDomainConfigManifest(creds, sections),
    resources,
  }
}

function resourceKey(resource: DomainConfigResource) {
  return `${resource.family}\0${resource.identity}`
}

function stableString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  if (!isObject(value) && !Array.isArray(value)) return prefix ? { [prefix]: value } : { value }
  if (Array.isArray(value)) {
    if (value.length === 0) return prefix ? { [prefix]: [] } : { value: [] }
    return Object.fromEntries(value.flatMap((item, index) => Object.entries(flatten(item, `${prefix}[${index}]`))))
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return prefix ? { [prefix]: {} } : { value: {} }
  return Object.fromEntries(
    entries.flatMap(([key, entryValue]) => Object.entries(flatten(entryValue, prefix ? `${prefix}.${key}` : key))),
  )
}

export function diffDomainConfigSnapshots(before: DomainConfigSnapshot, after: DomainConfigSnapshot): DomainConfigDiff {
  const beforeByKey = new Map(before.resources.map((resource) => [resourceKey(resource), resource]))
  const afterByKey = new Map(after.resources.map((resource) => [resourceKey(resource), resource]))
  const keys = Array.from(new Set([...beforeByKey.keys(), ...afterByKey.keys()])).sort()
  const resources = keys.flatMap((key): DomainConfigDiffResource[] => {
    const previous = beforeByKey.get(key)
    const next = afterByKey.get(key)
    const candidate = next ?? previous
    if (!candidate) return []
    if (!previous) return [{ family: candidate.family, identity: candidate.identity, kind: 'added', changes: [] }]
    if (!next) return [{ family: candidate.family, identity: candidate.identity, kind: 'removed', changes: [] }]
    if (stableString(previous.data) === stableString(next.data)) return []
    const previousFlat = flatten(previous.data)
    const nextFlat = flatten(next.data)
    const paths = Array.from(new Set([...Object.keys(previousFlat), ...Object.keys(nextFlat)])).sort()
    const changes = paths.flatMap((path) =>
      stableString(previousFlat[path]) === stableString(nextFlat[path])
        ? []
        : [{ path, before: previousFlat[path] ?? null, after: nextFlat[path] ?? null }],
    )
    return [{ family: candidate.family, identity: candidate.identity, kind: 'changed', changes }]
  })

  return {
    beforeId: before.manifest.id,
    afterId: after.manifest.id,
    resources,
  }
}

function browserStorage(): StorageArea | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

export function readStoredDomainConfigSnapshots(storage: StorageArea | null = browserStorage()) {
  if (!storage) return []
  try {
    const parsed = JSON.parse(storage.getItem(DOMAIN_CONFIG_SNAPSHOT_STORAGE_KEY) ?? '{"snapshots":[]}') as StoredSnapshotEnvelope
    return Array.isArray(parsed.snapshots) ? parsed.snapshots : []
  } catch {
    return []
  }
}

export function readStoredDomainConfigSnapshotsForScope(
  creds: WlsCredentials,
  storage: StorageArea | null = browserStorage(),
) {
  const scopeKey = domainConfigSnapshotScopeKeyForCredentials(creds)
  return readStoredDomainConfigSnapshots(storage).filter((snapshot) => domainConfigSnapshotInScope(snapshot, scopeKey))
}

function writeSnapshotEnvelope(storage: StorageArea, snapshots: DomainConfigSnapshot[]) {
  storage.setItem(DOMAIN_CONFIG_SNAPSHOT_STORAGE_KEY, JSON.stringify({ snapshots }))
}

export function writeStoredDomainConfigSnapshot(
  snapshot: DomainConfigSnapshot,
  storage: StorageArea | null = browserStorage(),
): DomainConfigSnapshotWriteResult {
  if (!storage) {
    return { snapshots: [snapshot], storageLimited: false, retainedScopeLimit: DOMAIN_CONFIG_SNAPSHOT_LIMIT }
  }

  const allSnapshots = readStoredDomainConfigSnapshots(storage).filter((entry) => entry.manifest.id !== snapshot.manifest.id)
  const scopeKey = domainConfigSnapshotScopeKey(snapshot.manifest)
  const sameScope = allSnapshots.filter((entry) => domainConfigSnapshotInScope(entry, scopeKey))
  const otherScopes = allSnapshots.filter((entry) => !domainConfigSnapshotInScope(entry, scopeKey))

  for (const limit of DOMAIN_CONFIG_SNAPSHOT_SCOPE_LIMIT_ATTEMPTS) {
    const scopedSnapshots = [snapshot, ...sameScope].slice(0, limit)
    const combined = [...scopedSnapshots, ...otherScopes]
    try {
      writeSnapshotEnvelope(storage, combined)
      return {
        snapshots: scopedSnapshots,
        storageLimited: limit !== DOMAIN_CONFIG_SNAPSHOT_LIMIT,
        retainedScopeLimit: limit,
      }
    } catch {
      // Try a smaller same-scope retention limit before dropping other scopes.
    }
  }

  try {
    writeSnapshotEnvelope(storage, [snapshot])
    return { snapshots: [snapshot], storageLimited: true, retainedScopeLimit: 1 }
  } catch {
    throw new Error('Snapshot captured, but local browser storage is full.')
  }
}

export function domainConfigSnapshotFilename(snapshot: DomainConfigSnapshot) {
  const target = snapshot.manifest.target.replace(/[^a-z0-9._-]+/gi, '-')
  const captured = snapshot.manifest.capturedAt.replace(/[:.]/g, '-')
  return `wls-config-snapshot-${target}-${captured}.json`
}
