import { normalizeWlsTarget } from './proxy-target.ts'
import { defaultWlsVersion, type WlsVersion } from './wls-version.ts'

export interface WlsCockpitRuntimeConfig {
  defaultTargetUrl?: string
  defaultVersion?: string
  readOnlyDemoMode?: boolean
  jmsJmxAvailable?: boolean
  jmsJmxUnavailableReason?: string
  actionAuditAvailable?: boolean
  connectionProfileCatalogAvailable?: boolean
  shutdownAvailable?: boolean
}

export interface ResolvedRuntimeConfig {
  defaultTargetUrl?: string
  defaultVersion: WlsVersion
  readOnlyDemoMode: boolean
  jmsJmxAvailable: boolean
  jmsJmxUnavailableReason: string | null
  actionAuditAvailable: boolean
  connectionProfileCatalogAvailable: boolean
  shutdownAvailable: boolean
}

export interface RuntimeConfigSources {
  runtime?: WlsCockpitRuntimeConfig
  env?: Record<string, string | undefined>
}

declare global {
  interface Window {
    __WLS_COCKPIT_RUNTIME__?: WlsCockpitRuntimeConfig
  }
}

function viteEnv() {
  return ((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}) as Record<
    string,
    string | undefined
  >
}

function normalizedTarget(targetUrl: string | undefined) {
  const target = normalizeWlsTarget(targetUrl)
  return target.ok ? target.targetUrl : undefined
}

function readBooleanFlag(value: unknown) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function readRuntimeConfig(runtimeConfig?: WlsCockpitRuntimeConfig): ResolvedRuntimeConfig {
  const env = viteEnv()
  const runtime = runtimeConfig ?? (typeof window === 'undefined' ? undefined : window.__WLS_COCKPIT_RUNTIME__)

  return resolveRuntimeConfig({ runtime, env })
}

export function resolveRuntimeConfig({ runtime, env = {} }: RuntimeConfigSources): ResolvedRuntimeConfig {
  const useRuntime = runtime !== undefined

  return {
    defaultTargetUrl: normalizedTarget(useRuntime ? runtime.defaultTargetUrl : env.VITE_WLS_TARGET),
    defaultVersion: defaultWlsVersion(useRuntime ? runtime.defaultVersion : env.VITE_WLS_DEFAULT_VERSION),
    readOnlyDemoMode: readBooleanFlag(useRuntime ? runtime.readOnlyDemoMode : env.VITE_WLS_COCKPIT_READ_ONLY),
    jmsJmxAvailable: readBooleanFlag(useRuntime ? runtime.jmsJmxAvailable : env.VITE_WLS_COCKPIT_JMS_JMX_AVAILABLE),
    jmsJmxUnavailableReason:
      typeof runtime?.jmsJmxUnavailableReason === 'string' && runtime.jmsJmxUnavailableReason.length > 0
        ? runtime.jmsJmxUnavailableReason
        : null,
    actionAuditAvailable: readBooleanFlag(useRuntime ? runtime.actionAuditAvailable : env.VITE_WLS_COCKPIT_ACTION_AUDIT_AVAILABLE),
    connectionProfileCatalogAvailable: readBooleanFlag(
      useRuntime ? runtime.connectionProfileCatalogAvailable : env.VITE_WLS_COCKPIT_CONNECTION_PROFILE_CATALOG_AVAILABLE,
    ),
    // Only the CLI server can stop itself; the Vite dev server never advertises it.
    shutdownAvailable: useRuntime ? runtime.shutdownAvailable === true : false,
  }
}

export function readOnlyDemoModeEnabled(runtimeConfig?: WlsCockpitRuntimeConfig) {
  return readRuntimeConfig(runtimeConfig).readOnlyDemoMode
}
