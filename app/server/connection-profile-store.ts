import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeWlsTarget } from '../src/api/proxy-target.ts'
import { isWlsVersion, type WlsVersion } from '../src/api/wls-version.ts'

export interface StoredConnectionProfile {
  id: string
  name: string
  targetUrl: string
  version: WlsVersion
  username?: string
  lastUsedAt?: string
}

export interface ConnectionProfileStoreOptions {
  path?: string
  dataDir?: string
  enabled?: boolean
  maxProfiles?: number
}

const DEFAULT_MAX_PROFILES = 200

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function enabled(options: ConnectionProfileStoreOptions = {}) {
  return options.enabled !== false
}

function maxProfiles(options: ConnectionProfileStoreOptions = {}) {
  const configured = options.maxProfiles ?? Number(process.env.WLS_COCKPIT_PROFILE_CATALOG_MAX_PROFILES)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_PROFILES
}

export function resolveConnectionProfileCatalogPath(
  options: ConnectionProfileStoreOptions = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  if (options.path) return options.path
  if (env.WLS_COCKPIT_PROFILE_CATALOG_PATH) return env.WLS_COCKPIT_PROFILE_CATALOG_PATH
  const dataDir = options.dataDir ?? env.WLS_COCKPIT_DATA_DIR ?? path.join(os.homedir(), '.wls-cockpit')
  return path.join(dataDir, 'connection-profiles.json')
}

export function sanitizeStoredConnectionProfile(value: unknown): StoredConnectionProfile | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<StoredConnectionProfile> & Record<string, unknown>
  const id = cleanText(candidate.id)
  const name = cleanText(candidate.name)
  const target = normalizeWlsTarget(candidate.targetUrl)
  if (!id || !name || !target.ok || candidate.targetUrl !== target.targetUrl) return null
  if (!isWlsVersion(candidate.version)) return null

  const profile: StoredConnectionProfile = {
    id,
    name,
    targetUrl: target.targetUrl,
    version: candidate.version,
  }
  const username = cleanText(candidate.username)
  if (username) profile.username = username
  const lastUsedAt = cleanText(candidate.lastUsedAt)
  if (lastUsedAt) profile.lastUsedAt = lastUsedAt
  return profile
}

export function sanitizeStoredConnectionProfiles(values: unknown, options: ConnectionProfileStoreOptions = {}) {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const profiles: StoredConnectionProfile[] = []
  for (const item of values) {
    const profile = sanitizeStoredConnectionProfile(item)
    if (!profile || seen.has(profile.id)) continue
    seen.add(profile.id)
    profiles.push(profile)
    if (profiles.length >= maxProfiles(options)) break
  }
  return profiles
}

export async function readConnectionProfileCatalog(options: ConnectionProfileStoreOptions = {}) {
  if (!enabled(options)) return []
  let text: string
  try {
    text = await readFile(resolveConnectionProfileCatalogPath(options), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  try {
    const parsed = JSON.parse(text) as unknown
    const profiles = typeof parsed === 'object' && parsed !== null && 'profiles' in parsed ? (parsed as { profiles?: unknown }).profiles : parsed
    return sanitizeStoredConnectionProfiles(profiles, options)
  } catch {
    return []
  }
}

export async function writeConnectionProfileCatalog(values: unknown, options: ConnectionProfileStoreOptions = {}) {
  if (!enabled(options)) return []
  const profiles = sanitizeStoredConnectionProfiles(values, options)
  const filePath = resolveConnectionProfileCatalogPath(options)
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  const body = JSON.stringify({ profiles }, null, 2) + '\n'
  await writeFile(tmpPath, body, { mode: 0o600, flag: 'wx' })
  await rename(tmpPath, filePath)
  return profiles
}
