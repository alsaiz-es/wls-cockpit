import { useQuery, type QueryClient } from '@tanstack/react-query'
import {
  WLS_REST_PROXY_BASE_URL,
  wlsBasicAuthHeader,
  wlsCredentialCacheKey,
  type WlsCredentials,
} from '../client.ts'
import type { WlsVersion } from '../wls-version.ts'
import { actionAuditHeaders } from '../action-audit-headers.ts'
import { WLS_TARGET_HEADER } from '../proxy-target.ts'
import { useRefreshStaleQueryOnVisibleReturn } from '../query-polling.ts'
import { normalizeWlsRestError, WlsRestError, withWlsRestTimeout } from '../wls-errors.ts'
import { runInEditSession } from './edit-session-transaction.ts'
import { useAuth } from '../../auth/useAuth.ts'
import { editSessionStatusQueryKey } from './edit-sessions.ts'
import {
  fieldSupportsMutation,
  topologyEndpointById,
  topologyEndpointFieldNames,
  topologyEndpointsFor,
  type TopologyEndpointCatalog,
  type TopologyFieldMetadata,
  type TopologyResourceKind,
} from './topology-configuration-catalog.ts'

export const TOPOLOGY_CONFIGURATION_REQUEST_TIMEOUT_MS = 10_000
export const TOPOLOGY_CONFIGURATION_TRANSACTION_TIMEOUT_MS = 120_000
export const TOPOLOGY_CONFIGURATION_REQUESTED_BY = 'wls-cockpit'

export type TopologyReferenceKind =
  | 'clusters'
  | 'dynamicServers'
  | 'machines'
  | 'networkAccessPoints'
  | 'serverTemplates'
  | 'servers'

export type TopologyReferenceTuple = [TopologyReferenceKind, string]

export interface TopologyPartialFailure {
  resourceKind: TopologyResourceKind
  resourceName: string | null
  endpointId: string
  sectionId: string
  message: string
}

export interface TopologySectionData {
  endpointId: string
  sectionId: string
  sectionLabel: string
  path: string
  fields: string[]
  data: unknown
}

export interface TopologyConfiguredResource {
  kind: TopologyResourceKind
  name: string
  root: Record<string, unknown>
  sections: TopologySectionData[]
  partialFailures: TopologyPartialFailure[]
}

export interface TopologyConfigurationSnapshot {
  servers: TopologyConfiguredResource[]
  clusters: TopologyConfiguredResource[]
  partialFailures: TopologyPartialFailure[]
}

export interface TopologyMutationStep {
  operation: string
  method: 'DELETE' | 'POST'
  path: string
  body?: Record<string, unknown>
}

export interface TopologyMutationResult {
  operation: string
  steps: string[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readItems(data: unknown): unknown[] {
  return isObject(data) && Array.isArray(data.items) ? data.items : []
}

function queryString(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}

export function topologyManagementPath(version: WlsVersion, path: string, params?: Record<string, string>) {
  const suffix = params ? `?${queryString(params)}` : ''
  return `/management/weblogic/${encodeURIComponent(version)}${path}${suffix}`
}

function replacePathParam(template: string, param: string, value: string) {
  return template.replace(`{${param}}`, encodeURIComponent(value))
}

export function topologyEndpointPath(
  version: WlsVersion,
  endpoint: Pick<TopologyEndpointCatalog, 'pathTemplate'>,
  options: { resourceName: string; childName?: string | null },
) {
  let path = endpoint.pathTemplate
  path = path
    .replace('{serverName}', encodeURIComponent(options.resourceName))
    .replace('{clusterName}', encodeURIComponent(options.resourceName))
  if (options.childName) {
    path = replacePathParam(path, 'channelName', options.childName)
  }
  return topologyManagementPath(version, path)
}

export function topologyEndpointCollectionPath(
  version: WlsVersion,
  endpoint: Pick<TopologyEndpointCatalog, 'collectionPathTemplate'>,
  resourceName?: string,
) {
  if (!endpoint.collectionPathTemplate) return null
  let path = endpoint.collectionPathTemplate
  if (resourceName) {
    path = path
      .replace('{serverName}', encodeURIComponent(resourceName))
      .replace('{clusterName}', encodeURIComponent(resourceName))
  }
  return topologyManagementPath(version, path)
}

export function topologyEndpointQuery(endpoint: Pick<TopologyEndpointCatalog, 'fields'>) {
  return {
    fields: topologyEndpointFieldNames(endpoint),
    links: 'none',
  }
}

function topologyRootEndpointQuery(resourceKind: TopologyResourceKind, version: WlsVersion) {
  const fields = topologyEndpointsFor(resourceKind, version)
    .filter((endpoint) => endpoint.endpointKind === 'root')
    .flatMap((endpoint) => endpoint.fields.map((field) => field.jsonProperty))
  return {
    fields: [...new Set(fields)].join(','),
    links: 'none',
  }
}

function pathWithQuery(path: string, params: Record<string, string>) {
  return `${path}?${queryString(params)}`
}

async function fetchWlsJson(creds: WlsCredentials, operation: string, path: string, timeoutMs = TOPOLOGY_CONFIGURATION_REQUEST_TIMEOUT_MS) {
  try {
    const response = await withWlsRestTimeout(
      operation,
      (signal) =>
        fetch(`${WLS_REST_PROXY_BASE_URL}${path}`, {
          signal,
          headers: {
            Accept: 'application/json',
            Authorization: wlsBasicAuthHeader(creds),
            [WLS_TARGET_HEADER]: creds.targetUrl,
          },
        }),
      timeoutMs,
    )

    if (!response.ok) {
      throw new WlsRestError({
        kind: 'http',
        operation,
        status: response.status,
        statusText: response.statusText,
        message: `${operation}: HTTP ${response.status} ${response.statusText || 'HTTP error'}`,
      })
    }

    if (response.status === 204) return null
    const text = await response.text()
    return text ? JSON.parse(text) : null
  } catch (error) {
    throw normalizeWlsRestError(operation, error, timeoutMs)
  }
}

async function mutateWlsJson(
  creds: WlsCredentials,
  step: TopologyMutationStep,
  timeoutMs = TOPOLOGY_CONFIGURATION_TRANSACTION_TIMEOUT_MS,
) {
  try {
    const response = await withWlsRestTimeout(
      step.operation,
      (signal) =>
        fetch(`${WLS_REST_PROXY_BASE_URL}${step.path}`, {
          method: step.method,
          signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: wlsBasicAuthHeader(creds),
            'X-Requested-By': TOPOLOGY_CONFIGURATION_REQUESTED_BY,
            ...actionAuditHeaders(creds),
          },
          body: step.method === 'DELETE' ? undefined : JSON.stringify(step.body ?? {}),
        }),
      timeoutMs,
    )

    if (!response.ok) {
      throw new WlsRestError({
        kind: 'http',
        operation: step.operation,
        status: response.status,
        statusText: response.statusText,
        message: `${step.operation}: HTTP ${response.status} ${response.statusText || 'HTTP error'}`,
      })
    }

    if (response.status === 204) return null
    const text = await response.text()
    return text ? JSON.parse(text) : null
  } catch (error) {
    throw normalizeWlsRestError(step.operation, error, timeoutMs)
  }
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Topology configuration request failed.'
}

function rootEndpoint(kind: TopologyResourceKind, version: WlsVersion) {
  const endpoint = topologyEndpointById(`${kind}.root`, version)
  if (!endpoint) throw new Error(`Topology ${kind} root endpoint is unavailable for ${version}.`)
  return endpoint
}

function childEndpoints(kind: TopologyResourceKind, version: WlsVersion) {
  return topologyEndpointsFor(kind, version).filter((endpoint) => endpoint.endpointKind !== 'root')
}

function normalizeNamedRows(data: unknown): Record<string, unknown>[] {
  return readItems(data).flatMap((item) => {
    if (!isObject(item)) return []
    const name = readString(item.name)
    return name ? [{ ...item, name }] : []
  })
}

function sectionFields(endpoint: TopologyEndpointCatalog) {
  return endpoint.fields.map((field) => field.jsonProperty)
}

async function fetchTopologySection(
  creds: WlsCredentials,
  resourceName: string,
  endpoint: TopologyEndpointCatalog,
): Promise<TopologySectionData> {
  const basePath = endpoint.endpointKind === 'collection-child'
    ? topologyEndpointCollectionPath(creds.version, endpoint, resourceName)
    : topologyEndpointPath(creds.version, endpoint, { resourceName })
  if (!basePath) throw new Error(`Topology endpoint ${endpoint.id} has no collection path.`)
  const path = pathWithQuery(basePath, topologyEndpointQuery(endpoint))
  const data = await fetchWlsJson(creds, `${endpoint.sectionLabel} ${resourceName}`, path)
  return {
    endpointId: endpoint.id,
    sectionId: endpoint.sectionId,
    sectionLabel: endpoint.sectionLabel,
    path,
    fields: sectionFields(endpoint),
    data,
  }
}

async function fetchTopologyResource(
  creds: WlsCredentials,
  resourceKind: TopologyResourceKind,
  seed: Record<string, unknown>,
): Promise<TopologyConfiguredResource> {
  const name = readString(seed.name)
  if (!name) throw new Error(`Topology ${resourceKind} row is missing a name.`)

  const root = rootEndpoint(resourceKind, creds.version)
  const failures: TopologyPartialFailure[] = []
  let rootData: Record<string, unknown> = seed
  try {
    const rootPath = pathWithQuery(
      topologyEndpointPath(creds.version, root, { resourceName: name }),
      topologyRootEndpointQuery(resourceKind, creds.version),
    )
    const data = await fetchWlsJson(creds, `${root.sectionLabel} ${name}`, rootPath)
    if (isObject(data)) rootData = data
  } catch (error) {
    failures.push({
      resourceKind,
      resourceName: name,
      endpointId: root.id,
      sectionId: root.sectionId,
      message: failureMessage(error),
    })
  }

  const endpoints = childEndpoints(resourceKind, creds.version)
  const childResults = await Promise.allSettled(
    endpoints.map((endpoint) => fetchTopologySection(creds, name, endpoint)),
  )
  const sections = childResults.flatMap((result, index) => {
    const endpoint = endpoints[index]
    if (result.status === 'fulfilled') return [result.value]
    failures.push({
      resourceKind,
      resourceName: name,
      endpointId: endpoint?.id ?? `${resourceKind}.unknown`,
      sectionId: endpoint?.sectionId ?? 'unknown',
      message: failureMessage(result.reason),
    })
    return []
  })

  return {
    kind: resourceKind,
    name,
    root: rootData,
    sections,
    partialFailures: failures,
  }
}

async function fetchTopologyResources(creds: WlsCredentials, resourceKind: TopologyResourceKind) {
  const endpoint = rootEndpoint(resourceKind, creds.version)
  const collectionPath = topologyEndpointCollectionPath(creds.version, endpoint)
  if (!collectionPath) throw new Error(`Topology ${resourceKind} collection endpoint is unavailable.`)
  const data = await fetchWlsJson(
    creds,
    `${resourceKind === 'server' ? 'Server' : 'Cluster'} configuration list`,
    pathWithQuery(collectionPath, { fields: 'name', links: 'none' }),
  )
  const seeds = normalizeNamedRows(data)
  return Promise.all(seeds.map((seed) => fetchTopologyResource(creds, resourceKind, seed)))
}

export function topologyConfigurationQueryKey(creds: WlsCredentials | null | undefined) {
  return ['topologyConfiguration', wlsCredentialCacheKey(creds)] as const
}

export async function fetchTopologyConfigurationSnapshot(creds: WlsCredentials): Promise<TopologyConfigurationSnapshot> {
  const [serversResult, clustersResult] = await Promise.allSettled([
    fetchTopologyResources(creds, 'server'),
    fetchTopologyResources(creds, 'cluster'),
  ])
  const partialFailures: TopologyPartialFailure[] = []
  const servers = serversResult.status === 'fulfilled' ? serversResult.value : []
  const clusters = clustersResult.status === 'fulfilled' ? clustersResult.value : []

  if (serversResult.status === 'rejected') {
    partialFailures.push({
      resourceKind: 'server',
      resourceName: null,
      endpointId: 'server.root',
      sectionId: 'identity',
      message: failureMessage(serversResult.reason),
    })
  }
  if (clustersResult.status === 'rejected') {
    partialFailures.push({
      resourceKind: 'cluster',
      resourceName: null,
      endpointId: 'cluster.root',
      sectionId: 'identity',
      message: failureMessage(clustersResult.reason),
    })
  }

  partialFailures.push(
    ...servers.flatMap((server) => server.partialFailures),
    ...clusters.flatMap((cluster) => cluster.partialFailures),
  )

  return {
    servers,
    clusters,
    partialFailures,
  }
}

export function useTopologyConfigurationSnapshot({ enabled = true }: { enabled?: boolean } = {}) {
  const { creds } = useAuth()
  const queryEnabled = enabled && !!creds
  const query = useQuery({
    queryKey: topologyConfigurationQueryKey(creds),
    enabled: queryEnabled,
    staleTime: 60_000,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchTopologyConfigurationSnapshot(creds)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: queryEnabled,
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return query
}

export function topologyReference(kind: TopologyReferenceKind, name: string): TopologyReferenceTuple {
  const normalized = name.trim()
  if (!normalized) throw new Error('Topology reference name is required.')
  return [kind, normalized]
}

export function serverReference(name: string) {
  return topologyReference('servers', name)
}

export function clusterReference(name: string) {
  return topologyReference('clusters', name)
}

export function machineReference(name: string) {
  return topologyReference('machines', name)
}

export function serverTemplateReference(name: string) {
  return topologyReference('serverTemplates', name)
}

export function networkChannelReference(name: string) {
  return topologyReference('networkAccessPoints', name)
}

export function dynamicServersReference(name: string) {
  return topologyReference('dynamicServers', name)
}

export function topologyReferenceList(references: TopologyReferenceTuple[]) {
  return references.map((reference) => [...reference] as TopologyReferenceTuple)
}

export function readTopologyReferenceName(value: unknown, expectedKind: TopologyReferenceKind) {
  if (Array.isArray(value)) {
    const kind = readString(value[0])
    const name = readString(value[1])
    return kind === expectedKind ? name : null
  }
  if (isObject(value) && Array.isArray(value.identity)) {
    return readTopologyReferenceName(value.identity, expectedKind)
  }
  return null
}

export function readTopologyReferenceNames(value: unknown, expectedKind: TopologyReferenceKind) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const name = readTopologyReferenceName(item, expectedKind)
    return name ? [name] : []
  })
}

function definedFields(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

function endpointFieldsForMutation(endpoint: TopologyEndpointCatalog, mode: 'create' | 'update') {
  return new Map(endpoint.fields
    .filter((field) => fieldSupportsMutation(field, mode))
    .map((field) => [field.jsonProperty, field]))
}

function rootFieldsForMutation(resourceKind: TopologyResourceKind, version: WlsVersion, mode: 'create' | 'update') {
  return new Map(topologyEndpointsFor(resourceKind, version)
    .filter((endpoint) => endpoint.endpointKind === 'root')
    .flatMap((endpoint) => endpoint.fields)
    .filter((field) => fieldSupportsMutation(field, mode))
    .map((field) => [field.jsonProperty, field]))
}

function payloadFromAllowedFields(
  input: Record<string, unknown>,
  allowed: Map<string, TopologyFieldMetadata>,
  label: string,
) {
  const unknownFields = Object.keys(input).filter((field) => !allowed.has(field))
  if (unknownFields.length) {
    throw new Error(`Unsupported topology field${unknownFields.length === 1 ? '' : 's'} for ${label}: ${unknownFields.join(', ')}.`)
  }
  return definedFields(input)
}

export function topologyMutationPayload(
  endpointId: string,
  version: WlsVersion,
  input: Record<string, unknown>,
  mode: 'create' | 'update',
) {
  const endpoint = topologyEndpointById(endpointId, version)
  if (!endpoint) throw new Error(`Topology endpoint ${endpointId} is unavailable for ${version}.`)
  const allowed = endpointFieldsForMutation(endpoint, mode)
  return payloadFromAllowedFields(input, allowed, endpointId)
}

export function topologyRootMutationPayload(
  resourceKind: TopologyResourceKind,
  version: WlsVersion,
  input: Record<string, unknown>,
  mode: 'create' | 'update',
) {
  return payloadFromAllowedFields(input, rootFieldsForMutation(resourceKind, version, mode), `${resourceKind}.root`)
}

export function sanitizeTopologyPayloadForFeedback(
  endpointId: string,
  version: WlsVersion,
  input: Record<string, unknown>,
) {
  const endpoint = topologyEndpointById(endpointId, version)
  if (!endpoint) return {}
  const fieldsByName = new Map(endpoint.fields.map((field) => [field.jsonProperty, field]))
  return Object.fromEntries(Object.entries(input).map(([fieldName, value]) => {
    const field = fieldsByName.get(fieldName)
    if (field?.sensitive || field?.writeSupport === 'write-only') return [fieldName, '[redacted]']
    return [fieldName, value]
  }))
}

function assertCapability(endpoint: TopologyEndpointCatalog, capability: 'create' | 'delete' | 'update') {
  if (!endpoint.capabilities.includes(capability)) {
    throw new Error(`Topology endpoint ${endpoint.id} does not support ${capability}.`)
  }
}

function startEditStep(creds: WlsCredentials): TopologyMutationStep {
  return {
    operation: 'Start edit session',
    method: 'POST',
    path: topologyManagementPath(creds.version, '/edit/changeManager/startEdit'),
    body: {},
  }
}

function activateEditStep(creds: WlsCredentials): TopologyMutationStep {
  return {
    operation: 'Activate edit session',
    method: 'POST',
    path: topologyManagementPath(creds.version, '/edit/changeManager/activate'),
    body: {},
  }
}

function cancelEditStep(creds: WlsCredentials): TopologyMutationStep {
  return {
    operation: 'Cancel edit session',
    method: 'POST',
    path: topologyManagementPath(creds.version, '/edit/changeManager/cancelEdit'),
    body: {},
  }
}

export async function runTopologyEditTransaction(
  creds: WlsCredentials,
  operation: string,
  mutationSteps: TopologyMutationStep[],
): Promise<TopologyMutationResult> {
  return runInEditSession(
    {
      startEdit: () => mutateWlsJson(creds, startEditStep(creds)),
      activate: () => mutateWlsJson(creds, activateEditStep(creds)),
      cancelEdit: () => mutateWlsJson(creds, cancelEditStep(creds)),
    },
    async () => {
      for (const step of mutationSteps) {
        await mutateWlsJson(creds, step)
      }
      return {
        operation,
        steps: mutationSteps.map((step) => step.operation),
      }
    },
  )
}

function rootCreatePath(creds: WlsCredentials, kind: TopologyResourceKind) {
  const endpoint = rootEndpoint(kind, creds.version)
  assertCapability(endpoint, 'create')
  const path = topologyEndpointCollectionPath(creds.version, endpoint)
  if (!path) throw new Error(`Topology ${kind} collection endpoint is unavailable.`)
  return { endpoint, path }
}

function rootResourcePath(creds: WlsCredentials, kind: TopologyResourceKind, name: string, capability: 'delete' | 'update') {
  const endpoint = rootEndpoint(kind, creds.version)
  assertCapability(endpoint, capability)
  return {
    endpoint,
    path: topologyEndpointPath(creds.version, endpoint, { resourceName: name }),
  }
}

function requireName(name: string, label: string) {
  const normalized = name.trim()
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}

export function createTopologyResourceStep(
  creds: WlsCredentials,
  kind: TopologyResourceKind,
  name: string,
  input: Record<string, unknown> = {},
): TopologyMutationStep {
  const normalizedName = requireName(name, kind === 'server' ? 'Server name' : 'Cluster name')
  const { path } = rootCreatePath(creds, kind)
  const body = topologyRootMutationPayload(kind, creds.version, { name: normalizedName, ...input }, 'create')
  return {
    operation: `Create ${kind} ${normalizedName}`,
    method: 'POST',
    path,
    body,
  }
}

export function updateTopologyResourceStep(
  creds: WlsCredentials,
  kind: TopologyResourceKind,
  name: string,
  input: Record<string, unknown>,
): TopologyMutationStep {
  const normalizedName = requireName(name, kind === 'server' ? 'Server name' : 'Cluster name')
  const { path } = rootResourcePath(creds, kind, normalizedName, 'update')
  const body = topologyRootMutationPayload(kind, creds.version, input, 'update')
  return {
    operation: `Update ${kind} ${normalizedName}`,
    method: 'POST',
    path,
    body,
  }
}

export function deleteTopologyResourceStep(
  creds: WlsCredentials,
  kind: TopologyResourceKind,
  name: string,
): TopologyMutationStep {
  const normalizedName = requireName(name, kind === 'server' ? 'Server name' : 'Cluster name')
  const { path } = rootResourcePath(creds, kind, normalizedName, 'delete')
  return {
    operation: `Delete ${kind} ${normalizedName}`,
    method: 'DELETE',
    path,
  }
}

// WebLogic creates a migratable target named "<server> (migratable)" when a server joins a cluster,
// and refuses to delete the server while that target still names it as its preferred server
// ("MigratableTargetMBean … does not have a preferred server set"). Deleting a server therefore
// deletes that automatic target in the same edit session. Targets an operator created are left
// alone: if one still points at the server, WebLogic's own validation error says so.
export function automaticMigratableTargetName(serverName: string) {
  return `${serverName.trim()} (migratable)`
}

export function deleteServerSteps(
  creds: WlsCredentials,
  serverName: string,
  migratableTargetNames: readonly string[],
): TopologyMutationStep[] {
  const automatic = automaticMigratableTargetName(serverName)
  const steps: TopologyMutationStep[] = []
  if (migratableTargetNames.includes(automatic)) {
    steps.push({
      operation: `Delete migratable target ${automatic}`,
      method: 'DELETE',
      path: topologyManagementPath(creds.version, `/edit/migratableTargets/${encodeURIComponent(automatic)}`),
    })
  }
  steps.push(deleteTopologyResourceStep(creds, 'server', serverName))
  return steps
}

export async function fetchMigratableTargetNames(creds: WlsCredentials) {
  const data = await fetchWlsJson(
    creds,
    'Migratable target list',
    topologyManagementPath(creds.version, '/edit/migratableTargets', { fields: 'name', links: 'none' }),
  )
  return normalizeNamedRows(data).map((row) => String(row.name))
}

export function updateTopologyChildStep(
  creds: WlsCredentials,
  endpointId: string,
  parentName: string,
  input: Record<string, unknown>,
  childName?: string,
): TopologyMutationStep {
  const endpoint = topologyEndpointById(endpointId, creds.version)
  if (!endpoint) throw new Error(`Topology endpoint ${endpointId} is unavailable for ${creds.version}.`)
  assertCapability(endpoint, 'update')
  const normalizedParent = requireName(parentName, endpoint.resourceKind === 'server' ? 'Server name' : 'Cluster name')
  const normalizedChild = endpoint.endpointKind === 'collection-child'
    ? requireName(childName ?? '', endpoint.childNameParam ?? 'Child resource name')
    : null
  const path = topologyEndpointPath(creds.version, endpoint, {
    resourceName: normalizedParent,
    childName: normalizedChild,
  })
  return {
    operation: `Update ${endpoint.sectionLabel} ${normalizedChild ?? normalizedParent}`,
    method: 'POST',
    path,
    body: topologyMutationPayload(endpoint.id, creds.version, input, 'update'),
  }
}

export function createTopologyChildStep(
  creds: WlsCredentials,
  endpointId: string,
  parentName: string,
  childName: string,
  input: Record<string, unknown> = {},
): TopologyMutationStep {
  const endpoint = topologyEndpointById(endpointId, creds.version)
  if (!endpoint) throw new Error(`Topology endpoint ${endpointId} is unavailable for ${creds.version}.`)
  assertCapability(endpoint, 'create')
  const collectionPath = topologyEndpointCollectionPath(creds.version, endpoint, parentName)
  if (!collectionPath) throw new Error(`Topology endpoint ${endpointId} cannot create child resources.`)
  const normalizedChild = requireName(childName, endpoint.childNameParam ?? 'Child resource name')
  return {
    operation: `Create ${endpoint.sectionLabel} ${normalizedChild}`,
    method: 'POST',
    path: collectionPath,
    body: topologyMutationPayload(endpoint.id, creds.version, { name: normalizedChild, ...input }, 'create'),
  }
}

export function deleteTopologyChildStep(
  creds: WlsCredentials,
  endpointId: string,
  parentName: string,
  childName: string,
): TopologyMutationStep {
  const endpoint = topologyEndpointById(endpointId, creds.version)
  if (!endpoint) throw new Error(`Topology endpoint ${endpointId} is unavailable for ${creds.version}.`)
  assertCapability(endpoint, 'delete')
  const normalizedParent = requireName(parentName, endpoint.resourceKind === 'server' ? 'Server name' : 'Cluster name')
  const normalizedChild = requireName(childName, endpoint.childNameParam ?? 'Child resource name')
  return {
    operation: `Delete ${endpoint.sectionLabel} ${normalizedChild}`,
    method: 'DELETE',
    path: topologyEndpointPath(creds.version, endpoint, { resourceName: normalizedParent, childName: normalizedChild }),
  }
}

export async function invalidateTopologyConfigurationQueries(
  queryClient: QueryClient,
  creds: WlsCredentials | null | undefined,
) {
  const cacheKey = wlsCredentialCacheKey(creds)
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: topologyConfigurationQueryKey(creds) }),
    queryClient.invalidateQueries({ queryKey: editSessionStatusQueryKey(creds) }),
    queryClient.invalidateQueries({ queryKey: ['serverRuntimes', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['serverRuntimeDetails', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['serverRuntimeDetail', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['clusters', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['nodeManager', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['domainDashboard', cacheKey] }),
    queryClient.invalidateQueries({ queryKey: ['domainConfigSnapshots', cacheKey] }),
  ])
}

export function fieldsBySensitivity(fields: TopologyFieldMetadata[]) {
  return fields.reduce<Record<string, string[]>>((groups, field) => {
    const key = field.sensitivity
    groups[key] = [...(groups[key] ?? []), field.jsonProperty]
    return groups
  }, {})
}
