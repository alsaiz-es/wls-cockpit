import { normalizeWlsTarget } from '../api/proxy-target.ts'
import { defaultWlsVersion, isWlsVersion, type WlsVersion } from '../api/wls-version.ts'
import type { WlsCredentials } from '../api/client.ts'

export { defaultWlsVersion } from '../api/wls-version.ts'

export const CONNECTION_PROFILES_STORAGE_KEY = 'wls-cockpit:connection-profiles:v1'
export const ACTIVE_CONNECTION_STORAGE_KEY = 'wls-cockpit:active-connection:v1'
export const LEGACY_CREDENTIAL_STORAGE_KEY = 'wls-cockpit:creds'
export const CONNECTION_PROFILES_API_PATH = '/__wls-cockpit/connection-profiles'

export interface ConnectionProfile {
  id: string
  name: string
  targetUrl: string
  version: WlsVersion
  username?: string
  lastUsedAt?: string
}

export interface ConnectionProfileInput {
  name: string
  targetUrl: string
  version: WlsVersion
  username?: string
}

export interface ActiveConnectionInput {
  profile: ConnectionProfile
  username: string
  password: string
  version?: WlsVersion
}

export interface StorageArea {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type StorageResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface ConnectionProfileCatalogSyncOptions {
  serverCatalogAvailable?: boolean
  storage?: StorageArea | null
  fetchImpl?: typeof fetch
}

function browserLocalStorage(): StorageArea | null {
  if (typeof window === 'undefined') return null
  return window.localStorage
}

function browserSessionStorage(): StorageArea | null {
  if (typeof window === 'undefined') return null
  return window.sessionStorage
}

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function newProfileId(targetUrl: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `profile-${crypto.randomUUID()}`
  }
  let hash = 2166136261
  for (let index = 0; index < targetUrl.length; index += 1) {
    hash ^= targetUrl.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `profile-${Date.now().toString(36)}-${(hash >>> 0).toString(36)}`
}

function defaultProfileId(targetUrl: string) {
  let hash = 2166136261
  for (let index = 0; index < targetUrl.length; index += 1) {
    hash ^= targetUrl.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `default-${(hash >>> 0).toString(36)}`
}

function sanitizeProfile(value: unknown): ConnectionProfile | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ConnectionProfile>
  const id = cleanText(candidate.id)
  const name = cleanText(candidate.name)
  const target = normalizeWlsTarget(candidate.targetUrl)
  if (!id || !name || !target.ok || candidate.targetUrl !== target.targetUrl) return null
  if (!isWlsVersion(candidate.version)) return null

  const profile: ConnectionProfile = {
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

function readProfileArray(storage: StorageArea | null = browserLocalStorage()) {
  if (!storage) return []
  try {
    const parsed = JSON.parse(storage.getItem(CONNECTION_PROFILES_STORAGE_KEY) ?? '[]') as unknown
    return sanitizeProfileArray(parsed)
  } catch {
    return []
  }
}

function writeProfileArray(profiles: ConnectionProfile[], storage: StorageArea | null = browserLocalStorage()) {
  if (!storage) return
  storage.setItem(CONNECTION_PROFILES_STORAGE_KEY, JSON.stringify(profiles.map(sanitizeStoredProfile)))
}

function sanitizeStoredProfile(profile: ConnectionProfile) {
  const stored: ConnectionProfile = {
    id: profile.id,
    name: profile.name,
    targetUrl: profile.targetUrl,
    version: profile.version,
  }
  if (profile.username) stored.username = profile.username
  if (profile.lastUsedAt) stored.lastUsedAt = profile.lastUsedAt
  return stored
}

function sanitizeProfileArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const profile = sanitizeProfile(item)
    return profile ? [profile] : []
  })
}

function mergeProfileCatalogs(primary: ConnectionProfile[], secondary: ConnectionProfile[]) {
  const byId = new Map<string, ConnectionProfile>()
  for (const profile of secondary) byId.set(profile.id, sanitizeStoredProfile(profile))
  for (const profile of primary) byId.set(profile.id, sanitizeStoredProfile(profile))
  return [...byId.values()]
}

function defaultProfile(targetUrl: string | undefined, version: string | undefined): ConnectionProfile | null {
  if (!targetUrl) return null
  const target = normalizeWlsTarget(targetUrl)
  if (!target.ok) return null
  return {
    id: defaultProfileId(target.targetUrl),
    name: 'Default domain',
    targetUrl: target.targetUrl,
    version: defaultWlsVersion(version),
    username: 'weblogic',
  }
}

async function readServerProfileCatalog(options: ConnectionProfileCatalogSyncOptions) {
  if (!options.serverCatalogAvailable) return null
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'undefined' ? null : fetch)
  if (!fetchImpl) return null
  try {
    const response = await fetchImpl(CONNECTION_PROFILES_API_PATH, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) return null
    const payload = (await response.json()) as { profiles?: unknown }
    return sanitizeProfileArray(payload.profiles)
  } catch {
    return null
  }
}

export async function persistConnectionProfileCatalog(
  profiles: ConnectionProfile[],
  options: ConnectionProfileCatalogSyncOptions = {},
) {
  const storage = options.storage === undefined ? browserLocalStorage() : options.storage
  const sanitized = profiles.flatMap((profile) => {
    const clean = sanitizeProfile(sanitizeStoredProfile(profile))
    return clean ? [clean] : []
  })
  writeProfileArray(sanitized, storage)

  if (options.serverCatalogAvailable) {
    const fetchImpl = options.fetchImpl ?? (typeof fetch === 'undefined' ? null : fetch)
    if (fetchImpl) {
      try {
        await fetchImpl(CONNECTION_PROFILES_API_PATH, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ profiles: sanitized }),
        })
      } catch {
        // Browser localStorage remains the fallback when the self-host catalog is unavailable.
      }
    }
  }

  return sanitized
}

export async function syncConnectionProfileCatalog(
  defaultTargetUrl: string | undefined,
  defaultVersion: string | undefined,
  options: ConnectionProfileCatalogSyncOptions = {},
) {
  const storage = options.storage === undefined ? browserLocalStorage() : options.storage
  const local = readProfileArray(storage)
  const server = await readServerProfileCatalog(options)
  let merged = server ? mergeProfileCatalogs(local, server) : local

  if (merged.length === 0) {
    const seeded = defaultProfile(defaultTargetUrl, defaultVersion)
    if (seeded) merged = [seeded]
  }

  if (server || merged.length !== local.length || merged.some((profile, index) => profile.id !== local[index]?.id)) {
    await persistConnectionProfileCatalog(merged, { ...options, storage })
  }

  return merged
}

export function listConnectionProfiles(storage: StorageArea | null = browserLocalStorage()) {
  return readProfileArray(storage)
}

export function seedDefaultConnectionProfile(
  targetUrl: string | undefined,
  version: string | undefined,
  storage: StorageArea | null = browserLocalStorage(),
) {
  const existing = readProfileArray(storage)
  if (existing.length > 0) return existing

  if (!targetUrl) return existing
  const profile = defaultProfile(targetUrl, version)
  if (!profile) return existing
  writeProfileArray([profile], storage)
  return [profile]
}

export function createConnectionProfile(
  input: ConnectionProfileInput,
  storage: StorageArea | null = browserLocalStorage(),
): StorageResult<ConnectionProfile> {
  const target = normalizeWlsTarget(input.targetUrl)
  const name = cleanText(input.name)
  if (!name) return { ok: false, error: 'Profile name is required.' }
  if (!target.ok) return { ok: false, error: target.error }
  if (!isWlsVersion(input.version)) return { ok: false, error: 'Unsupported WLS REST version.' }

  const profiles = readProfileArray(storage)
  const profile: ConnectionProfile = {
    id: newProfileId(target.targetUrl),
    name,
    targetUrl: target.targetUrl,
    version: input.version,
  }
  const username = cleanText(input.username)
  if (username) profile.username = username
  writeProfileArray([...profiles, profile], storage)
  return { ok: true, value: profile }
}

export function updateConnectionProfile(
  id: string,
  input: ConnectionProfileInput,
  storage: StorageArea | null = browserLocalStorage(),
): StorageResult<ConnectionProfile> {
  const target = normalizeWlsTarget(input.targetUrl)
  const name = cleanText(input.name)
  if (!name) return { ok: false, error: 'Profile name is required.' }
  if (!target.ok) return { ok: false, error: target.error }
  if (!isWlsVersion(input.version)) return { ok: false, error: 'Unsupported WLS REST version.' }

  const profiles = readProfileArray(storage)
  const index = profiles.findIndex((profile) => profile.id === id)
  if (index < 0) return { ok: false, error: 'Profile not found.' }

  const updated: ConnectionProfile = {
    ...profiles[index],
    name,
    targetUrl: target.targetUrl,
    version: input.version,
  }
  const username = cleanText(input.username)
  if (username) updated.username = username
  else delete updated.username
  profiles[index] = updated
  writeProfileArray(profiles, storage)
  return { ok: true, value: updated }
}

export function deleteConnectionProfile(id: string, storage: StorageArea | null = browserLocalStorage()) {
  const profiles = readProfileArray(storage).filter((profile) => profile.id !== id)
  writeProfileArray(profiles, storage)
  return profiles
}

export function markConnectionProfileUsed(
  id: string,
  username: string,
  storage: StorageArea | null = browserLocalStorage(),
  now = new Date(),
) {
  const profiles = readProfileArray(storage)
  const next = profiles.map((profile) => {
    if (profile.id !== id) return profile
    return {
      ...profile,
      username: cleanText(username) || profile.username,
      lastUsedAt: now.toISOString(),
    }
  })
  writeProfileArray(next, storage)
  return next
}

export function activeConnectionFromProfile(input: ActiveConnectionInput): StorageResult<WlsCredentials> {
  const username = cleanText(input.username)
  if (!username) return { ok: false, error: 'Username is required.' }
  if (!input.password) return { ok: false, error: 'Password is required.' }
  const target = normalizeWlsTarget(input.profile.targetUrl)
  if (!target.ok || input.profile.targetUrl !== target.targetUrl) {
    return { ok: false, error: target.ok ? 'Profile target is not normalized.' : target.error }
  }
  const version = input.version ?? input.profile.version
  if (!isWlsVersion(version)) return { ok: false, error: 'Unsupported WLS REST version.' }

  return {
    ok: true,
    value: {
      profileId: input.profile.id,
      name: input.profile.name,
      targetUrl: target.targetUrl,
      username,
      password: input.password,
      version,
    },
  }
}

function sanitizeActiveConnection(value: unknown): WlsCredentials | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<WlsCredentials>
  const profileId = cleanText(candidate.profileId)
  const name = cleanText(candidate.name)
  const username = cleanText(candidate.username)
  const password = typeof candidate.password === 'string' ? candidate.password : ''
  const target = normalizeWlsTarget(candidate.targetUrl)
  if (!profileId || !name || !username || !password || !target.ok) return null
  if (candidate.targetUrl !== target.targetUrl) return null
  if (!isWlsVersion(candidate.version)) return null

  return {
    profileId,
    name,
    targetUrl: target.targetUrl,
    username,
    password,
    version: candidate.version,
  }
}

// The legacy session blob ('wls-cockpit:creds') stored a password without the target it belonged
// to, so it is discarded instead of being replayed against whatever target the server has now.
export function readActiveConnectionSession(
  storage: StorageArea | null = browserSessionStorage(),
): WlsCredentials | null {
  if (!storage) return null
  storage.removeItem(LEGACY_CREDENTIAL_STORAGE_KEY)
  try {
    const raw = storage.getItem(ACTIVE_CONNECTION_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      const active = sanitizeActiveConnection(parsed)
      if (active) return active
      storage.removeItem(ACTIVE_CONNECTION_STORAGE_KEY)
    }
  } catch {
    storage.removeItem(ACTIVE_CONNECTION_STORAGE_KEY)
  }

  return null
}

export function writeActiveConnectionSession(
  connection: WlsCredentials,
  storage: StorageArea | null = browserSessionStorage(),
) {
  if (!storage) return
  const active = sanitizeActiveConnection(connection)
  if (!active) {
    storage.removeItem(ACTIVE_CONNECTION_STORAGE_KEY)
    return
  }
  storage.setItem(ACTIVE_CONNECTION_STORAGE_KEY, JSON.stringify(active))
  storage.removeItem(LEGACY_CREDENTIAL_STORAGE_KEY)
}

export function clearActiveConnectionSession(storage: StorageArea | null = browserSessionStorage()) {
  if (!storage) return
  storage.removeItem(ACTIVE_CONNECTION_STORAGE_KEY)
  storage.removeItem(LEGACY_CREDENTIAL_STORAGE_KEY)
}
