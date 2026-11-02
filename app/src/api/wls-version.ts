export const WLS_VERSIONS = ['14.1.2.0.0', '12.2.1.4.0'] as const
export type WlsVersion = (typeof WLS_VERSIONS)[number]

export function isWlsVersion(value: unknown): value is WlsVersion {
  return typeof value === 'string' && WLS_VERSIONS.includes(value as WlsVersion)
}

export function defaultWlsVersion(raw: string | undefined): WlsVersion {
  return isWlsVersion(raw) ? raw : '14.1.2.0.0'
}
