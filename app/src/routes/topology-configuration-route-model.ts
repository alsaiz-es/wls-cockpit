import type { WlsCredentials } from '../api/client.ts'
import type { ClusterRow } from '../api/queries/clusters.ts'
import {
  clusterReference,
  createTopologyResourceStep,
  machineReference,
  readTopologyReferenceName,
  readTopologyReferenceNames,
  topologyReference,
  topologyReferenceList,
  type TopologyConfiguredResource,
  type TopologyMutationStep,
  type TopologyReferenceKind,
} from '../api/queries/topology-configuration.ts'
import {
  fieldSupportsMutation,
  type TopologyEndpointCatalog,
  type TopologyFieldMetadata,
} from '../api/queries/topology-configuration-catalog.ts'
import type { ServerRuntimeRow } from '../api/queries/server-runtimes.ts'

export type CreateServerClusterMode = 'none' | 'existing' | 'new'

export interface CreateServerForm {
  name: string
  listenAddress: string
  listenPort: string
  notes: string
  clusterMode: CreateServerClusterMode
  clusterName: string
  newClusterName: string
  machineName: string
}

export interface CreateServerValidation {
  valid: boolean
  errors: Partial<Record<keyof CreateServerForm | 'configuration', string>>
}

export interface CreateServerIntent {
  serverName: string
  subject: string
  detail: string
  steps: TopologyMutationStep[]
}

export interface CreateClusterForm {
  name: string
  clusterAddress: string
  clusterMessagingMode: string
  clusterType: string
  frontendHost: string
  frontendHTTPPort: string
  frontendHTTPSPort: string
  notes: string
}

export type CreateClusterErrors = Partial<Record<keyof CreateClusterForm | 'configuration', string>>

export interface CreateClusterIntent {
  clusterName: string
  subject: string
  detail: string
  input: Record<string, unknown>
}

export interface ConfigEditDraft {
  endpointId: string
  values: Record<string, string>
}

export interface TopologySectionEditIntent {
  kind: 'update-section'
  endpointId: string
  endpointKind: TopologyEndpointCatalog['endpointKind']
  sectionLabel: string
  resourceName: string
  changedFields: string[]
  payload: Record<string, unknown>
  detail: string
}

export type ConfigEditErrors = Record<string, string>

export function normalizeTextInput(value: string) {
  return value.trim()
}

export function validateWebLogicName(value: string, label: string) {
  const normalized = normalizeTextInput(value)
  if (!normalized) return `${label} is required.`
  const hasUnsafeCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return character === '/' || character === '\\' || codePoint < 32
  })
  if (hasUnsafeCharacter) return `${label} cannot contain slashes or control characters.`
  return null
}

export function parseOptionalTopologyPort(value: string) {
  const normalized = normalizeTextInput(value)
  if (!normalized) return null
  const parsed = Number(normalized)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : null
}

function invalidPort(value: string) {
  const normalized = normalizeTextInput(value)
  if (!normalized) return false
  const parsed = Number(normalized)
  return !Number.isInteger(parsed) || parsed < 1 || parsed > 65_535
}

export function initialCreateServerForm(): CreateServerForm {
  return {
    name: '',
    listenAddress: '',
    listenPort: '',
    notes: '',
    clusterMode: 'none',
    clusterName: '',
    newClusterName: '',
    machineName: '',
  }
}

export function validateCreateServerForm(
  form: CreateServerForm,
  options: {
    configurationLoaded: boolean
    serverNames: string[]
    clusterNames: string[]
    machineNames: string[]
    machinesAvailable: boolean
  },
): CreateServerValidation {
  const errors: CreateServerValidation['errors'] = {}
  const name = normalizeTextInput(form.name)
  const nameError = validateWebLogicName(form.name, 'Server name')
  if (nameError) errors.name = nameError
  else if (name === 'AdminServer') errors.name = 'AdminServer is protected.'
  else if (options.serverNames.includes(name)) errors.name = 'Server name already exists.'

  if (invalidPort(form.listenPort)) errors.listenPort = 'Listen port must be an integer from 1 to 65535.'

  if (!options.configurationLoaded) {
    errors.configuration = 'Server configuration discovery is still loading.'
  }

  if (form.clusterMode === 'existing') {
    const clusterName = normalizeTextInput(form.clusterName)
    if (!clusterName) errors.clusterName = 'Cluster is required.'
    else if (!options.clusterNames.includes(clusterName)) errors.clusterName = 'Select a current cluster.'
  }
  if (form.clusterMode === 'new') {
    const clusterName = normalizeTextInput(form.newClusterName)
    const clusterError = validateWebLogicName(form.newClusterName, 'Cluster name')
    if (clusterError) errors.newClusterName = clusterError
    else if (options.clusterNames.includes(clusterName)) errors.newClusterName = 'Cluster name already exists.'
  }

  const machineName = normalizeTextInput(form.machineName)
  if (machineName && (!options.machinesAvailable || !options.machineNames.includes(machineName))) {
    errors.machineName = 'Select a current machine.'
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  }
}

export function createServerIntent(creds: WlsCredentials, form: CreateServerForm): CreateServerIntent {
  const serverName = normalizeTextInput(form.name)
  const listenAddress = normalizeTextInput(form.listenAddress)
  const notes = normalizeTextInput(form.notes)
  const listenPort = parseOptionalTopologyPort(form.listenPort)
  const clusterName =
    form.clusterMode === 'existing'
      ? normalizeTextInput(form.clusterName)
      : form.clusterMode === 'new'
        ? normalizeTextInput(form.newClusterName)
        : ''
  const machineName = normalizeTextInput(form.machineName)
  const serverInput = {
    ...(listenAddress ? { listenAddress } : {}),
    ...(listenPort !== null ? { listenPort } : {}),
    ...(notes ? { notes } : {}),
    ...(clusterName ? { cluster: clusterReference(clusterName) } : {}),
    ...(machineName ? { machine: machineReference(machineName) } : {}),
  }
  const steps: TopologyMutationStep[] = []
  if (form.clusterMode === 'new' && clusterName) {
    steps.push(createTopologyResourceStep(creds, 'cluster', clusterName))
  }
  steps.push(createTopologyResourceStep(creds, 'server', serverName, serverInput))

  return {
    serverName,
    subject: [
      serverName,
      clusterName ? `cluster ${clusterName}` : 'no cluster',
      machineName ? `machine ${machineName}` : 'no machine',
    ].join(' | '),
    detail: `Create managed server ${serverName}`,
    steps,
  }
}

export function initialCreateClusterForm(): CreateClusterForm {
  return {
    name: '',
    clusterAddress: '',
    clusterMessagingMode: '',
    clusterType: '',
    frontendHost: '',
    frontendHTTPPort: '',
    frontendHTTPSPort: '',
    notes: '',
  }
}

function setClusterPortError(errors: CreateClusterErrors, field: 'frontendHTTPPort' | 'frontendHTTPSPort') {
  if (field === 'frontendHTTPPort') errors.frontendHTTPPort = 'Frontend HTTP port must be an integer from 1 to 65535.'
  else errors.frontendHTTPSPort = 'Frontend HTTPS port must be an integer from 1 to 65535.'
}

export function validateCreateClusterForm(
  form: CreateClusterForm,
  options: {
    configurationLoaded: boolean
    clusterNames: string[]
  },
) {
  const errors: CreateClusterErrors = {}
  const name = normalizeTextInput(form.name)
  const nameError = validateWebLogicName(form.name, 'Cluster name')
  if (nameError) errors.name = nameError
  else if (options.clusterNames.includes(name)) errors.name = 'Cluster name already exists.'

  if (invalidPort(form.frontendHTTPPort)) setClusterPortError(errors, 'frontendHTTPPort')
  if (invalidPort(form.frontendHTTPSPort)) setClusterPortError(errors, 'frontendHTTPSPort')

  if (!options.configurationLoaded) {
    errors.configuration = 'Cluster configuration discovery is still loading.'
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  }
}

export function createClusterIntent(form: CreateClusterForm): CreateClusterIntent {
  const clusterName = normalizeTextInput(form.name)
  const clusterAddress = normalizeTextInput(form.clusterAddress)
  const clusterMessagingMode = normalizeTextInput(form.clusterMessagingMode)
  const clusterType = normalizeTextInput(form.clusterType)
  const frontendHost = normalizeTextInput(form.frontendHost)
  const frontendHTTPPort = parseOptionalTopologyPort(form.frontendHTTPPort)
  const frontendHTTPSPort = parseOptionalTopologyPort(form.frontendHTTPSPort)
  const notes = normalizeTextInput(form.notes)
  const input = {
    ...(clusterAddress ? { clusterAddress } : {}),
    ...(clusterMessagingMode ? { clusterMessagingMode } : {}),
    ...(clusterType ? { clusterType } : {}),
    ...(frontendHost ? { frontendHost } : {}),
    ...(frontendHTTPPort !== null ? { frontendHTTPPort } : {}),
    ...(frontendHTTPSPort !== null ? { frontendHTTPSPort } : {}),
    ...(notes ? { notes } : {}),
  }

  return {
    clusterName,
    subject: [
      clusterName,
      clusterAddress ? `address ${clusterAddress}` : 'no address',
      clusterMessagingMode ? `messaging ${clusterMessagingMode}` : 'default messaging',
    ].join(' | '),
    detail: `Create cluster ${clusterName}`,
    input,
  }
}

export function referenceKindForTopologyField(field: TopologyFieldMetadata): TopologyReferenceKind | null {
  const property = field.jsonProperty.toLowerCase()
  if (property === 'cluster' || property.includes('cluster')) return 'clusters'
  if (property.includes('machine')) return 'machines'
  if (property.includes('dynamicserver')) return 'dynamicServers'
  if (property === 'servertemplate') return 'serverTemplates'
  if (property.includes('networkaccesspoint')) return 'networkAccessPoints'
  if (property === 'servers' || property.includes('server')) return 'servers'
  return null
}

export function configFieldsForMutation(endpoint: TopologyEndpointCatalog, mode: 'create' | 'update') {
  if (!endpoint.capabilities.includes(mode)) return []
  return endpoint.fields.filter((field) => fieldSupportsMutation(field, mode) && !field.unavailableReason)
}

export function editableConfigFields(endpoint: TopologyEndpointCatalog) {
  return configFieldsForMutation(endpoint, 'update')
}

function splitListDraft(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function draftValueForConfigField(field: TopologyFieldMetadata, value: unknown) {
  if (field.sensitive || field.writeSupport === 'write-only') return ''
  const referenceKind = referenceKindForTopologyField(field)
  if (referenceKind && field.valueKind === 'reference') {
    return readTopologyReferenceName(value, referenceKind) ?? ''
  }
  if (referenceKind && field.valueKind === 'reference-list') {
    return readTopologyReferenceNames(value, referenceKind).join(', ')
  }
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === 'string' || typeof item === 'number' ? String(item) : '').filter(Boolean).join(', ')
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value
  return ''
}

export function buildConfigEditDraft(endpoint: TopologyEndpointCatalog, data: unknown): ConfigEditDraft {
  const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
  const values = Object.fromEntries(
    editableConfigFields(endpoint).map((field) => [field.jsonProperty, draftValueForConfigField(field, record[field.jsonProperty])]),
  )
  return { endpointId: endpoint.id, values }
}

function validateDraftPattern(field: TopologyFieldMetadata, value: string) {
  if (!field.validation?.pattern || !value) return null
  try {
    return new RegExp(field.validation.pattern).test(value) ? null : `${field.label} does not match the required format.`
  } catch {
    return null
  }
}

export function parseConfigDraftValue(field: TopologyFieldMetadata, draftValue: string) {
  const normalized = draftValue.trim()
  // Hidden fields (write-only or sensitive) render empty: blank means "keep the current value",
  // never "clear it", or saving one field would wipe paths such as javaHome or classPath.
  if ((field.writeSupport === 'write-only' || field.sensitive) && !normalized) return { skip: true as const }

  if (field.valueKind === 'boolean') {
    if (!normalized) return { value: null }
    if (normalized === 'true') return { value: true }
    if (normalized === 'false') return { value: false }
    return { error: `${field.label} must be true or false.` }
  }

  if (field.valueKind === 'integer') {
    if (!normalized) return { value: null }
    const value = Number(normalized)
    if (!Number.isInteger(value)) return { error: `${field.label} must be an integer.` }
    const min = field.validation?.min
    const max = field.validation?.max
    if (typeof min === 'number' && value < min) return { error: `${field.label} must be at least ${min}.` }
    if (typeof max === 'number' && value > max) return { error: `${field.label} must be at most ${max}.` }
    return { value }
  }

  if (field.valueKind === 'string-list') {
    return { value: splitListDraft(draftValue) }
  }

  const referenceKind = referenceKindForTopologyField(field)
  if (field.valueKind === 'reference') {
    if (!referenceKind) return { error: `${field.label} reference type is unsupported.` }
    return { value: normalized ? topologyReference(referenceKind, normalized) : null }
  }
  if (field.valueKind === 'reference-list') {
    if (!referenceKind) return { error: `${field.label} reference type is unsupported.` }
    return { value: topologyReferenceList(splitListDraft(draftValue).map((name) => topologyReference(referenceKind, name))) }
  }

  if (field.valueKind === 'object') {
    if (!normalized) return { value: null }
    try {
      return { value: JSON.parse(normalized) as unknown }
    } catch {
      return { error: `${field.label} must be valid JSON.` }
    }
  }

  const patternError = validateDraftPattern(field, normalized)
  if (patternError) return { error: patternError }
  if (field.validation?.enumValues && normalized && !field.validation.enumValues.includes(normalized)) {
    return { error: `${field.label} is not a supported value.` }
  }
  return { value: draftValue }
}

function serializedValue(value: unknown) {
  return JSON.stringify(value ?? null)
}

export function buildTopologySectionEditIntent({
  resourceName,
  endpoint,
  data,
  values,
}: {
  resourceName: string
  endpoint: TopologyEndpointCatalog
  data: unknown
  values: Record<string, string>
}): { intent: TopologySectionEditIntent | null; errors: ConfigEditErrors } {
  const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
  const errors: ConfigEditErrors = {}
  const payload: Record<string, unknown> = {}
  const changedFields: string[] = []

  editableConfigFields(endpoint).forEach((field) => {
    const draftValue = values[field.jsonProperty] ?? ''
    const originalDraft = draftValueForConfigField(field, record[field.jsonProperty])
    const hidesCurrentValue = field.sensitive || field.writeSupport === 'write-only'
    if (!hidesCurrentValue && draftValue === originalDraft) return

    const parsed = parseConfigDraftValue(field, draftValue)
    if ('skip' in parsed) return
    if ('error' in parsed && typeof parsed.error === 'string') {
      errors[field.jsonProperty] = parsed.error
      return
    }
    if (!hidesCurrentValue && serializedValue(parsed.value) === serializedValue(record[field.jsonProperty])) return

    payload[field.jsonProperty] = parsed.value
    changedFields.push(field.label)
  })

  if (Object.keys(errors).length > 0) return { intent: null, errors }
  if (changedFields.length === 0) {
    return { intent: null, errors: { __form: 'No changed editable fields.' } }
  }

  return {
    errors: {},
    intent: {
      endpointId: endpoint.id,
      endpointKind: endpoint.endpointKind,
      kind: 'update-section',
      sectionLabel: endpoint.sectionLabel,
      resourceName,
      changedFields,
      payload,
      detail: `Update ${endpoint.sectionLabel} for ${resourceName}`,
    },
  }
}

export function serverDeleteBlockedReason(serverName: string, row: ServerRuntimeRow | null, resource: TopologyConfiguredResource | null) {
  if (serverName === 'AdminServer') return 'AdminServer is protected.'
  if (!resource) return 'Configuration row is required before deletion.'
  if (!row) return null
  if (row.state === 'SHUTDOWN' || row.state === 'UNKNOWN') return null
  return `Stop ${serverName} before deleting it.`
}

export function buildServerDeleteIntent(serverName: string, resource: TopologyConfiguredResource) {
  const clusterName = readTopologyReferenceName(resource.root.cluster, 'clusters')
  const machineName = readTopologyReferenceName(resource.root.machine, 'machines')
  const dependencies = [
    clusterName ? `cluster ${clusterName}` : null,
    machineName ? `machine ${machineName}` : null,
  ].filter((item): item is string => !!item)

  return {
    kind: 'delete-server' as const,
    endpointId: 'server.root',
    endpointKind: 'root' as const,
    sectionLabel: 'Managed Server',
    serverName,
    childName: null,
    changedFields: dependencies.length ? [`Dependencies: ${dependencies.join(', ')}`] : ['No configured dependencies reported'],
    payload: {},
    detail: `Delete managed server ${serverName}`,
  }
}

export function clusterDeleteBlockedReason(row: ClusterRow, resource: TopologyConfiguredResource | null) {
  if (!resource) return 'Configuration row is required before deletion.'
  const configuredMembers = row.configuredMemberNames.length
  const rootMembers = readTopologyReferenceNames(resource.root.servers, 'servers').length
  const members = Math.max(configuredMembers, rootMembers)
  if (members > 0) return `Remove ${members.toLocaleString()} configured server member${members === 1 ? '' : 's'} before deleting this cluster.`
  return null
}

export function buildClusterDeleteIntent(row: ClusterRow, resource: TopologyConfiguredResource) {
  const dynamicServer = readTopologyReferenceName(resource.root.dynamicServers, 'dynamicServers')
  return {
    kind: 'delete-cluster' as const,
    endpointId: 'cluster.root',
    endpointKind: 'root' as const,
    sectionLabel: 'Cluster',
    clusterName: row.name,
    changedFields: dynamicServer ? [`Dynamic servers: ${dynamicServer}`] : ['No configured members reported'],
    payload: {},
    detail: `Delete cluster ${row.name}`,
  }
}
