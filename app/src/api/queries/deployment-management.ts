import { useQuery } from '@tanstack/react-query'
import { createClient12, createClient14, wlsCredentialCacheKey, type WlsCredentials } from '@/api/client'
import { DEPLOYMENT_UPLOAD_PATH, MAX_DEPLOYMENT_UPLOAD_BYTES } from '@/api/deployment-upload-contract'
import { deploymentUploadRequestInit } from './deployment-upload'
export { deploymentNameFromFileName } from './deployment-upload'
import { createWlsHttpError, WlsRestError, withWlsRestTimeout } from '@/api/wls-errors'
import { fetchDeploymentProgressObject } from './deployment-lifecycle'
import { deploymentStateLabel, settleDeploymentProgress } from './deployment-progress'
import { runInEditSession } from './edit-session-transaction'
import { useAuth } from '@/auth/useAuth'
import type { DeploymentTargetRef } from './deployments'
import { deploymentTargetLabel, deploymentTargetTuple } from './deployment-targets'

export type DeploymentConfigAction = 'deploy' | 'undeploy' | 'targets'

export interface DeploymentTargetChoice extends DeploymentTargetRef {
  id: string
}

export type DeploymentSource = 'path' | 'upload'

export interface DeployApplicationInput {
  name: string
  // 'path': an archive already on the AdminServer host; 'upload': a file from this computer.
  source?: DeploymentSource
  applicationPath: string
  planPath: string
  file?: File | null
  targets: DeploymentTargetRef[]
}

export interface DeploymentConfigResult {
  action: DeploymentConfigAction
  deploymentName: string
  targets: DeploymentTargetRef[]
  state: string | null
  detail: string
}

const DEPLOYMENT_CONFIG_TIMEOUT_MS = 60_000
// Uploading and staging a large archive takes far longer than a configuration call.
const DEPLOYMENT_UPLOAD_TIMEOUT_MS = 15 * 60_000

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readItems(data: unknown): unknown[] {
  return isObject(data) && Array.isArray(data.items) ? data.items : []
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => (readString(item) ? [readString(item) as string] : [])) : []
}

function redactSensitiveText(value: string) {
  return value
    .replace(/\bBasic\s+[A-Za-z0-9+/=._-]+/gi, 'Basic [redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, '$1[redacted]@')
    .replace(/\b(password|passwd|pwd)=([^&\s]+)/gi, '$1=[redacted]')
}

function deployTargetNames(targets: DeploymentTargetRef[]) {
  return targets.map((target) => target.name)
}

function progressState(data: unknown) {
  if (!isObject(data)) return null
  return readString(data.state) ?? readString(data.progress)
}

function progressError(data: unknown) {
  if (!isObject(data)) return null
  const failedTargets = readStringArray(data.failedTargets)
  if (failedTargets.length) return `Failed targets: ${failedTargets.join(', ')}`
  const state = progressState(data)
  if (state?.toUpperCase().includes('FAILED')) return state
  return null
}

function resultDetail(action: DeploymentConfigAction, deploymentName: string, targets: DeploymentTargetRef[], state: string | null) {
  const targetText = targets.length ? targets.map(deploymentTargetLabel).join(', ') : 'no targets'
  const label = deploymentStateLabel(state)
  const stateText = label ? ` · ${label}` : ''
  if (action === 'deploy') return `Deploy ${deploymentName} to ${targetText}${stateText}`
  if (action === 'undeploy') return `Undeploy ${deploymentName}${stateText}`
  return `Targets ${deploymentName}: ${targetText}${stateText}`
}

function configResult(
  action: DeploymentConfigAction,
  deploymentName: string,
  targets: DeploymentTargetRef[],
  state: string | null = null,
): DeploymentConfigResult {
  return {
    action,
    deploymentName,
    targets,
    state,
    detail: resultDetail(action, deploymentName, targets, state),
  }
}

async function editRequest(label: string, request: (signal: AbortSignal) => Promise<{ error?: unknown; response: Response }>) {
  const res = await withWlsRestTimeout(label, request, DEPLOYMENT_CONFIG_TIMEOUT_MS)
  if (res.error) throw createWlsHttpError(label, res.response, res.error)
}

async function startEdit(creds: WlsCredentials) {
  await editRequest('Start edit session', (signal) =>
    clientFor(creds).POST('/management/weblogic/{version}/edit/changeManager/startEdit', {
      signal,
      params: {
        path: { version: creds.version },
        header: { 'X-Requested-By': 'wls-cockpit' },
      },
      body: {},
    }),
  )
}

async function activateEdit(creds: WlsCredentials) {
  await editRequest('Activate edit session', (signal) =>
    clientFor(creds).POST('/management/weblogic/{version}/edit/changeManager/activate', {
      signal,
      params: {
        path: { version: creds.version },
        header: { 'X-Requested-By': 'wls-cockpit' },
      },
      body: {},
    }),
  )
}

async function cancelEdit(creds: WlsCredentials) {
  await editRequest('Cancel edit session', (signal) =>
    clientFor(creds).POST('/management/weblogic/{version}/edit/changeManager/cancelEdit', {
      signal,
      params: {
        path: { version: creds.version },
        header: { 'X-Requested-By': 'wls-cockpit' },
      },
      body: {},
    }),
  )
}

async function withEditSession<T>(creds: WlsCredentials, mutation: () => Promise<T>): Promise<T> {
  return runInEditSession(
    {
      startEdit: () => startEdit(creds),
      activate: () => activateEdit(creds),
      cancelEdit: () => cancelEdit(creds),
    },
    mutation,
  )
}

export function deploymentTargetsQueryKey(creds: WlsCredentials | null | undefined) {
  return ['deploymentTargets', wlsCredentialCacheKey(creds)] as const
}

export async function fetchDeploymentTargetChoices(creds: WlsCredentials): Promise<DeploymentTargetChoice[]> {
  const client = clientFor(creds)
  const [servers, clusters] = await Promise.all([
    withWlsRestTimeout('Deployment target servers', (signal) =>
      client.GET('/management/weblogic/{version}/edit/servers', {
        signal,
        params: { path: { version: creds.version }, query: { fields: 'name', links: 'none' } },
      }),
    ),
    withWlsRestTimeout('Deployment target clusters', (signal) =>
      client.GET('/management/weblogic/{version}/edit/clusters', {
        signal,
        params: { path: { version: creds.version }, query: { fields: 'name', links: 'none' } },
      }),
    ),
  ])

  if (servers.error) throw createWlsHttpError('Deployment target servers', servers.response, servers.error)
  if (clusters.error) throw createWlsHttpError('Deployment target clusters', clusters.response, clusters.error)

  const choices = [
    ...readItems(servers.data).flatMap((item): DeploymentTargetChoice[] => {
      if (!isObject(item)) return []
      const name = readString(item.name)
      return name ? [{ id: `servers:${name}`, kind: 'servers', name }] : []
    }),
    ...readItems(clusters.data).flatMap((item): DeploymentTargetChoice[] => {
      if (!isObject(item)) return []
      const name = readString(item.name)
      return name ? [{ id: `clusters:${name}`, kind: 'clusters', name }] : []
    }),
  ]

  return choices.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

export function useDeploymentTargetChoices() {
  const { creds } = useAuth()

  return useQuery({
    queryKey: deploymentTargetsQueryKey(creds),
    enabled: !!creds,
    staleTime: 30_000,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchDeploymentTargetChoices(creds)
    },
  })
}

async function uploadApplication(
  creds: WlsCredentials,
  deploymentName: string,
  targets: DeploymentTargetRef[],
  file: File,
) {
  if (file.size === 0) throw new Error('The selected archive is empty.')
  if (file.size > MAX_DEPLOYMENT_UPLOAD_BYTES) throw new Error('The selected archive is larger than 2 GiB.')
  const label = `Upload ${deploymentName}`
  const query = new URLSearchParams({ version: creds.version })
  const response = await withWlsRestTimeout(
    label,
    (signal) => fetch(`${DEPLOYMENT_UPLOAD_PATH}?${query}`, { ...deploymentUploadRequestInit(creds, deploymentName, targets, file), signal }),
    DEPLOYMENT_UPLOAD_TIMEOUT_MS,
  )
  if (!response.ok) throw createWlsHttpError(label, response, await response.json().catch(() => undefined))
}

export async function deployApplication(
  creds: WlsCredentials,
  input: DeployApplicationInput,
): Promise<DeploymentConfigResult> {
  if (input.source === 'upload') {
    const deploymentName = input.name.trim()
    if (!deploymentName) throw new Error('Deployment name is required.')
    if (!input.file) throw new Error('Choose the archive to upload.')
    if (input.targets.length === 0) throw new Error('At least one target is required.')
    const file = input.file
    return withEditSession(creds, async () => {
      await uploadApplication(creds, deploymentName, input.targets, file)
      return configResult('deploy', deploymentName, input.targets)
    })
  }

  const deploymentName = input.name.trim()
  const applicationPath = input.applicationPath.trim()
  const planPath = input.planPath.trim()
  if (!deploymentName) throw new Error('Deployment name is required.')
  if (!applicationPath) throw new Error('AdminServer application path is required.')
  if (input.targets.length === 0) throw new Error('At least one target is required.')

  const res = await withWlsRestTimeout(
    `Deploy ${deploymentName}`,
    (signal) =>
      clientFor(creds).POST('/management/weblogic/{version}/domainRuntime/deploymentManager/deploy', {
        signal,
        params: {
          path: { version: creds.version },
          header: { 'X-Requested-By': 'wls-cockpit' },
        },
        body: {
          name: deploymentName,
          applicationPath,
          // The generated OpenAPI types this as string, but live WLS expects
          // the deployment target list as an array of target names.
          targets: deployTargetNames(input.targets),
          plan: planPath,
          deploymentOptions: {},
        } as never,
      }),
    DEPLOYMENT_CONFIG_TIMEOUT_MS,
  )

  if (res.error) throw createWlsHttpError(`Deploy ${deploymentName}`, res.response, res.error)
  const settled = await settleDeploymentProgress(res.data, (name) => fetchDeploymentProgressObject(creds, name))
  const error = progressError(settled)
  if (error) {
    throw new WlsRestError({
      kind: 'transport',
      operation: `Deploy ${deploymentName}`,
      message: redactSensitiveText(`Deploy ${deploymentName}: ${error}`),
    })
  }
  return configResult('deploy', deploymentName, input.targets, progressState(settled))
}

export async function undeployApplication(
  creds: WlsCredentials,
  deploymentName: string,
): Promise<DeploymentConfigResult> {
  const name = deploymentName.trim()
  if (!name) throw new Error('Deployment name is required.')

  return withEditSession(creds, async () => {
    await editRequest(`Undeploy ${name}`, (signal) =>
      clientFor(creds).DELETE('/management/weblogic/{version}/edit/appDeployments/{deploymentName}', {
        signal,
        params: {
          path: { version: creds.version, deploymentName: name },
          header: { 'X-Requested-By': 'wls-cockpit' },
        },
      }),
    )
    return configResult('undeploy', name, [])
  })
}

export async function updateDeploymentTargets(
  creds: WlsCredentials,
  deploymentName: string,
  targets: DeploymentTargetRef[],
): Promise<DeploymentConfigResult> {
  const name = deploymentName.trim()
  if (!name) throw new Error('Deployment name is required.')
  if (targets.length === 0) throw new Error('At least one target is required.')

  return withEditSession(creds, async () => {
    await editRequest(`Update targets ${name}`, (signal) =>
      clientFor(creds).POST('/management/weblogic/{version}/edit/appDeployments/{deploymentName}', {
        signal,
        params: {
          path: { version: creds.version, deploymentName: name },
          header: { 'X-Requested-By': 'wls-cockpit' },
        },
        body: {
          targets: targets.map(deploymentTargetTuple),
        } as never,
      }),
    )
    return configResult('targets', name, targets)
  })
}
