export const WLS_TARGET_HEADER = 'X-WLS-Cockpit-Target'
export const WLS_TARGET_HEADER_LOWER = WLS_TARGET_HEADER.toLowerCase()

export type NormalizedWlsTarget =
  | {
      ok: true
      targetUrl: string
      host: string
      port: number
      protocol: 'http:' | 'https:'
    }
  | {
      ok: false
      error: string
    }

export function normalizeWlsTarget(input: string | null | undefined): NormalizedWlsTarget {
  const raw = input?.trim()
  if (!raw) return { ok: false, error: 'Target URL is required.' }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: 'Target URL must be a valid absolute URL.' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Target URL protocol must be http or https.' }
  }
  if (!url.hostname) {
    return { ok: false, error: 'Target URL must include a hostname.' }
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Target URL must not include embedded credentials.' }
  }
  if (url.pathname && url.pathname !== '/') {
    return { ok: false, error: 'Target URL must be an origin without a path.' }
  }
  if (url.search) {
    return { ok: false, error: 'Target URL must not include a query string.' }
  }
  if (url.hash) {
    return { ok: false, error: 'Target URL must not include a fragment.' }
  }

  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: 'Target URL port is invalid.' }
  }

  return {
    ok: true,
    targetUrl: url.origin,
    host: url.hostname,
    port,
    protocol: url.protocol,
  }
}

export function requireNormalizedWlsTarget(input: string | null | undefined): NormalizedWlsTarget {
  const normalized = normalizeWlsTarget(input)
  if (!normalized.ok) return normalized
  if (input?.trim() !== normalized.targetUrl) {
    return { ok: false, error: 'Target URL must already be normalized before proxy routing.' }
  }
  return normalized
}
