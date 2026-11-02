import { createClient12, createClient14, type WlsCredentials } from '../client.ts'
import { createWlsHttpError, WlsRestError, withWlsRestTimeout } from '../wls-errors.ts'
import {
  enrichLifecycleFailureWithNodeManager,
  nodeManagerContextForServer,
} from './node-manager.ts'

export type ServerLifecycleAction = 'start' | 'shutdown' | 'forceShutdown' | 'suspend' | 'resume'

export interface ServerLifecycleTask {
  serverName: string
  action: ServerLifecycleAction
  name: string | null
  operation: string | null
  status: string | null
  running: boolean | null
  errorMessage: string | null
}

const LIFECYCLE_TIMEOUT_MS = 45_000

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
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

function normalizeTaskError(value: unknown) {
  if (value === null || value === undefined) return null

  const message = firstMeaningfulString(value)
  if (message) return message

  if (isObject(value) && Object.keys(value).length === 0) {
    return 'Lifecycle task returned an error.'
  }

  try {
    return redactSensitiveText(JSON.stringify(value)).slice(0, 500)
  } catch {
    return 'Lifecycle task returned an error.'
  }
}

function normalizeTask(data: unknown, serverName: string, action: ServerLifecycleAction): ServerLifecycleTask {
  const task = isObject(data) ? data : {}

  return {
    serverName: readString(task.serverName) ?? serverName,
    action,
    name: readString(task.name),
    operation: readString(task.operation),
    status: readString(task.status) ?? readString(task.taskStatus) ?? readString(task.progress),
    running: readBoolean(task.running),
    errorMessage: normalizeTaskError(task.error ?? task.taskError),
  }
}

function lifecycleOperation(serverName: string, action: ServerLifecycleAction) {
  if (action === 'start') return `Start ${serverName}`
  if (action === 'shutdown') return `Shutdown ${serverName}`
  if (action === 'forceShutdown') return `Force shutdown ${serverName}`
  if (action === 'suspend') return `Suspend ${serverName}`
  return `Resume ${serverName}`
}

function nodeManagerContextRelevant(message: string) {
  return /\b(node\s*manager|nodemanager|machine|reach|unreachable|connect|connection|refused|timeout|timed\s*out|host)\b/i.test(message)
}

async function enrichLifecycleError(
  creds: WlsCredentials,
  serverName: string,
  action: ServerLifecycleAction,
  error: Error,
) {
  if (action !== 'start' || !nodeManagerContextRelevant(error.message)) return error

  try {
    const context = await nodeManagerContextForServer(creds, serverName)
    const message = enrichLifecycleFailureWithNodeManager(error.message, context)
    if (message === error.message) return error
    return new Error(message, { cause: error })
  } catch {
    return error
  }
}

export async function runServerLifecycleAction(
  creds: WlsCredentials,
  serverName: string,
  action: ServerLifecycleAction,
): Promise<ServerLifecycleTask> {
  const client = clientFor(creds)
  const operation = lifecycleOperation(serverName, action)

  const response = await withWlsRestTimeout(
    operation,
    (signal) => {
      const params = {
        path: { version: creds.version, serverName },
        header: { 'X-Requested-By': 'wls-cockpit' },
      }

      if (action === 'start') {
        return client.POST('/management/weblogic/{version}/domainRuntime/serverLifeCycleRuntimes/{serverName}/start', {
          signal,
          params,
          body: {},
        })
      }

      if (action === 'shutdown') {
        return client.POST('/management/weblogic/{version}/domainRuntime/serverLifeCycleRuntimes/{serverName}/shutdown', {
          signal,
          params,
          body: { timeout: 0, ignoreSessions: false },
        })
      }

      if (action === 'forceShutdown') {
        return client.POST('/management/weblogic/{version}/domainRuntime/serverLifeCycleRuntimes/{serverName}/forceShutdown', {
          signal,
          params,
          body: {},
        })
      }

      if (action === 'suspend') {
        return client.POST('/management/weblogic/{version}/domainRuntime/serverLifeCycleRuntimes/{serverName}/suspend', {
          signal,
          params,
          body: {},
        })
      }

      return client.POST('/management/weblogic/{version}/domainRuntime/serverLifeCycleRuntimes/{serverName}/resume', {
        signal,
        params,
        body: {},
      })
    },
    LIFECYCLE_TIMEOUT_MS,
  )

  if (response.error) {
    throw await enrichLifecycleError(creds, serverName, action, createWlsHttpError(operation, response.response, response.error))
  }

  const task = normalizeTask(response.data, serverName, action)
  if (task.errorMessage) {
    throw await enrichLifecycleError(creds, serverName, action, new WlsRestError({
      kind: 'transport',
      operation,
      message: `${operation}: ${task.errorMessage}`,
    }))
  }

  return task
}
