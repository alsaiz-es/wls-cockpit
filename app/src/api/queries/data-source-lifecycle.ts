import { createClient12, createClient14, type WlsCredentials } from '../client.ts'
import { createWlsHttpError, WlsRestError, withWlsRestTimeout } from '../wls-errors.ts'

export type DataSourceLifecycleAction =
  | 'testPool'
  | 'suspend'
  | 'resume'
  | 'shrink'
  | 'reset'
  | 'clearStatementCache'

export interface DataSourceLifecycleResult {
  dataSourceName: string
  serverName: string
  action: DataSourceLifecycleAction
  message: string | null
}

interface DataSourceLifecycleFetchResponse {
  data?: unknown
  error?: unknown
  response: Response
}

const DATASOURCE_LIFECYCLE_TIMEOUT_MS = 45_000

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function redactSensitiveText(value: string) {
  return value
    .replace(/\bBasic\s+[A-Za-z0-9+/=._-]+/gi, 'Basic [redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, '$1[redacted]@')
    .replace(/\b(password|passwd|pwd)=([^&\s]+)/gi, '$1=[redacted]')
}

function actionLabel(action: DataSourceLifecycleAction) {
  if (action === 'testPool') return 'Test'
  if (action === 'clearStatementCache') return 'Clear statement cache'
  return action[0].toUpperCase() + action.slice(1)
}

function lifecycleOperation(dataSourceName: string, serverName: string, action: DataSourceLifecycleAction) {
  return `${actionLabel(action)} ${dataSourceName} on ${serverName}`
}

export const DATA_SOURCE_TEST_PASSED = 'connection reserved and released, the pool works'

// Runtime actions answer {"return": value}. testPool returns null when a connection could be
// reserved and released, and the exception text when it could not, so a non-null value is a
// failed test, not a message to show next to a success.
export function normalizeLifecycleResult(
  data: unknown,
  dataSourceName: string,
  serverName: string,
  action: DataSourceLifecycleAction,
): DataSourceLifecycleResult {
  const value = typeof data === 'object' && data !== null && 'return' in data ? (data as { return: unknown }).return : data
  const message = readString(value)
  if (action === 'testPool') {
    if (message) {
      throw new WlsRestError({
        kind: 'transport',
        operation: `Test ${dataSourceName} on ${serverName}`,
        message: `Test ${dataSourceName} on ${serverName} failed: ${redactSensitiveText(message)}`,
      })
    }
    return { dataSourceName, serverName, action, message: DATA_SOURCE_TEST_PASSED }
  }
  return {
    dataSourceName,
    serverName,
    action,
    message: message ? redactSensitiveText(message) : null,
  }
}

export async function runDataSourceLifecycleAction(
  creds: WlsCredentials,
  dataSourceName: string,
  serverName: string,
  action: DataSourceLifecycleAction,
): Promise<DataSourceLifecycleResult> {
  const client = clientFor(creds)
  const operation = lifecycleOperation(dataSourceName, serverName, action)
  const params = {
    path: { version: creds.version, serverName, dataSourceName },
    header: { 'X-Requested-By': 'wls-cockpit' },
  }
  const body = {}

  const response = await withWlsRestTimeout<DataSourceLifecycleFetchResponse>(
    operation,
    async (signal) => {
      switch (action) {
        case 'testPool':
          return (await client.POST(
            '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans/{dataSourceName}/testPool',
            { signal, params, body },
          )) as DataSourceLifecycleFetchResponse
        case 'suspend':
          return (await client.POST(
            '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans/{dataSourceName}/suspend',
            { signal, params, body },
          )) as DataSourceLifecycleFetchResponse
        case 'resume':
          return (await client.POST(
            '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans/{dataSourceName}/resume',
            { signal, params, body },
          )) as DataSourceLifecycleFetchResponse
        case 'shrink':
          return (await client.POST(
            '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans/{dataSourceName}/shrink',
            { signal, params, body },
          )) as DataSourceLifecycleFetchResponse
        case 'reset':
          return (await client.POST(
            '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans/{dataSourceName}/reset',
            { signal, params, body },
          )) as DataSourceLifecycleFetchResponse
        case 'clearStatementCache':
          return (await client.POST(
            '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans/{dataSourceName}/clearStatementCache',
            { signal, params, body },
          )) as DataSourceLifecycleFetchResponse
      }
    },
    DATASOURCE_LIFECYCLE_TIMEOUT_MS,
  )

  if (response.error) {
    throw createWlsHttpError(operation, response.response, response.error)
  }

  return normalizeLifecycleResult(response.data, dataSourceName, serverName, action)
}
