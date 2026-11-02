import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient12, createClient14, wlsCredentialCacheKey, type WlsCredentials } from '@/api/client'
import {
  useRefreshStaleQueryOnVisibleReturn,
  useVisiblePollingInterval,
} from '@/api/query-polling'
import { fetchServerRuntimeRows, type ServerRuntimeRow } from '@/api/queries/server-runtimes'
import { createWlsHttpError, withWlsRestTimeout } from '@/api/wls-errors'
import { useAuth } from '@/auth/useAuth'
import { healthTone, WLS_HEALTH_STATES, type WlsHealthState } from '@/components'
import {
  applyJmsModuleTargets,
  deploymentConfigMapEntries,
  jmsModuleTargetEntries,
  type DeploymentConfigSummary,
  type DeploymentTargetRef,
} from './deployment-config-normalization.ts'
import { applyDeploymentLifecycleSupport } from './deployment-lifecycle-support.ts'
import {
  deploymentHealthSymptoms,
  type DeploymentHealthSymptom,
} from './deployment-health-symptoms.ts'
import {
  deploymentConfigQueryParams,
  deploymentRuntimeDetailCandidates,
  deploymentRuntimeQueryParams,
} from './deployment-runtime-detail-selection.ts'
import { deploymentDataSourceKey, filterDeploymentDataSourceRows } from './deployment-datasource-filter.ts'
export {
  deploymentConfigQueryParams,
  deploymentRuntimeDetailCandidates,
  deploymentRuntimeQueryParams,
} from './deployment-runtime-detail-selection.ts'
export {
  buildDeploymentRuntimeGroups,
  type DeploymentGroupScope,
  type DeploymentRuntimeGroup,
} from './deployment-runtime-groups.ts'
export {
  deploymentHealthSymptoms,
  type DeploymentHealthSymptom,
} from './deployment-health-symptoms.ts'

export type DeploymentSeverity = 'healthy' | 'warning' | 'critical' | 'unknown'
export type DeploymentsStatus = 'available' | 'empty' | 'partial'
export type DeploymentScope = 'external' | 'internal'
export type {
  DeploymentConfigMetadata,
  DeploymentConfigSummary,
  DeploymentTargetKind,
  DeploymentTargetRef,
} from './deployment-config-normalization.ts'

export interface DeploymentRuntimeRow {
  id: string
  name: string
  deploymentName: string
  serverName: string
  targetName: string
  lifecycleSupported: boolean
  configurationSupported: boolean
  configuredTargets: DeploymentTargetRef[]
  moduleType: string | null
  deploymentOrder: number | null
  sourcePath: string | null
  planPath: string | null
  securityDDModel: string | null
  stagingMode: string | null
  healthState: WlsHealthState
  overallHealthState: WlsHealthState
  healthSymptoms: DeploymentHealthSymptom[]
  activeVersionState: number | null
  deploymentState: string | number | null
  applicationVersion: string | null
  scope: DeploymentScope
  severity: DeploymentSeverity
}

export interface DeploymentsSnapshot {
  status: DeploymentsStatus
  rows: DeploymentRuntimeRow[]
  partialFailures: Array<{ serverName: string; message: string }>
}

export interface DeploymentDataSourceNamesSnapshot {
  dataSourceNamesByServer: Map<string, Set<string>>
  partialFailures: Array<{ serverName: string; message: string }>
}

export interface DeploymentRuntimeDetailSnapshot {
  row: DeploymentRuntimeRow | null
  partialFailures: Array<{ serverName: string; message: string }>
  resolvedApplicationName: string | null
}

const EMPTY_DEPLOYMENT_CONFIGS = new Map<string, DeploymentConfigSummary>()
const EMPTY_JMS_MODULE_TARGETS = new Map<string, DeploymentTargetRef[]>()
const EMPTY_DEPLOYMENT_DATASOURCE_NAMES = new Map<string, Set<string>>()

export function deploymentsQueryKey(creds: WlsCredentials | null | undefined) {
  return ['deployments', wlsCredentialCacheKey(creds)] as const
}

export function deploymentConfigsQueryKey(creds: WlsCredentials | null | undefined) {
  return ['deploymentConfigs', wlsCredentialCacheKey(creds)] as const
}

export function deploymentLifecycleNamesQueryKey(creds: WlsCredentials | null | undefined) {
  return ['deploymentLifecycleNames', wlsCredentialCacheKey(creds)] as const
}

export function deploymentDataSourceNamesQueryKey(creds: WlsCredentials | null | undefined) {
  return ['deploymentDataSourceNames', wlsCredentialCacheKey(creds)] as const
}

export function deploymentJmsModulesQueryKey(creds: WlsCredentials | null | undefined) {
  return ['deploymentJmsModules', wlsCredentialCacheKey(creds)] as const
}

export function deploymentRuntimeDetailQueryKey(
  creds: WlsCredentials | null | undefined,
  serverName: string | null | undefined,
  deploymentName: string | null | undefined,
) {
  return ['deploymentRuntimeDetail', wlsCredentialCacheKey(creds), serverName ?? '', deploymentName ?? ''] as const
}

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readItems(data: unknown): unknown[] {
  return isObject(data) && Array.isArray(data.items) ? data.items : []
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function normalizeHealth(value: unknown): WlsHealthState {
  if (typeof value !== 'string') return 'unknown'
  const normalized = value.toLowerCase() === 'warning' ? 'warn' : value.toLowerCase()
  return WLS_HEALTH_STATES.includes(normalized as WlsHealthState)
    ? (normalized as WlsHealthState)
    : 'unknown'
}

function healthFromObject(value: unknown): WlsHealthState {
  return normalizeHealth(isObject(value) ? value.state : null)
}

function isRuntimeServer(row: ServerRuntimeRow) {
  return row.state === 'RUNNING' || row.state === 'ADMIN' || row.state === 'STANDBY'
}

function severityFromHealth(state: WlsHealthState): DeploymentSeverity {
  const tone = healthTone(state)
  if (tone === 'negative') return 'critical'
  if (tone === 'warning') return 'warning'
  if (tone === 'positive' || tone === 'neutral') return 'healthy'
  return 'unknown'
}

function worseSeverity(a: DeploymentSeverity, b: DeploymentSeverity): DeploymentSeverity {
  const order: DeploymentSeverity[] = ['unknown', 'healthy', 'warning', 'critical']
  return order.indexOf(b) > order.indexOf(a) ? b : a
}

function classifyDeployment(row: Omit<DeploymentRuntimeRow, 'id' | 'severity'>): DeploymentSeverity {
  const healthSeverity = worseSeverity(
    severityFromHealth(row.healthState),
    severityFromHealth(row.overallHealthState),
  )
  if (healthSeverity === 'critical') return 'critical'
  if (healthSeverity === 'warning') return 'warning'

  if (
    row.deploymentState !== null &&
    row.deploymentState !== 2 &&
    row.deploymentState !== 'ACTIVATED' &&
    row.deploymentState !== 'ACTIVE'
  ) {
    return 'warning'
  }

  return healthSeverity === 'unknown' ? 'unknown' : 'healthy'
}

export function normalizeDeployment(
  serverName: string,
  item: unknown,
  deploymentConfigs: ReadonlyMap<string, DeploymentConfigSummary>,
): DeploymentRuntimeRow | null {
  if (!isObject(item)) return null
  const name = readString(item.applicationName) ?? readString(item.name)
  if (!name) return null
  const deploymentName = readString(item.name) ?? name
  const deploymentConfig = deploymentConfigs.get(deploymentName) ?? deploymentConfigs.get(name) ?? null
  const metadata = deploymentConfig?.metadata

  const row = {
    name,
    deploymentName,
    serverName,
    targetName: serverName,
    lifecycleSupported: false,
    configurationSupported: deploymentConfigs.has(deploymentName) || deploymentConfigs.has(name),
    configuredTargets: deploymentConfig?.targets ?? [],
    moduleType: metadata?.moduleType ?? null,
    deploymentOrder: metadata?.deploymentOrder ?? null,
    sourcePath: metadata?.sourcePath ?? null,
    planPath: metadata?.planPath ?? null,
    securityDDModel: metadata?.securityDDModel ?? null,
    stagingMode: metadata?.stagingMode ?? null,
    healthState: healthFromObject(item.healthState),
    overallHealthState: healthFromObject(item.overallHealthState),
    healthSymptoms: deploymentHealthSymptoms(item.healthState, item.overallHealthState),
    activeVersionState: readNumber(item.activeVersionState),
    deploymentState: readString(item.deploymentState) ?? readNumber(item.deploymentState),
    applicationVersion: readString(item.applicationVersion),
    scope: readBoolean(item.internal) ? 'internal' : 'external',
  } satisfies Omit<DeploymentRuntimeRow, 'id' | 'severity'>

  return {
    id: `${serverName}:${deploymentName}`,
    ...row,
    severity: classifyDeployment(row),
  }
}

function applyDeploymentConfig(
  row: DeploymentRuntimeRow,
  deploymentConfigs: ReadonlyMap<string, DeploymentConfigSummary>,
): DeploymentRuntimeRow {
  const deploymentConfig = deploymentConfigs.get(row.deploymentName) ?? deploymentConfigs.get(row.name) ?? null
  const metadata = deploymentConfig?.metadata

  return {
    ...row,
    configurationSupported: !!deploymentConfig,
    configuredTargets: deploymentConfig?.targets ?? [],
    moduleType: metadata?.moduleType ?? null,
    deploymentOrder: metadata?.deploymentOrder ?? null,
    sourcePath: metadata?.sourcePath ?? null,
    planPath: metadata?.planPath ?? null,
    securityDDModel: metadata?.securityDDModel ?? null,
    stagingMode: metadata?.stagingMode ?? null,
  }
}

export function applyDeploymentConfigs(
  rows: DeploymentRuntimeRow[],
  deploymentConfigs: ReadonlyMap<string, DeploymentConfigSummary>,
) {
  return rows.map((row) => applyDeploymentConfig(row, deploymentConfigs))
}

export async function fetchJmsModuleTargets(creds: WlsCredentials) {
  const res = await withWlsRestTimeout('JMS modules', (signal) =>
    clientFor(creds).GET('/management/weblogic/{version}/edit/JMSSystemResources', {
      signal,
      params: { path: { version: creds.version }, query: { fields: 'name,targets', links: 'none' } },
    }),
  )
  if (res.error) throw createWlsHttpError('JMS modules', res.response, res.error)
  return new Map(readItems(res.data).flatMap(jmsModuleTargetEntries))
}

export async function fetchDeploymentConfigs(creds: WlsCredentials) {
  const res = await withWlsRestTimeout('Deployment configuration', (signal) =>
    clientFor(creds).GET('/management/weblogic/{version}/edit/appDeployments', {
      signal,
      params: {
        path: { version: creds.version },
        query: deploymentConfigQueryParams(),
      },
    }),
  )

  if (res.error) throw createWlsHttpError('Deployment configuration', res.response, res.error)

  return new Map(readItems(res.data).flatMap(deploymentConfigMapEntries))
}

interface SelectedDeploymentConfig {
  deploymentName: string
  applicationName: string | null
  configs: Map<string, DeploymentConfigSummary>
}

async function fetchSelectedDeploymentConfig(
  creds: WlsCredentials,
  deploymentName: string,
): Promise<SelectedDeploymentConfig> {
  const res = await withWlsRestTimeout(`Deployment configuration ${deploymentName}`, (signal) =>
    clientFor(creds).GET('/management/weblogic/{version}/edit/appDeployments/{deploymentName}', {
      signal,
      params: {
        path: { version: creds.version, deploymentName },
        query: deploymentConfigQueryParams(),
      },
    }),
  )

  if (res.error) throw createWlsHttpError(`Deployment configuration ${deploymentName}`, res.response, res.error)

  const item: Record<string, unknown> = isObject(res.data) ? res.data : {}
  return {
    deploymentName: readString(item.name) ?? deploymentName,
    applicationName: readString(item.applicationName),
    configs: new Map(deploymentConfigMapEntries(res.data)),
  }
}

async function fetchSelectedDeploymentRuntime(creds: WlsCredentials, serverName: string, applicationName: string) {
  const res = await withWlsRestTimeout(`Application ${serverName}/${applicationName}`, (signal) =>
    clientFor(creds).GET(
      '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/applicationRuntimes/{applicationName}',
      {
        signal,
        params: {
          path: { version: creds.version, serverName, applicationName },
          query: deploymentRuntimeQueryParams(),
        },
      },
    ),
  )

  if (res.error) throw createWlsHttpError(`Application ${serverName}/${applicationName}`, res.response, res.error)
  return res.data
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error'
}

function normalizeSelectedDeployment(
  serverName: string,
  routeDeploymentName: string,
  runtimeItem: unknown,
  selectedConfig: SelectedDeploymentConfig | null,
): DeploymentRuntimeRow | null {
  const configApplicationName = selectedConfig?.applicationName ?? null
  const configDeploymentName = selectedConfig?.deploymentName ?? null
  const fallbackItem =
    runtimeItem ??
    ({
      name: configDeploymentName ?? routeDeploymentName,
      applicationName: configApplicationName ?? routeDeploymentName,
    } satisfies Record<string, unknown>)
  const row = normalizeDeployment(serverName, fallbackItem, selectedConfig?.configs ?? EMPTY_DEPLOYMENT_CONFIGS)
  if (!row) return null

  const runtimeApplicationName = isObject(runtimeItem)
    ? (readString(runtimeItem.applicationName) ?? readString(runtimeItem.name))
    : null
  const name = runtimeApplicationName ?? configApplicationName ?? row.name
  const deploymentName = configDeploymentName ?? row.deploymentName

  return {
    ...row,
    id: `${serverName}:${deploymentName}`,
    name,
    deploymentName,
  }
}

export async function fetchDeploymentRuntimeDetail(
  creds: WlsCredentials,
  serverName: string,
  deploymentName: string,
): Promise<DeploymentRuntimeDetailSnapshot> {
  const [configOutcome, runtimeOutcome] = await Promise.allSettled([
    fetchSelectedDeploymentConfig(creds, deploymentName),
    fetchSelectedDeploymentRuntime(creds, serverName, deploymentName),
  ])
  const selectedConfig = configOutcome.status === 'fulfilled' ? configOutcome.value : null
  let selectedRuntimeOutcome = runtimeOutcome
  let resolvedApplicationName =
    runtimeOutcome.status === 'fulfilled'
      ? isObject(runtimeOutcome.value)
        ? (readString(runtimeOutcome.value.applicationName) ?? readString(runtimeOutcome.value.name))
        : null
      : null
  const candidates = deploymentRuntimeDetailCandidates(deploymentName, selectedConfig?.applicationName ?? null)
  const fallbackApplicationName = candidates.find((candidate) => candidate !== deploymentName) ?? null

  if (runtimeOutcome.status === 'rejected' && fallbackApplicationName) {
    const fallbackOutcome = await Promise.allSettled([
      fetchSelectedDeploymentRuntime(creds, serverName, fallbackApplicationName),
    ])
    selectedRuntimeOutcome = fallbackOutcome[0] ?? runtimeOutcome
    if (selectedRuntimeOutcome.status === 'fulfilled') resolvedApplicationName = fallbackApplicationName
  }

  const runtimeItem = selectedRuntimeOutcome.status === 'fulfilled' ? selectedRuntimeOutcome.value : null
  const row = normalizeSelectedDeployment(serverName, deploymentName, runtimeItem, selectedConfig)

  return {
    row,
    resolvedApplicationName: resolvedApplicationName ?? selectedConfig?.applicationName ?? deploymentName,
    partialFailures: [
      ...(configOutcome.status === 'fulfilled'
        ? []
        : [{ serverName: `edit/appDeployments/${deploymentName}`, message: failureMessage(configOutcome.reason) }]),
      ...(selectedRuntimeOutcome.status === 'fulfilled'
        ? []
        : [
            {
              serverName: `${serverName}/applicationRuntimes/${fallbackApplicationName ?? deploymentName}`,
              message: failureMessage(selectedRuntimeOutcome.reason),
            },
          ]),
    ],
  }
}

export async function fetchDeploymentLifecycleNames(creds: WlsCredentials) {
  const res = await withWlsRestTimeout('Deployment lifecycle runtimes', (signal) =>
    clientFor(creds).GET('/management/weblogic/{version}/domainRuntime/deploymentManager/appDeploymentRuntimes', {
      signal,
      params: {
        path: { version: creds.version },
        query: {
          fields: 'name,applicationName',
          links: 'none',
        },
      },
    }),
  )

  if (res.error) throw createWlsHttpError('Deployment lifecycle runtimes', res.response, res.error)

  return new Set(
    readItems(res.data).flatMap((item) => {
      if (!isObject(item)) return []
      return [readString(item.name), readString(item.applicationName)].filter((value): value is string => !!value)
    }),
  )
}

async function fetchServerDataSourceNames(creds: WlsCredentials, server: ServerRuntimeRow) {
  const res = await withWlsRestTimeout(`JDBC filter ${server.name}`, (signal) =>
    clientFor(creds).GET(
      '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans',
      {
        signal,
        params: {
          path: { version: creds.version, serverName: server.name },
          query: {
            fields: 'name',
            links: 'none',
          },
        },
      },
    ),
  )

  if (res.error) throw createWlsHttpError(`JDBC filter ${server.name}`, res.response, res.error)

  return new Set(
    readItems(res.data).flatMap((item) => {
      if (!isObject(item)) return []
      const name = readString(item.name)
      return name ? [deploymentDataSourceKey(server.name, name)] : []
    }),
  )
}

export async function fetchDeploymentDataSourceNames(creds: WlsCredentials): Promise<DeploymentDataSourceNamesSnapshot> {
  const servers = await fetchServerRuntimeRows(creds)
  const runningServers = servers.filter(isRuntimeServer)
  const outcomes = await Promise.allSettled(runningServers.map((server) => fetchServerDataSourceNames(creds, server)))

  const dataSourceNamesByServer = new Map(
    outcomes.flatMap((outcome, index) => {
      const server = runningServers[index]
      return outcome.status === 'fulfilled' && server ? [[server.name, outcome.value] as const] : []
    }),
  )
  const partialFailures = outcomes.flatMap((outcome, index) => {
    if (outcome.status === 'fulfilled') return []
    const serverName = runningServers[index]?.name ?? 'unknown'
    const message = outcome.reason instanceof Error ? outcome.reason.message : 'Unknown error'
    return [{ serverName, message }]
  })

  return {
    dataSourceNamesByServer,
    partialFailures,
  }
}

async function fetchServerDeployments(
  creds: WlsCredentials,
  server: ServerRuntimeRow,
  deploymentConfigs: ReadonlyMap<string, DeploymentConfigSummary>,
  dataSourceNames: ReadonlySet<string>,
) {
  const res = await withWlsRestTimeout(`Applications ${server.name}`, (signal) =>
    clientFor(creds).GET(
      '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/applicationRuntimes',
      {
        signal,
        params: {
          path: { version: creds.version, serverName: server.name },
          query: {
            ...deploymentRuntimeQueryParams(),
          },
        },
      },
    ),
  )

  if (res.error) throw createWlsHttpError(`Applications ${server.name}`, res.response, res.error)
  const rows = readItems(res.data).flatMap((item) => {
    const row = normalizeDeployment(server.name, item, deploymentConfigs)
    return row ? [row] : []
  })
  return filterDeploymentDataSourceRows(rows, new Map([[server.name, dataSourceNames]]))
}

export async function fetchDeploymentsSnapshot(
  creds: WlsCredentials,
  deploymentConfigs: ReadonlyMap<string, DeploymentConfigSummary> = EMPTY_DEPLOYMENT_CONFIGS,
  dataSourceNamesByServer: ReadonlyMap<string, ReadonlySet<string>> = EMPTY_DEPLOYMENT_DATASOURCE_NAMES,
): Promise<DeploymentsSnapshot> {
  const servers = await fetchServerRuntimeRows(creds)
  const runningServers = servers.filter(isRuntimeServer)
  const outcomes = await Promise.allSettled(
    runningServers.map((server) =>
      fetchServerDeployments(
        creds,
        server,
        deploymentConfigs,
        dataSourceNamesByServer.get(server.name) ?? new Set(),
      ),
    ),
  )

  const rows = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []))
  const partialFailures = [
    ...outcomes.flatMap((outcome, index) => {
      if (outcome.status === 'fulfilled') return []
      const serverName = runningServers[index]?.name ?? 'unknown'
      const message = outcome.reason instanceof Error ? outcome.reason.message : 'Unknown error'
      return [{ serverName, message }]
    }),
  ]

  return {
    status: partialFailures.length ? 'partial' : rows.length ? 'available' : 'empty',
    rows,
    partialFailures,
  }
}

export function useDeployments() {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval()
  const configQuery = useQuery({
    queryKey: deploymentConfigsQueryKey(creds),
    enabled: !!creds,
    staleTime: 60_000,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchDeploymentConfigs(creds)
    },
  })

  const jmsModulesQuery = useQuery({
    queryKey: deploymentJmsModulesQueryKey(creds),
    enabled: !!creds,
    staleTime: 60_000,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchJmsModuleTargets(creds)
    },
  })

  const lifecycleQuery = useQuery({
    queryKey: deploymentLifecycleNamesQueryKey(creds),
    enabled: !!creds,
    staleTime: 60_000,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchDeploymentLifecycleNames(creds)
    },
  })

  const dataSourceNamesQuery = useQuery({
    queryKey: deploymentDataSourceNamesQueryKey(creds),
    enabled: !!creds,
    staleTime: 60_000,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchDeploymentDataSourceNames(creds)
    },
  })

  const snapshotQuery = useQuery({
    queryKey: deploymentsQueryKey(creds),
    enabled: !!creds,
    staleTime: 0,
    refetchInterval: livePollingInterval,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchDeploymentsSnapshot(
        creds,
        configQuery.data ?? EMPTY_DEPLOYMENT_CONFIGS,
        dataSourceNamesQuery.data?.dataSourceNamesByServer ?? EMPTY_DEPLOYMENT_DATASOURCE_NAMES,
      )
    },
  })
  const data = useMemo(() => {
    if (!snapshotQuery.data) return undefined
    const rowsWithConfig = applyJmsModuleTargets(
      applyDeploymentConfigs(snapshotQuery.data.rows, configQuery.data ?? EMPTY_DEPLOYMENT_CONFIGS),
      jmsModulesQuery.data ?? EMPTY_JMS_MODULE_TARGETS,
    )
    const rowsWithDataSourcesFiltered = filterDeploymentDataSourceRows(
      rowsWithConfig,
      dataSourceNamesQuery.data?.dataSourceNamesByServer ?? EMPTY_DEPLOYMENT_DATASOURCE_NAMES,
    )
    const lifecycleNames = lifecycleQuery.data ?? new Set<string>()
    const configFailures =
      configQuery.isError
        ? [
            {
              serverName: 'edit/appDeployments',
              message:
                configQuery.error instanceof Error
                  ? configQuery.error.message
                  : 'Deployment configuration discovery unavailable',
            },
          ]
        : []
    const lifecycleFailures =
      lifecycleQuery.isError
        ? [
            {
              serverName: 'deploymentManager',
              message:
                lifecycleQuery.error instanceof Error
                  ? lifecycleQuery.error.message
                  : 'Deployment lifecycle discovery unavailable',
            },
          ]
        : []
    const dataSourceFailures =
      dataSourceNamesQuery.isError
        ? [
            {
              serverName: 'JDBCDataSourceRuntimeMBeans',
              message:
                dataSourceNamesQuery.error instanceof Error
                  ? dataSourceNamesQuery.error.message
                  : 'Deployment datasource filter discovery unavailable',
            },
          ]
        : (dataSourceNamesQuery.data?.partialFailures ?? [])
    const jmsModuleFailures =
      jmsModulesQuery.isError
        ? [
            {
              serverName: 'edit/JMSSystemResources',
              message:
                jmsModulesQuery.error instanceof Error
                  ? jmsModulesQuery.error.message
                  : 'JMS module target discovery unavailable',
            },
          ]
        : []

    return {
      ...snapshotQuery.data,
      rows: applyDeploymentLifecycleSupport(rowsWithDataSourcesFiltered, lifecycleNames),
      partialFailures: [
        ...configFailures,
        ...lifecycleFailures,
        ...dataSourceFailures,
        ...jmsModuleFailures,
        ...snapshotQuery.data.partialFailures,
      ],
      status:
        configFailures.length || lifecycleFailures.length || dataSourceFailures.length || jmsModuleFailures.length
          ? 'partial'
          : snapshotQuery.data.status,
    } satisfies DeploymentsSnapshot
  }, [
    configQuery.data,
    configQuery.error,
    configQuery.isError,
    jmsModulesQuery.data,
    jmsModulesQuery.error,
    jmsModulesQuery.isError,
    dataSourceNamesQuery.data,
    dataSourceNamesQuery.error,
    dataSourceNamesQuery.isError,
    lifecycleQuery.data,
    lifecycleQuery.error,
    lifecycleQuery.isError,
    snapshotQuery.data,
  ])

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds,
    isFetching:
      snapshotQuery.isFetching ||
      configQuery.isFetching ||
      lifecycleQuery.isFetching ||
      dataSourceNamesQuery.isFetching ||
      jmsModulesQuery.isFetching,
    isStale:
      snapshotQuery.isStale ||
      configQuery.isStale ||
      lifecycleQuery.isStale ||
      dataSourceNamesQuery.isStale ||
      jmsModulesQuery.isStale,
    refetch: async () => {
      const [snapshotResult] = await Promise.all([
        snapshotQuery.refetch(),
        configQuery.refetch(),
        lifecycleQuery.refetch(),
        dataSourceNamesQuery.refetch(),
        jmsModulesQuery.refetch(),
      ])
      return snapshotResult
    },
  })

  return {
    ...snapshotQuery,
    data,
    dataUpdatedAt: Math.max(
      snapshotQuery.dataUpdatedAt,
      configQuery.dataUpdatedAt,
      lifecycleQuery.dataUpdatedAt,
      dataSourceNamesQuery.dataUpdatedAt,
      jmsModulesQuery.dataUpdatedAt,
    ),
    isFetching:
      snapshotQuery.isFetching ||
      configQuery.isFetching ||
      lifecycleQuery.isFetching ||
      dataSourceNamesQuery.isFetching ||
      jmsModulesQuery.isFetching,
    refetch: async () => {
      const [snapshotResult] = await Promise.all([
        snapshotQuery.refetch(),
        configQuery.refetch(),
        lifecycleQuery.refetch(),
        dataSourceNamesQuery.refetch(),
        jmsModulesQuery.refetch(),
      ])
      return snapshotResult
    },
  }
}

export function useDeploymentRuntimeDetail(serverName: string | null, deploymentName: string | null) {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval()
  const lifecycleQuery = useQuery({
    queryKey: deploymentLifecycleNamesQueryKey(creds),
    enabled: !!creds,
    staleTime: 60_000,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchDeploymentLifecycleNames(creds)
    },
  })

  const detailQuery = useQuery({
    queryKey: deploymentRuntimeDetailQueryKey(creds, serverName, deploymentName),
    enabled: !!creds && !!serverName && !!deploymentName,
    staleTime: 0,
    refetchInterval: livePollingInterval,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      if (!creds || !serverName || !deploymentName) throw new Error('deployment detail query disabled')
      return fetchDeploymentRuntimeDetail(creds, serverName, deploymentName)
    },
  })

  const data = useMemo(() => {
    if (!detailQuery.data) return undefined
    const lifecycleNames = lifecycleQuery.data ?? new Set<string>()
    const row = detailQuery.data.row
    const lifecycleRows = row ? applyDeploymentLifecycleSupport([row], lifecycleNames) : []
    const lifecycleFailures =
      lifecycleQuery.isError
        ? [
            {
              serverName: 'deploymentManager',
              message:
                lifecycleQuery.error instanceof Error
                  ? lifecycleQuery.error.message
                  : 'Deployment lifecycle discovery unavailable',
            },
          ]
        : []

    return {
      ...detailQuery.data,
      row: lifecycleRows[0] ?? row,
      partialFailures: [...lifecycleFailures, ...detailQuery.data.partialFailures],
    } satisfies DeploymentRuntimeDetailSnapshot
  }, [detailQuery.data, lifecycleQuery.data, lifecycleQuery.error, lifecycleQuery.isError])

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds && !!serverName && !!deploymentName,
    isFetching: detailQuery.isFetching || lifecycleQuery.isFetching,
    isStale: detailQuery.isStale || lifecycleQuery.isStale,
    refetch: async () => {
      const [detailResult] = await Promise.all([detailQuery.refetch(), lifecycleQuery.refetch()])
      return detailResult
    },
  })

  return {
    ...detailQuery,
    data,
    dataUpdatedAt: Math.max(detailQuery.dataUpdatedAt, lifecycleQuery.dataUpdatedAt),
    isFetching: detailQuery.isFetching || lifecycleQuery.isFetching,
    refetch: async () => {
      const [detailResult] = await Promise.all([detailQuery.refetch(), lifecycleQuery.refetch()])
      return detailResult
    },
  }
}
