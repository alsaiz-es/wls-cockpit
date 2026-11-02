import createClient from 'openapi-fetch'
import type { paths as paths14 } from './generated/wls-14.1.2'
import type { paths as paths12 } from './generated/wls-12.2.1.4'
import { actionAuditHeaders } from './action-audit-headers.ts'
import type { WlsVersion } from './wls-version.ts'
export { WLS_VERSIONS } from './wls-version.ts'
export type { WlsVersion } from './wls-version.ts'

export interface WlsCredentials {
  profileId: string
  name: string
  targetUrl: string
  username: string
  password: string
  version: WlsVersion
}

// Separates cached data per domain and user. The password stays out of the key (query keys are
// visible in devtools and error reports); AuthProvider clears the query cache on every login and
// logout instead, so results fetched with old credentials are never reused.
export function wlsCredentialCacheKey(c: WlsCredentials | null | undefined) {
  if (!c) return 'anonymous'

  let hash = 2166136261
  const input = `${c.version}\0${c.profileId}\0${c.targetUrl}\0${c.username}`
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `${c.version}:${c.profileId}:${c.username}:${(hash >>> 0).toString(36)}`
}

export const WLS_REST_PROXY_BASE_URL = '/api/wls'

export function wlsBasicAuthHeader(c: WlsCredentials) {
  return 'Basic ' + btoa(`${c.username}:${c.password}`)
}

export function createClient14(c: WlsCredentials) {
  return createClient<paths14>({
    baseUrl: WLS_REST_PROXY_BASE_URL,
    headers: {
      Authorization: wlsBasicAuthHeader(c),
      Accept: 'application/json',
      'X-Requested-By': 'wls-cockpit',
      ...actionAuditHeaders(c),
    },
  })
}

export function createClient12(c: WlsCredentials) {
  return createClient<paths12>({
    baseUrl: WLS_REST_PROXY_BASE_URL,
    headers: {
      Authorization: wlsBasicAuthHeader(c),
      Accept: 'application/json',
      'X-Requested-By': 'wls-cockpit',
      ...actionAuditHeaders(c),
    },
  })
}
