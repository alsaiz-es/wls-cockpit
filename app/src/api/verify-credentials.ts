import { actionAuditHeaders } from './action-audit-headers.ts'
import { WLS_REST_PROXY_BASE_URL, wlsBasicAuthHeader, type WlsCredentials } from './client.ts'
import { WLS_REST_TIMEOUT_MS } from './wls-errors.ts'

export type CredentialCheck = { ok: true } | { ok: false; reason: 'unauthorized' | 'unreachable'; message: string }

function unreachable(creds: WlsCredentials, timeoutMs?: number): CredentialCheck {
  const within = timeoutMs === undefined ? '' : ` within ${Math.round(timeoutMs / 1000)}s`
  return {
    ok: false,
    reason: 'unreachable',
    message: `Could not reach ${creds.targetUrl}${within}. Check the AdminServer URL and that it is running.`,
  }
}

// One cheap authenticated read, so a wrong password is reported on the login form instead of
// surfacing as HTTP 401 on every page after signing in.
export async function verifyWlsCredentials(
  creds: WlsCredentials,
  fetcher: typeof fetch = fetch,
  timeoutMs = WLS_REST_TIMEOUT_MS,
): Promise<CredentialCheck> {
  const url = `${WLS_REST_PROXY_BASE_URL}/management/weblogic/${creds.version}/domainRuntime?fields=name&links=none`
  let response: Response
  try {
    response = await fetcher(url, {
      headers: {
        Authorization: wlsBasicAuthHeader(creds),
        Accept: 'application/json',
        'X-Requested-By': 'wls-cockpit',
        ...actionAuditHeaders(creds),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return unreachable(creds, timeoutMs)
  }

  if (response.ok) return { ok: true }
  // 502/504 come from the local proxy (or a gateway in front of WebLogic) when the AdminServer
  // did not answer, so they are reported as unreachable rather than as a WebLogic reply.
  if (response.status === 502 || response.status === 504) return unreachable(creds)
  if (response.status === 401) {
    return { ok: false, reason: 'unauthorized', message: 'WebLogic rejected the username or password.' }
  }
  if (response.status === 403) {
    return {
      ok: false,
      reason: 'unauthorized',
      message: 'WebLogic accepted the login but this user may not read the domain runtime. Use a user in the Administrators, Operators or Monitors group.',
    }
  }
  return {
    ok: false,
    reason: 'unreachable',
    message: `${creds.targetUrl} answered HTTP ${response.status}. Check the AdminServer URL and the WLS REST version.`,
  }
}
