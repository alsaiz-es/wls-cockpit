import { createClient12, createClient14, type WlsCredentials } from '@/api/client'
import { createWlsHttpError, WlsRestError, withWlsRestTimeout } from '@/api/wls-errors'
import { deploymentProgressPending, settleDeploymentProgress } from './deployment-progress'

export type DeploymentLifecycleAction = 'start' | 'stop' | 'redeploy'

export interface DeploymentLifecycleProgress {
  deploymentName: string
  applicationName: string
  targetName: string
  action: DeploymentLifecycleAction
  id: string | null
  name: string | null
  operationType: number | null
  state: string | null
  targets: string[]
  messages: string[]
  failedTargets: string[]
  errorMessage: string | null
}

const DEPLOYMENT_LIFECYCLE_TIMEOUT_MS = 45_000

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => (readString(item) ? [readString(item) as string] : [])) : []
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function redactSensitiveText(value: string) {
  return value
    .replace(/\bBasic\s+[A-Za-z0-9+/=._-]+/gi, 'Basic [redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, '$1[redacted]@')
    .replace(/\b(password|passwd|pwd)=([^&\s]+)/gi, '$1=[redacted]')
}

function firstMeaningfulString(value: unknown, depth = 0): string | null {
  if (depth > 3) return null

  const direct = readString(value)
  if (direct) return redactSensitiveText(direct)
  if (!isObject(value)) return null

  for (const key of ['message', 'localizedMessage', 'detail', 'details', 'reason', 'exception', 'cause']) {
    const found = firstMeaningfulString(value[key], depth + 1)
    if (found) return found
  }

  return null
}

function normalizeProgressError(value: unknown) {
  if (value === null || value === undefined) return null

  const message = firstMeaningfulString(value)
  if (message) return message

  if (isObject(value) && Object.keys(value).length === 0) {
    return 'Deployment progress returned an error.'
  }

  try {
    return redactSensitiveText(JSON.stringify(value)).slice(0, 500)
  } catch {
    return 'Deployment progress returned an error.'
  }
}

function rootExceptionMessage(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return null
  const messages = value.flatMap((item) => {
    const message = normalizeProgressError(item)
    return message ? [message] : []
  })
  return messages.length ? messages.join(' · ') : 'Deployment progress returned root exceptions.'
}

function normalizeProgress(
  data: unknown,
  deploymentName: string,
  targetName: string,
  action: DeploymentLifecycleAction,
): DeploymentLifecycleProgress {
  const progress = isObject(data) ? data : {}
  const failedTargets = readStringArray(progress.failedTargets)
  const rootError = rootExceptionMessage(progress.rootExceptions)
  const state = readString(progress.state)
  const completed = readBoolean(progress.completed)
  const progressValue = readString(progress.progress)
  const stateError = state && state.toUpperCase().includes('FAILED') ? state : null
  const progressError = progressValue && progressValue.toLowerCase().includes('fail') ? progressValue : null
  const failedTargetError = failedTargets.length ? `Failed targets: ${failedTargets.join(', ')}` : null

  return {
    deploymentName,
    applicationName: readString(progress.applicationName) ?? deploymentName,
    targetName,
    action,
    id: readString(progress.id),
    name: readString(progress.name),
    operationType: readNumber(progress.operationType),
    state: state ?? progressValue,
    targets: readStringArray(progress.targets),
    messages: readStringArray(progress.messages ?? progress.deploymentMessages).map(redactSensitiveText),
    failedTargets,
    errorMessage:
      rootError ??
      failedTargetError ??
      stateError ??
      progressError ??
      // A progress object still running after the wait budget is not a failure; it is reported as such.
      (completed === false && !deploymentProgressPending(state ?? progressValue) ? 'Deployment progress did not complete.' : null),
  }
}

export async function fetchDeploymentProgressObject(creds: WlsCredentials, progressName: string) {
  const res = await withWlsRestTimeout(`Deployment progress ${progressName}`, (signal) =>
    clientFor(creds).GET(
      '/management/weblogic/{version}/domainRuntime/deploymentManager/deploymentProgressObjects/{deploymentProgressId}',
      {
        signal,
        params: { path: { version: creds.version, deploymentProgressId: progressName }, query: { links: 'none' } },
      },
    ),
  )
  if (res.error) throw createWlsHttpError(`Deployment progress ${progressName}`, res.response, res.error)
  return res.data
}

function actionLabel(action: DeploymentLifecycleAction) {
  if (action === 'start') return 'Start'
  if (action === 'stop') return 'Stop'
  return 'Redeploy'
}

function lifecycleOperation(deploymentName: string, targetName: string, action: DeploymentLifecycleAction) {
  return `${actionLabel(action)} ${deploymentName} on ${targetName}`
}

export async function runDeploymentLifecycleAction(
  creds: WlsCredentials,
  deploymentName: string,
  targetName: string,
  action: DeploymentLifecycleAction,
): Promise<DeploymentLifecycleProgress> {
  const client = clientFor(creds)
  const operation = lifecycleOperation(deploymentName, targetName, action)
  const targetBody = { targets: [targetName], deploymentOptions: {} }

  const response = await withWlsRestTimeout(
    operation,
    (signal) => {
      if (action === 'start') {
        return client.POST('/management/weblogic/{version}/domainRuntime/deploymentManager/appDeploymentRuntimes/{deploymentName}/start', {
            signal,
            params: {
              path: { version: creds.version, deploymentName },
              header: { 'X-Requested-By': 'wls-cockpit' },
            },
            body: targetBody,
          })
      }

      if (action === 'stop') {
        return client.POST('/management/weblogic/{version}/domainRuntime/deploymentManager/appDeploymentRuntimes/{deploymentName}/stop', {
            signal,
            params: {
              path: { version: creds.version, deploymentName },
              header: { 'X-Requested-By': 'wls-cockpit' },
            },
            body: targetBody,
          })
      }

      return client.POST('/management/weblogic/{version}/domainRuntime/deploymentManager/appDeploymentRuntimes/{deploymentName}/redeploy', {
        signal,
        params: {
          path: { version: creds.version, deploymentName },
          header: { 'X-Requested-By': 'wls-cockpit' },
        },
        // The generated OpenAPI requires SourcePath/PlanPath, but live WLS
        // exposes the no-argument redeploy() signature for existing sources.
        body: undefined as never,
      })
    },
    DEPLOYMENT_LIFECYCLE_TIMEOUT_MS,
  )

  if (response.error) {
    throw createWlsHttpError(operation, response.response, response.error)
  }

  const settled = await settleDeploymentProgress(response.data, (name) => fetchDeploymentProgressObject(creds, name))
  const progress = normalizeProgress(settled, deploymentName, targetName, action)
  if (progress.errorMessage) {
    throw new WlsRestError({
      kind: 'transport',
      operation,
      message: `${operation}: ${progress.errorMessage}`,
    })
  }

  return progress
}
